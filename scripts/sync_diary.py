#!/usr/bin/env python3
"""Diary helper for pipeline cards, plus optional Wispr Flow meeting notes.

`--add` and `--note` always work (the inbox routine uses `--add`). The plain
run seeds diary events from each card's status history, and pulls Wispr Flow
meeting notes only when profile/candidate.json -> integrations.wispr_flow is
true. Otherwise the Wispr step is skipped quietly.

Never attaches therapy, medical, or household meetings. A meeting only lands
on a card when the company name (or the position id slug) is clearly in the
title, participants, or summary.

    .venv/bin/python scripts/sync_diary.py
    .venv/bin/python scripts/sync_diary.py --dry-run
    .venv/bin/python scripts/sync_diary.py --add ID --type email --title "..." --detail "..." --at ISO --external gmail:msgid
    .venv/bin/python scripts/sync_diary.py --note ID "freeform note"
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from jobsearch_lib import (
    CONVERSATION_STATUSES,
    append_event,
    company_key,
    event_id,
    file_lock,
    load_positions,
    match_tokens,
    migrate_ongoing,
    now_iso,
    save_positions,
    seed_events_from_history,
    slug_from_id,
)

WISPR_DB = (
    Path.home() / "Library/Application Support/Wispr Flow/flow.sqlite"
)

# Personal calendar noise. These never belong on a job card, and they must
# never be written into the positions file.
SKIP_TITLE = re.compile(
    r"\b("
    r"therapy|therapist|counsell?ing|grief|doctor|dentist|medical|clinic|"
    r"vet appointment|physio|personal|family|birthday"
    r")\b",
    re.I,
)

LIVE_STATUSES = frozenset(
    {"interested", "applied", "screen", "interview", "offer", "ongoing", "no_answer"}
) | CONVERSATION_STATUSES


def _parse_dt(value) -> str:
    if value is None:
        return now_iso()
    text = str(value).strip()
    if not text:
        return now_iso()
    if text.isdigit():
        # Wispr stores some stamps as epoch milliseconds.
        n = int(text)
        if n > 10_000_000_000:
            n = n / 1000
        return datetime.fromtimestamp(n, tz=timezone.utc).astimezone().isoformat(
            timespec="seconds"
        )
    text = text.replace(" ", "T", 1)
    return text


def _clip(text: str | None, limit: int = 1800) -> str | None:
    if not text:
        return None
    cleaned = re.sub(r"<@speaker:\d+>", "", text)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return None
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1].rstrip() + "…"


def _compact(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def _hay(meeting: dict) -> str:
    # Title and participants only. The summary names tools and past employers
    # from the candidate's own stories, which must not count as the employer.
    parts = [
        meeting.get("title") or "",
        meeting.get("participantNames") or "",
    ]
    return " ".join(parts).lower()


def _skip_meeting(title: str) -> bool:
    return bool(SKIP_TITLE.search(title or ""))


def wispr_enabled() -> bool:
    try:
        from profile_lib import load_candidate
        return bool((load_candidate().get("integrations") or {}).get("wispr_flow"))
    except Exception:
        return False


def load_meetings() -> list[dict]:
    if not WISPR_DB.exists():
        return []
    con = sqlite3.connect(f"file:{WISPR_DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """
        SELECT id, title, createdAt, notes, summary, participantNames, importSource
        FROM Meetings
        WHERE coalesce(isDeleted, 0) = 0
        ORDER BY createdAt DESC
        """
    ).fetchall()
    con.close()
    out = []
    for row in rows:
        out.append({k: row[k] for k in row.keys()})
    return out


def score_match(meeting: dict, position: dict) -> int:
    title = meeting.get("title") or ""
    if _skip_meeting(title):
        return 0
    hay = _hay(meeting)
    compact_hay = _compact(hay)
    company = position.get("company") or ""
    tokens = match_tokens(company)
    slug = slug_from_id(position.get("id") or "")
    score = 0
    if company and company.lower() in hay:
        score += 10
    compact_co = _compact(company_key(company)) or _compact(company)
    if compact_co and len(compact_co) >= 6 and compact_co in compact_hay:
        score += 10
    if slug and len(slug) >= 5:
        slug_sp = slug.replace("-", " ")
        if slug_sp in hay.replace("-", " ") or _compact(slug) in compact_hay:
            score += 8
    distinctive = [t for t in tokens if len(t) >= 5]
    hits = sum(1 for t in distinctive if t in hay)
    if distinctive and hits == len(distinctive):
        score += 6
    elif hits:
        score += hits * 2
    return score


def best_position(meeting: dict, positions: list[dict]) -> dict | None:
    ranked = []
    for p in positions:
        s = score_match(meeting, p)
        if s >= 8:
            ranked.append((s, 0 if p.get("status") in LIVE_STATUSES else 1, p))
    if not ranked:
        return None
    ranked.sort(key=lambda row: (-row[0], row[1]))
    top = ranked[0]
    # Two live cards at the same company with the same score: leave it.
    ties = [r for r in ranked if r[0] == top[0] and r[1] == top[1]]
    if len(ties) > 1:
        companies = {t[2].get("company") for t in ties}
        if len(companies) > 1:
            return None
        # Same company, pick the live one already chosen by the sort.
    return top[2]


def meeting_event(meeting: dict) -> dict:
    summary = meeting.get("summary") or ""
    notes = meeting.get("notes") or ""
    detail = _clip(summary if len(summary) > 80 else (notes or summary))
    mid = meeting.get("id")
    return {
        "id": f"wispr:{mid}",
        "type": "whisper",
        "at": _parse_dt(meeting.get("createdAt")),
        "source": "wispr",
        "title": meeting.get("title") or "Meeting notes",
        "detail": detail,
        "external_id": f"wispr:{mid}",
    }


def add_manual(data: dict, args: argparse.Namespace) -> int:
    position = next((p for p in data["positions"] if p["id"] == args.add), None)
    if position is None:
        raise SystemExit(f"No position with id {args.add!r} was found.")
    ok = append_event(
        position,
        {
            "id": event_id(args.source or args.type, args.external),
            "type": args.type,
            "at": args.at or now_iso(),
            "source": args.source or args.type,
            "title": args.title or args.type,
            "detail": args.detail,
            "external_id": args.external,
        },
    )
    return 1 if ok else 0


def add_note(data: dict, position_id: str, text: str) -> int:
    position = next((p for p in data["positions"] if p["id"] == position_id), None)
    if position is None:
        raise SystemExit(f"No position with id {position_id!r} was found.")
    text = (text or "").strip()
    if not text:
        raise SystemExit("note is empty")
    ok = append_event(
        position,
        {
            "type": "note",
            "source": "manual",
            "title": "Note",
            "detail": _clip(text, 4000),
            "at": now_iso(),
        },
    )
    return 1 if ok else 0


def sync(data: dict, dry_run: bool) -> dict:
    stats = {"history": 0, "migrated": 0, "wispr": 0, "skipped_personal": 0, "unmatched": 0}
    for p in data["positions"]:
        if migrate_ongoing(p):
            stats["migrated"] += 1
        stats["history"] += seed_events_from_history(p)

    if not wispr_enabled():
        stats["wispr_note"] = "Wispr Flow is not switched on in profile/candidate.json, skipped"
        return stats
    meetings = load_meetings()
    if not meetings:
        return stats

    for meeting in meetings:
        title = meeting.get("title") or ""
        if _skip_meeting(title):
            stats["skipped_personal"] += 1
            continue
        pos = best_position(meeting, data["positions"])
        if pos is None:
            stats["unmatched"] += 1
            continue
        if append_event(pos, meeting_event(meeting)):
            stats["wispr"] += 1
            if dry_run:
                print(f"  would attach {title!r} -> {pos.get('company')} ({pos.get('id')})")
    return stats


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--add")
    parser.add_argument("--type", default="email")
    parser.add_argument("--title")
    parser.add_argument("--detail")
    parser.add_argument("--at")
    parser.add_argument("--external")
    parser.add_argument("--source")
    parser.add_argument("--note", nargs=2, metavar=("ID", "TEXT"))
    args = parser.parse_args()

    with file_lock():
        data = load_positions()
        changed = 0
        if args.add:
            changed += add_manual(data, args)
            stats = {"manual": changed}
        elif args.note:
            changed += add_note(data, args.note[0], args.note[1])
            stats = {"note": changed}
        else:
            stats = sync(data, args.dry_run)
            changed = sum(int(stats.get(k, 0)) for k in ("history", "migrated", "wispr"))
        if changed and not args.dry_run:
            save_positions(data)
        print(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
