# Weekly email digest routine

Run by the LaunchAgent `local.jobsearch.weekly-comms` on the day and time in
`profile/candidate.json → schedule.weekly_digest` (default Friday 10:00). It
rewrites `docs/comms-digest.md`: a one-page summary of what employers said this
week and which threads need a nudge. **Read-only**: it never changes a card.

Read this file top to bottom, then execute. Work autonomously; do not ask questions.

## 1. Window

Read the `last_run:` line at the bottom of `docs/comms-digest.md` and sweep from
that date. First run, or no file: sweep the last 30 days.

## 2. Gmail sweep

Same search as `docs/inbox-update-routine.md` section 2, with whichever Gmail
tool this session has. Read subjects and senders first, open only real outcomes
and human replies, go in small batches, and say what was missed.

## 3. Meeting notes (optional)

Only if `integrations.granola` is true in `profile/candidate.json`: search Granola
for interviews and recruiter calls in the window and capture company, date, who,
stage, what was asked, concerns raised, next steps and any pay discussed.

## 4. Compare with the dashboard

For every company found, compare with `dashboard/data/positions.json`:

- An outcome email whose card has not moved: flag it.
- A promised follow-up date that has passed with no reply: flag it as going cold.
- A card marked `applied` with no confirmation email at all: flag it; the
  application may never have arrived.

Never change a status here. Show the evidence and let the candidate (or the
**Update from email** button) decide.

## 5. Write

Rewrite `docs/comms-digest.md` in plain, friendly language: what this covers and
what it could not read, interviews on record, an outcomes table, threads worth a
follow-up, automatic acknowledgements in one line each, and **What this tells
you**: specific, checkable observations (reply rate, time to first human reply,
pay gaps, repeated concerns), not generic encouragement. End with
`last_run: YYYY-MM-DD`.

Append a dated entry to `docs/WORKLOG.md` and notify:

```
osascript -e 'display notification "Weekly digest ready: N outcomes, M threads to follow up" with title "Job Search" sound name "Glass"'
```

## Rules

- Never send, reply, delete or mark anything read.
- Never invent an outcome.
