# Desk Calendar

A dark desktop app for **Google Calendar** on **Windows and macOS**, with an **AI assistant** that can read and
change your schedule. Built with Electron: one codebase that looks at home on both (Mica and Windows' own caption
buttons on Windows 11; vibrancy, the traffic-light buttons, a menu bar icon and the usual Cmd shortcuts on a Mac).
Bring your own Google Cloud project and your own AI provider (Claude, Gemini, OpenAI, Groq, OpenRouter, a local
model through Ollama, or any OpenAI-compatible server).

![Week view with sample data](docs/screenshots/week.png)

## Features

- **Day / Week / Month / Agenda** views that work like Google Calendar, across **all your calendars** in their Google colors
- **Click an empty slot to create**, **drag to move**, **drag the bottom edge to resize**, click an event for details
- **Quick add** in plain English: `gym tomorrow 6pm`, `lunch w/ Sam fri 12:30-2pm #personal`, `standup 9am for 15 min`
- **Countdown** to your next event, with a **Join** button for Meet / Zoom / Teams links
- **Google Tasks**: "Today's tasks" in the sidebar (unfinished ones from earlier days show as Overdue), tasks in the
  Agenda view, an "Add a task" box that understands dates (`call mom friday`), tick to complete, Undo on delete
- Full editor with **color**, **notifications** (reminders) and **Google Meet**
- **Assistant** side panel: "move gym to 7pm", "what's on Friday?", "delete my 3pm" (with Undo), and
  **"plan my week"**: it turns your tasks into time blocks around your events, following an **About you** profile
  (working hours, focus time, block length, breaks). It shows the plan first and creates the blocks when you agree.
  About $0.001 a message on Claude Haiku: see **[docs/COST.md](docs/COST.md)**
- **Desktop notifications** before events, a **tray icon** (Windows) or **menu bar icon** (Mac), **Ctrl+Shift+Space**
  (**Cmd+Shift+Space** on a Mac) to show/hide from any app, **starts when you sign in**
- **Mica** (Windows 11) or **vibrancy** (Mac) background, Fluent icons, keyboard shortcuts (D / W / M / A views,
  T today, J / K previous/next, C create; on a Mac also Cmd+N new event, Cmd+R refresh, Cmd+, settings)
- **Your secrets stay on your computer**: Google sign-in and API keys are encrypted by the operating system
  (DPAPI with your Windows account, or your Mac's Keychain)

## Get started

**Download the app** from the **[latest release](../../releases/latest)** (no Node.js or other tools needed),
then follow the guide for your computer. Each guide is complete on its own: installing, connecting your Google
account (about 10 minutes, once), and everyday use. They also cover running from the source code.

| | Download | Guide |
|---|---|---|
| **Windows 10 / 11** | `Desk-Calendar-Setup-<version>.exe` | **[SETUP-WINDOWS.md](SETUP-WINDOWS.md)** |
| **Mac with Apple Silicon** (M1 and newer) | `Desk-Calendar-<version>-arm64.dmg` | **[SETUP-MAC.md](SETUP-MAC.md)** |
| **Mac with Intel** | `Desk-Calendar-<version>-x64.dmg` | **[SETUP-MAC.md](SETUP-MAC.md)** |
| **iPhone** (optional, add-on) | nothing to download | **[SETUP-IPHONE.md](SETUP-IPHONE.md)**: a Home Screen app with reminders, set up from either computer |

Both desktop guides use the same Google step, **[SETUP-GOOGLE.md](SETUP-GOOGLE.md)**, and the same code: a fix or
new feature reaches Windows and Mac at the same time.

## What everyone needs

- A **Google account** with the calendar you want to see, and a free **Google Cloud project** you create in about
  10 minutes ([SETUP-GOOGLE.md](SETUP-GOOGLE.md)).
- Optional: an **AI provider** for the assistant. Several are free: [docs/ASSISTANT.md](docs/ASSISTANT.md).

Nobody shares credentials here: everyone who runs this app sets up their **own** Google Cloud project and
their **own** AI key. Nothing secret is in this repository.

## iPhone app (optional)

The same calendar on your iPhone: Agenda / Day / 3-day / Month views, quick add, Google Tasks, the Claude
assistant with task planning, and silent reminder notifications. It's an installable web app (`mobile/`) that you
add to your Home Screen, served by a small, free **Cloudflare Worker** (`worker/`) that keeps you signed in to
Google, holds the Claude key, sends the reminders, and only lets your own Google account in. No Xcode or
Apple developer account needed, and the setup works the same from a Windows PC or a Mac:
**[SETUP-IPHONE.md](SETUP-IPHONE.md)** (about 30 minutes). Afterwards, **Settings → Account → Phone app** in the
desktop app links the two, so shown calendars, defaults and "About you" stay the same on both.

The desktop app doesn't need any of it. The code is explained in [worker/README.md](worker/README.md); its tests
run with `npm test` inside `worker/`, and `npm run dev:mock` there runs the whole phone app locally against a fake
calendar.

## Tests

```shell
npm test
```

Same command on Windows and Mac. Runs the unit tests (free-time arithmetic) with Node's test runner, then the app tests in Electron: the assistant
against mock Claude / OpenAI-compatible servers (caching markers, task tools, plan-then-confirm, short ids, cost
tracking) and the UI in a real window with a stubbed Google account. Nothing touches your real calendar, settings or keys.

`.\scripts\bench.ps1` (Windows) or `./scripts/bench.sh` (Mac) runs the **live cost benchmark**: real Claude Haiku 5.5
requests against a made-up week, a few cents in total, results written to [docs/COST.md](docs/COST.md).

## Building the app

Ready-made downloads are on the **[Releases](../../releases)** page, built by GitHub Actions
(`.github/workflows/release.yml`) whenever a version tag such as `v1.0.1` is pushed. To make a new release: raise
`"version"` in `package.json`, commit, and push the matching tag (`git tag v1.0.1` then `git push origin v1.0.1`).

To build on your own computer, `npm run dist` makes an installer on Windows and `.dmg` files on a Mac. The steps,
and what to click when Windows SmartScreen or macOS Gatekeeper warns about an unsigned app, are in
[SETUP-WINDOWS.md](SETUP-WINDOWS.md#5-build-your-own-installer-optional) and
[SETUP-MAC.md](SETUP-MAC.md#5-build-your-own-app-optional).

Only `src/` and `package.json` (plus dependencies) go into the package, so a `credentials.json` sitting in
the project folder is **not** shipped. Each installed copy loads its own credentials on first run.

## The assistant

![Settings → Assistant](docs/screenshots/settings-assistant.png)

![Tasks in the sidebar and Agenda (sample data)](docs/screenshots/agenda-tasks.png)

Pick a provider in **Settings → Assistant**. The assistant gets ten tools (calendars, events, tasks and a free-time
finder) and calls them itself; you see a card for every change, and deletes can be undone. Fill in **About you** in the
same page so it plans around how you actually work.

| Provider | Cost | Notes |
|---|---|---|
| Claude (Anthropic) | Pay per use, about $0.002 a message on Haiku | Most reliable with the calendar tools. The default. |
| Google Gemini | Free tier | Free-tier prompts may be used by Google to improve its products. |
| Groq / Cerebras | Free tier or trial | Fast hosted open models (gpt-oss, Llama, Qwen). |
| OpenRouter | `:free` models, about 50 requests a day | One key, hundreds of models. |
| OpenAI | Pay per use | |
| Ollama / LM Studio | Free | Runs on your computer; nothing leaves it. Needs a capable machine (Apple Silicon Macs do well). |
| Anything OpenAI-compatible | Varies | Cloudflare Workers AI, Together, vLLM, a company gateway… |

Step-by-step setup for each one, model suggestions and privacy notes: **[docs/ASSISTANT.md](docs/ASSISTANT.md)**.

## How it's organized

```
src/
├─ main/                  ← BACKEND (Node.js). Talks to Google and the AI provider. Holds all secrets.
│  ├─ main.js             startup + the list of IPC handlers the UI may call (incl. delete-with-undo)
│  ├─ windowManager.js    the window: size/position memory, Mica / Mac vibrancy, caption buttons, × = hide
│  ├─ background.js       tray / menu bar icon + menu, global hotkey, start at sign-in
│  ├─ menu.js             the Mac menu bar (Cmd+C/V, Cmd+Q, Cmd+N, Cmd+,); Windows has none
│  ├─ notifier.js         desktop notifications before events
│  ├─ prefs.js            non-secret settings (prefs.json) and their defaults
│  ├─ auth.js             Google OAuth (loopback + PKCE), token refresh
│  ├─ secureStore.js      encrypts tokens/keys with Windows DPAPI / the macOS Keychain (Electron safeStorage)
│  ├─ calendar.js         Calendar API: calendars, events, create/update/delete, colors, reminders, Meet
│  ├─ tasks.js            Google Tasks API: lists, tasks due/overdue/undated, add, complete, delete
│  ├─ freetime.js         working-hours free time for the assistant (pure functions, unit-tested)
│  ├─ quickadd.js         "gym tomorrow 6pm #work" → {title, start, end, calendar} using chrono-node
│  ├─ providers.js        the AI providers the assistant can use (add your own here)
│  ├─ sync.js             optional: shares some settings with the iPhone app (Settings → Account → Phone app)
│  └─ assistant.js        assistant: tools, profile prompt, caching, cost tracking, the tool-use loop
├─ preload.js             the bridge: exposes window.desk.* to the page, nothing else
├─ assets/                app icon (icon.svg is the source), Mac menu bar icon + Fluent UI icons (MIT)
└─ renderer/              ← FRONTEND (sandboxed web page). No Node, no secrets.
   ├─ index.html          layout (title bar, toolbar, sidebar, views, panels, dialogs)
   ├─ styles.css          dark theme (colors and sizes are variables at the top)
   ├─ icons.css           generated by scripts/copy-icons.js
   └─ js/
      ├─ util.js          helpers, date formatting, popovers
      ├─ data.js          shared state, date navigation, loading events
      ├─ sidebar.js       countdown, Create, quick add, mini month, calendar lists
      ├─ view-time.js     Day & Week hour grid (overlap layout, all-day row, now line)
      ├─ view-month.js    Month grid (spanning bars, "+N more")
      ├─ views.js         toolbar, picking the view, Agenda view
      ├─ interactions.js  click/drag to create, move, resize; details popover; undo toast
      ├─ editor.js        full event editor (color, notifications, Meet)
      ├─ tasks.js         "Today's tasks", tasks in the Agenda, task details and editor
      ├─ chat.js          assistant side panel
      ├─ settings.js      settings page
      └─ app.js           startup, sign-in screen, keyboard shortcuts, timers
docs/
├─ ASSISTANT.md           choosing and setting up an AI provider, planning with tasks
├─ COST.md                measured cost per message (from scripts/bench-assistant.js)
├─ TROUBLESHOOTING.md     common problems and fixes
├─ UI-SPEC.md, ui/        design history: the original UI spec and questionnaire (older screenshots)
└─ screenshots/           README images (made-up sample data)
scripts/                  icons, the cost benchmark (bench.ps1 / bench.sh → bench-assistant.js)
test/                     unit/ (node --test) and electron/run.js (assistant + UI tests)
build/                    icon.ico (Windows installer) and icon.png (made into the Mac app icon)
.github/workflows/        test.yml: tests on Windows and macOS on every push; release.yml: builds the downloads

Optional iPhone app (SETUP-IPHONE.md):
mobile/                   the phone app: plain HTML/CSS/JS, no build step (views, sheets, service worker)
worker/                   its Cloudflare Worker: sign-in, calendar/tasks proxy, assistant, reminders, settings sync
                          (worker/README.md lists every file; worker/test/ has its tests)
```

How a drag flows: `interactions.js` calls `desk.updateEvent(...)` → `preload.js` sends IPC message
`cal:update` → `main.js` handler → `calendar.updateEvent()` → Google API → result travels back the same way.

## Where your secrets live

The app-data folder is:

- **Windows**: `%APPDATA%\desk-calendar\` (from source) or `%APPDATA%\Desk Calendar\` (installed)
- **Mac**: `~/Library/Application Support/desk-calendar/` (from source) or `~/Library/Application Support/Desk Calendar/` (built app)

| What | Where | Protection |
|---|---|---|
| `credentials.json` (your OAuth client) | the app-data folder | Outside the repo; `.gitignore` blocks it if you put one in the project |
| Google access/refresh token | same folder, `google-token.bin` | Encrypted by the OS: DPAPI (your Windows account) or a key in your Mac's Keychain |
| AI API keys | same folder, `anthropic-key.bin`, `assistant-key-<provider>.bin` | Encrypted the same way |
| Preferences, your "About you" profile, window position | same folder, `prefs.json`, `window.json` | Not secret (plain JSON, no keys) |

Nothing secret is ever written in plain text, and none of it is inside the project folder.
Settings → Account → **Sign out** deletes the Google token and revokes it with Google.

`.gitignore` also blocks `credentials.json`, `client_secret*.json`, `token*.json`, `*.bin`, and `.env*`,
so a stray secret in the project folder can't be committed by accident.

## Common changes

Most everyday options are in the app's **Settings** page. For deeper changes:

| I want to… | Edit |
|---|---|
| Refresh more/less often | `REFRESH_MINUTES` at the top of `src/renderer/js/data.js` |
| Change colors / font / sizes | variables in `:root` in `src/renderer/styles.css` |
| Taller/shorter hours in Day/Week | `HOUR_H` in `view-time.js` (and the matching `48px` in `.tg-col` in styles.css) |
| Drag snapping | `SNAP_MIN` in `src/renderer/js/interactions.js` |
| Undo window after delete | `UNDO_MS` in `src/main/main.js` |
| Default window size | `DEFAULT_SIZE` in `src/main/windowManager.js` |
| Suggestion chips in the assistant | `SUGGESTIONS` in `src/renderer/js/chat.js` |
| Add an AI provider or change a default model | `PROVIDERS` in `src/main/providers.js` |
| Claude models, prices, effort | `MODELS` in `src/main/assistant.js` |
| How long a chat lasts before starting fresh | `IDLE_RESET_MS`, `MAX_USER_TURNS` in `src/main/assistant.js` |
| Default "About you" values | `PROFILE_DEFAULTS` in `src/main/freetime.js` |
| Assistant behavior/tone | `SYSTEM` prompt in `src/main/assistant.js` |
| Give the assistant a new ability | add an entry to `TOOLS` and a `case` in `runTool()` in `assistant.js` (works for every provider) |
| Add an icon | add its name to `ICONS` in `scripts/copy-icons.js`, then `npm run icons:copy` |
| Change the app icon | edit `src/assets/icon.svg`, then `npm run icons` |

## Notes and limits

- **Testing-mode sign-in lasts 7 days.** See the end of SETUP-GOOGLE.md for how to avoid it.
- Editing or dragging a recurring event changes **only that occurrence**.
- **Tasks are date-only.** Google's Tasks API doesn't expose the time you can give a task in Google Calendar, so
  tasks appear in the sidebar and Agenda, not in the hour grid. Moving a task to another list isn't supported by the API.
- Events you've declined are hidden, like in Google Calendar.
- Deleting shows **"Event deleted · Undo"** for 6 seconds before it's really deleted. Quitting from the
  tray / menu bar (or Cmd+Q) finishes pending deletes; killing the process (Ctrl+C in a terminal) within those
  6 seconds cancels them.
- The assistant's quality depends on the model. Small local models sometimes pick the wrong event or
  skip a tool call; larger hosted models are more dependable. Deletes are always undoable.
- Windows shows notifications for the installed app; while running from `npm start` they may not appear.
  On a Mac they appear in both cases (labelled "Electron" when running from source); allow them when macOS asks.
- Closing the window (× or the red button) keeps Desk Calendar running in the tray / menu bar so reminders still
  arrive. On a Mac, click its Dock icon to bring the window back.
