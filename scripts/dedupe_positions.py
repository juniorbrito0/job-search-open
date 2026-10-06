#!/usr/bin/env python3
"""Find and close duplicate rows in positions.json.

Without this, a role you rejected can come back on the board a day later as a
second row next to the first. Two shapes of it:

  Same id, same day. The scan built its skip-set once, before the append loop,
  and never added its own new rows back in, so one employer posting the same
  title three times in a morning produced three rows with a byte-identical id.
  The dashboard patches the first row it finds and stops, so rejecting the card
  moved one row and left its twins in Review.

  Different id, weeks apart. The id carries the scan date, so an August row can
  never match a September one, and the backup check compared web addresses as
  exact text while LinkedIn serves one job under several addresses.

Both checks now live in jobsearch_lib.DuplicateIndex, which the scan is required
to use. This is the repair for what got in before that, and the audit that says
whether anything new slipped through.

  dedupe_positions.py                  report only, changes nothing
  dedupe_positions.py --merge          merge same-id twins, close stale repeats
  dedupe_positions.py --merge --dry-run   say what --merge would do
  dedupe_positions.py --close <id>     settle one row this left for you to decide

A repeat is only closed when the row it repeats has been decided: applied,
rejected, disqualified, in a conversation, or no answer. Two undecided rows are
reported and left alone, because neither one is a decision worth protecting.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import defaultdict
from pathlib import Path

# Normally the sibling scripts/ folder. JOBSEARCH_ROOT lets this be run from
# outside the checkout against another copy of the data.
sys.path.insert(0, str(Path(__file__).resolve().parent))
if os.environ.get("JOBSEARCH_ROOT"):
    sys.path.insert(0, str(Path(os.environ["JOBSEARCH_ROOT"]) / "scripts"))

from jobsearch_lib import (  # noqa: E402
    append_event,
    file_lock,
    load_positions,
    match_keys,
    now_iso,
    save_positions,
)

# A row in one of these has been decided, by the candidate or by an application that
# actually went out. A later copy of it is a repeat, not news.
DECIDED = frozenset(
    {"applied", "screen", "interview", "offer", "ongoing", "no_answer",
     "rejected", "disqualified"}
)

# An application already went out for these, so a second row reaching the apply
# queue would send a second application to the same employer. Always closed.
APPLIED_FUNNEL = frozenset(
    {"applied", "screen", "interview", "offer", "ongoing", "no_answer"}
)

# Which row survives a same-id merge. Anything decided outranks anything not.
PRECEDENCE = ["offer", "ongoing", "interview", "screen", "applied", "no_answer",
              "rejected", "disqualified", "interested", "review"]


def rank(position: dict) -> tuple[int, int]:
    status = position.get("status") or "review"
    try:
        order = PRECEDENCE.index(status)
    except ValueError:
        order = len(PRECEDENCE)
    touched = len(position.get("status_history") or []) + len(position.get("events") or [])

    return (order, -touched)


def sort_key(position: dict) -> str:
    """Oldest first. The id's date suffix is the only ordering the rows carry."""
    return str(position.get("found_date") or "") + "|" + str(position.get("id") or "")


def same_id_groups(positions: list) -> dict:
    by_id = defaultdict(list)
    for position in positions:
        by_id[position.get("id")].append(position)

    return {k: v for k, v in by_id.items() if len(v) > 1}


def repeat_groups(positions: list) -> list:
    """Rows that are the same posting under different ids, oldest row first."""
    owner: dict[str, str] = {}
    groups: dict[str, list] = defaultdict(list)
    for position in sorted(positions, key=sort_key):
        pid = position.get("id")
        head = None
        keys = match_keys(position.get("company") or "", position.get("title") or "",
                          position.get("url") or "")
        for key in keys:
            if key in owner:
                head = owner[key]
                break
        if head is None:
            for key in keys:
                owner[key] = pid
            groups[pid].append(position)
        else:
            for key in keys:
                owner.setdefault(key, head)
            groups[head].append(position)

    return [rows for rows in groups.values() if len(rows) > 1]


def merge_same_id(rows: list) -> tuple[dict, list]:
    """Keep the row that carries a decision. Fold the rest into it."""
    ordered = sorted(rows, key=rank)
    keeper, dropped = ordered[0], ordered[1:]
    folded = keeper.setdefault("merged_duplicates", [])
    for row in dropped:
        folded.append({
            "url": row.get("url"),
            "status": row.get("status"),
            "found_date": row.get("found_date"),
            "merged_at": now_iso(),
        })
    append_event(keeper, {
        "id": "dedupe:merged:%s" % now_iso(),
        "type": "note",
        "at": now_iso(),
        "source": "dedupe",
        "title": "Merged %d duplicate row%s" % (len(dropped), "" if len(dropped) == 1 else "s"),
        "detail": "The scan wrote %d rows under this same id. Kept the one holding "
                  "the decision (%s)." % (len(rows), keeper.get("status")),
        "external_id": "dedupe:merged:%s" % keeper.get("id"),
    })

    return keeper, dropped


def close_repeat(position: dict, original: dict) -> None:
    """Take a repeat of an already-decided row off the board and off the queue."""
    position["duplicate_of"] = original.get("id")
    position["apply_requested"] = False
    position["auto_apply_queued"] = False
    position["resume_requested"] = False
    detail = "Same posting as %s, which is already %s%s." % (
        original.get("id"),
        original.get("status"),
        " (applied %s)" % original["applied_at"] if original.get("applied_at") else "",
    )
    position["status"] = "disqualified"
    position.setdefault("status_history", []).append({
        "status": "disqualified",
        "at": now_iso(),
        "note": detail,
    })
    append_event(position, {
        "id": "dedupe:repeat:%s" % position.get("id"),
        "type": "note",
        "at": now_iso(),
        "source": "dedupe",
        "title": "Closed as a repeat",
        "detail": detail,
        "external_id": "dedupe:repeat:%s" % position.get("id"),
    })


def triage(repeats: list) -> tuple[list, list]:
    """Split repeats into the ones to close and the ones only the candidate can settle.

    Closed automatically: the earlier row is one an application already went out
    for, so a second row on the queue means a second application to the same
    employer; or the later row is still in Review, meaning nobody has touched it
    and it is pure noise.

    Left alone: the candidate rejected the first one and then marked the repeat
    Interested. That may be a change of mind, and this script does not get to
    overrule it. It says so instead.
    """
    close_now, ask_candidate = [], []
    for rows in repeats:
        original = rows[0]
        if original.get("status") not in DECIDED:
            continue
        later = [r for r in rows[1:]
                 if r.get("status") not in DECIDED and not r.get("duplicate_of")]
        if not later:
            continue
        if original.get("status") in APPLIED_FUNNEL:
            close_now.append((original, later))
            continue
        untouched = [r for r in later if r.get("status") == "review"]
        moved = [r for r in later if r.get("status") != "review"]
        if untouched:
            close_now.append((original, untouched))
        if moved:
            ask_candidate.append((original, moved))

    return close_now, ask_candidate


def report_repeats(close_now: list, ask_candidate: list) -> None:
    total = sum(len(later) for _, later in close_now)
    print("%d repeat row%s of an already decided posting" % (
        total, "" if total == 1 else "s"))
    for original, later in close_now:
        print("  %s (%s) came back as:" % (original.get("id"), original.get("status")))
        for row in later:
            queued = " ON THE APPLY QUEUE" if row.get("apply_requested") else ""
            print("      %s (%s)%s" % (row.get("id"), row.get("status"), queued))
    for original, later in ask_candidate:
        for row in later:
            print("  your call: %s is %s, but %s is already %s"
                  % (row.get("id"), row.get("status"),
                     original.get("id"), original.get("status")))


def close_by_id(data: dict, positions: list, wanted: list, dry_run: bool) -> int:
    """Close named rows as repeats. Used for the ones --merge leaves for the candidate."""
    by_id = {p.get("id"): p for p in positions}
    heads = {}
    for rows in repeat_groups(positions):
        for row in rows[1:]:
            heads[row.get("id")] = rows[0]

    closed = 0
    for position_id in wanted:
        position = by_id.get(position_id)
        if position is None:
            print("no row with id %s" % position_id)

            return 1
        original = heads.get(position_id)
        if original is None:
            print("%s does not repeat anything on file, so there is nothing to close it "
                  "against. Change its status on the board instead." % position_id)

            return 1
        print("closing %s (%s) as a repeat of %s (%s)" % (
            position_id, position.get("status"), original.get("id"), original.get("status")))
        if not dry_run:
            close_repeat(position, original)
        closed += 1

    if dry_run:
        print("\nDry run. %d row%s would be closed. Nothing written." % (
            closed, "" if closed == 1 else "s"))

        return 0

    save_positions(data)
    print("\n%d row%s closed. positions.json written." % (closed, "" if closed == 1 else "s"))

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--merge", action="store_true",
                        help="apply the repair instead of only reporting it")
    parser.add_argument("--dry-run", action="store_true",
                        help="with --merge, say what would change and write nothing")
    parser.add_argument("--close", metavar="ID", action="append", default=[],
                        help="close this row as a repeat. For the cases --merge "
                             "reports as your call and refuses to decide.")
    args = parser.parse_args()

    with file_lock():
        data = load_positions()
        positions = data.get("positions") or []

        if args.close:
            return close_by_id(data, positions, args.close, args.dry_run)

        twins = same_id_groups(positions)
        repeats = repeat_groups(positions)

        print("%d positions on file" % len(positions))
        print("%d id%s carrying more than one row" % (len(twins), "" if len(twins) == 1 else "s"))
        for pid, rows in twins.items():
            print("  %dx %s  %s" % (len(rows), pid, [r.get("status") for r in rows]))

        close_now, ask_candidate = triage(repeats)
        report_repeats(close_now, ask_candidate)

        if not args.merge:
            print("\nReport only. Add --merge to repair.")

            return 0

        removed = 0
        for pid, rows in twins.items():
            keeper, dropped = merge_same_id(rows)
            for row in dropped:
                positions.remove(row)
                removed += 1
            print("merged %d row%s into %s (%s)" % (
                len(dropped), "" if len(dropped) == 1 else "s", pid, keeper.get("status")))

        # Recomputed, because the merge above removed rows the first pass saw.
        close_now, ask_candidate = triage(repeat_groups(positions))

        closed = 0
        for original, later in close_now:
            for row in later:
                close_repeat(row, original)
                closed += 1
                print("closed %s as a repeat of %s" % (row.get("id"), original.get("id")))

        for original, later in ask_candidate:
            for row in later:
                print("LEFT ALONE, your call: %s is marked %s but %s is already %s"
                      % (row.get("id"), row.get("status"),
                         original.get("id"), original.get("status")))

        if args.dry_run:
            print("\nDry run. %d row%s would be removed, %d closed. Nothing written." % (
                removed, "" if removed == 1 else "s", closed))

            return 0

        data["positions"] = positions
        save_positions(data)
        print("\n%d row%s removed, %d closed. positions.json written." % (
            removed, "" if removed == 1 else "s", closed))

    return 0


if __name__ == "__main__":
    sys.exit(main())
