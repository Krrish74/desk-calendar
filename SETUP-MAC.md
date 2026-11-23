# Desk Calendar on a Mac

Everything for **macOS 12 (Monterey) or newer**, on Apple Silicon (M1 and newer) or Intel, start to finish
(about 20 minutes, most of it the Google step). On Windows? Use **[SETUP-WINDOWS.md](SETUP-WINDOWS.md)** instead.

Commands below are typed in **Terminal**: press **Cmd+Space**, type `Terminal`, and press Return.

## 1. Install the tools (once)

1. **Node.js 22 or newer**: download the **LTS** macOS installer (`.pkg`) from <https://nodejs.org/> and open it.
   (Using Homebrew? `brew install node` works too.)
2. **Git**: check whether you have it:

   ```shell
   git --version
   ```

   If macOS offers to install the **Command Line Developer Tools**, click **Install** and wait for it to finish.
3. Close Terminal and open it again, then check Node:

   ```shell
   node -v
   ```

   It should print `v22` or higher.

## 2. Download Desk Calendar

```shell
cd ~/Documents
```

```shell
git clone <repository URL>
```

```shell
cd desk-calendar
```

```shell
npm install
```

Replace `<repository URL>` with the address from the green **Code** button on this repository's GitHub page
(the **HTTPS** one, ending in `.git`). If the repository is private, Git asks for your GitHub username and a
password: use a **personal access token** as the password (GitHub → Settings → Developer settings → Personal access
tokens), or sign in once with GitHub Desktop or `gh auth login` and Git uses that.

## 3. Create your Google sign-in (once, ~10 minutes)

Follow **[SETUP-GOOGLE.md](SETUP-GOOGLE.md)**. You end up with a `credentials.json` file in your Downloads folder.
Everyone uses their own Google Cloud project, so nobody shares keys. If you already did this on a Windows PC, reuse
the same `credentials.json` (AirDrop it or email it to yourself).

## 4. Start the app

```shell
npm start
```

1. Click **Load credentials.json…** and pick the file from step 3.
2. Click **Sign in with Google**. Your browser opens: pick your account, click **Continue** on the
   "Google hasn't verified this app" screen, and allow Calendar and Tasks.
3. macOS asks whether the app may use its key in your **Keychain** (that's where your sign-in is encrypted).
   Enter your Mac password and click **Always Allow**.
4. Your calendar appears. If macOS asks about notifications, click **Allow** so reminders can show.

While running this way the menu bar and Dock say "Electron"; the app you build in the next step is called
Desk Calendar.

Optional: **Settings → Assistant**, pick a provider and paste its API key. Several are free; see
**[docs/ASSISTANT.md](docs/ASSISTANT.md)**. On Apple Silicon, a local model through Ollama works well too.

## 5. Install it as a normal app (recommended)

```shell
npm run dist
```

This makes two disk images in `dist/`:

- `Desk Calendar-1.0.0-arm64.dmg` for Apple Silicon Macs (M1 and newer)
- `Desk Calendar-1.0.0.dmg` for Intel Macs

(Not sure which you have? Apple menu → **About This Mac**: "Chip Apple M…" is Apple Silicon, "Processor Intel…" is
Intel.) Open the one for your Mac and drag **Desk Calendar** into **Applications**, then open it from Launchpad or
the Applications folder. Repeat step 4's sign-in once (the built app keeps its own settings).

A copy you built yourself opens normally. The app isn't signed with an Apple Developer ID, so a `.dmg` someone
*sends* you is blocked the first time ("Apple could not verify…"): open **System Settings → Privacy & Security**,
scroll down and click **Open Anyway** next to Desk Calendar.

Uninstall by dragging Desk Calendar from Applications to the Bin.

## Using it on a Mac

- **The red button hides the window**; Desk Calendar keeps running in the **menu bar** (the calendar icon at the
  top right) so reminders keep coming. Click its **Dock** icon to bring the window back. **Cmd+Q** really quits.
- **Cmd+Shift+Space** shows or hides it from any app (change it in Settings → General).
- **Cmd+N** new event, **Cmd+R** refresh, **Cmd+,** settings, **Cmd+W** hide the window.
- Also: **D / W / M / A** switch views, **T** today, **J / K** next / previous, **C** new event.
- **Open at login** is on by default in the built app (Settings → General).

## Where your data lives

`~/Library/Application Support/desk-calendar/` when run with `npm start`, `~/Library/Application Support/Desk
Calendar/` for the built app (in Finder: **Go → Go to Folder…** and paste the path). Your Google sign-in and API
keys there are encrypted with a key kept in your Keychain; nothing secret is in the project folder. To start fresh,
quit with Cmd+Q and delete that folder.

## Updating

```shell
cd ~/Documents/desk-calendar && git pull && npm install
```

Then `npm start`, or `npm run dist` again and drag the new copy into Applications (replace the old one).

## Optional: the iPhone app

Follow **[SETUP-IPHONE.md](SETUP-IPHONE.md)**, typing its commands in Terminal. Then link the two in
**Settings → Account → Phone app**.

## Problems?

See **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**: the *Mac* section, then *Both*.
