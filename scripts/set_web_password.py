#!/usr/bin/env python3
"""Set (or change) the password for the job search's web page.

Reads the new password from stdin, so it never appears in the command line,
the shell history or `ps`. Keeps only a salted PBKDF2 hash, in
.secrets/web-login.json (git-ignored, readable by this Mac account only).
Changing it signs every browser out.

    some-command-that-prints-it | python3 scripts/set_web_password.py
    python3 scripts/set_web_password.py --check     exit 0 if a password is set
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "dashboard"))
import webmode  # noqa: E402


def main() -> int:
    if "--check" in sys.argv:
        ok = webmode.password_set()
        print("a password is set" if ok else "no password set yet")
        return 0 if ok else 1
    password = sys.stdin.readline().rstrip("\r\n")
    if len(password) < 10:
        print("Refused: the password must be at least 10 characters.", file=sys.stderr)
        return 1
    webmode._write_json(webmode.LOGIN_FILE, webmode.hash_password(password), secret=True)
    webmode.drop_all_sessions()
    print("Password saved. Every browser has been signed out and will ask for it again.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
