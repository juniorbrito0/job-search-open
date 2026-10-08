# Inbox update routine

Started from the dashboard **Check email now** button. It reads the candidate's
Gmail and **moves pipeline cards** when an email is a clear employer outcome, and
writes a short diary note on the card (a title and a one-line quote, never the
whole email). The weekly digest (`docs/weekly-comms-routine.md`) is read-only;
this job is the one that updates the board.

Read this file top to bottom, then execute. Work autonomously; do not ask
questions. Project root: the folder that holds `docs/`, `dashboard/`, `scripts/`.
Never read or run anything under `~/Documents`: background jobs have no
permission there and the run would freeze.

## 1. Window

Read `dashboard/data/.last-inbox-at` (an ISO datetime) and sweep from then. If it
is missing, sweep the last **14 days**.

## 2. Gmail sweep

Use whichever Gmail tool this session has (the claude.ai Gmail connector, or a
Google Workspace server). Search:

```
after:YYYY/MM/DD (subject:(application OR interview OR "thank you for applying" OR "your application"
OR candidate OR "next steps" OR offer OR regret OR "not moving forward" OR "moving forward" OR recruiter
OR "phone screen") OR from:(greenhouse.io OR lever.co OR ashbyhq.com OR workable.com OR jazzhr.com
OR myworkday.com OR dayforcehcm.com OR bamboohr.com OR smartrecruiters.com OR icims.com OR breezy.hr
OR applytojob.com))
-from:linkedin.com -in:spam
```

Read subjects and senders first; open full messages only when they look like a
real outcome or a person writing. Gmail limits fast reading: go in small batches
and say what was missed rather than stalling.

Classify each: `auto-ack`, `rejection`, `interview-invite`, `human-reply`, `offer`, `other`.

## 3. Meeting notes (optional)

Only if `profile/candidate.json → integrations.granola` is true: use Granola's
meeting search for interviews and recruiter calls in the window (company, date,
next step). Only if `integrations.wispr_flow` is true: run
`.venv/bin/python scripts/sync_diary.py` after the Gmail pass.

## 4. Update the pipeline

Match each outcome to a card in `dashboard/data/positions.json` by company and
role. If two roles at one company are live, use the title in the email. If you
cannot tell which card it is, change neither and note it in the worklog.

Only these moves, and only when the email is explicit:

| Email | Card is now | Move to |
|---|---|---|
| Employer says no (not moving forward, role filled) | `applied`, `screen`, `interview`, `offer`, `ongoing` | `disqualified` |
| Recruiter screen or first call | `applied` | `screen` |
| Later interview (hiring manager, panel, "next round") | `applied` or `screen` | `interview` |
| Offer | `applied`, `screen`, `interview`, `ongoing` | `offer` (also note it in `apply_result`) |

On every move add a diary event:
`.venv/bin/python scripts/sync_diary.py --add <id> --type email|screen|interview|offer|rejection --title "..." --detail "one-line quote" --at <email ISO datetime> --external gmail:<message id>`

- `rejected` means the candidate said no. Never change it. Never change `review`.
- Never invent an outcome. Automatic "we got your application" emails move nothing.
- Every status change appends `status_history` `{status, at}` with the **email's** date.
- An employer no: `status: "disqualified"` and `apply_result` starting
  `employer-rejected:` plus the date and a short quote.
- Hold `fcntl.flock` on `dashboard/data/.lock` for the read, modify, write. Bump `updated_at`.

## 5. Housekeeping

If any card moved, run:

```
.venv/bin/python scripts/classify_disqualified.py
.venv/bin/python scripts/classify_applications.py
.venv/bin/python scripts/score_worth_applying.py --learn
```

## 6. Log and notify

Append a dated, plain-language entry to `docs/WORKLOG.md`: window, emails read,
cards moved (company, role, old to new), anything unmatched. Then:

```
osascript -e 'display notification "Email update: N cards moved" with title "Job Search" sound name "Glass"'
```

## Rules

- Never send, reply, delete, or mark anything read.
- Never apply to anything or change any account setting.
- Never copy a password, code, or a whole email into `positions.json`.
