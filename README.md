# Job Search

Your own job-search assistant. Twice a day it looks for jobs that fit you,
scores them, writes a tailored resume for the best ones, and shows everything on
a private page on your Mac. It only applies when you press a button.

You do not need to know anything technical. You copy three lines, and Claude
does the rest while asking you questions.

## What you need

- A Mac.
- A paid Claude plan (Pro or Max) at https://claude.ai. Twice-daily searches use
  a fair amount of it; if you hit limits often, Max, or one search a day, fixes it.
- Your resume as a Word or PDF file.
- About 45 minutes for the first setup.

## Setup: three steps

You will use the **Terminal** app. Open it: press **Command + Space**, type
`Terminal`, press **Return**. A window with text appears. That is it.

For each step: copy the grey line, click in the Terminal window, paste it with
**Command + V**, and press **Return**.

**Step 1. Install Claude Code** (the version of Claude that can set things up on
your Mac). This is Anthropic's official installer:

```
curl -fsSL https://claude.ai/install.sh | bash
```

When it finishes, **close the Terminal window and open a new one** (Command + Q,
then open Terminal again).

**Step 2. Download the job search to your Mac:**

```
git clone https://github.com/juniorbrito0/job-search-open.git ~/job-search
```

If a small window pops up asking to install "command line developer tools",
click **Install**, wait for it to finish (about 10 minutes), then paste the line
again.

**Step 3. Start Claude in that folder:**

```
cd ~/job-search && ~/.local/bin/claude
```

The first time, Claude asks you to sign in to your Claude account in the
browser. Do that, come back, and type **hi**. Claude takes it from there: it
will ask about you, explain everything, and switch it on.

When Claude asks for permission to do something on your Mac, choose
**"Yes, and don't ask again"** for anything in this job-search folder.

## Afterwards

Setup puts two icons on your Desktop:

- **Job Search Dashboard**: double-click to see your jobs (or go to **http://localhost:7411**).
- **Job Search Assistant**: double-click to talk to Claude about your search.
  (Or open Terminal and paste `cd ~/job-search && ~/.local/bin/claude`.)

- Ask anything in plain words, for example "is everything working?",
  "add this job: <link>", "pay matters more to me now", "help me prep for my
  interview at <company>".

The full plain-language guide is in [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md),
and the dashboard has a **Guide** tab with the same information.

## Want it more automatic?

Some company job sites make you create an account before you can apply. If you
connect a **password manager**, the assistant can create those accounts and
finish the application on its own, saving each new password in your password
manager. 1Password works best (fully automatic). Bitwarden (free) also works.
Apple Passwords and Google (Chrome) passwords cannot be written to by any
program, so with those you import the new passwords in a few clicks now and then.
Claude offers this during setup, or ask "connect my password manager" any time.

## Your privacy

Everything stays in the `job-search` folder on your Mac. Your email is read
through a connection you can switch off any time at
https://claude.ai/settings/connectors. Nothing you enter is ever sent back to
this shared copy.
