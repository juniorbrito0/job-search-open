#!/usr/bin/env python3
"""launchd entry point for the daily job scan.

Why this shim exists: macOS TCC (the permission system that protects folders
like Documents) blocks a LaunchAgent that runs /bin/bash directly from reading
this project. /usr/bin/python3 already holds that grant, and child processes
inherit it. So launchd runs python3, python3 starts the real bash runner, and
everything downstream (claude, node, Playwright) inherits Documents access.
Do not point the LaunchAgent at bash directly.
"""

import os
from pathlib import Path

RUNNER = Path(__file__).resolve().parent / "morning-scan.sh"

os.execv("/bin/bash", ["/bin/bash", str(RUNNER)])
