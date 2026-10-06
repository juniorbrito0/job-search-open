#!/usr/bin/env python3
"""Draft hiring-manager outreach for score 4 and 5 applications.

After a 4 or 5 is marked applied, this finds named people in the posting
(hiring manager, recruiter, founder), writes a one-line message, and leaves
it on the position for the candidate to review and send from the dashboard.

    .venv/bin/python scripts/stakeholder_outreach.py --id <position-id>
    .venv/bin/python scripts/stakeholder_outreach.py --backfill
    .venv/bin/python scripts/stakeholder_outreach.py --pending-send-count

The apply job sends only when status is send_requested. It never messages
on its own.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from jobsearch_lib import (  # noqa: E402
    EVENT_TYPES,
    append_event,
    file_lock,
    load_positions,
    now_iso,
    save_positions,
)

from profile_lib import first_name, load_candidate  # noqa: E402

PROFILE = ROOT / "dashboard/data/application-profile.json"

PERSON = r"[A-Z][A-Za-z'\-]+(?:\s+(?:[A-Z]\.|[A-Z][A-Za-z'\-]+)){1,2}"
PERSON_LOOSE = r"[A-Z][A-Za-z'\-]+(?:\s+(?:[A-Z]\.|[A-Z][A-Za-z'\-]+)){0,2}"
NAME = re.compile(rf"\b({PERSON})\b")
REPORTS_TO = re.compile(
    r"(?:reports to|reporting to|you will report to|you'll report to)"
    rf"[:\s]+({PERSON_LOOSE})",
    re.I,
)
HIRE_MGR = re.compile(
    r"(?:hiring manager|the hiring manager is|posted by|recruiter)"
    rf"[:\s]+({PERSON_LOOSE})",
    re.I,
)
ROLE_HINT = re.compile(
    r"\b(head of (?:people|talent|hr|human resources)|chief people|"
    r"talent (?:partner|acquisition|lead)|recruiter|"
    r"founding? (?:ceo|coo|cto)|founder)\b",
    re.I,
)
JUNK_NAMES = {
    "Linked In",
    "North America",
    "United States",
    "Remote Canada",
    "Job Description",
    "Equal Opportunity",
    "Chief Of",
    "Head Of",
}
FOUNDER = re.compile(
    r"(?:co-?founders?|founders?|ceo|chief executive(?: officer)?)"
    rf"[:\s,]+({PERSON_LOOSE})",
    re.I,
)
TALENT = re.compile(
    r"(?:talent (?:partner|acquisition|lead)|recruiter|people partner)"
    rf"[:\s,]+({PERSON_LOOSE})",
    re.I,
)
BOLD_PERSON = re.compile(
    rf"\*\*({PERSON})\*\*"
    r"(?:\s*[\(,–-]\s*([^)\n*]{2,60}))?"
)
BOLD_COMMA = re.compile(
    rf"\*\*({PERSON}),\s*([^*]{2,80})\*\*"
)
TITLE_THEN_NAME = re.compile(
    r"\b(GM|CEO|CTO|COO|Founder|Recruiter)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)"
)
LABELED_PERSON = re.compile(
    r"(?:likely hiring manager|hiring manager|recruiter contact|recruiter|"
    r"founder\s*/\s*ceo|co-?founders?|founders?|ceo)"
    rf"[:*\s]+({PERSON})",
    re.I,
)
COMPANIES = ROOT / "dashboard/data/companies.json"


def calendar_url() -> str:
    """Booking link from profile/candidate.json -> calendar_url (empty if none)."""
    url = (load_candidate().get("calendar_url") or "").strip()
    if url:
        return url
    try:
        data = json.loads(PROFILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    return ((data.get("identity") or {}).get("calendar_url") or "").strip()


def overall(position: dict) -> int:
    try:
        return int((position.get("scores") or {}).get("overall") or 0)
    except (TypeError, ValueError):
        return 0


def eligible(position: dict) -> bool:
    if overall(position) < 4:
        return False
    if position.get("status") in {
        "review",
        "rejected",
        "disqualified",
        "no_answer",
        "interested",
    }:
        return False
    if not position.get("applied_at") and position.get("status") not in {
        "applied",
        "screen",
        "interview",
        "offer",
        "ongoing",
    }:
        return False
    return True


TITLE_AS_NAME = re.compile(
    r"\b(hiring manager|recruiter|video call|job description|equal opportunity|"
    r"head of|chief of|talent partner)\b",
    re.I,
)


def _clean_name(raw: str) -> str | None:
    name = re.sub(r"\s+", " ", (raw or "").strip(" .,;:"))
    name = re.sub(r"\b(the|our|their)\b", "", name, flags=re.I).strip()
    if len(name.split()) < 2:
        return None
    if name in JUNK_NAMES or TITLE_AS_NAME.search(name):
        return None
    if re.search(r"\b(studio|inc|llc|ltd|agency|http|www)\b", name, re.I):
        return None
    if not NAME.fullmatch(name):
        return None
    return name


def _linkedin_search(name: str, company: str) -> str:
    q = f"{name} {company}".strip()
    return "https://www.linkedin.com/search/results/people/?keywords=" + (
        __import__("urllib.parse").parse.quote(q)
    )


def _company_memory_blob(company: str) -> str:
    try:
        data = json.loads(COMPANIES.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    key = re.sub(r"[^a-z0-9]+", " ", (company or "").lower()).strip()
    for row in data.get("companies") or []:
        row_key = (row.get("key") or "").strip()
        name = (row.get("name") or "").strip()
        if row_key == key or name.lower() == (company or "").lower():
            return " ".join(
                str(x) for x in (row.get("summary"), row.get("notes"), row.get("funding")) if x
            )
    return ""


def extract_people(position: dict) -> list[dict]:
    event_text = "\n".join(
        f"{e.get('title') or ''} {e.get('detail') or ''}"
        for e in position.get("events") or []
    )
    blob = "\n".join(
        [
            position.get("jd_text") or "",
            position.get("jd_summary") or "",
            position.get("research_md") or "",
            event_text,
            _company_memory_blob(position.get("company") or ""),
        ]
    )
    company = position.get("company") or ""
    found: list[dict] = []
    seen: set[str] = set()

    def add(name: str | None, title: str, role: str, why: str | None = None) -> None:
        cleaned = _clean_name(name or "")
        if not cleaned:
            return
        key = cleaned.lower()
        if key in seen:
            return
        seen.add(key)
        found.append(
            {
                "name": cleaned,
                "title": title,
                "role": role,
                "linkedin_url": _linkedin_search(cleaned, company),
                "email": None,
                "summary": why
                or f"{cleaned} is named around the {company} posting as {title}.",
                "channel": "linkedin",
            }
        )

    for match in REPORTS_TO.finditer(blob):
        add(match.group(1), "Hiring manager (reports-to)", "hiring_manager")
    for match in HIRE_MGR.finditer(blob):
        label = match.group(0).split(":")[0].strip().lower()
        role = "talent" if "recruit" in label else "hiring_manager"
        title = "Recruiter" if role == "talent" else "Hiring manager"
        add(match.group(1), title, role)
    for match in TALENT.finditer(blob):
        add(match.group(1), "Talent / recruiter", "talent")
    for match in FOUNDER.finditer(blob):
        add(match.group(1), "Founder / CEO", "founder")
    for match in BOLD_PERSON.finditer(blob):
        extra = (match.group(2) or "").lower()
        if not extra:
            continue
        if any(w in extra for w in ("recruit", "talent", "people", "hr", "founder", "ceo", "hiring")):
            role = "talent" if any(w in extra for w in ("recruit", "talent", "people", "hr")) else (
                "founder" if "founder" in extra or "ceo" in extra else "hiring_manager"
            )
            add(match.group(1), match.group(2).strip(" .,"), role)
    for match in BOLD_COMMA.finditer(blob):
        extra = (match.group(2) or "").lower()
        if any(w in extra for w in ("recruit", "talent", "people", "hr", "founder", "ceo", "hiring")):
            role = "talent" if any(w in extra for w in ("recruit", "talent", "people", "hr")) else (
                "founder" if "founder" in extra or "ceo" in extra else "hiring_manager"
            )
            add(match.group(1), match.group(2).strip(" .,"), role)
    for match in TITLE_THEN_NAME.finditer(blob):
        title = match.group(1)
        role = {
            "Recruiter": "talent",
            "Founder": "founder",
            "CEO": "founder",
            "CTO": "founder",
            "COO": "hiring_manager",
            "GM": "hiring_manager",
        }.get(title, "hiring_manager")
        add(match.group(2), title, role)
    for match in LABELED_PERSON.finditer(blob):
        label = match.group(0).split(":")[0].lower()
        if "recruit" in label or "talent" in label:
            add(match.group(1), "Recruiter", "talent")
        elif "hiring" in label:
            add(match.group(1), "Hiring manager", "hiring_manager")
        else:
            add(match.group(1), "Founder / CEO", "founder")

    slug = (position.get("id") or "").split("--", 1)[0]
    for name, title, role, why in KNOWN_PEOPLE.get(slug, []):
        add(name, title, role, why)

    return found[:4]


# People already known for a company, keyed by the company slug at the start
# of the position id: {"acme": [("Name", "Title", "founder", "one-line why")]}.
KNOWN_PEOPLE: dict[str, list[tuple[str, str, str, str]]] = {}


def draft_message(position: dict, person: dict | None = None) -> str:
    company = position.get("company") or "the team"
    title = position.get("title") or "this role"
    first = ""
    if person and person.get("name"):
        first = person["name"].split()[0]
    greeting = f"Hi {first}," if first else "Hi,"
    cand = load_candidate()
    pitch = (cand.get("outreach_pitch") or "").strip()
    link = calendar_url()
    me = first_name(cand)
    parts = [f"{greeting} I just applied for the {title} role at {company} and wanted to say hello directly."]
    if pitch:
        parts.append(pitch if pitch.endswith((".", "!", "?")) else pitch + ".")
    if link:
        parts.append(f"If a short call would help, you can pick a time here: {link}")
    else:
        parts.append("I would be glad to have a short call if it helps.")
    parts.append(f"Thank you, {me}" if me else "Thank you")
    body = " ".join(parts)
    # Outward-facing text carries no em or en dashes.
    body = body.replace("—", ",").replace("–", "-")
    return " ".join(body.split())


def empty_outreach() -> dict:
    return {
        "status": "none",
        "researched_at": None,
        "people": [],
        "message": "",
        "calendar_url": calendar_url(),
        "send_requested": False,
        "sent_at": None,
        "sent_via": None,
        "sent_to": [],
        "blocked_reason": None,
    }


def prepare_position(position: dict, overwrite: bool = False) -> dict:
    """Write or refresh stakeholder_outreach. Safe to call twice."""
    current = position.get("stakeholder_outreach")
    if (
        isinstance(current, dict)
        and current.get("status") in {"ready", "send_requested", "sent"}
        and not overwrite
    ):
        return current
    if current and current.get("status") == "sent" and not overwrite:
        return current

    people = extract_people(position)
    message = draft_message(position, people[0] if people else None)
    outreach = {
        "status": "ready",
        "researched_at": now_iso(),
        "people": people,
        "message": message,
        "calendar_url": calendar_url(),
        "send_requested": False,
        "sent_at": None,
        "sent_via": None,
        "sent_to": [],
        "blocked_reason": None
        if people
        else "No named hiring manager or recruiter on the posting. Message is ready. Add a person or search LinkedIn from the links.",
    }
    position["stakeholder_outreach"] = outreach
    return outreach


def request_send(position: dict, message: str | None = None) -> dict:
    outreach = position.get("stakeholder_outreach") or prepare_position(position)
    if outreach.get("status") == "sent":
        return outreach
    if message:
        outreach["message"] = " ".join(message.split())
    outreach["status"] = "send_requested"
    outreach["send_requested"] = True
    outreach["message"] = " ".join((outreach.get("message") or draft_message(position)).split())
    position["stakeholder_outreach"] = outreach
    append_event(
        position,
        {
            "id": f"outreach:requested:{now_iso()}",
            "type": "outreach",
            "at": now_iso(),
            "source": "dashboard",
            "title": "Stakeholder message queued",
            "detail": outreach["message"][:400],
            "external_id": f"outreach:requested:{position.get('id')}",
        },
    )
    return outreach


def mark_sent(position: dict, via: str, to: list[str]) -> dict:
    outreach = position.setdefault("stakeholder_outreach", empty_outreach())
    outreach["status"] = "sent"
    outreach["send_requested"] = False
    outreach["sent_at"] = now_iso()
    outreach["sent_via"] = via
    outreach["sent_to"] = to
    outreach["blocked_reason"] = None
    position["stakeholder_outreach"] = outreach
    append_event(
        position,
        {
            "id": f"outreach:sent:{now_iso()}",
            "type": "outreach",
            "at": now_iso(),
            "source": via,
            "title": f"Stakeholder message sent via {via}",
            "detail": ", ".join(to) if to else outreach.get("message", "")[:400],
            "external_id": f"outreach:sent:{position.get('id')}",
        },
    )
    return outreach


def mark_blocked(position: dict, reason: str) -> dict:
    outreach = position.setdefault("stakeholder_outreach", empty_outreach())
    outreach["status"] = "blocked"
    outreach["send_requested"] = False
    outreach["blocked_reason"] = reason
    position["stakeholder_outreach"] = outreach
    return outreach


def pending_sends(positions: list[dict]) -> list[dict]:
    out = []
    for position in positions:
        outreach = position.get("stakeholder_outreach") or {}
        if outreach.get("status") == "send_requested" or outreach.get("send_requested"):
            out.append(position)
    return out


def backfill(overwrite: bool = False) -> int:
    with file_lock():
        data = load_positions()
        n = 0
        for position in data.get("positions") or []:
            if not eligible(position):
                continue
            before = json.dumps(position.get("stakeholder_outreach") or {}, sort_keys=True)
            prepare_position(position, overwrite=overwrite)
            after = json.dumps(position.get("stakeholder_outreach") or {}, sort_keys=True)
            if after != before:
                n += 1
        if n:
            save_positions(data)
    return n


def prepare_one(position_id: str, overwrite: bool = False) -> int:
    with file_lock():
        data = load_positions()
        position = next(
            (p for p in data.get("positions") or [] if p.get("id") == position_id),
            None,
        )
        if position is None:
            print(f"No position with id {position_id!r} was found.", file=sys.stderr)
            return 2
        if not eligible(position) and not overwrite:
            print("Not an applied role with Dream fit 4 or 5, so no message was drafted.")
            return 1
        prepare_position(position, overwrite=True)
        save_positions(data)
        people = position["stakeholder_outreach"].get("people") or []
        print(f"{position['company']}: {len(people)} people, status ready")
    return 0


def _self_test() -> int:
    pos = {
        "title": "Head of Operations",
        "company": "Acme",
        "jd_text": "This role reports to Maya Chen, CEO. Recruiter: Sam Patel.",
        "scores": {"overall": 4},
        "status": "applied",
        "applied_at": "2026-09-01",
    }
    people = extract_people(pos)
    names = {p["name"] for p in people}
    assert "Maya Chen" in names, names
    assert "Sam Patel" in names, names
    msg = draft_message(pos, people[0])
    assert "\n" not in msg
    assert "—" not in msg and "–" not in msg
    assert msg.startswith("Hi Maya,"), msg
    assert "I wanted to reach out" not in msg
    assert eligible(pos)
    prepare_position(pos)
    assert pos["stakeholder_outreach"]["status"] == "ready"
    request_send(pos)
    assert pos["stakeholder_outreach"]["status"] == "send_requested"
    print("self-test: ok")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--id", help="prepare one position")
    parser.add_argument("--backfill", action="store_true",
                        help="prepare every applied score 4 and 5")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--pending-send-count", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return _self_test()
    if args.pending_send_count:
        data = load_positions()
        print(len(pending_sends(data.get("positions") or [])))
        return 0
    if args.id:
        return prepare_one(args.id, overwrite=args.overwrite)
    if args.backfill:
        n = backfill(overwrite=args.overwrite)
        print(f"prepared {n}")
        return 0
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
