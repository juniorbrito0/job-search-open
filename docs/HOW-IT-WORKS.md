# How your job search works

This is the plain-language guide. The dashboard's **Guide** tab says the same
thing, so you never have to come back here.

## The short version

Twice a day your Mac quietly looks for new jobs that fit you, scores each one
from 1 to 5, writes a tailored resume for the best ones, and puts everything on
your **dashboard**: a private web page that lives only on your Mac, at
**http://localhost:7411**. You decide what to apply to. Nothing is ever sent
unless you press a button.

## When things happen

| What | When | What you need to do |
|---|---|---|
| **Job search** | Twice a day, 8:00 am and 4:00 pm (you can change this) | Nothing. If your Mac was asleep, it runs when you wake it. If it was shut down, it waits for the next time. |
| **Weekly email summary** | Fridays at 10:00 am (you can change or switch it off) | Read it on the dashboard or ask Claude about it. |
| **Update from email** | Only when you press the button | Press it after you get replies from employers. |
| **Apply queue** | Only when you press **Apply queue now** | Check the list first. |
| **Dashboard** | Always on | Bookmark http://localhost:7411 |

Each search takes roughly 20 to 60 minutes. A browser window may open by itself
during a search or while applying: that is the job browser at work. Leave it
alone and it closes when done.

**Keep your Mac plugged in and the lid open at search times if you can.**

## Where jobs come from

- **LinkedIn**: a search for your job titles in your area and remote, every run.
- **Your LinkedIn job-alert emails** (if Gmail is connected).
- **Startup job boards**: Y Combinator and Wellfound (optional).
- **Communitech** (Canadian tech job board, optional).
- **Startup watchlist**: a few new small companies in your area every day, whose
  careers pages are checked on every search (optional).

## The dashboard tabs

| Tab | What it is for |
|---|---|
| **Review** | New jobs waiting for your opinion, best first. Your main to-do list. |
| **Pipeline** | Jobs you said yes to, laid out by stage: interested, applied, screening call, interview, offer. |
| **Startups** | The watchlist of small companies near you. |
| **Archive** | Jobs you said "not for me" to. You can restore any of them. |
| **Screened out** | Jobs hidden by one of your deal-breakers, with the reason. Check it now and then to be sure nothing good was hidden. |
| **Analytics** | Charts: how many jobs found and applied to per week, where they come from, score spread. |
| **Rejected** | Only jobs where an employer wrote back to say no, and what they have in common. |
| **Lost** | Everything else that ended: postings that closed, applications with no answer after 14 days. |
| **Guide** | This explanation. |

## The buttons you will use most

- **Search now** (top bar): run a search right away instead of waiting.
- On a Review card: **Agree** moves it to your Pipeline. **Disagree** asks you
  why (location, pay, industry, too senior or junior, company size, the work
  itself, other). Your reasons teach future scores.
- **Apply for me**: puts the job on the apply queue.
- **Apply queue now** (Pipeline): applies to everything on the queue, up to 8 at
  a time. You can watch the progress live.
- **Prepare tailored resume**: makes a resume version for that job.
- **Update from email** (Pipeline): reads replies from employers and moves cards
  (for example from Applied to Interview).
- **Send this message**: sends the drafted note to a hiring manager. Nothing is
  sent until you press it.
- **◐**: switch between light and dark.

## Job sites that want you to make an account

Many company job sites (Workday, for example) make you create an account before
you can apply. You choose how that works:

- **Without a password manager** (the starting point): it uses "Sign in with
  Google" when the site offers it. Otherwise it leaves that job for you, with the
  link, and says so on the card. It takes about 10 minutes to do yourself.
- **With a password manager** (more automatic): it creates the account itself
  with a new strong password, saves the password in your password manager first,
  confirms the email, and finishes the application. Later you can sign in to that
  site yourself with the saved password.
  - **1Password** (recommended, about $3 to $5 a month): fully automatic.
  - **Bitwarden** (free): fully automatic, but your Bitwarden master password has
    to be stored in your Mac's Keychain so it can unlock while you are away.
  - **Apple Passwords or Google (Chrome) passwords**: Apple and Google do not let
    any program save passwords into them. The job search keeps the new passwords
    in your Mac's Keychain instead, and when you ask, it makes a file you import
    into Apple Passwords or Google in a few clicks.

Ask Claude "connect my password manager" (or type `/password-manager`) any time.

## What it will never do

- Apply to anything without you pressing a button.
- Message, connect with, or follow anyone, post anything, or change any setting
  on LinkedIn or anywhere else.
- Make up experience on your resume or guess an answer on a form. If a form asks
  something it does not know, it stops and tells you exactly what is needed.
- Use or see your own passwords. If you connect a password manager, it only
  creates new passwords for job sites, files each one in your password manager
  first, and never writes them anywhere else.
- Send your information anywhere except the job applications you approve.

## Your information

Everything (your resume, your answers, the jobs) stays in the `job-search`
folder on your Mac. Gmail is read through a connection you can remove any time at
https://claude.ai/settings/connectors. LinkedIn is used through a separate
browser that only this job search uses.

## Talking to Claude later

Double-click **Job Search Assistant** on your Desktop (or open **Terminal**, type
`cd ~/job-search && ~/.local/bin/claude` and press Return), then ask in plain words. Shortcuts: `/status` (is everything working?), `/tune` (change what
counts in scoring), `/add-job` (paste a job link to score it), `/tour` (explain
the dashboard again).
