#!/usr/bin/env python3
"""Put every settings and data file in place for a fresh setup.

    python3 scripts/init_data.py           create whatever is missing
    python3 scripts/init_data.py --check   report what still needs filling in

Copies the blank templates in templates/ to where the system reads them, and
creates empty data files for the dashboard. It never overwrites a file that is
already there, so it is safe to run again at any time.
"""

from __future__ import annotations

import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "dashboard" / "data"
TEMPLATES = ROOT / "templates"

# (template file, live location, what it is in plain words)
COPIES = [
    ("candidate.example.json", ROOT / "profile" / "candidate.json", "your profile (who you are and what you want)"),
    ("resume.example.json", ROOT / "profile" / "resume.json", "your master resume"),
    ("scoring-profile.example.json", DATA / "scoring-profile.json", "your scoring rules"),
    ("application-profile.example.json", DATA / "application-profile.json", "your standard application answers"),
]

# Placeholder text the templates use. Any of these still present means a file
# has not been filled in yet.
PLACEHOLDER_MARKERS = (
    "Full Name", "name@example.com", "Alex Sample", "alex.sample@example.com",
    "FILL ME IN", "FILL:", "linkedin.com/in/...",
)


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def seeds() -> dict[Path, object]:
    sys.path.insert(0, str(ROOT / "scripts"))
    try:
        from apply_progress import STEPS
        steps = [{"id": s, "label": l} for s, l in STEPS]
    except Exception:  # noqa: BLE001
        steps = []
    stamp = now()
    return {
        DATA / "positions.json": {"version": 1, "updated_at": stamp, "positions": []},
        DATA / "startups.json": {"version": 1, "updated_at": stamp, "startups": []},
        DATA / "ignored.json": {"version": 1, "updated_at": stamp, "ignored": []},
        DATA / "companies.json": {"version": 1, "updated_at": stamp, "companies": []},
        DATA / "applied-ledger.json": {
            "note": "Every application actually sent. Stops the same job being applied to twice.",
            "submitted": [],
        },
        DATA / "apply-progress.json": {
            "running": False, "started_at": None, "queued": 0, "batch": 0,
            "completed": 0, "current": None, "done": [], "steps": steps,
        },
    }


WORKLOG_HEADER = """# Work log

A dated note after every search, apply run, inbox update and settings change.
Newest entries at the bottom.
"""


def create() -> int:
    made, kept, missing_templates = [], [], []
    for template, dest, label in COPIES:
        src = TEMPLATES / template
        if dest.exists():
            kept.append(label)
            continue
        if not src.exists():
            missing_templates.append(template)
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        made.append(label)
    for path, content in seeds().items():
        if path.exists():
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        made.append(f"empty {path.name}")
    worklog = ROOT / "docs" / "WORKLOG.md"
    if not worklog.exists():
        worklog.parent.mkdir(parents=True, exist_ok=True)
        worklog.write_text(WORKLOG_HEADER, encoding="utf-8")
        made.append("the work log")
    for folder in ("Applications", "tailor", "logs", "Resume"):
        (ROOT / folder).mkdir(exist_ok=True)

    if made:
        print("Created: " + "; ".join(made) + ".")
    if kept:
        print("Already there, left untouched: " + "; ".join(kept) + ".")
    if missing_templates:
        print("Could not find these templates: " + ", ".join(missing_templates), file=sys.stderr)
        return 1
    if not made:
        print("Everything was already in place. Nothing changed.")
    return 0


def check() -> int:
    todo = []
    for _template, dest, label in COPIES:
        if not dest.exists():
            todo.append(f"{label}: not created yet ({dest.relative_to(ROOT)})")
            continue
        text = dest.read_text(encoding="utf-8")
        try:
            json.loads(text)
        except json.JSONDecodeError as exc:
            todo.append(f"{label}: has a typo on line {exc.lineno} ({dest.relative_to(ROOT)})")
            continue
        hits = [m for m in PLACEHOLDER_MARKERS if m in text]
        if hits:
            todo.append(f"{label}: still has sample text ({dest.relative_to(ROOT)})")
    cand = ROOT / "profile" / "candidate.json"
    if cand.exists():
        try:
            if not json.loads(cand.read_text(encoding="utf-8")).get("onboarded"):
                todo.append("setup interview: not marked finished yet (onboarded is false)")
        except json.JSONDecodeError:
            pass
    for path in seeds():
        if not path.exists():
            todo.append(f"data file missing: {path.relative_to(ROOT)}")
    if todo:
        print("Still to do:")
        for line in todo:
            print("  - " + line)
        return 1
    print("All settings are filled in.")
    return 0


if __name__ == "__main__":
    sys.exit(check() if "--check" in sys.argv else create())
