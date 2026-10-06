#!/usr/bin/env python3
"""launchd entry point for the weekly comms sweep.

Same Documents-permission reason as run-morning-scan.py: launchd must start
/usr/bin/python3, not /bin/bash. This shim then starts weekly-comms.sh.
"""

import os
from pathlib import Path

RUNNER = Path(__file__).resolve().parent / "weekly-comms.sh"

os.execv("/bin/bash", ["/bin/bash", str(RUNNER)])
