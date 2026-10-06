#!/usr/bin/env python3
"""Say where the apply run has got to, while it is still running.

The apply worker is one long agent session. Until now the only thing it told
anybody was the exit code, forty minutes later: the board said "running" and
nothing else, so a run that was quietly stuck looked exactly like a run that was
working. This is the running commentary.

The shell script writes the bookends (`start` and `end`), so the file is honest
about whether a run is live even if the agent never says another word. The agent
writes everything in between.

Every write is atomic. A half-written progress file read by the dashboard's next
poll would be worse than no file at all.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "dashboard" / "data"
FILE = DATA / "apply-progress.json"

# A fixed vocabulary, in the order the routine does them. The UI counts steps
# against this list, so an agent inventing its own labels would make "step 3 of
# 6" meaningless. Anything unrecognised is kept and shown, but does not move the
# counter.
STEPS = [
    ("picked", "Picked the role"),
    ("research", "Reading the posting"),
    ("resume", "Tailoring the resume"),
    ("portal", "Opening the apply path"),
    ("account", "Making a portal account"),
    ("form", "Filling the application"),
    ("submit", "Submitting"),
    ("record", "Recording the outcome"),
]
STEP_IDS = [s for s, _ in STEPS]
STEP_LABEL = dict(STEPS)


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def read() -> dict:
    try:
        d = json.loads(FILE.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write(d: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    d["updated_at"] = now()
    tmp = FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, FILE)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("start", help="a run is beginning")
    s.add_argument("--queued", type=int, default=0)
    s.add_argument("--batch", type=int, default=0)

    p = sub.add_parser("position", help="starting work on one role")
    p.add_argument("--id", required=True)
    p.add_argument("--company", default="")
    p.add_argument("--title", default="")

    st = sub.add_parser("step", help="where this role has got to")
    st.add_argument("name", help=f"one of: {', '.join(STEP_IDS)}")
    st.add_argument("--note", default="")

    f = sub.add_parser("finish", help="this role is done, one way or another")
    f.add_argument("--outcome", required=True, choices=["applied", "blocked", "skipped"])
    f.add_argument("--note", default="")

    sub.add_parser("end", help="the run is over")

    a = ap.parse_args()
    d = read()

    if a.cmd == "start":
        write({
            "running": True,
            "started_at": now(),
            "queued": a.queued,
            "batch": a.batch,
            "completed": 0,
            "current": None,
            "done": [],
            "steps": [{"id": i, "label": l} for i, l in STEPS],
        })
        return 0

    if a.cmd == "position":
        d["current"] = {
            "id": a.id,
            "company": a.company,
            "title": a.title,
            "started_at": now(),
            "step": None,
            "step_label": "",
            "step_index": 0,
            "note": "",
        }
        write(d)
        return 0

    if a.cmd == "step":
        cur = d.get("current")
        if not cur:
            # A step with no role is a reporting mistake, not a crash. Record it
            # rather than losing it: a run saying something odd is still better
            # than a run saying nothing.
            cur = {"id": "", "company": "", "title": "", "started_at": now()}
        cur["step"] = a.name
        cur["step_label"] = STEP_LABEL.get(a.name, a.name)
        cur["step_index"] = STEP_IDS.index(a.name) + 1 if a.name in STEP_IDS else 0
        cur["note"] = a.note
        cur["step_at"] = now()
        d["current"] = cur
        write(d)
        return 0

    if a.cmd == "finish":
        cur = d.get("current") or {}
        row = {
            "id": cur.get("id", ""),
            "company": cur.get("company", ""),
            "title": cur.get("title", ""),
            "outcome": a.outcome,
            "note": a.note,
            "at": now(),
        }
        d.setdefault("done", []).append(row)
        d["completed"] = len(d["done"])
        d["current"] = None
        write(d)
        return 0

    if a.cmd == "end":
        d["running"] = False
        d["current"] = None
        d["ended_at"] = now()
        write(d)
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
