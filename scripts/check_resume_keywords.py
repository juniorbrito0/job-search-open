#!/usr/bin/env python3
"""Check a tailored resume against the posting, and add missing words the
candidate genuinely has.

Nobody has to read the PDF for keyword gaps. This script:
1. Pulls the important words out of the job description.
2. Checks they appear in the tailored resume.
3. If a missing word is already somewhere on the master resume
   (profile/resume.json), it is added to the tailoring file's
   `extra_keywords` and the resume is rebuilt with scripts/build_resume.py.
4. Words the candidate does not have are left off. Nothing is invented.

    .venv/bin/python scripts/check_resume_keywords.py
    .venv/bin/python scripts/check_resume_keywords.py --id <position-id> --fix

The tailoring file for a position is the tailor/*.json whose `position_id`
matches; failing that, the one whose `company` matches.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import generate_resume as g  # noqa: E402
from jobsearch_lib import file_lock, load_positions, now_iso, save_positions  # noqa: E402
from profile_lib import search_titles  # noqa: E402

# Words recruiters and screening software commonly look for, across functions.
# The list is extended at run time with the candidate's own titles, skills and
# tools, so it fits whatever field she works in.
GENERIC_PHRASES = [
    "chief of staff", "operations", "business operations", "program management",
    "project management", "people operations", "human resources", "recruiting",
    "onboarding", "compliance", "budget", "forecasting", "reporting", "analytics",
    "stakeholder management", "cross-functional", "process improvement",
    "change management", "vendor management", "customer success", "account management",
    "marketing", "content", "social media", "seo", "sales", "crm", "salesforce",
    "hubspot", "excel", "google sheets", "sql", "tableau", "power bi", "jira",
    "asana", "notion", "slack", "okrs", "kpis", "agile", "scrum", "gdpr",
    "payroll", "fp&a", "strategy", "leadership", "mentoring", "training",
    "event planning", "communications", "writing", "research", "product management",
    "user research", "design", "figma", "partnerships", "fundraising", "grant writing",
    "ai", "chatgpt", "claude", "automation", "zapier",
]


def _split_items(text: str) -> list[str]:
    return [x.strip().lower() for x in re.split(r"\s*(?:·|,|;|\|)\s*", text or "") if x.strip()]


def phrase_list(master: dict) -> list[str]:
    phrases = list(GENERIC_PHRASES)
    for t in search_titles():
        phrases.append(str(t).lower())
    for group in master.get("skills_groups") or []:
        if isinstance(group, list) and len(group) > 1:
            phrases += _split_items(group[1])
    phrases += _split_items(master.get("tools") or "")
    out = []
    for p in phrases:
        p = p.strip()
        if 2 <= len(p) <= 40 and p not in out:
            out.append(p)
    return out


def _has(phrase: str, text: str) -> bool:
    return re.search(r"(?<![a-z0-9])" + re.escape(phrase) + r"(?![a-z0-9])", text) is not None


def extract_keywords(jd: str, phrases: list[str]) -> list[str]:
    text = (jd or "").lower()
    return [p for p in phrases if _has(p, text)]


def missing_from(keywords: list[str], hay: str) -> list[str]:
    low = hay.lower()
    return [kw for kw in keywords if not _has(kw, low)]


def find_overlay(position: dict) -> Path | None:
    pid = position.get("id") or ""
    company = (position.get("company") or "").strip().lower()
    by_company = []
    for path in sorted((ROOT / "tailor").glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if pid and data.get("position_id") == pid:
            return path
        if company and (data.get("company") or "").strip().lower() == company:
            by_company.append(path)
    return by_company[0] if len(by_company) == 1 else None


def resume_docx_path(position: dict) -> Path | None:
    rel = position.get("resume_path")
    if not rel:
        return None
    path = ROOT / rel
    docx = path.with_suffix(".docx")
    if docx.exists():
        return docx
    if path.exists() and path.suffix.lower() == ".docx":
        return path
    folder = path.parent
    if folder.is_dir():
        docs = list(folder.glob("*.docx"))
        if len(docs) == 1:
            return docs[0]
    return None


def add_keywords(overlay_path: Path, words: list[str]) -> bool:
    data = json.loads(overlay_path.read_text(encoding="utf-8"))
    current = [w.lower() for w in data.get("extra_keywords") or []]
    add = [w for w in words if w.lower() not in current]
    if not add:
        return False
    label = lambda k: k.upper() if len(k) <= 4 else k.title()  # noqa: E731
    data["extra_keywords"] = (data.get("extra_keywords") or []) + [label(k) for k in add]
    overlay_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True


def rebuild(overlay_path: Path) -> Path | None:
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "build_resume.py"), str(overlay_path)],
        capture_output=True, text=True, timeout=300,
    )
    lines = [l for l in (proc.stdout or "").splitlines() if l.strip()]
    if not lines:
        return None
    path = ROOT / lines[-1].strip()
    return path if path.exists() else None


def check_one(position: dict, fix: bool, master: dict, master_low: str, phrases: list[str]) -> dict:
    jd = position.get("jd_text") or position.get("jd_summary") or ""
    keywords = extract_keywords(jd, phrases)
    docx = resume_docx_path(position)
    if docx is None or not docx.exists():
        return {"id": position.get("id"), "ok": False, "reason": "no-resume", "keywords": keywords}
    tailored = g.docx_text(docx)
    missing = missing_from(keywords, tailored)
    fixable = [k for k in missing if _has(k, master_low)]
    unfixable = [k for k in missing if k not in fixable]
    result = {
        "id": position.get("id"),
        "ok": not missing,
        "missing": missing,
        "fixable": fixable,
        "unfixable": unfixable,
        "fixed": False,
        "at": now_iso(),
    }
    if fix and fixable:
        overlay = find_overlay(position)
        if overlay is None:
            result["reason"] = "no tailoring file found in tailor/ for this position"
        else:
            add_keywords(overlay, fixable)
            rebuilt = rebuild(overlay)
            if rebuilt:
                tailored2 = g.docx_text(rebuilt.with_suffix(".docx"))
                still = missing_from(fixable, tailored2)
                result["fixed"] = not still
                result["missing"] = missing_from(keywords, tailored2)
                result["ok"] = not result["missing"] or set(result["missing"]) <= set(unfixable)
                result["still_missing_fixable"] = still
                if rebuilt.suffix == ".pdf":
                    position["resume_path"] = str(rebuilt.relative_to(ROOT))
    position["resume_check"] = {
        "at": result["at"],
        "ok": bool(result["ok"]),
        "missing": result.get("missing") or [],
        "fixed": bool(result.get("fixed")),
        "unfixable": unfixable,
        "note": (
            "Resume matches the posting"
            if result["ok"]
            else (
                "Added posting words that were already on your master resume"
                if result.get("fixed")
                else "Posting words you do not have were left off"
            )
        ),
    }
    return result


def targets(data: dict, only_id: str | None) -> list[dict]:
    out = []
    for p in data["positions"]:
        if only_id and p.get("id") != only_id:
            continue
        if not p.get("resume_path"):
            continue
        if p.get("status") in {"rejected"}:
            continue
        overall = (p.get("scores") or {}).get("overall") or 0
        if only_id or overall >= 4 or p.get("status") in {
            "interested", "applied", "screen", "interview", "offer", "ongoing",
        }:
            out.append(p)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--id")
    parser.add_argument("--fix", action="store_true")
    args = parser.parse_args()

    master = g.load_data()
    master_low = g.master_text(master).lower()
    phrases = phrase_list(master)
    with file_lock():
        data = load_positions()
        rows = [check_one(p, args.fix, master, master_low, phrases) for p in targets(data, args.id)]
        if args.id and not rows:
            print(f"No position {args.id!r} with a resume was found.", file=sys.stderr)
        save_positions(data)
    json.dump({"checked": len(rows), "results": rows}, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
