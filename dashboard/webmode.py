"""Web mode: the job search as a password-protected page for someone in the house.

Switched on by `profile/candidate.json → dashboard.web_login: true` (see
docs/WEB-MODE.md). It adds, on top of the plain dashboard:

* a login page and a session cookie (the password is set with
  scripts/set_web_password.py; only its PBKDF2 hash is kept, in .secrets/),
* a chat with Claude that runs the onboarding interview and, afterwards, takes
  any change the candidate asks for (`/api/chat`),
* resume upload (`/api/upload`),
* "Connect Gmail" through Google's own consent screen (`/oauth/google/...`),
* the "My answers" form (`/api/answers`).

Callers on this Mac itself (127.0.0.1) skip the login, exactly as before: the
scheduled jobs and setup-mac.sh talk to the dashboard that way.

Standard library only, and Python 3.9 compatible (the LaunchAgent uses the
Mac's built-in /usr/bin/python3).
"""

from __future__ import annotations

import base64
import fcntl
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

DASHBOARD_DIR = Path(__file__).resolve().parent
PROJECT_DIR = DASHBOARD_DIR.parent
DATA_DIR = DASHBOARD_DIR / "data"
SECRETS_DIR = PROJECT_DIR / ".secrets"
LOGIN_FILE = SECRETS_DIR / "web-login.json"
SESSIONS_FILE = SECRETS_DIR / "web-sessions.json"
CANDIDATE_FILE = PROJECT_DIR / "profile" / "candidate.json"
SCORING_FILE = DATA_DIR / "scoring-profile.json"
CHAT_DIR = PROJECT_DIR / "profile" / "chat"
UPLOAD_DIR = PROJECT_DIR / "profile" / "uploads"
LOCK_FILE = DATA_DIR / ".lock"
LOG_DIR = PROJECT_DIR / "logs"
CHAT_RULES = PROJECT_DIR / "docs" / "WEB-CHAT.md"

sys.path.insert(0, str(PROJECT_DIR / "scripts"))
import gmail  # noqa: E402
import instance  # noqa: E402

COOKIE = "js_web"
SESSION_DAYS = 120
MAX_UPLOAD = 15 * 1024 * 1024
UPLOAD_TYPES = {".pdf", ".docx", ".doc", ".txt", ".rtf", ".md", ".odt", ".pages", ".png", ".jpg", ".jpeg"}
TURN_TIMEOUT = 15 * 60
MODES = ("onboarding", "assistant")

# What the chat's Claude may do without anyone approving it. Everything else is
# refused (permission mode dontAsk). File tools are held to this folder by
# Claude Code itself; writes only to the candidate's own files.
CHAT_TOOLS = [
    "Read(./**)", "Glob(./**)", "Grep(./**)", "WebFetch", "WebSearch", "TodoWrite",
    "Edit(./profile/**)", "Edit(./dashboard/data/**)", "Edit(./tailor/**)",
    "Edit(./Applications/**)", "Edit(./Resume/**)", "Edit(./docs/WORKLOG.md)",
    "Bash(.venv/bin/python generate_resume.py*)",
    "Bash(.venv/bin/python scripts/*)",
    # Exact shapes only: a free-form textutil or soffice could write a file
    # anywhere, including a script the next rule would then run.
    "Bash(textutil -convert txt -stdout *)",
    "Bash(soffice --headless --convert-to pdf --outdir Resume *)",
    "Bash(soffice --headless --convert-to pdf --outdir Applications/*)",
    "Bash(ls)", "Bash(ls *)",
]
# `scripts/../profile/x.py` would otherwise pass the scripts/ rule and run a file
# the chat itself can write. No legitimate chat command needs "..".
# .secrets/ holds the Gmail key, the Google app secret and the login hash: the
# chat can fetch web pages, so it must never be able to read them.
CHAT_DENY = ["Bash(*..*)", "Bash(*.secrets*)", "Bash(*-output*)", "Bash(*--outdir*--outdir*)",
             "Bash(*>*)", "Bash(*|*)", "Bash(*`*)", "Bash(*$(*)",
             "Read(./.secrets/**)", "Edit(./.secrets/**)"]


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _read_json(path: Path, default):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default
    return data if isinstance(data, type(default)) else default


def _write_json(path: Path, data, secret: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if secret:
        os.chmod(path.parent, 0o700)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600 if secret else 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    tmp.replace(path)


@contextmanager
def _file_lock():
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK_FILE, "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def candidate() -> dict:
    return _read_json(CANDIDATE_FILE, {})


def enabled() -> bool:
    # A password on file keeps the login on even if candidate.json is edited
    # (the chat can write that file; it cannot touch .secrets/).
    return password_set() or (candidate().get("dashboard") or {}).get("web_login") is True


def onboarded() -> bool:
    return candidate().get("onboarded") is True


def language() -> str:
    lang = str(candidate().get("language") or "").lower()
    return lang if lang in ("pt", "en") else ""


def _update_candidate(fn) -> dict:
    with _file_lock():
        data = _read_json(CANDIDATE_FILE, {})
        fn(data)
        _write_json(CANDIDATE_FILE, data)
        return data


# ---------------------------------------------------------------- passwords and sessions

def hash_password(password: str, salt: bytes | None = None, rounds: int = 310000) -> dict:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, rounds)
    return {"salt": base64.b64encode(salt).decode(), "hash": base64.b64encode(digest).decode(),
            "rounds": rounds, "set_at": _now()}


def _password_ok(password: str) -> bool:
    rec = _read_json(LOGIN_FILE, {})
    if not rec.get("hash"):
        return False
    try:
        salt = base64.b64decode(rec["salt"])
        want = base64.b64decode(rec["hash"])
        got = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(rec.get("rounds") or 310000))
    except (ValueError, TypeError, KeyError):
        return False
    return hmac.compare_digest(got, want)


def password_set() -> bool:
    return bool(_read_json(LOGIN_FILE, {}).get("hash"))


_sessions_lock = threading.Lock()


def _token_key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _new_session(ip: str) -> str:
    token = secrets.token_urlsafe(32)
    with _sessions_lock:
        rows = _read_json(SESSIONS_FILE, {})
        cutoff = time.time() - SESSION_DAYS * 86400
        rows = {k: v for k, v in rows.items() if float(v.get("last", 0)) > cutoff}
        rows[_token_key(token)] = {"created": time.time(), "last": time.time(), "ip": ip}
        _write_json(SESSIONS_FILE, rows, secret=True)
    return token


def _session_valid(token: str) -> bool:
    if not token:
        return False
    key = _token_key(token)
    with _sessions_lock:
        rows = _read_json(SESSIONS_FILE, {})
        row = rows.get(key)
        if not row or float(row.get("last", 0)) < time.time() - SESSION_DAYS * 86400:
            return False
        # Touch at most hourly, so reading the board is not a disk write each time.
        if time.time() - float(row.get("last", 0)) > 3600:
            row["last"] = time.time()
            _write_json(SESSIONS_FILE, rows, secret=True)
    return True


def _drop_session(token: str) -> None:
    with _sessions_lock:
        rows = _read_json(SESSIONS_FILE, {})
        if rows.pop(_token_key(token), None) is not None:
            _write_json(SESSIONS_FILE, rows, secret=True)


def drop_all_sessions() -> None:
    with _sessions_lock:
        _write_json(SESSIONS_FILE, {}, secret=True)


# Failed logins, per address: a short pause that doubles with each miss.
_fails: dict = {}
_fails_lock = threading.Lock()


def _locked_out(ip: str) -> float:
    with _fails_lock:
        row = _fails.get(ip)
        if not row:
            return 0
        return max(0.0, row["until"] - time.time())


def _note_fail(ip: str) -> None:
    with _fails_lock:
        row = _fails.setdefault(ip, {"n": 0, "until": 0})
        row["n"] += 1
        if row["n"] >= 5:
            row["until"] = time.time() + min(3600, 30 * 2 ** (row["n"] - 5))


def _clear_fails(ip: str) -> None:
    with _fails_lock:
        _fails.pop(ip, None)


def _cookie(handler) -> str:
    for part in (handler.headers.get("Cookie") or "").split(";"):
        part = part.strip()
        if part.startswith(COOKIE + "="):
            return part.split("=", 1)[1].strip()
    return ""


def _is_loopback(handler) -> bool:
    try:
        return ipaddress.ip_address(handler.client_address[0]).is_loopback
    except (ValueError, IndexError):
        return False


def authed(handler) -> bool:
    if not enabled() or _is_loopback(handler):
        return True
    return _session_valid(_cookie(handler))


# ---------------------------------------------------------------- the chat

def _chat_file(mode: str) -> Path:
    return CHAT_DIR / f"{mode}.json"


def _load_chat(mode: str) -> dict:
    data = _read_json(_chat_file(mode), {})
    data.setdefault("session_id", None)
    data.setdefault("messages", [])
    return data


MARKER = re.compile(r"\[\[\s*(choices|button|file|do)\s*:\s*(.*?)\s*\]\]", re.S | re.I)
BUTTONS = {"connect-gmail", "upload-resume", "open-panel", "search-now"}
ACTIONS = {"start-search", "finish-onboarding", "reschedule"}


def parse_reply(text: str) -> dict:
    """Pull the page markers out of what Claude wrote."""
    out = {"text": "", "choices": [], "buttons": [], "files": [], "actions": []}
    for kind, value in MARKER.findall(text):
        kind = kind.lower()
        if kind == "choices":
            out["choices"] += [c.strip().strip("\\").strip() for c in value.split("|") if c.strip().strip("\\").strip()][:8]
        elif kind == "button" and value.strip().lower() in BUTTONS:
            out["buttons"].append(value.strip().lower())
        elif kind == "file":
            rel = value.strip().lstrip("/")
            if _servable(rel):
                out["files"].append(rel)
        elif kind == "do" and value.strip().lower() in ACTIONS:
            out["actions"].append(value.strip().lower())
    out["text"] = re.sub(r"\n{3,}", "\n\n", MARKER.sub("", text)).strip()
    return out


def _servable(rel: str):
    """A file the page may show: resumes and cover letters only."""
    try:
        target = (PROJECT_DIR / unquote(rel)).resolve()
        inside = target.relative_to(PROJECT_DIR)
    except ValueError:
        return None
    if inside.parts[:1] not in (("Applications",), ("Resume",)):
        return None
    if any(part.startswith(".") for part in inside.parts) or not target.is_file():
        return None
    return target


TOOL_WORDS = {
    "Read": "reading", "Glob": "looking through files", "Grep": "looking through files",
    "Write": "saving", "Edit": "saving", "WebFetch": "reading a web page",
    "WebSearch": "searching the web", "Bash": "working", "TodoWrite": "planning",
}


class Chat:
    """One Claude turn at a time, streamed into memory so the page can poll it."""

    def __init__(self, start_job, reschedule):
        self._lock = threading.Lock()
        self._start_job = start_job
        self._reschedule = reschedule
        self.busy = None  # {"mode", "started", "partial", "status"}
        self.last_error = {}

    def state(self, mode: str) -> dict:
        data = _load_chat(mode)
        busy = self.busy if self.busy and self.busy.get("mode") == mode else None
        visible = [m for m in data["messages"] if not m.get("hidden")]
        return {
            "mode": mode,
            "messages": visible,
            "busy": bool(busy),
            "partial": busy.get("partial", "") if busy else "",
            "status": busy.get("status", "") if busy else "",
            "started": busy.get("started") if busy else None,
            "error": self.last_error.get(mode, ""),
            "other_busy": bool(self.busy) and not busy,
        }

    def send(self, mode: str, text: str, hidden: bool = False, attachment: str | None = None):
        text = (text or "").strip()
        if mode not in MODES or not text:
            return 400, {"error": "nothing to send"}
        with self._lock:
            if self.busy:
                return 409, {"error": "busy"}
            self.busy = {"mode": mode, "started": _now(), "partial": "", "status": "thinking"}
        self.last_error.pop(mode, None)
        data = _load_chat(mode)
        msg = {"role": "user", "text": text[:8000], "at": _now()}
        if hidden:
            msg["hidden"] = True
        if attachment:
            msg["attachment"] = attachment
        data["messages"].append(msg)
        _write_json(_chat_file(mode), data)
        threading.Thread(target=self._run, args=(mode, text), daemon=True).start()
        return 202, {"ok": True}

    def reset(self, mode: str) -> None:
        if mode in MODES and not (self.busy and self.busy.get("mode") == mode):
            try:
                _chat_file(mode).unlink()
            except FileNotFoundError:
                pass

    # -- the Claude run

    def _rules(self, mode: str) -> str:
        try:
            rules = CHAT_RULES.read_text(encoding="utf-8")
        except OSError:
            rules = ""
        lang = language()
        speak = {"pt": "Brazilian Portuguese", "en": "English"}.get(lang, "English")
        return (
            f"{rules}\n\n## This conversation\n\n"
            f"- Mode: **{mode}**.\n"
            f"- Speak {speak} with the candidate (unless they switch language).\n"
            f"- Today is {datetime.now().strftime('%A %Y-%m-%d')}.\n"
            f"- The project folder is {PROJECT_DIR}."
        )

    def _cmd(self, mode: str, text: str, session_id: str | None) -> list[str]:
        claude = next((c for c in (Path.home() / ".local/bin/claude", Path.home() / ".claude/local/claude",
                                   Path("/opt/homebrew/bin/claude"), Path("/usr/local/bin/claude"))
                       if c.is_file()), Path("claude"))
        # The message goes in on stdin, never as an argument: a message that
        # starts with "-" (a pasted bullet list) would be read as an option.
        cmd = [str(claude), "-p", "--output-format", "stream-json", "--verbose",
               "--include-partial-messages", "--append-system-prompt", self._rules(mode),
               "--permission-mode", "dontAsk", "--allowedTools", ",".join(CHAT_TOOLS),
               "--disallowedTools", ",".join(CHAT_DENY)]
        cmd += ["--resume", session_id] if session_id else ["--session-id", str(uuid.uuid4())]
        return cmd + instance.claude_args()

    def _run(self, mode: str, text: str) -> None:
        data = _load_chat(mode)
        session_id = data.get("session_id")
        env = instance.claude_env()
        env["PATH"] = f"{Path.home()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        env.setdefault("USER", os.environ.get("USER") or Path.home().name)
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        pieces: list[str] = []
        current = ""
        new_session = None
        error = ""
        result_text = None
        try:
            proc = subprocess.Popen(self._cmd(mode, text, session_id), cwd=str(PROJECT_DIR), env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=open(LOG_DIR / "web-chat.err.log", "a"), text=True, bufsize=1)
            proc.stdin.write(text)
            proc.stdin.close()
        except OSError as exc:
            self._finish(mode, None, "", f"could not start Claude ({exc})")
            return
        killer = threading.Timer(TURN_TIMEOUT, proc.kill)
        killer.start()
        try:
            for line in proc.stdout:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(ev, dict):
                    continue
                kind = ev.get("type")
                if kind == "system" and ev.get("subtype") == "init":
                    new_session = ev.get("session_id") or new_session
                elif kind == "stream_event":
                    e = ev.get("event") or {}
                    if e.get("type") == "message_start" and current.strip():
                        pieces.append(current.strip())
                        current = ""
                    delta = e.get("delta") or {}
                    if delta.get("type") == "text_delta":
                        current += delta.get("text", "")
                        self.busy["status"] = "writing"
                    elif e.get("type") == "content_block_start":
                        block = e.get("content_block") or {}
                        if block.get("type") == "tool_use":
                            self.busy["status"] = TOOL_WORDS.get(block.get("name", ""), "working")
                    self.busy["partial"] = parse_reply("\n\n".join(pieces + [current]))["text"]
                elif kind == "result":
                    new_session = ev.get("session_id") or new_session
                    result_text = ev.get("result") or ""
                    if ev.get("is_error"):
                        error = str(result_text or "Claude stopped with an error")[:300]
            proc.wait()
        except Exception as exc:  # whatever happens, the chat must not stay "busy" for ever
            error = f"the assistant's answer could not be read ({exc})"
            try:
                proc.kill()
            except OSError:
                pass
        finally:
            killer.cancel()
        if current.strip():
            pieces.append(current.strip())
        reply = "\n\n".join(pieces).strip() or (result_text or "").strip()
        if proc.returncode not in (0, None) and not error:
            error = "the assistant took too long and was stopped" if proc.returncode in (-9, 137) \
                else f"the assistant stopped unexpectedly (exit {proc.returncode})"
        self._finish(mode, new_session or session_id, reply, error)

    def _finish(self, mode: str, session_id, reply: str, error: str) -> None:
        data = _load_chat(mode)
        if session_id:
            data["session_id"] = session_id
        parsed = parse_reply(reply) if reply else None
        if parsed and (parsed["text"] or parsed["choices"] or parsed["buttons"]):
            data["messages"].append({"role": "assistant", "at": _now(), **parsed})
        _write_json(_chat_file(mode), data)
        if error:
            self.last_error[mode] = error
        with self._lock:
            self.busy = None
        for action in (parsed or {}).get("actions", []):
            try:
                self._do(action)
            except Exception as exc:  # an action failing must never take the chat down
                self.last_error[mode] = f"{action} did not work: {exc}"

    def _do(self, action: str) -> None:
        if action == "start-search":
            self._start_job("scan")
        elif action == "reschedule":
            self._reschedule()
        elif action == "finish-onboarding":
            def mark(c):
                c["onboarded"] = True
            _update_candidate(mark)
            try:
                (PROJECT_DIR / "profile" / "onboarding-progress.json").unlink()
            except FileNotFoundError:
                pass
            # The scheduled search is only switched on once the interview is done,
            # so it never runs against a half-filled profile.
            self._reschedule()


# ---------------------------------------------------------------- answers ("My answers" tab)

def _list_of_str(v, limit=40, size=120):
    return [str(x).strip()[:size] for x in (v if isinstance(v, list) else []) if str(x).strip()][:limit]


def _url_or_blank(v) -> str:
    v = str(v or "").strip()[:500]
    if v and not re.match(r"^https?://", v, re.I):
        v = "https://" + v
    return v if not v or re.match(r"^https?://[^\s/$.?#][^\s]*$", v, re.I) else ""


SOURCE_KEYS = ("linkedin_sweep", "linkedin_alert_emails", "yc_jobs", "wellfound", "communitech", "startup_watch")


def answers() -> dict:
    c = candidate()
    s = _read_json(SCORING_FILE, {})
    comp = (s.get("dimensions") or {}).get("comp") or {}
    loc = (s.get("dimensions") or {}).get("location") or {}
    home = c.get("home_area") or {}
    return {
        "language": language() or "en",
        "titles": _list_of_str((s.get("search_scope") or {}).get("titles") or c.get("target_titles")),
        "companies": [{"name": str(x.get("name", "")), "url": str(x.get("url", ""))}
                      for x in c.get("target_companies") or [] if isinstance(x, dict)],
        "sites": [{"url": str(x.get("url", "")), "note": str(x.get("note", ""))}
                  for x in (c.get("sources") or {}).get("custom_sites") or [] if isinstance(x, dict)],
        "home_label": str(home.get("label", "")),
        "radius_km": home.get("radius_km", 40),
        "remote_ok": loc.get("remote_must_be_in_country", True) is not None,
        "max_office_days": loc.get("max_office_days_home_area", 3),
        "relocate": bool(loc.get("willing_to_relocate", False)),
        "pay_floor": comp.get("floor", 0),
        "pay_goal": comp.get("bonus", 0),
        "currency": c.get("currency", "CAD"),
        "off_limits": _list_of_str(list(dict.fromkeys(
            _list_of_str((c.get("industries") or {}).get("off_limits"))
            + _list_of_str((s.get("hard_exclusions") or {}).get("industries"))))),
        "search_times": _list_of_str((c.get("schedule") or {}).get("search_times"), 4, 5),
        "sources": {k: bool((c.get("sources") or {}).get(k, False)) for k in SOURCE_KEYS},
        "summary": str(s.get("plain_summary") or c.get("goal_summary") or ""),
        "gmail": gmail_status(),
    }


def save_answers(body: dict) -> tuple[int, dict]:
    changed_schedule = False
    titles = _list_of_str(body.get("titles"), 20)
    companies = []
    for x in body.get("companies") or []:
        if isinstance(x, dict) and str(x.get("name", "")).strip():
            companies.append({"name": str(x["name"]).strip()[:120], "url": _url_or_blank(x.get("url"))})
    sites = []
    for x in body.get("sites") or []:
        if isinstance(x, dict) and _url_or_blank(x.get("url")):
            sites.append({"url": _url_or_blank(x["url"]), "note": str(x.get("note", "")).strip()[:200]})
    times = []
    for t in body.get("search_times") or []:
        m = re.fullmatch(r"(\d{1,2}):(\d{2})", str(t).strip())
        if m and int(m.group(1)) < 24 and int(m.group(2)) < 60:
            times.append(f"{int(m.group(1)):02d}:{m.group(2)}")
    times = sorted(set(times))[:3]

    def num(v, lo=0, hi=10_000_000):
        try:
            return max(lo, min(hi, int(float(str(v).replace(",", "").replace("$", "").strip() or 0))))
        except ValueError:
            return lo

    with _file_lock():
        c = _read_json(CANDIDATE_FILE, {})
        s = _read_json(SCORING_FILE, {})
        if body.get("language") in ("pt", "en"):
            c["language"] = body["language"]
        if "titles" in body:
            c["target_titles"] = titles
            s.setdefault("search_scope", {})["titles"] = titles
        if "companies" in body:
            c["target_companies"] = companies
        if "sites" in body:
            c.setdefault("sources", {})["custom_sites"] = sites
        if isinstance(body.get("sources"), dict):
            for k in SOURCE_KEYS:
                if k in body["sources"]:
                    c.setdefault("sources", {})[k] = bool(body["sources"][k])
        if "home_label" in body:
            c.setdefault("home_area", {})["label"] = str(body.get("home_label") or "").strip()[:120]
        if "radius_km" in body:
            c.setdefault("home_area", {})["radius_km"] = num(body.get("radius_km"), 0, 500)
        dims = s.setdefault("dimensions", {})
        if "max_office_days" in body:
            dims.setdefault("location", {})["max_office_days_home_area"] = num(body.get("max_office_days"), 0, 5)
        if "relocate" in body:
            dims.setdefault("location", {})["willing_to_relocate"] = bool(body.get("relocate"))
        if "pay_floor" in body:
            dims.setdefault("comp", {})["floor"] = num(body.get("pay_floor"))
        if "pay_goal" in body:
            dims.setdefault("comp", {})["bonus"] = num(body.get("pay_goal"))
        if "off_limits" in body:
            off = _list_of_str(body.get("off_limits"), 30)
            c.setdefault("industries", {})["off_limits"] = off
            s.setdefault("hard_exclusions", {})["industries"] = off
        if "search_times" in body and times:
            old = (c.get("schedule") or {}).get("search_times")
            c.setdefault("schedule", {})["search_times"] = times
            changed_schedule = old != times
        s["updated_at"] = _now()
        _write_json(CANDIDATE_FILE, c)
        if SCORING_FILE.exists() or s:
            _write_json(SCORING_FILE, s)
    _worklog("Answers changed on the web page (My answers).")
    return 200, {"ok": True, "reschedule": changed_schedule}


def _worklog(line: str) -> None:
    path = PROJECT_DIR / "docs" / "WORKLOG.md"
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"\n## {datetime.now().strftime('%Y-%m-%d %H:%M')} (web page)\n\n- {line}\n")
    except OSError:
        pass


# ---------------------------------------------------------------- Gmail

def gmail_status() -> dict:
    t = gmail.token()
    return {"connected": bool(t.get("refresh_token")), "email": t.get("email", ""),
            "app_ready": gmail.client_ready()}


_oauth_nonces: dict = {}


def _oauth_state(host: str) -> str:
    nonce = secrets.token_urlsafe(18)
    now = time.time()
    for k in [k for k, v in _oauth_nonces.items() if v < now]:
        _oauth_nonces.pop(k, None)
    _oauth_nonces[nonce] = now + 900
    payload = json.dumps({"n": nonce, "r": f"http://{host}/oauth/google/callback"}, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


def _oauth_check(state: str) -> bool:
    try:
        raw = base64.urlsafe_b64decode(state + "=" * (-len(state) % 4))
        nonce = json.loads(raw).get("n", "")
    except (ValueError, TypeError):
        return False
    expiry = _oauth_nonces.pop(nonce, 0)
    return expiry > time.time()


# ---------------------------------------------------------------- HTTP

def _page(name: str) -> bytes:
    return (DASHBOARD_DIR / name).read_bytes()


class Web:
    """Routes for web mode. `handle` returns True when it answered the request."""

    PUBLIC = {"/login", "/api/login", "/i18n.js", "/web.css"}

    def __init__(self, start_job, server_port: int):
        self.port = server_port
        self.chat = Chat(start_job, self._reschedule)

    def _reschedule(self) -> None:
        subprocess.Popen(["/bin/bash", str(PROJECT_DIR / "scripts/setup-mac.sh"), "--schedule-jobs"],
                         cwd=str(PROJECT_DIR), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)

    # -- helpers

    @staticmethod
    def _body(h, limit: int = 1_000_000):
        try:
            length = int(h.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length < 0 or length > limit:
            return None
        raw = h.rfile.read(length) if length else b""
        try:
            data = json.loads(raw or b"{}")
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    @staticmethod
    def _redirect(h, where: str, cookie: str | None = None) -> None:
        h.send_response(302)
        h.send_header("Location", where)
        h.send_header("Cache-Control", "no-store")
        if cookie is not None:
            h.send_header("Set-Cookie", cookie)
        h.send_header("Content-Length", "0")
        h.end_headers()

    @staticmethod
    def _cookie_header(token: str, max_age: int) -> str:
        return f"{COOKIE}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax"

    def _mode(self, qs) -> str:
        mode = (qs.get("mode") or [""])[0]
        if mode in MODES:
            return mode
        return "assistant" if onboarded() else "onboarding"

    # -- entry point

    def handle(self, h, method: str) -> bool:
        if not enabled():
            return False
        parsed = urlparse(h.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        # Belt and braces on top of server.py's Origin check: a browser marks a
        # request another site started as cross-site, and that is never us.
        # This also covers a browser on this Mac, which skips the login.
        if method == "POST" and (h.headers.get("Sec-Fetch-Site") or "").lower() == "cross-site":
            h._send_json(403, {"error": "forbidden"})
            return True
        if (method == "POST" and path != "/api/upload"
                and "application/json" not in (h.headers.get("Content-Type") or "").lower()):
            # A plain HTML form cannot send JSON, so this rules out form-based forgery.
            h._send_json(415, {"error": "JSON only"})
            return True

        if path == "/login" and method == "GET":
            h._send(200, _page("login.html"), "text/html; charset=utf-8")
            return True
        if path == "/i18n.js":
            h._send(200, _page("i18n.js"), "text/javascript; charset=utf-8")
            return True
        if path == "/web.css":
            h._send(200, _page("web.css"), "text/css; charset=utf-8")
            return True
        if path == "/api/login" and method == "POST":
            self._login(h)
            return True

        if not authed(h):
            if path.startswith("/api/") or method != "GET":
                h._send_json(401, {"error": "login required"})
            else:
                self._redirect(h, "/login")
            return True

        if path == "/api/logout" and method == "POST":
            _drop_session(_cookie(h))
            h.send_response(200)
            h.send_header("Set-Cookie", self._cookie_header("", 0))
            h.send_header("Content-Type", "application/json")
            h.send_header("Content-Length", "2")
            h.end_headers()
            h.wfile.write(b"{}")
            return True

        if method == "GET" and path in ("/", "/index.html") and not onboarded():
            h._send(200, _page("welcome.html"), "text/html; charset=utf-8")
            return True
        if method == "GET" and path in ("/", "/index.html"):
            h._send(200, self._panel(), "text/html; charset=utf-8")
            return True
        if method == "GET" and path == "/welcome":
            h._send(200, _page("welcome.html"), "text/html; charset=utf-8")
            return True
        if method == "GET" and path in ("/chat.js", "/web.js"):
            h._send(200, _page(path[1:]), "text/javascript; charset=utf-8")
            return True

        if path == "/api/web" and method == "GET":
            c = candidate()
            h._send_json(200, {"web": True, "onboarded": onboarded(), "language": language(),
                               "first_name": c.get("first_name") or "", "gmail": gmail_status(),
                               "busy": bool(self.chat.busy)})
            return True
        if path == "/api/language" and method == "POST":
            body = self._body(h) or {}
            lang = body.get("language")
            if lang not in ("pt", "en"):
                h._send_json(400, {"error": "pt or en"})
                return True
            _update_candidate(lambda c: c.__setitem__("language", lang))
            h._send_json(200, {"ok": True, "language": lang})
            return True

        if path == "/api/chat":
            if method == "GET":
                h._send_json(200, self.chat.state(self._mode(qs)))
            elif method == "POST":
                body = self._body(h)
                if body is None:
                    h._send_json(400, {"error": "invalid JSON"})
                    return True
                mode = body.get("mode") if body.get("mode") in MODES else self._mode(qs)
                code, out = self.chat.send(mode, str(body.get("text") or ""), bool(body.get("hidden")),
                                           body.get("attachment") if isinstance(body.get("attachment"), str) else None)
                h._send_json(code, out)
            return True
        if path == "/api/chat/reset" and method == "POST":
            body = self._body(h) or {}
            self.chat.reset(str(body.get("mode") or ""))
            h._send_json(200, {"ok": True})
            return True

        if path == "/api/upload" and method == "POST":
            self._upload(h, qs)
            return True

        if path == "/api/answers":
            if method == "GET":
                h._send_json(200, answers())
            else:
                body = self._body(h)
                if body is None:
                    h._send_json(400, {"error": "invalid JSON"})
                    return True
                code, out = save_answers(body)
                if out.get("reschedule"):
                    self._reschedule()
                h._send_json(code, out)
            return True

        if path == "/oauth/google/start" and method == "GET":
            if not gmail.client_ready():
                self._redirect(h, "/?gmail=error&why=" + quote("the Google app is not set up yet"))
                return True
            host = h.headers.get("Host") or f"localhost:{self.port}"
            self._redirect(h, gmail.auth_url(_oauth_state(host)))
            return True
        if path == "/oauth/google/callback" and method == "GET":
            self._oauth_callback(h, qs)
            return True
        if path == "/api/gmail/disconnect" and method == "POST":
            gmail.disconnect()

            def off(c):
                c.setdefault("integrations", {})["gmail"] = "none"
                c.pop("gmail_address", None)
            _update_candidate(off)
            h._send_json(200, {"ok": True})
            return True

        if path.startswith("/files/") and method == "GET":
            target = _servable(path[len("/files/"):])
            if not target:
                h._send_json(404, {"error": "not found"})
            else:
                ctype = "application/pdf" if target.suffix.lower() == ".pdf" else "application/octet-stream"
                h._send(200, target.read_bytes(), ctype)
            return True
        return False

    @staticmethod
    def _panel() -> bytes:
        """The plain dashboard page, with the web-mode scripts and language added."""
        page = _page("index.html").decode("utf-8")
        lang = language() or "en"
        page = page.replace('<html lang="en">', f'<html lang="{"pt-BR" if lang == "pt" else "en"}" data-lang="{lang}">', 1)
        page = page.replace('<link rel="stylesheet" href="/styles.css', '<link rel="stylesheet" href="/web.css?v=w1">\n<link rel="stylesheet" href="/styles.css', 1)
        page = page.replace('<script src="/app.js', '<script src="/i18n.js?v=w1"></script>\n<script src="/chat.js?v=w1"></script>\n'
                                                   '<script src="/web.js?v=w1"></script>\n<script src="/app.js', 1)
        return page.encode("utf-8")

    def _login(self, h) -> None:
        ip = h.client_address[0] if h.client_address else "?"
        wait = _locked_out(ip)
        if wait:
            h._send_json(429, {"error": "too many tries", "wait": int(wait) + 1})
            return
        body = self._body(h, 10_000) or {}
        password = str(body.get("password") or "")
        if not password_set() or not _password_ok(password):
            _note_fail(ip)
            time.sleep(1)  # slow guessing down without telling it anything
            h._send_json(403, {"error": "wrong password"})
            return
        _clear_fails(ip)
        token = _new_session(ip)
        h.send_response(200)
        h.send_header("Set-Cookie", self._cookie_header(token, SESSION_DAYS * 86400))
        h.send_header("Content-Type", "application/json")
        h.send_header("Cache-Control", "no-store")
        h.send_header("Content-Length", "11")
        h.end_headers()
        h.wfile.write(b'{"ok":true}')

    def _upload(self, h, qs) -> None:
        name = os.path.basename(unquote((qs.get("name") or ["resume"])[0]))[:120]
        ext = os.path.splitext(name)[1].lower()
        try:
            length = int(h.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if ext not in UPLOAD_TYPES:
            h._send_json(400, {"error": "type", "allowed": sorted(UPLOAD_TYPES)})
            return
        if length <= 0 or length > MAX_UPLOAD:
            h._send_json(413, {"error": "size", "max_mb": MAX_UPLOAD // (1024 * 1024)})
            return
        data = h.rfile.read(length)
        safe = re.sub(r"[^\w.\- ]+", "_", name).strip() or f"file{ext}"
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        target = UPLOAD_DIR / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{safe}"
        target.write_bytes(data)
        h._send_json(200, {"ok": True, "path": str(target.relative_to(PROJECT_DIR)), "name": name})

    def _oauth_callback(self, h, qs) -> None:
        state = (qs.get("state") or [""])[0]
        if (qs.get("error") or [""])[0]:
            why = "you closed the Google window or said no" if qs["error"][0] == "access_denied" else qs["error"][0]
            self._redirect(h, "/?gmail=error&why=" + quote(why))
            return
        if not _oauth_check(state):
            self._redirect(h, "/?gmail=error&why=" + quote("that link was old; press Connect Gmail again"))
            return
        try:
            email = gmail.exchange_code((qs.get("code") or [""])[0])
        except gmail.GmailError as exc:
            self._redirect(h, "/?gmail=error&why=" + quote(str(exc)))
            return

        def on(c):
            c.setdefault("integrations", {})["gmail"] = "google-oauth"
            c["gmail_address"] = email
            # Strong-match emails need permission to send, which this connection
            # deliberately does not ask for. The page shows them instead.
            c.setdefault("notifications", {})["email_strong_matches"] = False
        _update_candidate(on)
        mode = "assistant" if onboarded() else "onboarding"
        if not self.chat.busy:
            self.chat.send(mode, f"[Page note, not typed by the candidate] Gmail is now connected "
                                 f"(read-only) as {email}. Carry on from where we were.", hidden=True)
        self._redirect(h, "/?gmail=connected")
