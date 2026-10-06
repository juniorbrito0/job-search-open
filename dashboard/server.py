"""Job Search dashboard.

Serves the single-page dashboard and a small JSON API over the data files in
dashboard/data/. No dependencies beyond the standard library.

`GET /api/data` returns positions, the scoring profile, startups, screened-out
postings, company memory, the candidate's profile (profile/candidate.json, with
safe defaults when it is missing) and optional insights (dashboard/data/insights.md).
`GET /api/jobs` reports last-run times and whether a search, apply, or inbox
job is running. `POST /api/jobs/{scan|apply|inbox}` starts that job in the
background (same scripts the LaunchAgents use). Search uses JOBSEARCH_FORCE=1
so a dashboard click is not blocked by the twice-daily slot guard.

By default it listens on this Mac only (127.0.0.1). Set
candidate.json -> dashboard.share_on_home_wifi to true to open it to other
devices on the home network. Host-header checks still reject public-internet
names (DNS rebinding). There is no login.

Port: candidate.json -> dashboard.port (default 7411). JOBSEARCH_PORT in the
environment overrides it, which is handy for testing.

Run:  python3 dashboard/server.py

The LaunchAgent starts this file with /usr/bin/python3, which is 3.9 on
most Macs. Keep the future import. Without it, `str | None` crashes on boot
and Search now clicks do nothing.
"""

from __future__ import annotations

import fcntl
import gzip
import hashlib
import hmac
import ipaddress
import json
import os
import re
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DASHBOARD_DIR = Path(__file__).resolve().parent
PROJECT_DIR = DASHBOARD_DIR.parent
DATA_DIR = DASHBOARD_DIR / "data"
POSITIONS_FILE = DATA_DIR / "positions.json"
PROFILE_FILE = DATA_DIR / "scoring-profile.json"
STARTUPS_FILE = DATA_DIR / "startups.json"
IGNORED_FILE = DATA_DIR / "ignored.json"
COMPANIES_FILE = DATA_DIR / "companies.json"
CANDIDATE_FILE = PROJECT_DIR / "profile" / "candidate.json"
INSIGHTS_FILE = DATA_DIR / "insights.md"
sys.path.insert(0, str(PROJECT_DIR / "scripts"))
try:
    from stakeholder_outreach import (  # noqa: E402
        eligible as outreach_eligible,
        prepare_position,
        request_send,
    )
except Exception as _exc:  # the board must still open if that helper breaks
    print(f"warning: outreach drafting is off ({_exc})")

    def outreach_eligible(position):  # type: ignore[no-redef]
        return False

    def prepare_position(position, overwrite=False):  # type: ignore[no-redef]
        return position

    def request_send(position, message=None):  # type: ignore[no-redef]
        return position

# What the page needs to know about the candidate when profile/candidate.json
# is missing or half filled in (a fresh clone before onboarding).
CANDIDATE_DEFAULTS = {
    "name": "",
    "first_name": "",
    "currency": "CAD",
    "experience_years": {"total": 0, "in_function": 0, "function_label": "relevant"},
    "location_buckets": [
        {"label": "Remote", "pattern": "remote"},
        {"label": "Other / unclear", "pattern": ""},
    ],
    "startup_watch": {"region_label": "", "max_employees": 100},
    "schedule": {
        "search_times": ["08:00", "16:00"],
        "weekly_digest": {"enabled": True, "weekday": 5, "time": "10:00"},
    },
    "dashboard": {"port": 7411, "share_on_home_wifi": False},
}


def _load_candidate() -> dict:
    try:
        raw = json.loads(CANDIDATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raw = {}
    except (OSError, json.JSONDecodeError):
        raw = {}
    merged = dict(CANDIDATE_DEFAULTS)
    for key, value in raw.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = {**merged[key], **value}
        elif value not in (None, ""):
            merged[key] = value
    return merged


def _port_and_host():
    dash = _load_candidate().get("dashboard") or {}
    port = 7411
    try:
        port = int(os.environ.get("JOBSEARCH_PORT") or dash.get("port") or 7411)
    except (TypeError, ValueError):
        pass
    host = "0.0.0.0" if dash.get("share_on_home_wifi") is True else "127.0.0.1"
    return port, host


PORT, BIND_HOST = _port_and_host()


def _fill_missing_outreach(data: dict) -> bool:
    """Draft people packs for applied score 4 and 5 that still have none."""
    changed = False
    for position in data.get("positions") or []:
        if not outreach_eligible(position):
            continue
        current = position.get("stakeholder_outreach") or {}
        if current.get("status") in {"ready", "send_requested", "sent", "blocked"}:
            continue
        prepare_position(position)
        changed = True
    return changed

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}

VALID_STATUSES = {
    "review", "rejected", "interested", "applied", "ongoing",
    "screen", "interview", "offer",
    "disqualified", "no_answer",
}
SCORE_KEYS = {"interests", "goals", "location", "comp", "overall"}
PATCHABLE = {
    "status", "scores", "reject_reasons", "reject_note", "research_md",
    "resume_path", "score_rationale", "resume_requested", "apply_requested",
    "auto_applied", "auto_apply_queued", "diary_note",
    "outreach_action", "outreach_message",
}

_lock = threading.Lock()
LOCK_FILE = DATA_DIR / ".lock"
LOG_DIR = PROJECT_DIR / "logs"
JOB_RUNS_FILE = LOG_DIR / "job-runs.json"
APPLY_PROGRESS_FILE = DATA_DIR / "apply-progress.json"
_TAILSCALE_CGNAT = ipaddress.ip_network("100.64.0.0/10")

# Dashboard buttons start the same jobs the LaunchAgents run. A click must
# return immediately; the watcher thread records when the child exits.
JOB_SPECS = {
    "scan": {
        "script": PROJECT_DIR / "scripts/morning-scan.sh",
        "lock": LOG_DIR / ".morning-scan.lock",
        "stamp": DATA_DIR / ".last-scan-at",
        "stale_minutes": 100,
        "env": {"JOBSEARCH_FORCE": "1"},
    },
    "apply": {
        "script": PROJECT_DIR / "scripts/auto-apply.sh",
        "lock": LOG_DIR / ".auto-apply.lock",
        "stamp": DATA_DIR / ".last-apply-at",
        # Must stay above the watchdog in scripts/auto-apply.sh (10800s since
        # 2026-09-15) and match its STALE_LOCK_MINUTES. This is how long the
        # board keeps believing a run is alive; go under the watchdog and the
        # board declares a healthy long run dead, re-enables Run apply queue,
        # and a second agent starts on the same list. Two agents, one queue, and
        # the same role is applied to twice.
        "stale_minutes": 190,
        "env": {},
    },
    "inbox": {
        "script": PROJECT_DIR / "scripts/inbox-update.sh",
        "lock": LOG_DIR / ".inbox-update.lock",
        "stamp": DATA_DIR / ".last-inbox-at",
        "stale_minutes": 70,
        "env": {},
    },
}
_job_watch_lock = threading.Lock()


def _host_without_port(value):
    host = (value or "").strip()
    if not host:
        return ""
    if host.startswith("["):
        end = host.find("]")
        return host[1:end] if end != -1 else host
    if host.count(":") == 1:
        return host.rsplit(":", 1)[0]
    return host


def _is_house_host(host):
    # Allow this Mac, localhost, the home network, and Tailscale. Reject public Host headers.
    host = (host or "").strip().lower().rstrip(".")
    if not host:
        return False
    if host in {"localhost", "127.0.0.1", "::1"}:
        return True
    if host.endswith(".local") or host.endswith(".localhost") or host.endswith(".ts.net"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # A name with no dot in it cannot be a public internet name, so it
        # cannot be the attacker-controlled domain a DNS-rebinding attack needs.
        # It is a LAN name, a Tailscale MagicDNS short name, or a /etc/hosts
        # entry. Accepting the whole class beats maintaining a hardcoded list.
        return "." not in host
    if ip.is_loopback or ip.is_link_local or ip.is_private:
        return True
    if ip.version == 4 and ip in _TAILSCALE_CGNAT:
        return True
    return False


def _origin_allowed(origin):
    if origin is None:
        return True
    if not (origin.startswith("http://") or origin.startswith("https://")):
        return False
    rest = origin.split("://", 1)[1]
    return _is_house_host(_host_without_port(rest))


@contextmanager
def _file_lock():
    # the morning-scan agent writes these files too — flock keeps writes exclusive across processes
    with open(LOCK_FILE, "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _pid_alive(pid) -> bool:
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _lock_held(lock_dir: Path, stale_minutes: int) -> bool:
    if not lock_dir.is_dir():
        return False
    age = time.time() - lock_dir.stat().st_mtime
    return age < stale_minutes * 60


def _read_stamp(path: Path) -> str | None:
    try:
        value = path.read_text(encoding="utf-8").strip().splitlines()[0]
    except OSError:
        return None
    if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:", value):
        return value
    return None


def _read_job_runs() -> dict:
    try:
        data = json.loads(JOB_RUNS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_job_runs(data: dict) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = JOB_RUNS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(JOB_RUNS_FILE)


def _record_job(name: str, **fields) -> dict:
    with _job_watch_lock:
        data = _read_job_runs()
        row = dict(data.get(name) or {})
        row.update(fields)
        data[name] = row
        _write_job_runs(data)
        return row


def _guess_scan_from_worklog() -> str | None:
    # First-load fallback when this Mac has never written .last-scan-at
    # (the stamp is local, so a fresh clone would otherwise say "never").
    path = PROJECT_DIR / "docs/WORKLOG.md"
    try:
        text = path.read_text(encoding="utf-8")[:8000]
    except OSError:
        return None
    match = re.search(r"^## (\d{4}-\d{2}-\d{2}) \((am|pm) search\)", text, re.M)
    if not match:
        return None
    hour = "08:00:00" if match.group(2) == "am" else "16:00:00"
    return f"{match.group(1)}T{hour}"


def _stat_key(path: Path):
    """A file's identity for caching: no read, just its mark on disk."""
    try:
        st = path.stat()
    except OSError:
        return (path.name, -1, -1)
    return (path.name, st.st_mtime_ns, st.st_size)


_pending_lock = threading.Lock()
_pending_cache = {"key": None, "value": 0}


def _pending_apply_count() -> int:
    # This forks a python that reads all of positions.json, and it is called from
    # every /api/jobs and every /api/data. The answer cannot change while
    # positions.json has not, so it is counted once per version of that file.
    key = _stat_key(POSITIONS_FILE)
    with _pending_lock:
        if _pending_cache["key"] == key:
            return _pending_cache["value"]
    script = PROJECT_DIR / "scripts/queue_auto_apply.py"
    py = PROJECT_DIR / ".venv/bin/python"
    cmd = [str(py) if py.is_file() else "python3", str(script), "--pending-count"]
    try:
        out = subprocess.check_output(cmd, cwd=str(PROJECT_DIR), text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        # A count that could not be taken is not a count of zero. Say zero for
        # this request, but never remember it as the answer.
        return 0
    digits = "".join(ch for ch in out if ch.isdigit())
    try:
        value = int(digits)
    except ValueError:
        return 0
    with _pending_lock:
        _pending_cache.update(key=key, value=value)
    return value


def _job_status(name: str) -> dict:
    spec = JOB_SPECS[name]
    recorded = _read_job_runs().get(name) or {}
    lock_busy = _lock_held(spec["lock"], spec["stale_minutes"])
    pid_busy = _pid_alive(recorded.get("pid"))
    running = lock_busy or pid_busy or recorded.get("state") == "running"
    if recorded.get("state") == "running" and not lock_busy and not pid_busy:
        # The run is gone and nothing recorded how it ended. That happens when
        # this server restarts mid-run and takes the watching thread with it,
        # which is exactly what hid the 2026-09-09 apply run: it submitted 10
        # applications, was killed by its own 60-minute watchdog, and the board
        # read "idle" with no error. A run that vanished is not a run that
        # finished, and the page has to say so.
        running = False
        recorded = _record_job(
            name,
            state="error",
            pid=None,
            finished_at=_now(),
            message="the run ended without recording a result, so it was cut short",
        )
    last_finished = _read_stamp(spec["stamp"])
    recorded_finished = recorded.get("finished_at")
    if recorded_finished and re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:", str(recorded_finished)):
        # The later of the two, not "the stamp unless it is missing". The stamp
        # only moves when work actually happened, so a run that submitted nothing
        # left this reading older than the run that had just ended: on
        # 2026-09-10 a run that ended at 09:19 was shown as finishing the
        # previous lunchtime.
        if not last_finished or str(recorded_finished) > str(last_finished):
            last_finished = recorded_finished
    if name == "scan" and not last_finished:
        last_finished = _guess_scan_from_worklog()
    status = {
        "state": "running" if running else recorded.get("state") or "idle",
        "started_at": recorded.get("started_at") if running else None,
        "finished_at": None if running else last_finished,
        "message": recorded.get("message") if not running else "running",
        "queued": _pending_apply_count() if name == "apply" else None,
    }
    if not running and recorded.get("state") == "error":
        status["state"] = "error"
        status["message"] = recorded.get("message") or "failed"
    return status


def _jobs_payload() -> dict:
    return {name: _job_status(name) for name in JOB_SPECS}


def _apply_progress() -> dict:
    """Where the running apply job has got to.

    Deliberately not folded into /api/data. That answer is 16 MB, cached on the
    mtimes of five files, and this one changes every few seconds while a run is
    live: putting it in there would rebuild and re-send 16 MB of postings every
    time the worker moved to the next step.

    `running` here is the worker's own claim. It is crossed against the real lock
    below, because a file saying "running" after the process died is exactly the
    stale-but-confident state this board already learned to distrust.
    """
    try:
        d = json.loads(APPLY_PROGRESS_FILE.read_text(encoding="utf-8"))
        if not isinstance(d, dict):
            d = {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        d = {}

    spec = JOB_SPECS["apply"]
    really_running = _lock_held(spec["lock"], spec["stale_minutes"]) or _pid_alive(
        (_read_job_runs().get("apply") or {}).get("pid"))
    d["claimed_running"] = bool(d.get("running"))
    d["running"] = bool(d.get("running")) and really_running
    d["worker_gone"] = bool(d.get("claimed_running")) and not really_running
    return d


# What an exit code means, in the words the dashboard should use. The runner
# scripts write their own, better version of this ("cut short at the 3600s limit
# after 2 submitted, the rest are still queued"); this is only the fallback for a
# run that died before it could say anything for itself.
EXIT_REASONS = {
    70: "no AI provider was available, so nothing ran",
    137: "force-killed, so it stopped wherever it had got to; anything already "
         "submitted is saved and the rest is still queued",
    143: "cut short at the time limit, so it stopped wherever it had got to; "
         "anything already submitted is saved and the rest is still queued",
}


def _watch_job(name: str, proc: subprocess.Popen, started_at: str) -> None:
    code = proc.wait()
    recorded = _read_job_runs().get(name) or {}
    # The runner script records how its own run ended a few seconds before this
    # thread wakes up, and it knows things an exit code cannot: how many
    # applications actually went out and how many are still queued. Until
    # 2026-09-15 this thread overwrote that every single time a run ended
    # non-zero, which is how the 11:53 run that submitted two and then hit its
    # own hour-long watchdog reached the dashboard as a bare "exited 143" and
    # read as an unexplained crash. If the runner already spoke for this run,
    # leave its answer alone.
    if (
        recorded.get("started_at") == started_at
        and recorded.get("exit_code") == code
        and recorded.get("finished_at")
        and recorded.get("message")
    ):
        return
    _record_job(
        name,
        state="idle" if code == 0 else "error",
        pid=None,
        finished_at=_now(),
        message=None if code == 0 else EXIT_REASONS.get(code, f"exited {code}"),
        exit_code=code,
    )


def _start_job(name: str) -> tuple[int, dict]:
    spec = JOB_SPECS[name]
    current = _job_status(name)
    if current["state"] == "running":
        return 409, {"error": "already running", "job": name, **current}
    if name == "apply" and _pending_apply_count() == 0:
        return 400, {"error": "empty queue", "job": name, **current}
    script = spec["script"]
    if not script.is_file():
        return 500, {"error": "runner missing", "job": name}
    env = os.environ.copy()
    env.update(spec["env"])
    try:
        proc = subprocess.Popen(
            ["/bin/bash", str(script)],
            cwd=str(PROJECT_DIR),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as exc:
        return 500, {"error": str(exc), "job": name}
    started_at = _now()
    _record_job(
        name,
        state="running",
        pid=proc.pid,
        started_at=started_at,
        finished_at=None,
        message="running",
        exit_code=None,
    )
    threading.Thread(target=_watch_job, args=(name, proc, started_at), daemon=True).start()
    return 202, {"ok": True, "job": name, **_job_status(name)}


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _append_event(position: dict, event: dict) -> None:
    events = position.setdefault("events", [])
    new_id = event.get("id")
    if not new_id:
        return
    if any(e.get("id") == new_id or (event.get("external_id") and e.get("external_id") == event.get("external_id")) for e in events):
        return
    events.append({
        "id": new_id,
        "type": event.get("type") or "note",
        "at": event.get("at") or _now(),
        "source": event.get("source") or "manual",
        "title": event.get("title") or "Note",
        "detail": event.get("detail"),
        "external_id": event.get("external_id"),
    })
    events.sort(key=lambda e: e.get("at") or "")


def _apply_patch(position: dict, patch: dict, profile: dict) -> None:
    old_status = position.get("status")

    if "scores" in patch:
        new_scores = {
            k: v for k, v in patch["scores"].items()
            if k in SCORE_KEYS and isinstance(v, int) and 1 <= v <= 5
        }
        if new_scores != {k: position["scores"].get(k) for k in new_scores}:
            position["scores"].update(new_scores)
            position["score_overridden"] = True

    for key in ("reject_note", "research_md", "resume_path"):
        if key in patch and (patch[key] is None or isinstance(patch[key], str)):
            position[key] = patch[key]
    if "score_rationale" in patch and isinstance(patch["score_rationale"], dict):
        position["score_rationale"] = patch["score_rationale"]

    for flag in ("resume_requested", "apply_requested", "auto_applied", "auto_apply_queued"):
        if flag in patch and isinstance(patch[flag], bool):
            position[flag] = patch[flag]

    if "reject_reasons" in patch and isinstance(patch["reject_reasons"], list):
        position["reject_reasons"] = [str(r) for r in patch["reject_reasons"]]

    if "diary_note" in patch and isinstance(patch["diary_note"], str):
        note = patch["diary_note"].strip()
        if note:
            at = _now()
            _append_event(position, {
                "id": f"note:{at}",
                "type": "note",
                "at": at,
                "source": "manual",
                "title": "Note",
                "detail": note[:4000],
                "external_id": f"note:{at}",
            })

    if "status" in patch and patch["status"] in VALID_STATUSES and patch["status"] != old_status:
        position["status"] = patch["status"]
        at = _now()
        position.setdefault("status_history", []).append(
            {"status": patch["status"], "at": at}
        )
        _append_event(position, {
            "id": f"status:{patch['status']}:{at}",
            "type": {
                "applied": "applied",
                "screen": "screen",
                "interview": "interview",
                "offer": "offer",
                "disqualified": "rejection",
            }.get(patch["status"], "status"),
            "at": at,
            "source": "status",
            "title": patch["status"].replace("_", " ").title(),
            "detail": None,
            "external_id": f"status:{patch['status']}:{at}",
        })
        if patch["status"] == "applied":
            position["apply_requested"] = False
            if not position.get("applied_at"):
                position["applied_at"] = _now()[:10]
        if patch["status"] in {"rejected", "disqualified"}:
            position["apply_requested"] = False
        if patch["status"] == "rejected" and (position.get("reject_reasons") or position.get("reject_note")):
            profile.setdefault("learning_log", []).append({
                "date": _now()[:10],
                "company": position.get("company"),
                "title": position.get("title"),
                "reasons": position.get("reject_reasons") or [],
                "note": position.get("reject_note"),
            })

    action = patch.get("outreach_action")
    if action == "prepare":
        prepare_position(position, overwrite=True)
    elif action == "send":
        msg = patch.get("outreach_message")
        request_send(position, message=msg if isinstance(msg, str) else None)
    elif outreach_eligible(position):
        current = position.get("stakeholder_outreach") or {}
        if current.get("status") not in {"ready", "send_requested", "sent", "blocked"}:
            prepare_position(position)


# --- /api/data, the whole board in one answer -------------------------------
#
# This answer can grow to many megabytes once a few months of postings pile up.
# It only changes when the files change, so it is built once per change and
# kept, gzipped as well (JSON shrinks to roughly an eighth on the wire).
_DATA_FILES = (POSITIONS_FILE, PROFILE_FILE, STARTUPS_FILE, IGNORED_FILE, COMPANIES_FILE,
               CANDIDATE_FILE, INSIGHTS_FILE)
_data_cache_lock = threading.Lock()
_data_cache = {"key": None, "body": b"", "packed": b""}


def _data_key(jobs_bytes: bytes):
    return (tuple(_stat_key(path) for path in _DATA_FILES), jobs_bytes)


def _build_data(jobs: dict) -> bytes:
    with _lock, _file_lock():
        try:
            startups = _read(STARTUPS_FILE)
        except (OSError, json.JSONDecodeError):
            startups = {"startups": []}
        try:
            ignored = _read(IGNORED_FILE)
        except (OSError, json.JSONDecodeError):
            ignored = {"ignored": []}
        try:
            companies = _read(COMPANIES_FILE)
        except (OSError, json.JSONDecodeError):
            companies = {"companies": []}
        try:
            positions = _read(POSITIONS_FILE)
        except (OSError, json.JSONDecodeError):
            positions = None
        if not isinstance(positions, dict):
            positions = {"version": 1, "updated_at": None, "positions": []}
        positions.setdefault("positions", [])
        if POSITIONS_FILE.is_file() and _fill_missing_outreach(positions):
            positions["updated_at"] = _now()
            _write(POSITIONS_FILE, positions)
        try:
            profile = _read(PROFILE_FILE)
        except (OSError, json.JSONDecodeError):
            profile = {}
        try:
            insights = INSIGHTS_FILE.read_text(encoding="utf-8")
        except OSError:
            insights = ""
        return json.dumps({
            "positions": positions,
            "profile": profile,
            "startups": startups,
            "ignored": ignored,
            "companies": companies,
            "candidate": _load_candidate(),
            "insights_md": insights,
            "jobs": jobs,
        }, ensure_ascii=False).encode()


def _one_position(pos_id: str):
    """One whole posting, text and all.

    The list answers are about to stop carrying `jd_text` on every row, which is
    two thirds of their weight. Whoever opens a posting asks for it here instead.
    """
    with _lock, _file_lock():
        try:
            data = _read(POSITIONS_FILE)
        except (OSError, json.JSONDecodeError) as exc:
            return 500, {"error": str(exc)}
    row = next((p for p in data.get("positions", []) if p.get("id") == pos_id), None)
    if row is None:
        return 404, {"error": "unknown position"}
    return 200, row


def _data_payload(want_gzip: bool):
    """The board as bytes, and whether they came back gzipped."""
    jobs = _jobs_payload()
    jobs_bytes = json.dumps(jobs, ensure_ascii=False, sort_keys=True).encode()
    key = _data_key(jobs_bytes)
    with _data_cache_lock:
        if _data_cache["key"] == key:
            return (_data_cache["packed"], True) if want_gzip else (_data_cache["body"], False)
    body = _build_data(jobs)
    # Drafting outreach can rewrite positions.json, so the key is taken again
    # after the build. Keyed on the file as it was before, every later request
    # would miss and rebuild.
    packed = gzip.compress(body, 5)
    with _data_cache_lock:
        _data_cache.update(key=_data_key(jobs_bytes), body=body, packed=packed)
    return (packed, True) if want_gzip else (body, False)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # keep stdout quiet
        pass

    def _send(self, code: int, body: bytes, ctype: str, encoding: str = "") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The reader gave up part way through. That is their business, and a
            # 20 line traceback per occurrence buries the errors that matter.
            pass

    def _send_json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json")

    def _pin_ok(self) -> bool:
        pin = (os.environ.get("COMMAND_HUB_PIN") or "").strip()
        if not pin:
            return True
        # A caller already on this Mac is inside the boundary. The morning scan,
        # the apply worker and setup-mac.sh all curl 127.0.0.1 with no secret,
        # and locking them out would break the pipeline to protect nothing.
        try:
            if ipaddress.ip_address(self.client_address[0]).is_loopback:
                return True
        except (ValueError, IndexError):
            pass
        header = (self.headers.get("X-Command-Pin") or "").strip()
        if header and hmac.compare_digest(header, pin):
            return True
        expected = hmac.new(pin.encode(), b"command-hub-gate", hashlib.sha256).hexdigest()
        for part in (self.headers.get("Cookie") or "").split(";"):
            part = part.strip()
            if part.startswith("command_gate="):
                got = part.split("=", 1)[1].strip()
                if hmac.compare_digest(got, expected):
                    return True
        return False

    def _request_allowed(self) -> bool:
        # Host is not a browser security boundary: block DNS-rebinding from
        # public names, and cross-site form POSTs (Origin) from other pages.
        # House LAN, .local, and Tailscale names are allowed; the public internet is not.
        if not _is_house_host(_host_without_port(self.headers.get("Host", ""))):
            return False
        if not _origin_allowed(self.headers.get("Origin")):
            return False
        return self._pin_ok()

    def do_GET(self):
        path = self.path.split("?")[0]
        # /apply-file/ is intentionally cross-origin (token + explicit CORS scope guard it)
        if not path.startswith("/apply-file/") and not self._request_allowed():
            self._send_json(403, {"error": "forbidden"})
            return
        if path in STATIC_FILES:
            name, ctype = STATIC_FILES[path]
            self._send(200, (DASHBOARD_DIR / name).read_bytes(), ctype)
        elif path == "/api/data":
            wants_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "").lower()
            body, packed = _data_payload(wants_gzip)
            self._send(200, body, "application/json", "gzip" if packed else "")
        elif path == "/api/apply-progress":
            self._send_json(200, _apply_progress())
        elif path == "/api/jobs":
            self._send_json(200, _jobs_payload())
        elif path.startswith("/api/position/"):
            match = re.fullmatch(r"/api/position/([\w\-]+)", path)
            if match:
                self._send_json(*_one_position(match.group(1)))
            else:
                self._send_json(404, {"error": "not found"})
        elif path.startswith("/files/"):
            self._serve_project_file(path[len("/files/"):])
        elif path.startswith("/apply-file/"):
            self._serve_apply_file(path[len("/apply-file/"):])
        else:
            self._send_json(404, {"error": "not found"})

    def _serve_project_file(self, rel: str) -> None:
        # Only the tailored resumes and cover letters under Applications/ are
        # served. The profile and data files hold personal details and have no
        # business going out over this route.
        try:
            from urllib.parse import unquote
            target = (PROJECT_DIR / unquote(rel)).resolve()
            target.relative_to(PROJECT_DIR / "Applications")  # raises if outside
            if any(part.startswith(".") for part in target.relative_to(PROJECT_DIR).parts):
                raise ValueError("hidden file")
        except ValueError:
            self._send_json(403, {"error": "forbidden"})
            return
        if not target.is_file():
            self._send_json(404, {"error": "not found"})
            return
        ctype = "application/pdf" if target.suffix == ".pdf" else "application/octet-stream"
        self._send(200, target.read_bytes(), ctype)

    def _serve_apply_file(self, token: str) -> None:
        # one-shot bridge for uploading resumes into ATS forms from in-page JS:
        # the agent writes {token, path, origin} to .apply-file.json before an
        # upload; only that exact token serves, CORS-scoped to that one origin
        mapping_file = DATA_DIR / ".apply-file.json"
        try:
            mapping = json.loads(mapping_file.read_text())
        except (OSError, json.JSONDecodeError):
            self._send_json(404, {"error": "not found"})
            return
        if not token or token != mapping.get("token"):
            self._send_json(403, {"error": "forbidden"})
            return
        target = (PROJECT_DIR / mapping["path"]).resolve()
        try:
            target.relative_to(PROJECT_DIR)
        except ValueError:
            self._send_json(403, {"error": "forbidden"})
            return
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", mapping.get("origin", ""))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        # Chrome Private Network Access preflight for the /apply-file/ bridge
        if not self.path.startswith("/apply-file/"):
            self._send_json(404, {"error": "not found"})
            return
        try:
            origin = json.loads((DATA_DIR / ".apply-file.json").read_text()).get("origin", "")
        except (OSError, json.JSONDecodeError):
            origin = ""
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_POST(self):
        if not self._request_allowed():
            self._send_json(403, {"error": "forbidden"})
            return
        path = self.path.split("?")[0]
        job_match = re.fullmatch(r"/api/jobs/(scan|apply|inbox)", path)
        if job_match:
            code, payload = _start_job(job_match.group(1))
            self._send_json(code, payload)
            return
        match = re.fullmatch(r"/api/position/([\w\-]+)", path)
        if not match:
            self._send_json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            patch = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid JSON"})
            return
        if not isinstance(patch, dict) or not (set(patch) & PATCHABLE):
            self._send_json(400, {"error": "no patchable fields"})
            return

        with _lock, _file_lock():
            data = _read(POSITIONS_FILE)
            try:
                profile = _read(PROFILE_FILE)
            except (OSError, json.JSONDecodeError):
                profile = {}
            # Every row under this id, not the first one. Until 2026-09-09 the
            # scan could write three rows sharing an id, and this patched one of
            # them and stopped: rejecting the card moved a single row and left
            # its identical twins sitting in Review. The scan cannot do that any
            # more, but a decision must land on the whole card either way.
            matches = [p for p in data["positions"] if p["id"] == match.group(1)]
            if not matches:
                self._send_json(404, {"error": "unknown position"})
                return
            position = matches[0]
            for row in matches:
                _apply_patch(row, patch, profile)
            if len(matches) > 1:
                print(f"warning: {len(matches)} rows share id {match.group(1)}; "
                      "patched all of them. Run scripts/dedupe_positions.py --merge.")
            data["updated_at"] = _now()
            _write(POSITIONS_FILE, data)
            _write(PROFILE_FILE, profile)
            self._send_json(200, position)


if __name__ == "__main__":
    server = ThreadingHTTPServer((BIND_HOST, PORT), Handler)
    where = "this Mac and the home network" if BIND_HOST == "0.0.0.0" else "this Mac only"
    print(f"Job Search dashboard on http://localhost:{PORT} ({where})")
    server.serve_forever()
