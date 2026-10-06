#!/bin/bash
# On-demand inbox update.
# Started from the dashboard "Update from email" button. Reads Gmail and moves
# pipeline cards when an email is a clear employer outcome. Not the Friday weekly-comms job:
# that one stays read-only and writes the digest.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT/logs"
LOG="$LOG_DIR/inbox-update.log"
LOCK="$LOG_DIR/.inbox-update.lock"
TIMEOUT_SECONDS=3600
STALE_LOCK_MINUTES=70

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
# job-runs.json is what the dashboard reads to say how this ran. The dashboard's own fallback wording for exit 143 talks about applications
# "submitted" and "still queued", which is the apply job's story, not this one.
# This script knows how its run ended, so it says so itself. started_at is left
# alone so the dashboard recognises the answer as belonging to this run.
record_run() {
  "$PY_BIN" - "$LOG_DIR/job-runs.json" "$1" "$2" "$3" <<'PYEOF' 2>/dev/null || true
import json, os, sys
from datetime import datetime, timezone
path, state, message, code = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    data = json.load(open(path, encoding="utf-8"))
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}
row = dict(data.get("inbox") or {})
row.update({
    "state": state,
    "pid": None,
    "finished_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
    "message": message or None,
    "exit_code": int(code),
})
data["inbox"] = row
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
os.replace(tmp, path)
PYEOF
}

stamp_now() {
  "$PY_BIN" -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'))" >"$1"
}

PROMPT='Run the inbox update. Read docs/inbox-update-routine.md top to bottom, then execute it exactly as written, working autonomously and without asking questions. Read the candidate'"'"'s Gmail (and Granola or Wispr Flow only if profile/candidate.json switches them on) and update dashboard/data/positions.json when an email is a clear employer outcome: a rejection moves applied/screen/interview/offer to disqualified, a first screen moves applied to screen, a later-round interview moves to interview, an offer moves to offer. Write a short diary event on the card. Do not change rejected or review cards. Do not send, reply, or mark anything read. Do not apply to any job. Re-run the classify scripts if a card moved, append a dated entry to docs/WORKLOG.md, and send the Mac notification.'

log "=== starting inbox update ==="

bash "$SCRIPT_DIR/agent-run.sh" \
  --label inbox \
  --log "$LOG" \
  --timeout "$TIMEOUT_SECONDS" \
  --prompt "$PROMPT"
STATUS=$?

"$PY_BIN" "$PROJECT/scripts/sync_diary.py" >>"$LOG" 2>&1 || log "sync_diary.py exited $?"

# The window only moves forward on success, so a failed run loses nothing: the
# next run re-reads the same mail from the last good stamp.
SINCE="$(cut -c1-10 dashboard/data/.last-inbox-at 2>/dev/null)"
SINCE="${SINCE:-the last 14 days}"
if [ "$STATUS" -eq 0 ]; then
  stamp_now "dashboard/data/.last-inbox-at"
  record_run idle "" 0
  log "=== inbox update finished OK (provider $(cat "$LOG_DIR/.last-provider-inbox" 2>/dev/null || echo unknown)) ==="
elif [ "$STATUS" -eq 70 ]; then
  record_run error "no AI provider was available, so no mail was read; the next run starts from $SINCE" "$STATUS"
  log "=== no AI provider available, inbox untouched ==="
elif [ "$STATUS" -eq 143 ] || [ "$STATUS" -eq 137 ]; then
  record_run error "stopped at the $((TIMEOUT_SECONDS / 60))-minute limit before it finished; any card it had already moved stays moved, and the next run re-reads mail from $SINCE" "$STATUS"
  log "=== inbox update exited with status $STATUS (timeout kills show as 143) ==="
else
  record_run error "the AI run failed (exit $STATUS); see logs/inbox-update.log. The next run re-reads mail from $SINCE" "$STATUS"
  log "=== inbox update exited with status $STATUS ==="
fi

bash "$SCRIPT_DIR/autopush.sh" "inbox update" >/dev/null 2>&1

exit "$STATUS"
