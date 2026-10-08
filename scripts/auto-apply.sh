#!/bin/bash
# Apply runner. Runs only when the candidate presses Run apply queue on the
# dashboard; there is no schedule.
# If the apply queue is empty, exit quietly. Never opens LinkedIn on an empty run.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT/logs"
LOG="$LOG_DIR/auto-apply.log"
LOCK="$LOG_DIR/.auto-apply.lock"
# Three hours. A LinkedIn Easy Apply role takes 5 to 7 minutes; a company portal
# can take 20 or more. Three hours covers a full batch of 8 with room to spare,
# and the watchdog still ends a run that hangs.
TIMEOUT_SECONDS=10800

# MUST stay above TIMEOUT_SECONDS. This is when a *second* press is allowed to
# decide the first run died and take its lock. If it ever drops below the
# watchdog, a healthy long run gets a second agent started on top of it, both
# working the same queue, and the same role goes out twice. That is the exact
# failure that paused this whole thing on 2026-09-01. The board's own
# `stale_minutes` for apply, in dashboard/server.py, has to move with it.
STALE_LOCK_MINUTES=190

# A batch is capped at 8 so a run finishes in a predictable time and leaves the
# queue in a state that is easy to read on the dashboard.
BATCH_SIZE="${APPLY_BATCH_SIZE:-8}"

ACCOUNT="$(whoami 2>/dev/null || echo "$USER")"
export HOME="${HOME:-/Users/$ACCOUNT}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export USER="${USER:-$ACCOUNT}"
export LOGNAME="${LOGNAME:-$USER}"

mkdir -p "$LOG_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 5000 ]; then
  tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +$STALE_LOCK_MINUTES 2>/dev/null)" ]; then
    log "reclaiming stale lock"
    rmdir "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || { log "could not acquire lock, exiting"; exit 0; }
  else
    log "another run is in progress, exiting"
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

cd "$PROJECT" || { log "FATAL: project dir missing"; exit 1; }

PY_BIN="$PROJECT/.venv/bin/python"
[ -x "$PY_BIN" ] || PY_BIN="python3"
stamp_now() {
  "$PY_BIN" -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'))" >"$1"
}

# Bring the duplicate-submit ledger up to date BEFORE deciding the queue. The
# ledger is the only thing that stops a reverted positions.json resubmitting a
# role, and until 2026-09-07 nothing ever wrote to it: it held two hand-typed
# entries while 79 other submitted applications sat unprotected.
"$PY_BIN" "$PROJECT/scripts/record_ledger.py" >>"$LOG" 2>&1 || log "record_ledger failed before the run, continuing"

PENDING="$("$PY_BIN" "$PROJECT/scripts/queue_auto_apply.py" --pending-count 2>/dev/null || echo 0)"
PENDING="$(printf '%s' "$PENDING" | tr -d '[:space:]')"
case "$PENDING" in
  ''|*[!0-9]*) PENDING=0 ;;
esac

if [ "$PENDING" -eq 0 ]; then
  # A run that checked and found nothing is still a run. Without this stamp the
  # only thing that moves .last-apply-at is a submission, so an hourly worker
  # that is perfectly alive reads as "last run 35 hours ago" on the dashboard
  # whenever the queue stays empty, which is most of the time. Every submission
  # is dated in dashboard/data/applied-ledger.json, so nothing is lost by
  # letting this file mean "the worker last checked in".
  stamp_now "dashboard/data/.last-apply-at"
  log "queue empty, exiting"
  exit 0
fi

LEDGER_FILE="$PROJECT/dashboard/data/applied-ledger.json"
ledger_count() {
  "$PY_BIN" - "$LEDGER_FILE" <<'PYEOF' 2>/dev/null || echo 0
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
    print(len(data.get("submitted") or []))
except Exception:
    print(0)
PYEOF
}

# job-runs.json is what the dashboard reads to say whether this ran. It used to
# be written only by a thread inside the dashboard process, so restarting the
# dashboard mid-run lost the result and a killed run showed as idle. This script
# knows how its own run ended, so it records it here too.
record_run() {
  "$PY_BIN" - "$LOG_DIR/job-runs.json" "$1" "$2" "$3" <<'PYEOF' 2>/dev/null || true
import json, sys
from datetime import datetime, timezone
path, state, message, code = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    data = json.load(open(path, encoding="utf-8"))
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}
row = dict(data.get("apply") or {})
row.update({
    "state": state,
    "pid": None,
    "finished_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
    "message": message or None,
    "exit_code": int(code),
})
data["apply"] = row
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
import os
os.replace(tmp, path)
PYEOF
}

BEFORE="$(ledger_count)"

# The bookends are written here, not by the agent. If the agent never says
# another word, the board still knows a run is live and, later, that it ended.
# A progress file the worker alone maintained would show a frozen step forever
# the moment the agent died.
progress() { "$PY_BIN" "$PROJECT/scripts/apply_progress.py" "$@" >/dev/null 2>&1 || true; }
trap 'progress end; rmdir "$LOCK" 2>/dev/null' EXIT

if [ "$PENDING" -gt "$BATCH_SIZE" ]; then
  BATCH="$BATCH_SIZE"
  log "=== starting auto-apply: $PENDING queued, taking the first $BATCH this run ==="
else
  BATCH="$PENDING"
  log "=== starting auto-apply for $PENDING queued position(s) ==="
fi

progress start --queued "$PENDING" --batch "$BATCH"

# Password manager: file anything held during an earlier outage, then report
# whether new portal accounts can be made this run.
"$PY_BIN" "$PROJECT/scripts/save_login.py" --flush-pending >>"$LOG" 2>&1 || true
"$PY_BIN" "$PROJECT/scripts/save_login.py" --check >>"$LOG" 2>&1
case $? in
  0) PM_STATE="A password manager is connected and answering: when a portal needs an account, use scripts/save_login.py as the routine says." ;;
  1) PM_STATE="The password manager is not answering right now, which is fine: scripts/save_login.py still prints a password and holds it safely until it answers. Create accounts as the routine says." ;;
  *) PM_STATE="No password manager is connected: use Sign in with Google when offered, otherwise mark account-only portals blocked for the candidate." ;;
esac

PROMPT="Run the apply queue. Read docs/auto-apply-routine.md top to bottom, then execute it exactly as written, working autonomously and without asking questions. Apply to AT MOST $BATCH positions this run, highest overall score first, then stop and report: there are $PENDING on the queue and the rest wait for the next press of Run apply queue. If the queue is empty, stop. Do not search for new jobs. Do not message, connect, post, or change LinkedIn account settings. On success set applied_at and status applied (and auto_applied when auto_apply_queued is true). On failure leave a plain-English apply_result that tells the candidate exactly what to do next, and never claim it was applied. Report progress as you go, exactly as section 7 of the routine describes, because the candidate watches this run on the dashboard. Portals that demand a new account: follow the New accounts rule in the routine. $PM_STATE Never run op or bw yourself and never write a password anywhere. Append a dated note to docs/WORKLOG.md only if you submitted or newly blocked something."

# Not `claude` directly: agent-run.sh owns the watchdog and the timeout, and it
# never retries a task failure on another provider (re-running a half-finished
# apply could submit twice).
bash "$SCRIPT_DIR/agent-run.sh" \
  --label apply \
  --log "$LOG" \
  --timeout "$TIMEOUT_SECONDS" \
  --prompt "$PROMPT"
STATUS=$?

# Whatever was just submitted goes into the ledger before anything else, so a
# revert between now and the next run cannot put it back on the queue.
"$PY_BIN" "$PROJECT/scripts/record_ledger.py" >>"$LOG" 2>&1 || log "record_ledger failed after the run"

AFTER="$(ledger_count)"
SENT=$((AFTER - BEFORE))
[ "$SENT" -lt 0 ] && SENT=0

# A run that submitted applications and was then killed still ran, and the board
# must not report it as "last run yesterday". The stamp used to move only on a
# clean exit, which is how a run that sent 10 applications left the dashboard
# claiming nothing had happened since the day before.
if [ "$STATUS" -eq 0 ] || [ "$SENT" -gt 0 ]; then
  stamp_now "dashboard/data/.last-apply-at"
fi

if [ "$STATUS" -eq 0 ]; then
  log "=== auto-apply finished OK, $SENT submitted (provider $(cat "$LOG_DIR/.last-provider-apply" 2>/dev/null || echo unknown)) ==="
  record_run idle "$SENT submitted" 0
elif [ "$STATUS" -eq 70 ]; then
  log "=== no AI provider available, queue untouched ==="
  record_run error "no AI provider was available, nothing was submitted" "$STATUS"
elif [ "$STATUS" -eq 143 ]; then
  # Hours, not seconds: this message is shown on the dashboard.
  LIMIT_HUMAN="$(awk -v s="$TIMEOUT_SECONDS" 'BEGIN{h=s/3600; printf (h==int(h) ? "%d" : "%.1f"), h}')"
  log "=== auto-apply was killed at the ${TIMEOUT_SECONDS}s watchdog after $SENT submitted ==="
  record_run error "cut short at the $LIMIT_HUMAN hour limit after $SENT submitted, the rest are still queued" "$STATUS"
else
  log "=== auto-apply exited with status $STATUS after $SENT submitted ==="
  record_run error "exited $STATUS after $SENT submitted" "$STATUS"
fi

# Back up to GitHub if the candidate switched that on (autopush.sh checks).
bash "$SCRIPT_DIR/autopush.sh" "apply queue" >/dev/null 2>&1

exit "$STATUS"
