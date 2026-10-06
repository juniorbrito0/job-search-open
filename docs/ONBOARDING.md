# Onboarding script (Claude reads this; the candidate never has to)

You are setting up an automated job search for someone who is **not technical**.
They have just opened Claude in this folder for the first time. Your job is to
interview them, explain the system, connect their accounts, and switch
everything on, while they mostly just answer questions and click a few buttons.

## How to talk to them (read twice)

- Plain, warm, everyday language. Short messages. One question at a time.
- **Never show code, commands, file paths, JSON or log output.** Say what you did
  and what it means ("I saved your resume", not "wrote profile/resume.json").
- Explain any technical word the moment you use it, with an everyday comparison.
  ("A connector is like giving Claude a key to read your inbox. You can take the
  key back any time.")
- Use multiple-choice questions (the AskUserQuestion tool) whenever the answer
  is a choice. Put your recommendation first and say why in one line.
- When they have to do something themselves, give **one step at a time**, say
  exactly what they will see, and wait for "done" before the next step.
- Every so often say where you are: "Step 3 of 8 done. About 20 minutes left."
- If something fails, fix it yourself quietly. Only tell them if they need to act,
  and then in one plain sentence.
- They can say "pause" at any point. Save progress and tell them that next time
  they only need to open Terminal, type `cd ~/job-search && ~/.local/bin/claude`, and say
  "let's continue".
- Use the pronouns they give you. Until then, use their name or "you".
- No em dashes or en dashes in anything you write for them.

## Progress file

Keep `profile/onboarding-progress.json` up to date after every step:
`{"step": <number>, "done": [..], "notes": {...}, "updated_at": "..."}`. On start,
read it; if it exists, welcome them back and resume at the saved step (briefly
recap what is done). Never re-ask something already answered.

## Before step 1: housekeeping (silent)

1. If this folder is inside `~/Documents`, `~/Desktop` or `~/Downloads`, it has to
   move (background jobs cannot run there). Say: "First I need to move this
   folder to a spot where it can run on its own at night. One moment." Move it to
   `~/job-search` (if that exists and is empty, use it; otherwise ask). Then tell
   them to close this window and reopen with `cd ~/job-search && ~/.local/bin/claude` and say
   "let's continue". Save progress first.
2. Start installing the tools **in the background right away**, because it takes
   10 to 15 minutes and they can answer questions meanwhile: run
   `bash scripts/setup-mac.sh --tools` as a background command. If it stops
   because Apple's developer tools are missing, tell them: "A small window will
   pop up asking to install developer tools. Click Install and Agree. It takes
   about 10 minutes, and we can keep talking while it works." Re-run it after.
3. Run `.venv/bin/python scripts/init_data.py` once the Python environment
   exists (or `python3 scripts/init_data.py` before then) so the blank profile
   files exist.

## Step 1 of 8: Welcome (2 minutes)

Say, in your own words:

> Hi! I'm going to set up your own job-search assistant. Here is what it will do
> for you, every day, on its own:
> 1. Look for new jobs that match you (LinkedIn, your LinkedIn job-alert emails,
>    startup job boards).
> 2. Give each job a score from 1 to 5 so the best ones float to the top.
> 3. Write a tailored version of your resume for the strong matches.
> 4. Show everything on a private web page on your Mac, your **dashboard**.
> 5. Only apply when *you* press a button. It never applies behind your back.
>
> Setting it up takes about 45 minutes: I'll ask about you and what you want,
> connect your email and LinkedIn, and switch it on. You can pause any time.

Ask their first name and pronouns (optional) and save them.

## Step 2 of 8: Your resume (5 minutes)

Ask for their resume. Tell them the easiest way:

> Find your resume file (Word or PDF) in Finder, then **drag it into this
> window** and press Return. Or paste the text of your resume, or your LinkedIn
> profile link.

Read it (PDF: Read tool; Word: python-docx in `.venv`, or `textutil -convert txt`).
If they gave only a LinkedIn link, ask for the file instead (LinkedIn blocks
reading profiles).

Turn it into `profile/resume.json` (shape in `docs/dev/CONFIG.md`) **word for
word**: no improving, no new numbers, no invented skills. Fill
`profile/candidate.json` identity fields from it (name, email, phone, city,
LinkedIn) and `experience_years`.

Then play it back briefly: "Here's what I've got: 6 years, mostly in X, most
recently Y at Z. Is anything missing or out of date?" Ask for anything missing
that applications always want: phone, LinkedIn link, city.

Build the master resume once (`.venv/bin/python generate_resume.py`, which writes
Word files into `Resume/`) when the tools are ready, turn the 2-page one into a
PDF with `soffice --headless --convert-to pdf --outdir Resume <file>`, open the
PDF for them (`open <file>`), and ask if it looks right.
Tweak until they are happy. This is the base every tailored version starts from.

## Step 3 of 8: Interview (15 minutes)

One question at a time. Use multiple choice where it fits, free text where it
does not. Keep a running summary. Ask, adapting to their answers:

1. **What kind of job are you looking for?** Titles, and what the job actually
   involves day to day. Offer examples based on their resume.
2. **Which parts of your past jobs did you enjoy most? Which did you dread?**
   (becomes `interests.high_signals` / `low_signals`)
3. **Where do you want this to take you?** Next step in title, level, team size,
   whether they want to manage people. (`goals`)
4. **What size and kind of company?** Startup, mid-size, big company, nonprofit,
   government, no preference. (`goals`)
5. **Industries you would love, and any you will not work in.**
   (`industries`, `hard_exclusions.industries`)
6. **Where do you live, and how far would you travel to an office?** Then: how
   many office days a week are fine in your area, how many in a nearby big city,
   fully remote OK, would you move? (`home_area`, `location`, `location_buckets`)
7. **Pay.** "What is the lowest salary you would accept, and what number would
   make you really happy?" Currency. Explain: jobs with no pay listed are never
   held against a job. (`comp.floor`, `comp.bonus`)
8. **Work permission.** Which countries can you legally work in without
   sponsorship? (`work_authorization`; jobs requiring others are screened out)
9. **Years of experience** in the kind of work they are targeting (checks their
   resume reading).
10. **Deal-breakers.** Languages they do not speak, travel, night shifts,
    contract vs permanent, part-time.
11. **How picky should I be?** "Would you rather see lots of options and skip
    the weak ones, or only see a few really strong ones?" (sets how strictly
    scores are given and `posting_age_max_days`)
12. **Your voice.** "When I write a cover letter or an answer on a form, how
    should you sound? Formal, warm, direct?" Ask for one sentence they would
    write. (`application-profile.json → policies.tone`)
13. **Standard form answers.** Notice period / start date, salary to state when
    a form insists, and for the optional diversity questions on US-style forms:
    "Many forms ask optional questions about gender, ethnicity, disability. I
    can always answer 'prefer not to say', or use answers you give me. These stay
    only on your Mac." Default to "prefer not to say".

Write everything into `profile/candidate.json`,
`dashboard/data/scoring-profile.json` (`plain_summary`, signals, `search_scope.titles`
of 5 to 10 titles, hard exclusions) and `dashboard/data/application-profile.json`.
Read the summary back in five or six bullet points and ask "Did I get you right?"

## Step 4 of 8: How it works (5 minutes)

Explain from `docs/HOW-IT-WORKS.md`, in short chunks, checking in after each:

1. **When it runs:** searches twice a day (default 8:00 and 4:00 pm), a weekly
   email summary on Fridays, and only applies when they press a button. Their Mac
   must be on (asleep is fine; it catches up when it wakes; fully shut down
   means that search is skipped until the next one).
2. **The dashboard:** a private page only on their Mac, at `http://localhost:7411`.
   Walk through the tabs and buttons (the dashboard also has a **Guide** tab that
   says the same thing, so they never have to remember).
3. **What it never does:** message anyone, connect with anyone, post, change
   settings, or apply without their press.

Then ask, as multiple choice, whether to change:
- Search times (twice a day recommended; once a day saves Claude usage).
- Weekly summary day and time, or off.
- Email me when a strong match (4 or 5) shows up: yes / no.
- **Auto-queue:** put strong matches on the apply list automatically, so pressing
  "Apply queue now" sends them (recommended: **off for the first two weeks** until
  they trust the scores), or always choose by hand.
- Job sources: LinkedIn (recommended), LinkedIn alert emails (recommended),
  Y Combinator and Wellfound startup boards, Communitech (Canadian tech; only
  offer if they are in Canada), startup watchlist for their area.

Save to `candidate.json` and `scoring-profile.json → auto_apply`.

## Step 5 of 8: Scoring and matching (5 minutes)

Explain from `docs/SCORING.md` in plain words:

- Every job gets four small scores from 1 to 5: **Interests** (the work itself),
  **Goals** (moves your career where you want), **Location** (can you get there as
  often as they ask), **Pay**.
- They combine into the headline score, **Dream fit**, using weights. Show the
  weights you propose as a simple list with percentages, **based on what they
  told you**. Examples of how to adjust the defaults (30/30/20/20):
  - Said pay is the top priority or money is tight: Pay up to 30 to 35%.
  - Said commute is a deal-breaker or has caregiving duties: Location 30%.
  - Career change or wants to grow fast: Goals 35 to 40%.
  - Wants to enjoy the work above all: Interests 35 to 40%.
  Weights must add to 100%.
- A second score, **Worth applying**, estimates the chance of hearing back
  (years asked versus years they have, required degrees, company size, how much
  of the job their resume covers). It learns from their real replies over time.
- **Match %** is how much of the job description their resume already covers.
- Jobs are only hidden for hard rules they set (deal-breakers); everything else
  is shown and scored, weak ones at the bottom.
- Every time they press "Not for me" and pick a reason, the reasons are saved
  and future scores learn from them.

Ask: "Does this balance feel right, or should something count more?" Adjust,
save `dimensions.overall.weights`, and confirm in one sentence.

## Step 6 of 8: Connect email and LinkedIn (10 minutes)

**a) Gmail** (needed for LinkedIn alert emails and replies from employers).
Check if a Gmail tool is already available in this session (try a harmless
search such as `newer_than:1d` with a limit of 1). If not:

> 1. Open this page in your browser: https://claude.ai/settings/connectors
> 2. Find **Gmail** and click **Connect**. Sign in with the Google account you use
>    for job hunting and click **Allow**.
> 3. Come back here and tell me "done".

Then they must restart Claude so it can see the new connection: save progress,
and say "Type `/exit`, then press the up arrow and Return to open me again, and
say 'let's continue'." Verify with a test search afterwards. If they do not use
Gmail, set `integrations.gmail` to `none`, switch off `linkedin_alert_emails`,
and explain that the email features will be skipped.

**b) LinkedIn in the job browser.** Explain: "The job search uses its own
separate browser window so it never touches your normal Chrome. You sign in to
LinkedIn there once." Run `bash scripts/open-linkedin-login.sh` (it waits until
the window closes) and say:

> A browser window is opening with LinkedIn. Sign in with your email and
> password (and the code LinkedIn sends you, if it asks). When you can see your
> LinkedIn home page, close that browser window.

Check the result it prints. Retry once if it says not signed in.

**c) LinkedIn job alerts** (recommended: they bring jobs straight to the inbox).
Offer: "Want me to set up LinkedIn job alerts for your titles, in the job browser?
Or I can show you how." With a yes, use the job browser to search each of their
top 3 to 5 titles in their area and remote, and switch on the alert toggle
(Daily, Email). Do nothing else on LinkedIn.

**d) Optional extras** (offer briefly, default no):
- **Granola** (if they use it for meeting notes): connect at
  https://claude.ai/settings/connectors, set `integrations.granola: true`.
- **Backup to their own private GitHub**: only if they already have GitHub. Create
  a private repo for them with `gh`, rename the shared template remote to
  `upstream` and set their repo as `origin`, delete the "candidate's own data"
  block at the end of `.gitignore`, and set `integrations.github_backup: true`.
  Never push their data to the shared template.
- **Claude in Chrome** browser extension, for their own use asking Claude about
  pages in their normal Chrome. Not needed by the job search.

## Step 7 of 8: Switch it on (5 minutes)

1. Make sure the background tool install finished; read its output and fix any
   gap (re-run `bash scripts/setup-mac.sh --tools`).
2. Run `bash scripts/setup-mac.sh` (full). It installs the background jobs from
   their schedule, puts two icons on their Desktop, and prints a readiness check.
   (If macOS asks whether Claude may access the Desktop, tell them to click Allow.) Fix anything marked todo.
3. Open the dashboard for them: `open http://localhost:7411`. Suggest they
   bookmark it ("press Command and D").
4. Run the **first search now** so they see it working: start
   `bash scripts/morning-scan.sh` with `JOBSEARCH_FORCE=1` in the background
   (it can take 20 to 60 minutes; say so). While it runs, open the Guide tab
   with them.
5. When it finishes, walk through two or three real cards: the scores, why, the
   tailored resume, and the buttons. Ask if any score feels wrong; if so, record
   it in `learning_log` and adjust the profile.

## Step 8 of 8: Wrap up (2 minutes)

- Set `onboarded: true` in `profile/candidate.json`; delete
  `profile/onboarding-progress.json`.
- Append a dated entry to `docs/WORKLOG.md` (what was set up, choices made).
- Give them a short cheat sheet in chat:
  - Two icons on your Desktop: **Job Search Dashboard** (your jobs) and **Job
    Search Assistant** (talk to me). The dashboard is also at http://localhost:7411.
  - Searches run at <times>. Keep the Mac plugged in and the lid open at those
    times if you can; if it was asleep it catches up when you wake it.
  - To talk to me again: open Terminal, type `cd ~/job-search && ~/.local/bin/claude`.
  - Things you can ask me any time: "change my scoring", "add this job: <link>",
    "is everything working?", "explain the dashboard again", "prep me for my
    interview at <company>".
  - Shortcut commands: `/tune` (change what counts), `/status` (health check),
    `/add-job` (paste a link), `/tour` (the explanation again).
- Thank them and wish them luck.
