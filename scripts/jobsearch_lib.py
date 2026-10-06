#!/usr/bin/env python3
"""Shared pipeline helpers: statuses, diary events, file lock."""

from __future__ import annotations

import fcntl
import json
import os
import re
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

# Normally the checkout this file sits in. JOBSEARCH_ROOT lets a tool be run from
# somewhere else against a checkout.
ROOT = Path(os.environ.get("JOBSEARCH_ROOT") or Path(__file__).resolve().parent.parent)
DATA = ROOT / "dashboard" / "data"
POSITIONS_FILE = DATA / "positions.json"
PROFILE_FILE = DATA / "scoring-profile.json"
COMPANIES_FILE = DATA / "companies.json"
LOCK_FILE = DATA / ".lock"

CONVERSATION_STATUSES = frozenset({"screen", "interview", "offer", "ongoing"})
APPLIED_FUNNEL = frozenset(
    {"applied", "screen", "interview", "offer", "ongoing", "no_answer"}
)
CLOSED_FOR_APPLY = frozenset(
    {
        "applied",
        "screen",
        "interview",
        "offer",
        "ongoing",
        "disqualified",
        "rejected",
        "no_answer",
    }
)
VALID_STATUSES = frozenset(
    {
        "review",
        "rejected",
        "interested",
        "applied",
        "screen",
        "interview",
        "offer",
        "ongoing",
        "disqualified",
        "no_answer",
    }
)

EVENT_TYPES = frozenset(
    {
        "applied",
        "email",
        "screen",
        "interview",
        "offer",
        "rejection",
        "note",
        "whisper",
        "status",
        "outreach",
    }
)

# First-time split of the old "ongoing" blob. Screen = first human or test.
# Interview = a real conversation already happened. Offer = they made one.
ONGOING_MIGRATION: dict[str, str] = {}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def company_key(name: str) -> str:
    text = re.sub(r"\([^)]*\)", " ", name or "")
    text = re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
    return re.sub(r"\s+", " ", text)


def slug_from_id(position_id: str) -> str:
    return (position_id or "").split("--", 1)[0]


@contextmanager
def file_lock():
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK_FILE, "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        if default is None:
            raise
        return default


def write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    tmp.replace(path)


def load_positions() -> dict:
    data = read_json(POSITIONS_FILE, default={"version": 1, "positions": []})
    data.setdefault("positions", [])
    return data


def save_positions(data: dict) -> None:
    data["updated_at"] = now_iso()
    write_json(POSITIONS_FILE, data)


def event_id(source: str, external_id: str | None = None) -> str:
    if external_id:
        return f"{source}:{external_id}"
    return f"{source}:{uuid.uuid4().hex[:12]}"


def append_event(position: dict, event: dict) -> bool:
    """Add a diary event if it is new. Returns True when something was added."""
    events = position.setdefault("events", [])
    new_id = event.get("id") or event_id(event.get("source") or "manual")
    event["id"] = new_id
    if event.get("type") not in EVENT_TYPES:
        event["type"] = "note"
    if not event.get("at"):
        event["at"] = now_iso()
    if not event.get("title"):
        event["title"] = event["type"]
    for existing in events:
        if existing.get("id") == new_id:
            return False
        ext = event.get("external_id")
        if ext and existing.get("external_id") == ext:
            return False
    events.append(
        {
            "id": new_id,
            "type": event["type"],
            "at": event["at"],
            "source": event.get("source") or "manual",
            "title": event["title"],
            "detail": event.get("detail"),
            "external_id": event.get("external_id"),
        }
    )
    events.sort(key=lambda e: e.get("at") or "")
    return True


def seed_events_from_history(position: dict) -> int:
    added = 0
    for step in position.get("status_history") or []:
        status = step.get("status")
        at = step.get("at")
        if not status or not at:
            continue
        note = step.get("note")
        etype = {
            "applied": "applied",
            "screen": "screen",
            "interview": "interview",
            "offer": "offer",
            "ongoing": "status",
            "disqualified": "rejection",
            "rejected": "status",
            "no_answer": "status",
            "interested": "status",
            "review": "status",
        }.get(status, "status")
        title = {
            "applied": "Applied",
            "screen": "Moved to screen",
            "interview": "Moved to interview",
            "offer": "Offer",
            "ongoing": "Process started",
            "disqualified": "Closed",
            "rejected": "You passed",
            "no_answer": "No answer",
            "interested": "Moved to pipeline",
            "review": "Found",
        }.get(status, status.replace("_", " "))
        if append_event(
            position,
            {
                "id": f"status:{status}:{at}",
                "type": etype,
                "at": at if "T" in str(at) else f"{at}T12:00:00",
                "source": "status",
                "title": title,
                "detail": note,
                "external_id": f"status:{status}:{at}",
            },
        ):
            added += 1
    if position.get("applied_at"):
        at = position["applied_at"]
        if append_event(
            position,
            {
                "id": f"status:applied:{at}",
                "type": "applied",
                "at": at if "T" in str(at) else f"{at}T12:00:00",
                "source": "status",
                "title": "Applied",
                "detail": position.get("apply_result"),
                "external_id": f"status:applied:{at}",
            },
        ):
            added += 1
    return added


def migrate_ongoing(position: dict) -> bool:
    if position.get("status") != "ongoing":
        return False
    new_status = ONGOING_MIGRATION.get(position.get("id"), "interview")
    position["status"] = new_status
    position.setdefault("status_history", []).append(
        {
            "status": new_status,
            "at": now_iso(),
            "note": "Split the old Ongoing column into Screen / Interview / Offer",
        }
    )
    return True


def is_conversation(status: str) -> bool:
    return status in CONVERSATION_STATUSES


def next_conversation_status(current: str, signal: str) -> str:
    """signal: screen | interview | offer | rejection"""
    if signal == "offer":
        return "offer"
    if signal == "interview":
        if current == "offer":
            return "offer"
        return "interview"
    if signal == "screen":
        if current in {"interview", "offer"}:
            return current
        return "screen"
    return current


def match_tokens(name: str) -> set[str]:
    key = company_key(name)
    parts = [p for p in key.split() if len(p) >= 4]
    if not parts and key:
        parts = [key]
    return set(parts)


# ---------------------------------------------------------------------------
# Duplicate detection
# ---------------------------------------------------------------------------
# Rejected roles kept coming back. Nothing ever overwrote the rejected status:
# the scan wrote a second row next to it, because the only two duplicate checks
# it had were structurally unable to find the first one.
#
#   1. The generated id carries the scan date, so an August id can never equal a
#      September id. It could only ever catch a collision inside one run, and it
#      did not even do that, because the skip-set was built once before the
#      append loop and newly written rows were never added back to it. That is
#      how three rows with a byte-identical id ended up in the file, one rejected
#      and two still in Review.
#   2. The URL check compared exact text. LinkedIn serves the same job as
#      linkedin.com/jobs/view/4457523305 and as
#      ca.linkedin.com/jobs/view/director-of-revenue-operations-at-riva-...-4457523305,
#      and employers repost with a brand-new number.
#
# Both live here now, as one index the scan is required to use, so this cannot be
# re-improvised differently every morning. Match on any of three keys: the job
# board's own numeric id, the URL reduced to its identity, or company plus title
# reduced to their identity.

# LinkedIn numbers a job once and then serves it under several addresses. The
# number is the only thing that survives all of them.
_LINKEDIN_ID_RE = re.compile(r"/jobs/view/(?:[^/?#]*?-)?(\d{6,})")
_CURRENT_JOB_RE = re.compile(r"[?&]currentjobid=(\d{6,})")
_TRACKING_SUBDOMAIN_RE = re.compile(r"^(?:www|[a-z]{2})\.")

# Words that carry no identity. "Director of Revenue Operations" and "Director
# Revenue Operations" are the same job posted by two people.
_TITLE_NOISE = frozenset({"of", "the", "a", "an", "and", "for", "to"})
_TITLE_SYNONYMS = {"sr": "senior", "jr": "junior", "mgr": "manager", "ops": "operations"}


def job_board_id(url: str) -> str | None:
    """The job board's own number for this posting, when the URL carries one."""
    text = (url or "").lower()
    match = _LINKEDIN_ID_RE.search(text) or _CURRENT_JOB_RE.search(text)
    return match.group(1) if match else None


def url_key(url: str) -> str:
    """A URL reduced to what identifies the posting.

    Scheme, www or country subdomain, query string, fragment and trailing slash
    all vary between the guest scrape and the logged-in browser for one job.
    """
    text = (url or "").strip().lower()
    if not text:
        return ""
    text = re.sub(r"^[a-z][a-z0-9+.-]*://", "", text)
    text = text.split("#", 1)[0].split("?", 1)[0]
    host, _, path = text.partition("/")
    host = _TRACKING_SUBDOMAIN_RE.sub("", host)
    return (host + "/" + path).rstrip("/")


def title_key(title: str) -> str:
    """A title reduced to what identifies the role."""
    text = re.sub(r"\([^)]*\)", " ", title or "").lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    words = [_TITLE_SYNONYMS.get(w, w) for w in text.split() if w not in _TITLE_NOISE]
    return " ".join(words)


def match_keys(company: str, title: str, url: str) -> set[str]:
    """Every key under which this posting should be recognised again."""
    keys = set()
    board = job_board_id(url)
    if board:
        keys.add("job:" + board)
    normalized = url_key(url)
    if normalized:
        keys.add("url:" + normalized)
    company_part = company_key(company)
    title_part = title_key(title)
    if company_part and title_part:
        keys.add("ct:" + company_part + "|" + title_part)
    return keys


def position_keys(position: dict) -> set[str]:
    return match_keys(
        position.get("company") or "",
        position.get("title") or "",
        position.get("url") or "",
    )


class DuplicateIndex:
    """Everything already seen, under every key it could come back as.

    Add each row you write back into it inside the loop. The bug this replaces
    built its skip-set once and then appended three copies of the same posting.
    """

    def __init__(self) -> None:
        self._seen: dict[str, str] = {}

    def __len__(self) -> int:
        return len(self._seen)

    def add(self, company: str, title: str, url: str, owner: str = "") -> None:
        for key in match_keys(company, title, url):
            self._seen.setdefault(key, owner)

    def add_position(self, position: dict) -> None:
        self.add(
            position.get("company") or "",
            position.get("title") or "",
            position.get("url") or "",
            position.get("id") or "",
        )

    def find(self, company: str, title: str, url: str) -> tuple[str, str] | None:
        """(key that matched, id of the row already holding it), or None."""
        for key in match_keys(company, title, url):
            if key in self._seen:
                return key, self._seen[key]
        return None

    def find_position(self, position: dict) -> tuple[str, str] | None:
        return self.find(
            position.get("company") or "",
            position.get("title") or "",
            position.get("url") or "",
        )


def _rows_from_ignored(path: Path) -> Iterable[dict]:
    data = read_json(path, default={})
    rows = data.get("ignored") if isinstance(data, dict) else data
    return rows if isinstance(rows, list) else []


def _rows_from_applications(path: Path) -> Iterable[dict]:
    import csv

    try:
        with open(path, newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                yield {
                    "company": row.get("Company") or "",
                    "title": row.get("Role") or "",
                    "url": row.get("Source URL") or "",
                    "id": "csv:" + (row.get("Company") or ""),
                }
    except (OSError, UnicodeDecodeError):
        return


def load_duplicate_index(positions: list | None = None) -> DuplicateIndex:
    """Every status in positions.json, plus ignored.json and the applications CSV.

    Every status, because a rejected role is exactly the one that must not come
    back. Pass `positions` when you already hold the file open under the lock.
    """
    index = DuplicateIndex()
    if positions is None:
        positions = (load_positions() or {}).get("positions") or []
    for position in positions:
        index.add_position(position)
    for row in _rows_from_ignored(DATA / "ignored.json"):
        if isinstance(row, dict):
            index.add(row.get("company") or "", row.get("title") or "",
                      row.get("url") or "", "ignored")
    for row in _rows_from_applications(ROOT / "job-applications.csv"):
        index.add(row["company"], row["title"], row["url"], row["id"])
    return index


def unique_position_id(base_id: str, taken: set[str]) -> str:
    """Never write a second row under an id that is already in the file.

    The dashboard patches the first row whose id matches and stops, so two rows
    sharing an id means rejecting one leaves the other on the board.
    """
    if base_id not in taken:
        return base_id
    for suffix in range(2, 100):
        candidate = "%s-%d" % (base_id, suffix)
        if candidate not in taken:
            return candidate
    return "%s-%s" % (base_id, uuid.uuid4().hex[:6])
