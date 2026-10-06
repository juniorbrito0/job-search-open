#!/usr/bin/env python3
"""launchd entry point for the auto-push job.

Same reason as run-morning-scan.py: macOS TCC blocks a LaunchAgent that runs
/bin/bash directly from reading this project, while /usr/bin/python3 already
holds that grant and passes it to its children. launchd runs python3, python3
starts the real bash runner. Do not point the LaunchAgent at bash directly.
"""

import os
from pathlib import Path

RUNNER = Path(__file__).resolve().parent / "autopush.sh"

os.execv("/bin/bash", ["/bin/bash", str(RUNNER), "scheduled"])
