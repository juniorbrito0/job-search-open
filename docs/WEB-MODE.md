# Web mode: a job search for someone else in the house

Web mode runs a second, separate copy of this job search on a Mac at home and
gives its owner (the candidate) a password-protected page they open from any
computer or phone on the home Wi-Fi. No terminal on their side: the page runs
the setup interview as a chat, then becomes their panel (the normal dashboard
plus **Assistant** and **My answers**).

This file is for whoever sets it up (the admin). The candidate never reads it.

## What is different from the normal setup

| | Normal | Web mode |
|---|---|---|
| Who talks to Claude | the candidate, in Terminal | the candidate, in a chat on the page (`dashboard/webmode.py`, `docs/WEB-CHAT.md`, `docs/WEB-ONBOARDING.md`) |
| Login | none (this Mac only) | password (`scripts/set_web_password.py`), session cookie |
| Gmail | claude.ai connector of whoever runs Claude | the candidate's own Google sign-in, read-only (`scripts/gmail.py`) |
| LinkedIn | signed in, in the job browser | guest only (`linkedin_mode: "guest"`) |
| Claude sessions | the Mac owner's full setup | isolated (`scripts/instance.py`): no owner settings, memory, hooks or claude.ai connectors; only this copy's own job browser |
| Background jobs | `local.jobsearch.<job>` | `local.jobsearch.<instance id>.<job>` |
| Chat permissions | n/a | `dontAsk` with an allowlist: read this folder, write the candidate's files, run this project's scripts |

The chat and the scheduled jobs run on the Mac owner's Claude subscription.

## Setup (admin, once)

1. **Clone** the template outside `~/Documents` (background jobs cannot run
   there), e.g. `git clone https://github.com/juniorbrito0/job-search-open ~/gui-job-search`.
2. **Tools:** `bash scripts/setup-mac.sh --tools`, then
   `.venv/bin/python scripts/init_data.py`.
3. **Settings** in `profile/candidate.json`:
   ```json
   "instance_id": "gui",
   "language": "",
   "linkedin_mode": "guest",
   "integrations": {"gmail": "none", "password_manager": "1password", "password_vault": "<vault>"},
   "notifications": {"email_strong_matches": false, "mac_notifications": false},
   "schedule": {"search_times": ["08:00", "16:00"], "weekly_digest": {"enabled": false}},
   "dashboard": {"port": 7412, "share_on_home_wifi": true, "web_login": true}
   ```
   Leave `onboarded` false: the page's interview sets it, and the scheduled
   search refuses to run until then.
4. **Password:** pipe it in, never as an argument:
   `<something that prints it> | python3 scripts/set_web_password.py`.
   Keep the real copy in a password manager.
5. **Google sign-in for Gmail** (optional but recommended):
   - Google Cloud project with the Gmail API on; Google Auth Platform:
     External, app name, support and developer email, home page and privacy
     links (`web/oauth-bounce/about.html`, `privacy.html`), the
     `gmail.readonly` scope; **Publish app** (in "Testing", Google expires the
     candidate's access every 7 days).
   - A **Web application** OAuth client whose only redirect URI is the bounce
     page (below).
   - Save `.secrets/google-client.json`:
     `{"client_id": "...", "client_secret": "...", "redirect_uri": "<bounce page URL>"}` (mode 0600).
   - Google only returns to public addresses, so `web/oauth-bounce/` is a tiny
     static page (deploy it anywhere public, e.g. a Cloudflare Worker with
     assets) that forwards the browser to the home page's
     `/oauth/google/callback`. It forwards only to home-network addresses and
     only to that path, and keeps nothing.
6. **Password manager** for job-site accounts: a 1Password service account
   that can see only the candidate's vault, its token stored in this Mac's
   Keychain under service `job-search-<instance id>`, account
   `1password-token` (`scripts/connect-password-manager.sh 1password` does it
   with a pop-up, or `security add-generic-password` in the Mac's own session).
7. **Start the page only:** `bash scripts/setup-mac.sh --schedule` installs the
   dashboard and the search jobs. The search does nothing until the interview
   finishes; the page re-applies the schedule at that moment.
8. Give the candidate the address (`http://<mac name>.local:<port>`) and the
   password.

## Maintenance

- Health: `bash scripts/setup-mac.sh --check` in the copy's folder.
- Logs: `logs/web-chat.err.log` (chat), `logs/morning-scan.log`, `logs/dashboard.launchd.err.log`.
- Change the password: step 4 again (signs every browser out).
- Start the interview over: delete `profile/chat/onboarding.json` and set
  `onboarded` false.
- Remove Gmail: the candidate presses Disconnect on My answers, or remove
  `.secrets/google-token.json`.
