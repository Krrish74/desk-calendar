# Troubleshooting

Jump to your computer: **[Windows](#windows)** · **[Mac](#mac)** · then **[Both](#both-windows-and-mac)**
(installing, Google sign-in, tasks, assistant).

## Windows

**Windows SmartScreen blocks the installer ("Windows protected your PC").** It's unsigned. Click
**More info → Run anyway**.

**`npm run dist` fails with `spawn UNKNOWN` or leaves a tiny (a few hundred KB) installer.**
Run it again. Antivirus scanning sometimes interrupts electron-builder the first time. A good installer
is over 100 MB.

**Clicking × doesn't quit.** By design it hides to the tray (bottom-right of the taskbar; check the `^`
overflow) so reminders keep coming. Right-click the tray icon → **Quit**.

**No desktop notifications.** They're reliable in the installed app, less so with `npm start`. Check
Windows Settings → System → Notifications (and Do not disturb), then Settings → Notifications →
**Send a test notification**.

**Ctrl+Shift+Space does nothing.** Another app already uses it. Settings → General → click the shortcut box and
press another; the page tells you if it's taken.

**No Mica effect.** Mica needs Windows 11 (build 22621 or newer). Older versions get a solid dark background.

**Start completely fresh.** Quit from the tray icon, then delete `%APPDATA%\desk-calendar` (when run with
`npm start`) or `%APPDATA%\Desk Calendar` (installed app). That removes your credentials, sign-in, keys and
preferences from this PC.

## Mac

**"Desk Calendar can't be opened because Apple cannot check it" / "Apple could not verify…".**
The app isn't signed with an Apple Developer ID. A copy you built yourself with `npm run dist` opens normally;
one you downloaded or were sent is blocked once. Open **System Settings → Privacy & Security**, scroll down and
click **Open Anyway** next to Desk Calendar, then confirm.

**"Desk Calendar is damaged and can't be opened".** Same cause, for a copy that was downloaded. In Terminal:
`xattr -cr "/Applications/Desk Calendar.app"`, then open it again.

**It keeps asking for my password to use the Keychain.** Desk Calendar keeps its encryption key in your login
Keychain. When macOS asks, enter your Mac password and click **Always Allow** (not just Allow). If you clicked
**Deny**, the app can't save your sign-in: quit it, open it again and choose **Always Allow**.

**`npm run dist` only made one of the two `.dmg` files, or fails on the Intel one.** Building the Intel
(`x64`) copy on an Apple Silicon Mac downloads a second Electron; check your network and run it again. To build
just one: `npx electron-builder --mac --arm64` (Apple Silicon) or `--x64` (Intel).

**The red button doesn't quit.** By design it keeps running in the menu bar (the calendar icon at the top right)
so reminders still arrive. Click the Dock icon or the menu bar icon to bring the window back; quit with **Cmd+Q**
or the menu bar icon → **Quit**. On a MacBook with a notch, a crowded menu bar can hide the icon behind the notch;
the Dock icon and Cmd+Shift+Space still work.

**No notifications.** System Settings → **Notifications** → **Desk Calendar** (or **Electron** when running
from source): turn on **Allow notifications**. Also check Focus / Do Not Disturb. Then Settings → Notifications →
**Send a test notification**.

**Cmd+Shift+Space does nothing.** Another app (often a launcher or input-source switcher) owns it. Settings →
General → click the shortcut box and press another, e.g. Cmd+Option+K.

**The menu bar and Dock say "Electron".** That's normal while running with `npm start`. The app built with
`npm run dist` is called Desk Calendar.

**No see-through background.** It follows **System Settings → Accessibility → Display → Reduce transparency**.

**`git clone` asks for a password.** For a private repository GitHub wants a **personal access token**, not your
account password (GitHub → Settings → Developer settings → Personal access tokens).

**Start completely fresh.** Quit with Cmd+Q, then delete `~/Library/Application Support/desk-calendar` (from
`npm start`) or `~/Library/Application Support/Desk Calendar` (built app). In Finder: **Go → Go to Folder…** and
paste the path. That removes your credentials, sign-in, keys and preferences from this Mac.

## Both (Windows and Mac)

### Installing and starting

**`npm install` finishes but `npm start` says Electron failed to install / can't find the Electron binary.**
Newer npm versions block package install scripts unless you approve them. This project approves Electron
in `package.json` (`allowScripts`), but if your npm still skipped it, run:

```shell
npm approve-scripts electron
node node_modules/electron/install.js
```

**`npm` or `node` isn't recognised / command not found.** Node.js isn't installed, or the terminal was open
before you installed it. Install Node.js 22+ from <https://nodejs.org/>, then close and reopen PowerShell /
Terminal.

### Google sign-in

**"Access blocked: Desk Calendar has not completed the Google verification process".**
Your Google account isn't a test user of your OAuth client. Google Cloud Console → Google Auth Platform →
**Audience → Test users → Add users**, add the account, and try again.

**`403 accessNotConfigured` or "Google Calendar API has not been used in project…".**
Enable the **Google Calendar API** for your project (SETUP-GOOGLE.md, step 2).

**"Google hasn't verified this app".** Expected for a personal OAuth client. Click **Continue**.

**The app asks me to sign in again every week.** Your OAuth client is in Testing mode, where Google
expires sign-ins after 7 days. See the end of SETUP-GOOGLE.md.

**I picked the wrong file / want to use another Google Cloud project.**
Settings → Account → **Replace credentials.json…**, then sign out and back in.

### Tasks

**The sidebar says "Connect Google Tasks".** Your sign-in is from before Tasks support, or you didn't allow Tasks.
Enable the **Google Tasks API** and add the `.../auth/tasks` scope (SETUP-GOOGLE.md, steps 2 and 3), then click
**Connect Google Tasks** and allow access.

**"The Google Tasks API is turned off for your Google Cloud project".** Enable it: Google Cloud Console →
APIs & Services → Library → Google Tasks API → **Enable**. It can take a minute to take effect.

**A task's time doesn't show.** Google's Tasks API only gives the due date, never the time, so Desk Calendar shows
tasks by day.

**A list is missing.** Settings → Calendars → **Task lists**: make sure it's switched on.

### Assistant

**"This message already made 3 changes…" / the assistant asks before changing a meeting.** That's the safety limit
(see [ASSISTANT.md](ASSISTANT.md#safety-limits)): reply "yes" and it does the rest.

**iPhone: "The assistant has used its monthly limit".** It resets next month, or raise `ASSISTANT_MONTHLY_LIMIT_USD`
on the Worker (SETUP-IPHONE.md, step 6).

See the table at the end of [ASSISTANT.md](ASSISTANT.md#problems) for anything else.

### Phone app link

**What the desktop app sends to the phone app's server.** To prove it's you, the desktop app sends its Google sign-in
(an access token, valid for about an hour) to the address in Settings → Account → Phone app, which must be `https://`.
Only enter the address of your own Worker.
