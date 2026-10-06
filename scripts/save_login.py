#!/usr/bin/env python3
"""Create (or recover) a job-portal login and hand back the password.

The apply job uses this when a portal will only take an application after you
make an account. It generates a strong password, files it in the candidate's
password manager, and prints ONLY the password on stdout so the browser step
can type it. Everything else goes to stderr.

    save_login.py --title "Acme Workday" --url https://acme.wd1.myworkdayjobs.com/
    save_login.py --check            can this Mac file a password right now?
    save_login.py --flush-pending    file anything held during an outage
    save_login.py --list             titles created by the job search (no passwords)
    save_login.py --export-csv apple|google <file>   (Mac Keychain mode only)

Which password manager: `profile/candidate.json → integrations.password_manager`
  "1password"     1Password service account, vault `integrations.password_vault`
                  (default "Job Portals"). Fully unattended. Recommended.
  "bitwarden"     Bitwarden CLI with an API key; unattended because the master
                  password is kept in the Mac's Keychain.
  "mac-keychain"  The Mac's own Keychain. Unattended, but Apple Passwords and
                  Google Password Manager cannot be written to by a program, so
                  the candidate imports the logins there with --export-csv.
  "none" / unset  Account creation is off; the apply job marks those roles for
                  the candidate to do by hand.

Credentials for the password manager itself live in the macOS Keychain under
service "job-search" (put there by scripts/connect-password-manager.sh), never
in a file in this folder.

Guarantees:
* The password is never a command-line argument (it would show in `ps`).
* Re-running with the same --title returns the SAME password, so a retried run
  never makes a second account or locks the candidate out of the first one.
* A password manager that is down never blocks an application: the password is
  held in a 0600 file outside the project (~/.config/job-search/) and filed on
  the next run (auto-apply.sh calls --flush-pending first).

Never call `op` or `bw` yourself. Use this script; it sets up the environment
those tools need to run without anyone at the keyboard.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import secrets
import shutil
import stat
import string
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = os.path.expanduser("~/.config/job-search")
PENDING_FILE = os.path.join(CONFIG_DIR, "pending-logins.local")
INDEX_FILE = os.path.join(CONFIG_DIR, "logins-index.json")  # titles only, no passwords
KEYCHAIN_SERVICE = "job-search"
KEYCHAIN_LOGIN_PREFIX = "job-search login: "
TIMEOUT = 25
# Symbols every applicant-tracking portal accepts. Quotes, backslashes and
# spaces get rejected and leave a half-made account behind.
SYMBOLS = "!#$%*+-=?@_"
EXTRA_PATH = [os.path.expanduser("~/.local/bin"), "/opt/homebrew/bin", "/usr/local/bin"]


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


class Unavailable(RuntimeError):
    """The password manager could not be asked. Not the same as 'no such item'."""


# --------------------------------------------------------------------------
# Settings and Keychain helpers
# --------------------------------------------------------------------------

def settings() -> tuple[str, str, str]:
    try:
        cand = json.loads((ROOT / "profile" / "candidate.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cand = {}
    integ = cand.get("integrations") or {}
    backend = str(integ.get("password_manager") or "none").strip().lower()
    vault = str(integ.get("password_vault") or "Job Portals")
    return backend, vault, str(cand.get("email") or "")


def keychain_get(account: str) -> str | None:
    try:
        out = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
            capture_output=True, text=True, timeout=TIMEOUT,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() or None if out.returncode == 0 else None


def security_batch(command: str) -> subprocess.CompletedProcess:
    """Run one `security` command through its interactive mode, so secrets go
    over stdin instead of the argument list."""
    return subprocess.run(["/usr/bin/security", "-i"], input=command + "\n",
                          capture_output=True, text=True, timeout=TIMEOUT)


def quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def which(name: str) -> str | None:
    found = shutil.which(name, path=os.pathsep.join(EXTRA_PATH + [os.environ.get("PATH", "")]))
    return found


# --------------------------------------------------------------------------
# Backends: each has get(title) -> str|None, create(...), check() -> str
# --------------------------------------------------------------------------

class OnePassword:
    name = "1Password"

    def __init__(self, vault: str):
        self.vault = vault

    def _env(self) -> dict:
        token = os.environ.get("OP_SERVICE_ACCOUNT_TOKEN") or keychain_get("1password-token")
        if not token:
            raise Unavailable("no 1Password service-account token in the Keychain (run connect-password-manager.sh 1password)")
        env = dict(os.environ)
        env["OP_SERVICE_ACCOUNT_TOKEN"] = token
        env["OP_BIOMETRIC_UNLOCK_ENABLED"] = "false"
        env.pop("OP_ACCOUNT", None)
        for key in [k for k in env if k.startswith("OP_SESSION_")]:
            env.pop(key, None)
        # `op` reads the desktop app's settings through HOME, which makes macOS
        # ask "allow access to data from other apps?" on an unattended run.
        # A private, empty HOME avoids that entirely.
        op_home = os.path.join(CONFIG_DIR, "op-home")
        os.makedirs(op_home, mode=0o700, exist_ok=True)
        env["HOME"] = op_home
        return env

    def _run(self, args: list[str], stdin: str | None = None) -> subprocess.CompletedProcess:
        binary = which("op")
        if not binary:
            raise Unavailable("the 1Password command-line tool is not installed")
        env = self._env()
        last = ""
        for attempt in (1, 2):
            try:
                return subprocess.run([binary, *args], input=stdin, capture_output=True,
                                      text=True, env=env, timeout=TIMEOUT)
            except subprocess.TimeoutExpired:
                last = f"`op {args[0]}` did not answer within {TIMEOUT}s"
            except OSError as exc:
                last = f"could not start op: {exc}"
                break
        raise Unavailable(last)

    def get(self, title: str) -> str | None:
        found = self._run(["item", "get", title, "--vault", self.vault, "--format", "json"])
        if found.returncode != 0:
            err = (found.stderr or "").lower()
            if "isn't an item" in err or "not found" in err or "no item matches" in err:
                return None
            if self._run(["whoami"]).returncode == 0:
                return None
            raise Unavailable(f"op item get failed: {(found.stderr or '').strip()}")
        try:
            item = json.loads(found.stdout)
        except ValueError:
            return None
        for field in item.get("fields", []):
            if field.get("id") == "password" or field.get("purpose") == "PASSWORD":
                if field.get("value"):
                    return field["value"]
        return None

    def create(self, title: str, username: str, url: str, password: str, note: str) -> None:
        template = {
            "title": title, "category": "LOGIN",
            "fields": [
                {"id": "username", "type": "STRING", "purpose": "USERNAME", "label": "username", "value": username},
                {"id": "password", "type": "CONCEALED", "purpose": "PASSWORD", "label": "password", "value": password},
                {"id": "notesPlain", "type": "STRING", "purpose": "NOTES", "label": "notesPlain", "value": note},
            ],
        }
        if url:
            template["urls"] = [{"label": "website", "primary": True, "href": url}]
        made = self._run(["item", "create", "--vault", self.vault, "--format", "json"], stdin=json.dumps(template))
        if made.returncode != 0:
            raise Unavailable(f"op item create failed: {(made.stderr or '').strip()}")

    def check(self) -> str:
        who = self._run(["whoami"])
        if who.returncode != 0:
            raise Unavailable(f"1Password refused the token: {(who.stderr or '').strip()}")
        vault = self._run(["vault", "get", self.vault, "--format", "json"])
        if vault.returncode != 0:
            raise Unavailable(f"the token cannot open the '{self.vault}' vault: {(vault.stderr or '').strip()}")
        return f"1Password is connected and can save to the '{self.vault}' vault"


class Bitwarden:
    name = "Bitwarden"

    def __init__(self, vault: str):
        self.folder = vault
        self._session = None

    def _bin(self) -> str:
        binary = which("bw")
        if not binary:
            raise Unavailable("the Bitwarden command-line tool is not installed")
        return binary

    def _env(self) -> dict:
        env = dict(os.environ)
        env["BITWARDENCLI_APPDATA_DIR"] = os.path.join(CONFIG_DIR, "bw-data")
        os.makedirs(env["BITWARDENCLI_APPDATA_DIR"], mode=0o700, exist_ok=True)
        return env

    def _run(self, args: list[str], stdin: str | None = None, extra: dict | None = None) -> subprocess.CompletedProcess:
        env = self._env()
        if extra:
            env.update(extra)
        try:
            return subprocess.run([self._bin(), *args], input=stdin, capture_output=True,
                                  text=True, env=env, timeout=TIMEOUT * 2)
        except subprocess.TimeoutExpired:
            raise Unavailable(f"`bw {args[0]}` did not answer in time")

    def session(self) -> str:
        if self._session:
            return self._session
        cid, secret, master = (keychain_get("bitwarden-client-id"), keychain_get("bitwarden-client-secret"),
                               keychain_get("bitwarden-master-password"))
        if not (cid and secret and master):
            raise Unavailable("Bitwarden details are missing from the Keychain (run connect-password-manager.sh bitwarden)")
        status = self._run(["status"])
        if '"unauthenticated"' in (status.stdout or ""):
            login = self._run(["login", "--apikey"], extra={"BW_CLIENTID": cid, "BW_CLIENTSECRET": secret})
            if login.returncode != 0:
                raise Unavailable(f"Bitwarden login failed: {(login.stderr or '').strip()}")
        unlock = self._run(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], extra={"BW_PASSWORD": master})
        if unlock.returncode != 0 or not unlock.stdout.strip():
            raise Unavailable(f"Bitwarden unlock failed: {(unlock.stderr or '').strip()}")
        self._session = unlock.stdout.strip()
        self._run(["sync"], extra={"BW_SESSION": self._session})
        return self._session

    def _folder_id(self) -> str | None:
        out = self._run(["list", "folders", "--search", self.folder], extra={"BW_SESSION": self.session()})
        try:
            for f in json.loads(out.stdout or "[]"):
                if f.get("name") == self.folder:
                    return f["id"]
        except ValueError:
            return None
        import base64
        made = self._run(["create", "folder", base64.b64encode(json.dumps({"name": self.folder}).encode()).decode()],
                         extra={"BW_SESSION": self.session()})
        try:
            return json.loads(made.stdout)["id"]
        except (ValueError, KeyError):
            return None

    def get(self, title: str) -> str | None:
        out = self._run(["list", "items", "--search", title], extra={"BW_SESSION": self.session()})
        if out.returncode != 0:
            raise Unavailable(f"bw list failed: {(out.stderr or '').strip()}")
        try:
            for item in json.loads(out.stdout or "[]"):
                if item.get("name") == title and item.get("login", {}).get("password"):
                    return item["login"]["password"]
        except ValueError:
            pass
        return None

    def create(self, title: str, username: str, url: str, password: str, note: str) -> None:
        import base64
        item = {
            "type": 1, "name": title, "notes": note, "folderId": self._folder_id(),
            "login": {"username": username, "password": password,
                      "uris": [{"match": None, "uri": url}] if url else []},
        }
        encoded = base64.b64encode(json.dumps(item).encode()).decode()
        made = self._run(["create", "item"], stdin=encoded, extra={"BW_SESSION": self.session()})
        if made.returncode != 0:
            raise Unavailable(f"bw create failed: {(made.stderr or '').strip()}")

    def check(self) -> str:
        self.session()
        return f"Bitwarden is connected; logins go in the '{self.folder}' folder"


class MacKeychain:
    name = "Mac Keychain"

    def get(self, title: str) -> str | None:
        out = subprocess.run(["/usr/bin/security", "find-generic-password", "-s",
                              KEYCHAIN_LOGIN_PREFIX + title, "-w"], capture_output=True, text=True, timeout=TIMEOUT)
        return out.stdout.rstrip("\n") if out.returncode == 0 else None

    def create(self, title: str, username: str, url: str, password: str, note: str) -> None:
        cmd = ("add-generic-password -U -s " + quote(KEYCHAIN_LOGIN_PREFIX + title) + " -a " + quote(username)
               + " -l " + quote(KEYCHAIN_LOGIN_PREFIX + title) + " -j " + quote(url or note)
               + " -w " + quote(password))
        out = security_batch(cmd)
        if out.returncode != 0 or self.get(title) is None:
            raise Unavailable(f"could not save to the Mac Keychain: {(out.stderr or '').strip()}")

    def check(self) -> str:
        probe = "__job-search self-test__"
        self.create(probe, "test", "", "test-only", "self-test")
        security_batch("delete-generic-password -s " + quote(KEYCHAIN_LOGIN_PREFIX + probe))
        return "The Mac Keychain is ready (use --export-csv to copy logins into Apple Passwords or Google)"


def backend():
    kind, vault, _ = settings()
    if kind in ("1password", "1pass", "op"):
        return OnePassword(vault)
    if kind in ("bitwarden", "bw"):
        return Bitwarden(vault)
    if kind in ("mac-keychain", "keychain", "apple", "google"):
        return MacKeychain()
    return None


# --------------------------------------------------------------------------
# Local fallback store and title index
# --------------------------------------------------------------------------

def _read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_private(path: str, data: dict) -> None:
    os.makedirs(CONFIG_DIR, mode=0o700, exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def remember_title(title: str, username: str, url: str) -> None:
    index = _read_json(INDEX_FILE)
    index[title] = {"username": username, "url": url,
                    "created_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")}
    _write_private(INDEX_FILE, index)


def generate_password(length: int) -> str:
    alphabet = string.ascii_letters + string.digits + SYMBOLS
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(length))
        if (any(c.islower() for c in pw) and any(c.isupper() for c in pw)
                and any(c.isdigit() for c in pw) and any(c in SYMBOLS for c in pw)):
            return pw


# --------------------------------------------------------------------------
# Modes
# --------------------------------------------------------------------------

def do_check() -> int:
    kind, _, _ = settings()
    store = backend()
    if store is None:
        log(f"No password manager is connected (setting: {kind}). Roles that need a new account are left for you to do by hand.")
        return 2
    try:
        log(store.check())
    except Unavailable as exc:
        log(f"{store.name} is not reachable right now: {exc}")
        log(f"Accounts still get created; passwords wait in {PENDING_FILE} until it answers.")
        return 1
    pending = _read_json(PENDING_FILE)
    if pending:
        log(f"{len(pending)} login(s) are waiting to be filed; run --flush-pending")
    return 0


def do_flush() -> int:
    store = backend()
    pending = _read_json(PENDING_FILE)
    if store is None or not pending:
        return 0
    for title, row in list(pending.items()):
        try:
            if store.get(title) is None:
                store.create(title, row.get("username", ""), row.get("url", ""), row["password"], row.get("note", ""))
            pending.pop(title)
            _write_private(PENDING_FILE, pending)
            log(f"Filed '{title}' in {store.name}")
        except (Unavailable, KeyError) as exc:
            log(f"Could not file '{title}' yet: {exc}")
            return 1
    return 0


def do_save(args) -> int:
    store = backend()
    if store is None:
        log("No password manager is connected, so this role needs the candidate to make the account by hand.")
        return 3
    _, _, default_email = settings()
    username = args.username or default_email
    if not username:
        log("No email address in profile/candidate.json to use as the username.")
        return 3
    title = args.title
    up = True
    try:
        existing = store.get(title)
        if existing:
            log(f"'{title}' already exists in {store.name}; reusing it")
            print(existing)
            return 0
    except Unavailable as exc:
        up = False
        log(f"{store.name} is not reachable: {exc}")

    pending = _read_json(PENDING_FILE)
    held = pending.get(title)
    if held and held.get("password"):
        if up:
            try:
                store.create(title, held.get("username", username), held.get("url", args.url), held["password"], held.get("note", args.note))
                pending.pop(title)
                _write_private(PENDING_FILE, pending)
            except Unavailable as exc:
                log(f"Could not file it yet: {exc}")
        print(held["password"])
        return 0

    password = generate_password(args.length)
    remember_title(title, username, args.url)
    if up:
        try:
            store.create(title, username, args.url, password, args.note)
            log(f"Saved '{title}' to {store.name}")
            print(password)
            return 0
        except Unavailable as exc:
            log(f"Could not save to {store.name}: {exc}")
    pending[title] = {"username": username, "url": args.url, "password": password, "note": args.note,
                      "created_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")}
    _write_private(PENDING_FILE, pending)
    log(f"Held '{title}' safely on this Mac until {store.name} answers; the next run files it.")
    print(password)
    return 0


def do_list() -> int:
    for title, row in sorted(_read_json(INDEX_FILE).items()):
        print(f"{title}\t{row.get('username', '')}\t{row.get('url', '')}\t{row.get('created_at', '')}")
    return 0


def do_export(target: str, path: str) -> int:
    """CSV for a one-time import into Apple Passwords or Google Password Manager.
    The file holds passwords in plain text: import it, then delete it."""
    store = MacKeychain()
    rows = []
    for title, row in sorted(_read_json(INDEX_FILE).items()):
        pw = store.get(title)
        if pw:
            rows.append((title, row.get("url", ""), row.get("username", ""), pw))
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        if target == "apple":
            w.writerow(["Title", "URL", "Username", "Password", "Notes", "OTPAuth"])
            for t, u, n, p in rows:
                w.writerow([t, u, n, p, "Created by the job search", ""])
        else:
            w.writerow(["name", "url", "username", "password", "note"])
            for t, u, n, p in rows:
                w.writerow([t, u, n, p, "Created by the job search"])
    log(f"Wrote {len(rows)} login(s) to {path}. Import it, then delete the file.")
    return 0


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--title", help='e.g. "Acme Workday"')
    p.add_argument("--username", default="", help="defaults to the email in profile/candidate.json")
    p.add_argument("--url", default="")
    p.add_argument("--length", type=int, default=20)
    p.add_argument("--note", default="Created by the job search for a portal that requires an account.")
    p.add_argument("--check", action="store_true")
    p.add_argument("--flush-pending", action="store_true")
    p.add_argument("--list", action="store_true")
    p.add_argument("--export-csv", nargs=2, metavar=("apple|google", "FILE"))
    a = p.parse_args()
    if a.check:
        sys.exit(do_check())
    if a.flush_pending:
        sys.exit(do_flush())
    if a.list:
        sys.exit(do_list())
    if a.export_csv:
        sys.exit(do_export(a.export_csv[0], a.export_csv[1]))
    if not a.title:
        p.error("--title is required")
    sys.exit(do_save(a))


if __name__ == "__main__":
    main()
