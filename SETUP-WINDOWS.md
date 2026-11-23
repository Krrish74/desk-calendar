# Desk Calendar on Windows

Everything for **Windows 10 or 11**, start to finish (about 20 minutes, most of it the Google step).
On a Mac? Use **[SETUP-MAC.md](SETUP-MAC.md)** instead.

Commands below are typed in **PowerShell**: press **Start**, type `PowerShell`, and open it.

## 1. Install the tools (once)

1. **Node.js 22 or newer**: download the **LTS** Windows installer from <https://nodejs.org/> and run it with
   the default options.
2. **Git**: download it from <https://git-scm.com/download/win> and run the installer with the default options.
3. Close PowerShell and open it again, then check both:

   ```powershell
   node -v
   ```

   ```powershell
   git --version
   ```

   `node -v` should print `v22` or higher.

## 2. Download Desk Calendar

```powershell
cd $HOME\Documents
```

```powershell
git clone <repository URL>
```

```powershell
cd desk-calendar
```

```powershell
npm install
```

Replace `<repository URL>` with the address from the green **Code** button on this repository's GitHub page
(the **HTTPS** one, ending in `.git`). If the repository is private, GitHub asks you to sign in the first time:
use the account that was invited.

## 3. Create your Google sign-in (once, ~10 minutes)

Follow **[SETUP-GOOGLE.md](SETUP-GOOGLE.md)**. You end up with a `credentials.json` file in your Downloads folder.
Everyone uses their own Google Cloud project, so nobody shares keys.

## 4. Start the app

```powershell
npm start
```

1. Click **Load credentials.json…** and pick the file from step 3.
2. Click **Sign in with Google**. Your browser opens: pick your account, click **Continue** on the
   "Google hasn't verified this app" screen, and allow Calendar and Tasks.
3. Your calendar appears.

Optional: **Settings → Assistant**, pick a provider and paste its API key. Several are free; see
**[docs/ASSISTANT.md](docs/ASSISTANT.md)**.

To start it again later: open PowerShell, `cd $HOME\Documents\desk-calendar`, then `npm start`. Or install it
as a normal app (next step) and skip PowerShell from then on.

## 5. Install it as a normal app (recommended)

```powershell
npm run dist
```

This makes `dist\Desk Calendar Setup 1.0.0.exe`. Double-click it to install: you get a Start menu entry and a
desktop shortcut. The installer isn't signed, so Windows SmartScreen says **"Windows protected your PC"**:
click **More info → Run anyway**. That's normal for personal apps.

The installed app asks for `credentials.json` and the Google sign-in once more (it keeps its own settings).
Uninstall it from **Windows Settings → Apps**.

## Using it on Windows

- **× hides the window** to the tray (bottom-right of the taskbar; check the `^` overflow) so reminders keep
  coming. Right-click the tray icon → **Quit** to really close it.
- **Ctrl+Shift+Space** shows or hides it from any app (change it in Settings → General).
- **Start with Windows** is on by default in the installed app (Settings → General).
- Keyboard: **D / W / M / A** switch views, **T** today, **J / K** next / previous, **C** new event.
- On Windows 11 the background uses **Mica** (it tints with your wallpaper).

## Where your data lives

`%APPDATA%\desk-calendar\` when run with `npm start`, `%APPDATA%\Desk Calendar\` for the installed app.
Your Google sign-in and API keys there are encrypted with your Windows account (DPAPI); nothing secret is in the
project folder. To start fresh, quit from the tray and delete that folder.

## Updating

```powershell
cd $HOME\Documents\desk-calendar
```

```powershell
git pull
```

```powershell
npm install
```

Then `npm start`, or `npm run dist` again and reinstall.

## Optional: the iPhone app

Follow **[SETUP-IPHONE.md](SETUP-IPHONE.md)**, typing its commands in PowerShell. Then link the two in
**Settings → Account → Phone app**.

## Problems?

See **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**: the *Windows* section, then *Both*.
