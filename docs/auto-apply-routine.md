# Apply queue routine

**This runs only when the candidate presses "Apply queue now" on the dashboard.**
There is no schedule: nothing is ever submitted while the candidate is not
looking. The runner is `scripts/auto-apply.sh`; if the queue is empty it exits
before this file is read. Every run stamps `dashboard/data/.last-apply-at`. What
was actually sent, and when, is in `dashboard/data/applied-ledger.json`.

This job **only applies**. It does not search, score, or add positions. Read this
file top to bottom, then execute. Work autonomously; do not ask questions.

## The duplicate-submit ledger

`dashboard/data/applied-ledger.json` records what has really been sent.
`scripts/queue_auto_apply.py` drops anything in it from the queue, so nothing is
ever applied to twice. `auto-apply.sh` keeps it up to date with
`scripts/record_ledger.py` before and after the run.

## 0. Empty-queue guard

Run `.venv/bin/python scripts/queue_auto_apply.py --pending-count`. If it prints `0`, stop.

## 1. Load context

- `dashboard/data/application-profile.json`: standard answers and `policies`.
- `profile/candidate.json` and `profile/resume.json`.
- `dashboard/data/scoring-profile.json`: `auto_apply`, `learning_log`, `hard_exclusions`.
- `dashboard/data/SCHEMA.md` and `dashboard/data/positions.json`.

Off-limits industries in `hard_exclusions` are never applied to, whatever the score.

## 2. Who to apply to

Every position with `apply_requested: true` that is not already applied or
closed (`applied`, `screen`, `interview`, `offer`, `ongoing`, `disqualified`,
`rejected`, `no_answer`, or any `applied_at`). Never twice. A position with
`apply_manual: true` is one the candidate applies to themself: never touch it.
If `auto_apply.enabled` is false, skip positions that only have
`auto_apply_queued`, but still do the ones the candidate queued with **Apply for me**.

## 3. Resume first

Use `resume_path`. If it is missing, build it exactly like the search does
(overlay in `tailor/`, then `scripts/build_resume.py`, then
`scripts/check_resume_keywords.py --id <id> --fix`). Never invent experience.

## 4. Submit

Use the job browser (`playwright-session` tools), which is signed in to LinkedIn.
LinkedIn Easy Apply, or the employer's own application form.

- Answer from `application-profile.json`, the tailored resume and
  `profile/resume.json`. Written answers ("why us", cover letters) are written
  from those and research, saved under `Applications/<Company>/`, and submitted.
  Follow the candidate's tone notes in `application-profile.json → policies.tone`
  if present. No em dashes.
- **Never guess a fact.** Years of experience, certifications, work permission,
  salary, office days, dates, demographic answers: only from the profile. If one
  is missing, stop on that role and mark it blocked with the exact question.
- **Never** touch a CAPTCHA (a "prove you are human" box), attest to something
  untrue, or type any password other than one `save_login.py` just gave you.
- **New accounts:** a portal that wants an account is not a blocker when a
  password manager is connected.
  1. If it offers "Sign in with Google" or "Continue with Google", use that.
  2. Otherwise, if `profile/candidate.json → integrations.password_manager` is not
     `none`, get a password with
     `python3 scripts/save_login.py --title "<Company> <Portal>" --url "<apply URL>"`.
     It prints only the password (it files it in the password manager first, and
     running it again returns the same password, so a retry never makes a second
     account). Sign up with the candidate's email and that password, open the
     confirmation email in Gmail and click the link if asked, then continue.
  3. If no password manager is connected (the script exits with code 3), mark the
     role blocked: "This one needs an account. Connect a password manager (ask me
     about it) or apply yourself here in about 10 minutes: <link>".
  - Never call `op` or `bw` yourself, and never write the password anywhere
    (files, logs, `apply_result`, notes). Say "saved to your password manager".
  - "The password manager failed" is never a reason to leave a role: the script
    always prints a password and holds it safely until the manager answers.
- **Video or live assessments** (recorded video, one-way video interview, timed
  test, ID check): do not apply. Mark it blocked and say what the gate is.
- Never message, connect, post, follow or change settings on LinkedIn.

**Hiring-manager note (scores 4 and 5 only).** After a successful apply, draft a
short note to the hiring manager or recruiter with
`.venv/bin/python scripts/stakeholder_outreach.py --id <id>`. Find real named
people (posting first, then the company's LinkedIn page). Never invent people.
Leave it at `status: ready`. **Do not send it.** Send only when its status is
`send_requested` (the candidate pressed Send on the dashboard): one paragraph, by
LinkedIn message if possible, otherwise email; then record it as sent. If it
cannot be sent, set `status: blocked` with a reason the candidate can act on.

Hold `fcntl.flock` on `dashboard/data/.lock` for every read, modify, write of
`positions.json`.

## 5. Record the outcome

`.venv/bin/python scripts/record_application.py <id> submitted|blocked|closed|skipped "note"`
is the one-shot recorder.

- **Submitted:** `applied_at`, `status: "applied"`, `apply_requested: false`; if
  `auto_apply_queued` is true also `auto_applied: true`.
- **Blocked:** leave `apply_requested: true`, write `apply_result` as one plain
  sentence telling the candidate exactly what to do next. Never claim it was sent.

Also process every position whose hiring-manager note is `send_requested`, even
when the apply queue is empty.

## 6. Notify and log

If something was submitted or newly blocked, send a Mac notification with real
numbers and append a short dated note to `docs/WORKLOG.md`.

## 7. Report progress as you go

The candidate watches this run on the dashboard. From the project root:

```sh
python3 scripts/apply_progress.py position --id <position id> --company "<company>" --title "<title>"
python3 scripts/apply_progress.py step <step>
python3 scripts/apply_progress.py finish --outcome applied|blocked|skipped --note "<one short sentence>"
```

Steps, in order: `picked`, `research`, `resume`, `portal`, `account` (only if a
portal asks for one), `form`, `submit`, `record`. Always call `position` first
and always `finish`, including when you give up. Notes are read by a person:
write a sentence, never a password, code or token. Do not call `start` or `end`.
