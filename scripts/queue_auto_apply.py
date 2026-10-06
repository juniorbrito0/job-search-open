#!/usr/bin/env python3
"""Put score-4+ positions on the apply queue. Never submits an application.

The search job calls this after scoring. The apply job (started only by the
Apply queue now button on the dashboard) reads the same flags. Turn the whole thing off with
`scoring-profile.json → auto_apply.enabled: false`.

    .venv/bin/python scripts/queue_auto_apply.py
    .venv/bin/python scripts/queue_auto_apply.py --dry-run
    .venv/bin/python scripts/queue_auto_apply.py --pending-count
    .venv/bin/python scripts/queue_auto_apply.py --self-test
"""

from __future__ import annotations

import argparse
import fcntl
import json
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POSITIONS = ROOT / "dashboard/data/positions.json"
PROFILE = ROOT / "dashboard/data/scoring-profile.json"
LEDGER = ROOT / "dashboard/data/applied-ledger.json"
LOCK_FILE = ROOT / "dashboard/data/.lock"

CLOSED_STATUSES = frozenset(
    {
        "applied",
        "ongoing",
        "screen",
        "interview",
        "offer",
        "disqualified",
        "rejected",
        "no_answer",
    }
)

def off_limits_words(profile: dict | None = None) -> list[str]:
    """Industries the candidate never wants, from both settings files.

    profile/candidate.json -> industries.off_limits and
    scoring-profile.json -> hard_exclusions.industries. Empty means none.
    """
    words: list[str] = []
    try:
        from profile_lib import load_candidate
        words += (load_candidate().get("industries") or {}).get("off_limits") or []
    except Exception:
        pass
    words += ((profile or {}).get("hard_exclusions") or {}).get("industries") or []
    out = []
    for w in words:
        if isinstance(w, str):
            for part in re.split(r"[/,]| or ", w):
                part = part.strip()
                if len(part) >= 3 and part.lower() not in {x.lower() for x in out}:
                    out.append(part)
    return out


def off_limits_re(words: list[str]):
    if not words:
        return None
    return re.compile(r"\b(" + "|".join(re.escape(w) for w in words) + r")", re.I)


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def auto_apply_config(profile: dict) -> dict:
    """Default is ON (strong matches are queued; nothing is sent until the
    candidate presses Apply queue now on the dashboard)."""
    block = profile.get("auto_apply")
    if block is None:
        return {"enabled": True, "min_overall": 4}
    if isinstance(block, bool):
        return {"enabled": bool(block), "min_overall": 4}
    if not isinstance(block, dict):
        return {"enabled": True, "min_overall": 4}
    try:
        min_overall = int(block.get("min_overall", 4))
    except (TypeError, ValueError):
        min_overall = 4
    return {
        "enabled": bool(block.get("enabled", True)),
        "min_overall": min_overall,
    }


def overall_score(position: dict) -> int:
    scores = position.get("scores") or {}
    try:
        return int(scores.get("overall") or 0)
    except (TypeError, ValueError):
        return 0


def _blob(position: dict) -> str:
    rationale = position.get("score_rationale") or {}
    parts = [
        position.get("title") or "",
        position.get("company") or "",
        position.get("jd_summary") or "",
        (position.get("jd_text") or "")[:4000],
        rationale.get("overall") or "",
        rationale.get("interests") or "",
    ]
    return " ".join(str(p) for p in parts)


def is_off_limits(position: dict, pattern=None) -> bool:
    return bool(pattern and pattern.search(_blob(position)))


def ledger_ids(path: Path = LEDGER) -> frozenset:
    # Duplicate-submit guard. The ledger lives outside positions.json so a
    # reverted or restored positions.json can never resubmit a ledgered id.
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return frozenset()
    rows = data.get("submitted") or []
    return frozenset(r.get("id") for r in rows if isinstance(r, dict) and r.get("id"))


def already_closed_or_applied(position: dict) -> bool:
    if position.get("applied_at"):
        return True
    if position.get("status") in CLOSED_STATUSES:
        return True
    if position.get("auto_applied"):
        return True
    return False


def decide(position: dict, cfg: dict, off_limits=None) -> tuple[bool, str]:
    """Return (should_queue, reason). Search job only. Never submits."""
    if not cfg["enabled"]:
        return False, "disabled"
    if already_closed_or_applied(position):
        return False, "already-closed-or-applied"
    if position.get("auto_apply_queued") or position.get("apply_requested"):
        return False, "already-queued"
    if position.get("apply_manual"):
        return False, "candidate-applies-manually"
    if overall_score(position) < cfg["min_overall"]:
        return False, "score-too-low"
    if is_off_limits(position, off_limits):
        return False, "off-limits-industry"
    return True, "queue"


def queue_position(position: dict) -> dict:
    """Mark a 4+ for the apply job. Does not stamp auto_applied."""
    position["auto_apply_queued"] = True
    position["apply_requested"] = True
    if not position.get("resume_path"):
        position["resume_requested"] = True
    return position


def queue_eligible(positions: list, profile: dict, ids: set[str] | None = None) -> list[dict]:
    cfg = auto_apply_config(profile)
    pattern = off_limits_re(off_limits_words(profile))
    submitted = ledger_ids()
    queued = []
    for position in positions:
        if ids is not None and position.get("id") not in ids:
            continue
        if position.get("id") in submitted:
            continue
        ok, reason = decide(position, cfg, pattern)
        if not ok:
            continue
        queue_position(position)
        queued.append({
            "id": position.get("id"),
            "company": position.get("company"),
            "title": position.get("title"),
            "overall": overall_score(position),
            "reason": reason,
        })
    return queued


def pending_apply(positions: list, profile: dict, submitted: frozenset | None = None) -> list[dict]:
    """Positions the apply job should try. Empty list means exit quietly."""
    cfg = auto_apply_config(profile)
    if submitted is None:
        submitted = ledger_ids()
    out = []
    for position in positions:
        if position.get("id") in submitted:
            continue
        if already_closed_or_applied(position):
            continue
        if not position.get("apply_requested"):
            continue
        if position.get("auto_apply_queued") and not cfg["enabled"]:
            continue
        out.append(position)
    return out


def _write_json(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def run(dry_run: bool, ids: set[str] | None) -> int:
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK_FILE, "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            data = _read(POSITIONS, {"positions": []})
            profile = _read(PROFILE, {})
            queued = queue_eligible(data.get("positions") or [], profile, ids)
            cfg = auto_apply_config(profile)
            if dry_run:
                print(f"dry-run: would queue {len(queued)} (enabled={cfg['enabled']}, min={cfg['min_overall']})")
                for row in queued:
                    print(f"  {row['overall']}  {row['company']}  {row['title']}  {row['id']}")
                return 0
            if queued:
                data["updated_at"] = _now()
                _write_json(POSITIONS, data)
            print(f"queued {len(queued)} for the apply queue (enabled={cfg['enabled']}, min={cfg['min_overall']})")
            for row in queued:
                print(f"  {row['overall']}  {row['company']}  {row['title']}  {row['id']}")
            return 0
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _read(path: Path, default: dict) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def print_pending_count() -> int:
    data = _read(POSITIONS, {"positions": []})
    profile = _read(PROFILE, {})
    n = len(pending_apply(data.get("positions") or [], profile))
    print(n)
    return 0


def _self_test() -> int:
    profile_on = {"auto_apply": {"enabled": True, "min_overall": 4}}
    profile_off = {"auto_apply": {"enabled": False, "min_overall": 4}}
    fresh = {
        "id": "acme--ops--20260824",
        "title": "Head of Operations",
        "company": "Acme",
        "status": "review",
        "scores": {"overall": 4},
        "apply_requested": False,
    }

    ok, reason = decide(fresh, auto_apply_config(profile_on))
    assert ok and reason == "queue", reason

    low = {**fresh, "scores": {"overall": 3}}
    ok, reason = decide(low, auto_apply_config(profile_on))
    assert not ok and reason == "score-too-low", reason

    ok, reason = decide(fresh, auto_apply_config(profile_off))
    assert not ok and reason == "disabled", reason

    applied = {**fresh, "status": "applied", "applied_at": "2026-08-01"}
    ok, reason = decide(applied, auto_apply_config(profile_on))
    assert not ok and reason == "already-closed-or-applied", reason

    done = {**fresh, "auto_applied": True}
    ok, reason = decide(done, auto_apply_config(profile_on))
    assert not ok and reason == "already-closed-or-applied", reason

    waiting = {**fresh, "auto_apply_queued": True, "apply_requested": True}
    ok, reason = decide(waiting, auto_apply_config(profile_on))
    assert not ok and reason == "already-queued", reason

    manual = {**fresh, "apply_manual": True}
    ok, reason = decide(manual, auto_apply_config(profile_on))
    assert not ok and reason == "candidate-applies-manually", reason

    pattern = off_limits_re(off_limits_words({"hard_exclusions": {"industries": ["gambling/betting", "tobacco"]}}))
    gambling = {**fresh, "title": "Head of Operations at an online betting sportsbook"}
    ok, reason = decide(gambling, auto_apply_config(profile_on), pattern)
    assert not ok and reason == "off-limits-industry", reason
    ok, reason = decide(gambling, auto_apply_config(profile_on), None)
    assert ok, reason

    ok, reason = decide(fresh, auto_apply_config({}))
    assert ok and reason == "queue", reason

    batch = [dict(fresh), dict(low), dict(applied)]
    queued = queue_eligible(batch, profile_on)
    assert len(queued) == 1, queued
    assert batch[0]["auto_apply_queued"] is True
    assert batch[0]["apply_requested"] is True
    assert batch[0]["resume_requested"] is True
    assert batch[0].get("auto_applied") is not True
    assert "auto_apply_queued" not in batch[1]

    waiting_copy = dict(waiting)
    assert len(pending_apply([waiting_copy], profile_on)) == 1
    assert len(pending_apply([waiting_copy], profile_off)) == 0
    by_hand = {**fresh, "apply_requested": True}
    assert len(pending_apply([by_hand], profile_off)) == 1
    assert len(pending_apply([dict(applied)], profile_on)) == 0
    ledgered = frozenset({fresh["id"]})
    assert len(pending_apply([dict(by_hand)], profile_on, submitted=ledgered)) == 0

    with tempfile.TemporaryDirectory() as tmp:
        pos_file = Path(tmp) / "positions.json"
        pos_file.write_text(json.dumps({"positions": [dict(fresh)]}), encoding="utf-8")
        data = json.loads(pos_file.read_text(encoding="utf-8"))
        n = queue_eligible(data["positions"], profile_on)
        assert len(n) == 1
        assert data["positions"][0]["auto_apply_queued"] is True
        assert data["positions"][0].get("auto_applied") is not True

    print("self-test: ok")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--pending-count", action="store_true",
                        help="print how many the apply job should try, then exit")
    parser.add_argument("--ids", help="comma-separated position ids to consider")
    args = parser.parse_args()
    if args.self_test:
        return _self_test()
    if args.pending_count:
        return print_pending_count()
    ids = {x.strip() for x in args.ids.split(",") if x.strip()} if args.ids else None
    return run(dry_run=args.dry_run, ids=ids)


if __name__ == "__main__":
    sys.exit(main())
