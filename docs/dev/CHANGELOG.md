# Changelog (shared template)

What changed in the shared template, newest first. The candidate's own session
log is `docs/WORKLOG.md`, which stays on their Mac.

## 2026-10-08: dashboard takes the Command hub's look

- The dashboard is rebuilt to match the Job Search room of the Command hub it
  came from: one title with a sticky status strip (board, last search, apply
  queue, waiting on you, in play), one card of tabs, and soft rows instead of
  the old card grid. Still plain HTML, CSS and JavaScript with no build step.
- Every row says why it got its match % and score, and what kept each from
  being higher, worded from the search's own fit analysis and rationale.
- Review buttons are now Apply for me, Interested, Not for me and Posting;
  select several to do the same to all of them, including Prepare resumes.
- New tabs: Apply queue (with live step-by-step progress while a run is
  going) and Applied. Archive is now called Turned down, with Back to Review.
- One filter bar for every list: find, quick score chips, and a Filters panel
  for title, place, work model, company size, score, match, pay and dates.
- Clicking a company opens one panel with the posting, scores you can change,
  research, the tailored resume, outreach and the job's diary.
- Run apply queue moved to the top bar and still asks before sending.
  Update from email is now Check email now, on the Pipeline tab.
- The Worth applying score is no longer shown on the page; it is still
  calculated and stored.

## 2026-10-06: first open version

- Built from a private, single-person job search and made generic: every personal
  detail now comes from `profile/candidate.json`, `profile/resume.json` and the
  scoring files the onboarding interview writes.
- Guided onboarding for non-technical users (`docs/ONBOARDING.md`, `/setup`),
  plus `/tour`, `/status`, `/tune`, `/add-job`, `/update`.
- Setup needs no administrator password: Node and LibreOffice install into the
  home folder with checksum checks; Homebrew is used only if already present.
- Search times and the weekly digest come from the profile; the apply queue runs
  only from the dashboard button; GitHub backup is optional and off by default.
- Dashboard: new Guide tab, profile-driven labels, no personal narrative, binds
  to this Mac only by default.
- Resumes: JSON master resume plus small per-job overlay files in `tailor/`,
  built by `scripts/build_resume.py`.
