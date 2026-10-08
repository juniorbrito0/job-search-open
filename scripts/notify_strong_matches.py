#!/usr/bin/env python3
"""Write the "strong matches" email the candidate gets after a search.

Prints a subject, body and recipient (profile/candidate.json -> email) to
stdout as JSON. The search agent sends that email to the candidate with the
Gmail tools. This script never sends mail itself. If email notifications are
off (notifications.email_strong_matches: false) or no email is set, it prints
{"send": false}.

    .venv/bin/python scripts/notify_strong_matches.py
    .venv/bin/python scripts/notify_strong_matches.py --since 2026-09-02
"""

from __future__ import annotations

import argparse
import json
import sys

from jobsearch_lib import load_positions
from profile_lib import load_candidate


def strong(positions: list[dict], since: str | None) -> list[dict]:
    out = []
    for p in positions:
        overall = (p.get("scores") or {}).get("overall") or 0
        if overall < 4:
            continue
        found = (p.get("found_date") or "")[:10]
        if since and found < since:
            continue
        if p.get("status") in {"rejected", "disqualified"}:
            continue
        out.append(p)
    out.sort(key=lambda p: (-(p.get("scores") or {}).get("overall", 0), p.get("company") or ""))
    return out


def body_for(rows: list[dict], port: int = 7411) -> tuple[str, str]:
    n = len(rows)
    fives = [p for p in rows if (p.get("scores") or {}).get("overall") == 5]
    fours = [p for p in rows if (p.get("scores") or {}).get("overall") == 4]
    if n == 1:
        p = rows[0]
        subject = f"Score {p['scores']['overall']}: {p.get('title')} at {p.get('company')}"
    else:
        subject = f"{n} strong roles just landed ({len(fives)} at 5, {len(fours)} at 4)"

    lines = [
        "New roles scored 4 or 5 (Dream fit). If auto-queue is on, they are already on the apply queue;",
        "nothing is sent until you press Run apply queue on the dashboard.",
        f"Dashboard: http://localhost:{port}",
        "",
    ]
    for p in rows:
        score = (p.get("scores") or {}).get("overall")
        loc = p.get("location") or "location unlisted"
        lines.append(f"- {p.get('company')}: {p.get('title')} (score {score}, {loc})")
        if p.get("url"):
            lines.append(f"  {p['url']}")
    lines.append("")
    lines.append("Open the dashboard to look them over. Reject any you would skip.")
    return subject, "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--since")
    args = parser.parse_args()
    cand = load_candidate()
    to = (cand.get("email") or "").strip()
    if not (cand.get("notifications") or {}).get("email_strong_matches", True) or not to:
        print(json.dumps({"send": False, "count": 0, "why": "email notifications are off or no email is set"}))
        return 0
    rows = strong(load_positions().get("positions") or [], args.since)
    if not rows:
        print(json.dumps({"send": False, "count": 0}))
        return 0
    port = (cand.get("dashboard") or {}).get("port") or 7411
    subject, body = body_for(rows, port)
    print(json.dumps({"send": True, "to": to, "subject": subject, "body": body, "count": len(rows)}, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
