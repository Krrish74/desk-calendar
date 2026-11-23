# Mac test plan (for an AI coding agent + a person)

Desk Calendar's Mac support has passed its automated tests on GitHub's Mac machines, but nobody has set it up
by hand on a real Mac yet. This plan walks through a full setup on a Mac and writes down **every bug,
confusing step or doc mistake** in a report, so the maintainers can fix them later.

**Who does what**

- **The agent** (Antigravity, Copilot, Cursor, …) reads the docs, runs the Terminal commands, reads the output,
  and writes the report.
- **The person** does what an agent can't: clicks in the app, looks at the window and the menu bar, answers
  macOS prompts (Keychain, notifications, "Open Anyway"), and does the Google Cloud Console step in the browser.
  The agent asks the person a short yes/no or "what do you see?" question for each of those.

To start, tell the agent:

> Read docs/MAC-TEST-PLAN.md and carry it out step by step. Ask me whenever a step needs me.

---

## Rules for the agent

1. **You are a tester, not a fixer.** Don't change any file in this repository except the report
   (`mac-test-report.md`) and screenshots in `mac-test-shots/`. If something fails, write it down. You may try a
   workaround to get past a blocker (for example a different command), but record exactly what failed, what you
   tried, and what worked. Never commit or push.
2. **Ask before every Terminal command**, and say in one line what it does. Never use `sudo`. Never delete
   anything outside this repository's `dist/` folder, except where a step below says so.
3. **No secrets in the chat or the report.** Never ask for, print or copy the contents of `credentials.json`,
   API keys, tokens, or anything in `~/Library/Application Support/desk-calendar/` except file *names*. In error
   messages, replace email addresses with `you@example.com` and real event or task titles with `<event>`.
4. **Write the report as you go** (see [The report](#the-report) at the end), not only at the end, so nothing is
   lost if the session stops.
5. A finding is anything where the docs and reality differ: an error, a warning, a step that's unclear, a
   screenshot that doesn't match, something that looks wrong, or something that took much longer than the guide
   says. When unsure, report it as **Minor** or **Doc**. Too many findings is better than too few.
6. Some checks need the person to look at the screen. Ask one short question at a time. If they can, ask them to
   take a screenshot (Cmd+Shift+4, then drag) and save it in `mac-test-shots/` with the check's number as its name.

---

## Step 0. The Mac

Run these and put the answers at the top of the report:

```shell
sw_vers
```

```shell
uname -m
```

```shell
node -v; npm -v; git --version
```

```shell
echo $SHELL
```

Also ask the person: Mac model (Apple menu → About This Mac), display (built-in / external, notch or not), and
whether the menu bar is set to light or dark (System Settings → Appearance).

`uname -m` says `arm64` (Apple Silicon) or `x86_64` (Intel). If Node is missing or older than 22, that's a finding
**only if** SETUP-MAC.md didn't make the fix clear; then install it as SETUP-MAC.md says (ask the person) and
continue.

---

## Step 1. Read the docs like a new user

Read `README.md`, `SETUP-MAC.md`, `SETUP-GOOGLE.md` and the **Mac** and **Both** sections of
`docs/TROUBLESHOOTING.md`. Report as **Doc** findings:

- steps that are unclear, out of order, or assume something not explained
- Windows-only wording in Mac instructions (PowerShell, `%APPDATA%`, backslash paths, "tray", Ctrl instead of Cmd)
- broken links or anchors (try opening each relative link)
- commands that don't work in the Mac's default shell (zsh)

---

## Step 2. From source: install and the automated tests

Follow SETUP-MAC.md → **Run it from the source code**, steps 1–2 (the code is already downloaded if you are
reading this). Then:

```shell
npm install
```

Record: did it finish, how long it took, and any `WARN` / `ERR!` lines (copy them). Then:

```shell
npm test
```

**Expected:** `ℹ pass 14` / `ℹ fail 0` for the unit tests, then the Electron tests ending in
`19 passed, 0 failed` and including `✔ fits the platform (darwin)`. A test window appears and closes by itself;
that's normal. Record the totals and copy any `✖` line with the few lines under it.

Optional, the iPhone app's server tests (no Cloudflare account needed):

```shell
cd worker && npm install && npm test; cd ..
```

**Expected:** `fail 0`.

---

## Step 3. From source: first start

```shell
npm start
```

Leave it running (the agent can keep reading its Terminal output; copy any error or warning lines into the
report). Ask the person to check each item and answer yes / no / what they see:

| # | Check | Expected |
|---|---|---|
| 3.1 | The window opens | Dark window with the setup card ("Welcome 👋"), no white flash or blank window |
| 3.2 | Title bar | Red / yellow / green buttons at the top left, vertically centred in the dark strip; "Desk Calendar" with its icon just to their right, **not** overlapping them |
| 3.3 | Background | Slightly see-through dark background (it tints with the desktop picture behind it), text readable |
| 3.4 | Font | Looks like normal Mac text (San Francisco), not Times or a fallback font |
| 3.5 | Dock | Desk Calendar's blue calendar icon in the Dock (not Electron's atom icon). Name under it may say "Electron": expected from source |
| 3.6 | Menu bar (top of screen) | Menus: Electron (or Desk Calendar) · File · Edit · View · Window. File has New Event, Refresh, Close Window |
| 3.7 | Menu bar icon | A small calendar outline at the top right of the screen, black on a light menu bar / white on a dark one (not a coloured square, not invisible) |
| 3.8 | Click the menu bar icon | A menu opens: Show Desk Calendar, New event, Refresh, Settings, Quit |

---

## Step 4. Google sign-in (the person does this part)

The person follows **SETUP-GOOGLE.md** in their browser to make `credentials.json`. The agent waits, then asks:

- Was any step in SETUP-GOOGLE.md different from what Google's pages showed? (Report as **Doc**, with the
  label they actually saw.)
- How long did it take?

Then in the app:

| # | Check | Expected |
|---|---|---|
| 4.1 | **Load credentials.json…** | A normal Mac file picker opens; picking the file is accepted |
| 4.2 | **Sign in with Google** | The default browser (Safari, Chrome, …) opens Google's sign-in page |
| 4.3 | After allowing access | The browser tab shows "✅ Signed in" and "You can close this tab and go back to Desk Calendar." in readable text |
| 4.4 | Keychain | macOS asks whether the app may use its key in the Keychain. After **Always Allow**, it doesn't ask again |
| 4.5 | Calendar | The week view shows the person's events (don't record titles) |
| 4.6 | Quit with Cmd+Q, then `npm start` again | Opens signed in, with no new sign-in or Keychain question |

---

## Step 5. Using it on a Mac

| # | Check | Expected |
|---|---|---|
| 5.1 | Keyboard: D, W, M, A, T, J, K | Day / Week / Month / Agenda, today, next / previous |
| 5.2 | Quick add box: type text, then Cmd+A, Cmd+C, Cmd+V, Cmd+Z | Select all, copy, paste and undo all work |
| 5.3 | Cmd+N | The new-event editor opens. Close it without saving |
| 5.4 | Cmd+R | The calendar refreshes (the refresh icon spins) |
| 5.5 | Cmd+, | Settings opens |
| 5.6 | Settings → General wording | "Open at login" and "Start hidden in the menu bar", not "Start with Windows" / "tray". Time format says "Use system setting" |
| 5.7 | Settings → General → Show/hide shortcut | Shows **Cmd+Shift+Space**. Click the box, press Cmd+Option+K: it saves and shows "Cmd+Option+K". Press Cmd+Option+K in another app: the window hides / shows. Set it back to Cmd+Shift+Space afterwards |
| 5.8 | Settings → Account → "Your data" wording | Mentions the Mac's Keychain and `~/Library/Application Support`, not Windows or `%APPDATA%` |
| 5.9 | Settings → Notifications → **Send a test notification** | macOS asks to allow notifications (first time), then a notification appears |
| 5.10 | Red button | The window hides; the app keeps running (menu bar icon still there). A one-time notification may say it's still running in the menu bar |
| 5.11 | Click the Dock icon | The window comes back |
| 5.12 | Cmd+W | Same as the red button: hides. Dock icon brings it back |
| 5.13 | Green button (full screen), then the red button | Goes full screen; the title strip has no empty gap at the left; red button leaves full screen and hides cleanly (no black screen left behind) |
| 5.14 | Drag the title bar; double-click it | Moves the window; double-click zooms (or does what System Settings → Desktop & Dock says) |
| 5.15 | Tasks: add "test task tomorrow" in Add a task, tick it, delete it with Undo | Works like the README says. Delete the test task afterwards |
| 5.16 | Create an event by clicking an empty slot, drag it, then delete it | All work; nothing left behind in Google Calendar |
| 5.17 | Optional: Settings → Assistant with a key (pasted by the person, never in the chat) and ask "what's on tomorrow?" | Sensible answer; the key status says it's encrypted with the Mac's Keychain |
| 5.18 | Cmd+Q | The app really quits (menu bar icon gone) |

---

## Step 6. Build the Mac app

```shell
npm run dist
```

**Expected:** after a few minutes, `dist/` contains `Desk-Calendar-1.0.0-arm64.dmg` and
`Desk-Calendar-1.0.0-x64.dmg` (the version may be higher). List `dist/` and record the file names and sizes
(about 120 MB each) and any errors.

Then the person opens the `.dmg` matching `uname -m` (`arm64` → the arm64 one, `x86_64` → x64), drags Desk
Calendar into Applications, and opens it:

| # | Check | Expected |
|---|---|---|
| 6.1 | Opening the self-built app | Opens without a security warning (built on this Mac) |
| 6.2 | Name | Menu bar and Dock say **Desk Calendar** (not Electron) |
| 6.3 | First run | Asks for credentials.json again (the built app has its own settings): load it and sign in. Keychain question as in 4.4 |
| 6.4 | Settings → General → Open at login | On by default; System Settings → General → Login Items lists Desk Calendar |
| 6.5 | Log out of the Mac and back in (optional) | Desk Calendar starts by itself; with "Start hidden in the menu bar" on, only the menu bar icon appears |

---

## Step 7. The download from GitHub (what other people will use)

The person opens the repository's **Releases** page (README → "latest release"), downloads the `.dmg` for this
Mac, and installs it over the self-built copy (choose **Replace**):

| # | Check | Expected |
|---|---|---|
| 7.1 | First open | macOS says it "could not verify" Desk Calendar |
| 7.2 | System Settings → Privacy & Security → **Open Anyway** | The app opens after confirming (record the exact wording of every dialog) |
| 7.3 | If macOS instead says the app "is damaged" | Report it as **Major** with the macOS version, then try `xattr -cr "/Applications/Desk Calendar.app"` (ask first) and record whether it then opens |
| 7.4 | After that | Still signed in (same settings as the built app) |

If the Mac is Apple Silicon and the person is willing, also note whether the Intel (`x64`) `.dmg` opens. It should,
through Rosetta (macOS may offer to install Rosetta first).

---

## Step 8. Secrets check

List the app-data folders (names only, don't open the files):

```shell
ls -la ~/Library/Application\ Support/desk-calendar ~/Library/Application\ Support/Desk\ Calendar 2>/dev/null
```

**Expected:** `credentials.json`, `google-token.bin`, `prefs.json`, `window.json`, maybe `anthropic-key.bin` /
`assistant-key-*.bin`. Then check that the token isn't readable as plain text (this prints only a count, never
the contents):

```shell
grep -c -a "refresh_token" ~/Library/Application\ Support/desk-calendar/google-token.bin
```

**Expected:** `0`. Anything else is a **Blocker** (the sign-in would be stored unencrypted). Also check the
repository folder has nothing new with secrets in it:

```shell
git status --short
```

**Expected:** nothing, or only `mac-test-report.md`, `mac-test-shots/` and `dist/`.

---

## Step 9. Clean up (ask the person first)

- Delete the test task and test event if they're still there.
- Optional: remove the built app (drag from Applications to the Bin) and `dist/`.
- Keep the report and screenshots.

---

## The report

Create **`mac-test-report.md`** in the repository's top folder (git ignores it). Use this layout:

```markdown
# Mac test report

Date:
Tester: (first name only)
Agent / editor used:
Mac: (model, chip, macOS version from sw_vers, uname -m)
Node / npm / git:
Menu bar: light / dark · Display: built-in (notch?) / external

## Summary
- Blockers: N · Major: N · Minor: N · Doc: N
- One or two sentences: could a new person set it up from the docs alone?

## Checklist
| # | Result | Note |
|---|---|---|
| 2 npm install | pass / fail | time, warnings |
| 2 npm test | pass / fail | totals |
| 3.1 | pass / fail / skipped | |
| … every numbered check above … | | |

## Findings

### F1. <short title>
- Severity: Blocker | Major | Minor | Doc
- Where: step / check number, and file (e.g. SETUP-MAC.md "Download the app" step 4, or src/main/menu.js) if known
- What happened: (exact error text in a code block, secrets and personal data replaced)
- Expected: (what the docs or this plan said)
- Steps to reproduce:
- Workaround that worked (if any):
- Screenshot: mac-test-shots/<file> (if any)
- Suggested fix (optional; don't make it):

## Things that worked well
## Timings
- Google setup: N min · npm install: N min · npm run dist: N min · total: N min
```

Severity guide:

- **Blocker**: can't continue, a secret is stored or shown in plain text, or data is lost
- **Major**: works only with a workaround, or something important looks or behaves clearly wrong
- **Minor**: cosmetic, or a small behaviour difference
- **Doc**: the app is fine but the instructions are wrong, unclear or missing something

When finished, tell the person: **send `mac-test-report.md` and the `mac-test-shots/` folder to the maintainer.**
Before sending, read the report once more and make sure it has no email addresses, keys, tokens or real
event / task titles.
