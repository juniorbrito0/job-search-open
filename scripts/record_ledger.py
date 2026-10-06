#!/usr/bin/env python3
"""Append every submitted application to the duplicate-submit ledger.

The ledger at dashboard/data/applied-ledger.json is what stops the apply job
resubmitting a role after positions.json is lost or reverted. It was added on
2026-09-02, after a revert put two roles back on the queue and one employer
received four copies of the same application.

Until 2026-09-07 nothing ever wrote to it. `queue_auto_apply.py` read it, and
the only two entries in it had been typed in by hand, so every application
submitted after that date was unprotected. This closes that: it reconciles
positions.json into the ledger, and the apply runner calls it before and after
every run.

    python3 scripts/record_ledger.py            # append what is missing
    python3 scripts/record_ledger.py --dry-run  # say what it would append

Append only. It never removes an entry and never edits one that already exists.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POSITIONS = ROOT / "dashboard/data/positions.json"
LEDGER = ROOT / "dashboard/data/applied-ledger.json"

NOTE = (
    "Append-only record of position ids that were actually submitted, kept OUTSIDE "
    "positions.json so a lost or reverted positions.json can never put a submitted "
    "role back on the apply queue. scripts/queue_auto_apply.py drops any ledger id "
    "from the pending queue. Added 2026-09-02 after the Sep 1 revert incident sent "
    "Affirm 4 duplicate applications. Maintained by scripts/record_ledger.py, which "
    "the apply runner calls before and after every run. Never remove entries."
)


def load(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def submitted(position: dict) -> bool:
    """What counts as sent. Any one of these means an employer has it."""
    return bool(position.get("applied_at")) or bool(position.get("auto_applied"))


def main() -> int:
    dry = "--dry-run" in sys.argv

    data = load(POSITIONS, None)
    if not isinstance(data, dict) or not isinstance(data.get("positions"), list):
        print("record_ledger: no readable positions.json, nothing to do", flush=True)
        return 0

    ledger = load(LEDGER, {})
    if not isinstance(ledger, dict):
        ledger = {}
    rows = ledger.get("submitted")
    if not isinstance(rows, list):
        rows = []

    known = {r.get("id") for r in rows if isinstance(r, dict)}
    added = []

    for position in data["positions"]:
        if not isinstance(position, dict):
            continue
        pid = position.get("id")
        if not pid or pid in known or not submitted(position):
            continue
        result = str(position.get("apply_result") or "").strip()
        added.append({
            "id": pid,
            "company": position.get("company") or "",
            "title": position.get("title") or "",
            "applied_at": position.get("applied_at") or "",
            "evidence": (result[:300] if result else "marked applied in positions.json"),
        })
        known.add(pid)

    if not added:
        print("record_ledger: ledger already covers every submitted role", flush=True)
        return 0

    for row in added:
        print("record_ledger: +%s (%s, %s)" % (row["id"], row["company"], row["applied_at"]), flush=True)

    if dry:
        print("record_ledger: dry run, nothing written", flush=True)
        return 0

    ledger["note"] = NOTE
    ledger["submitted"] = rows + added

    # Write through a temporary file in the same directory: a half-written ledger
    # is worse than a missing one, because the guard would silently protect less.
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(LEDGER.parent), prefix=".ledger-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(ledger, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, LEDGER)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

    print("record_ledger: wrote %d new entr%s" % (len(added), "y" if len(added) == 1 else "ies"), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
