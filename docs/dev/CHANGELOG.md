# Changelog (shared template)

What changed in the shared template, newest first. The candidate's own session
log is `docs/WORKLOG.md`, which stays on their Mac.

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
