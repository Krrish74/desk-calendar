# Troubleshooting

## Installing and starting

**`npm install` finishes but `npm start` says Electron failed to install / can't find the Electron binary.**
Newer npm versions block package install scripts unless you approve them. This project approves Electron
in `package.json` (`allowScripts`), but if your npm still skipped it, run:

```powershell
npm approve-scripts electron
node node_modules/electron/install.js
```

**`npm run dist` fails with `spawn UNKNOWN` or leaves a tiny (a few hundred KB) installer.**
Run it again. Antivirus scanning sometimes interrupts electron-builder the first time. A good installer
is over 100 MB.

**Windows SmartScreen blocks the installer.** It's unsigned. Click **More info → Run anyway**.

## Google sign-in

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

**Start completely fresh.** Quit the app from the tray icon, then delete the app-data folder:
`%APPDATA%\desk-calendar` (when run with `npm start`) or `%APPDATA%\Desk Calendar` (installed app).
That removes your credentials, sign-in, keys and preferences from this PC.

## Window, tray and notifications

**Clicking × doesn't quit.** By design it hides to the tray (bottom-right of the taskbar; check the `^`
overflow). Right-click the tray icon → **Quit**.

**The show/hide shortcut doesn't work.** Another app already uses it. Settings → General → pick another
shortcut; the page tells you if it's taken.

**No desktop notifications.** They're reliable in the installed app, less so with `npm start`. Check
Windows Settings → System → Notifications (and Do not disturb), then Settings → Notifications →
**Send a test notification**.

**No Mica effect.** Mica needs Windows 11 (build 22621 or newer). Older versions get a solid dark background.

## Assistant

See the table at the end of [ASSISTANT.md](ASSISTANT.md#problems).
