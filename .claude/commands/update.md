---
description: Get the latest improvements to the job search
---
Fetch improvements from the shared template without touching the candidate's data. The template is the `origin` remote, or `upstream` if they set up their own GitHub backup. Run `git fetch` on it, then `git merge --ff-only` (or a normal merge if their backup repo has its own commits). Their personal files are ignored by git, so they are never overwritten. If the merge conflicts, abort it and explain in one sentence. Then run `bash scripts/setup-mac.sh` so new tools and schedule changes take effect, and tell them in two or three plain sentences what changed (read the new commit messages).
