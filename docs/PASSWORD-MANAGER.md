# Password manager: guided connection (Claude reads this)

Purpose: let the apply queue create accounts on company job sites (Workday,
iCIMS, Taleo, SuccessFactors and similar) and finish the application without the
candidate. Without it, those roles are left for the candidate by hand.

Follow the talking rules in `docs/ONBOARDING.md`: plain words, one step at a
time, wait for "done", never show commands or secrets. **Never ask them to paste
a password, token or key into this chat.** Secrets go only into the hidden Mac
pop-up that `scripts/connect-password-manager.sh` opens.

## 1. Explain and choose (multiple choice)

Say it like this:

> Some company job sites make you create an account before you can apply. If you
> connect a password manager, I can make those accounts myself: I create a strong
> new password, save it in your password manager first, and then finish the
> application. You can always sign in to those sites later with the saved
> password. Which do you use, or would like to use?

Options, recommendation first:

1. **1Password (recommended).** Fully automatic. Paid (about $3 to $5 a month;
   Individual or Families plan is fine). New logins appear in a "Job Portals"
   vault in their 1Password app.
2. **Bitwarden (free).** Fully automatic, with one trade-off to state plainly:
   their Bitwarden master password is stored in the Mac's Keychain (the Mac's
   built-in locked password store) so the job search can unlock Bitwarden while
   they are away. Anyone who can use their Mac account could reach it.
3. **Apple Passwords or Google / Chrome passwords.** Say honestly: "Apple and
   Google do not let any program save passwords into them, so it can't be fully
   automatic. I can keep the new job-site passwords in your Mac's Keychain, and
   whenever you like I'll make a file you import into Apple Passwords or Google
   in a few clicks." (This is option `mac-keychain`.) If they would rather have
   it fully automatic, suggest 1Password just for job sites.
4. **Not now.** Job sites that need an account stay on their to-do list with a
   link. They can change their mind any time.

Whatever they choose, explain: "Sign in with Google" is always used first when a
site offers it, so a password is only created when there is no other way.

## 2a. 1Password

Check first: do they already have a 1Password account? If not, send them to
https://1password.com/sign-up to start one (Individual plan) and wait.

Then, one step at a time:

1. "Open https://my.1password.com and sign in." (Run `open https://my.1password.com`.)
2. "Make a new vault just for job sites: in the left sidebar click **Vaults**,
   then **New Vault**, name it **Job Portals**, and click **Create**."
   (The job search cannot use their main Personal/Private vault; 1Password does
   not allow that, which is also safer.)
3. "In the left sidebar click **Developer** (it may be under **More**). Choose
   **Service Account** (sometimes under *Infrastructure Secrets Management* or
   *Directory*). Click **Create a Service Account**."
4. "Name it **Job Search**. When it asks which vaults it can use, pick **Job
   Portals** and tick **Read** and **Write**. Click **Create Account**."
5. "You'll see a long token that starts with **ops_**. Click **Copy**. (Also
   click **Save in 1Password** so you have a copy.) Then tell me 'copied'."
6. Run `bash scripts/connect-password-manager.sh 1password "Job Portals"`.
   Say: "A small window will pop up asking for the token. Click in the box, press
   Command and V to paste, and click Save. It goes straight into your Mac's
   Keychain; I never see it."
7. Read the result. Success says it can save to the vault. If the token was
   rejected, have them copy it again (step 5) and repeat step 6. If the vault
   cannot be opened, the service account was not given Read and Write on "Job
   Portals": they can fix that on the same Developer page, or create a new one.

If a step looks different on their screen, ask them to take a screenshot
(Command, Shift, 4, then drag over the window) and drag the image into this
window, and guide them from what you see.

## 2b. Bitwarden

1. Account: if they have none, https://vault.bitwarden.com/#/register (free).
2. "Open https://vault.bitwarden.com and sign in. Click **Settings**, then
   **Security**, then the **Keys** tab, then **View API key**. Type your master
   password when it asks. Leave that page open."
3. Run `bash scripts/connect-password-manager.sh bitwarden "Job Portals"`. Three
   pop-ups appear in turn: "Copy **client_id** from the page and paste it into
   the first pop-up. Then **client_secret** into the second. The third asks for
   your Bitwarden master password."
4. Read the result. On failure, the usual cause is a mistyped master password:
   run it again.

## 2c. Apple Passwords or Google (mac-keychain)

1. Run `bash scripts/connect-password-manager.sh mac-keychain`. No pop-up needed.
2. Explain the routine: "Every week or two, ask me to 'export my job-site
   passwords' and I'll walk you through importing them."

**Exporting (when they ask, or `/password-manager export`):**
- Write the file to their Desktop:
  `.venv/bin/python scripts/save_login.py --export-csv apple ~/Desktop/job-site-passwords.csv`
  (or `google` instead of `apple`).
- Apple Passwords: "Open the **Passwords** app, choose **File**, then **Import
  Passwords**, pick *job-site-passwords* on your Desktop, and click Import."
- Google: "Go to https://passwords.google.com, click the gear (Settings), then
  **Import passwords**, **Select file**, pick *job-site-passwords* on your Desktop."
  (In Chrome: Passwords, Settings, Import.)
- **Then delete the file** (it holds passwords in plain text): move it to the Bin
  and empty the Bin. Offer to delete it for them once they confirm the import.
  Never leave it on the Desktop.

## 3. Finish

- Confirm in one sentence what will now happen with account-only job sites.
- Re-check the waiting queue: positions blocked earlier for "needs an account"
  can now be retried. Offer to put them back on the apply queue
  (`apply_requested: true`).
- Append a dated entry to `docs/WORKLOG.md` (which manager, never any secret).

## Changing or removing

- Switch managers: run the script with the new kind.
- Stop creating accounts: `bash scripts/connect-password-manager.sh off`.
- See what was created (titles only): `.venv/bin/python scripts/save_login.py --list`.
- To fully disconnect 1Password, they can also delete the "Job Search" service
  account on the 1Password Developer page; for Bitwarden, "Rotate API key".
