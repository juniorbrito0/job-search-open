#!/usr/bin/env python3
"""Which search slot is due right now, from profile/candidate.json.

Prints a slot id such as `2026-10-06-0800` (the latest search time today that
has already passed), or `none` when no search time has come yet today.
`--times` prints the configured times, one per line, for setup-mac.sh.

Standard library only, so the LaunchAgent's /usr/bin/python3 can run it.
"""

import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TIMES = ["08:00", "16:00"]


def search_times():
    try:
        data = json.loads((ROOT / "profile" / "candidate.json").read_text(encoding="utf-8"))
        raw = (data.get("schedule") or {}).get("search_times") or DEFAULT_TIMES
    except (OSError, ValueError):
        raw = DEFAULT_TIMES
    times = []
    for value in raw:
        m = re.fullmatch(r"\s*(\d{1,2}):(\d{2})\s*", str(value))
        if m and int(m.group(1)) < 24 and int(m.group(2)) < 60:
            times.append((int(m.group(1)), int(m.group(2))))
    return sorted(set(times)) or [(8, 0), (16, 0)]


def due_slot(now=None):
    now = now or datetime.now()
    passed = [t for t in search_times() if (now.hour, now.minute) >= t]
    if not passed:
        return "none"
    h, m = passed[-1]
    return f"{now:%Y-%m-%d}-{h:02d}{m:02d}"


if __name__ == "__main__":
    if "--times" in sys.argv:
        for h, m in search_times():
            print(f"{h:02d}:{m:02d}")
    else:
        print(due_slot())
