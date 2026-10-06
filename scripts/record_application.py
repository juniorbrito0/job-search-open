#!/usr/bin/env python3
"""Record a submitted (or blocked) application in one shot.

Updates dashboard/data/positions.json and appends a row to job-applications.csv.

    scripts/record_application.py <position_id> submitted "what was sent"
    scripts/record_application.py <position_id> blocked   "why it needs you"
    scripts/record_application.py <position_id> closed    "posting no longer live"
    scripts/record_application.py <position_id> skipped   "why it was skipped"

Only `submitted` sets applied_at and status=applied. All outcomes clear
apply_requested so the dashboard queue drains.
"""

import csv
import sys
from datetime import date

from jobsearch_lib import ROOT, file_lock, load_positions, save_positions

CSV_PATH = ROOT / "job-applications.csv"
CSV_HEADER = [
    "Date Applied", "Company", "Role", "Location", "Work Model", "Tier", "Compensation",
    "Benefits", "Match %", "Match Notes", "Status", "Next Action", "Source URL", "Notes",
]

STATUS_FOR = {
    "submitted": "applied",
    "blocked": "interested",
    "closed": "disqualified",
    "skipped": "disqualified",
}


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    pos_id, outcome, note = sys.argv[1], sys.argv[2], sys.argv[3]
    if outcome not in STATUS_FOR:
        sys.exit(f"outcome must be one of {sorted(STATUS_FOR)}")

    today = date.today().isoformat()
    with file_lock():
        data = load_positions()
        pos = next((p for p in data["positions"] if p.get("id") == pos_id), None)
        if pos is None:
            sys.exit(f"No position with id {pos_id!r} was found.")
        update(pos, outcome, note, today)
        save_positions(data)
    write_csv(pos, outcome, note, today)
    print(f"{pos['company']} | {pos['title']} -> {outcome} ({STATUS_FOR[outcome]})")


def update(pos: dict, outcome: str, note: str, today: str) -> None:
    new_status = STATUS_FOR[outcome]
    pos["apply_requested"] = False
    pos["apply_result"] = note
    pos["status"] = new_status
    if outcome == "submitted":
        pos["applied_at"] = today
        if pos.get("auto_apply_queued"):
            pos["auto_applied"] = True
    pos.setdefault("status_history", []).append({"status": new_status, "at": today})


def write_csv(pos: dict, outcome: str, note: str, today: str) -> None:
    if outcome == "submitted":
        scores = pos.get("scores") or {}
        new_file = not CSV_PATH.exists()
        with CSV_PATH.open("a", newline="") as fh:
            if new_file:
                csv.writer(fh).writerow(CSV_HEADER)
            csv.writer(fh).writerow([
                today,
                pos["company"],
                pos["title"],
                pos.get("location") or "",
                pos.get("work_model") or "",
                "",
                pos.get("salary_text") or "Not listed",
                "",
                f"{pos.get('match_pct', '')}%",
                f"Overall score {scores.get('overall', '')}/5",
                "Applied",
                "Await response",
                pos.get("url") or "",
                note,
            ])


if __name__ == "__main__":
    main()
