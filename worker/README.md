# Desk Calendar Worker (iPhone backend)

The Cloudflare Worker behind the iPhone version of Desk Calendar. It serves the phone
app (`../mobile`) and its API from one address, keeps you signed in to Google, holds the
Claude API key, and (from Phase 4) sends reminder notifications. The desktop app (Windows or Mac) in
`../src` doesn't use any of this.

| File | What it does |
|---|---|
| `src/index.js` | Front door: routes `/auth/*` and `/api/*`, input checks, CSRF check, cron |
| `src/auth.js` | Google sign-in (OAuth code flow + PKCE), session cookie, allow-list |
| `src/google.js` | Calendar REST calls with automatic access-token refresh |
| `src/calendar.js` | Calendars, events, create/update/delete (port of `src/main/calendar.js`) |
| `src/quickadd.js` | "gym tomorrow 6pm #fitness" parser (port of `src/main/quickadd.js`) |
| `src/assistant.js` | Claude tool-use loop with task planning, About-you profile, prompt caching and cost tracking (port of `src/main/assistant.js`, Claude only) |
| `src/tasks.js` | Google Tasks: lists, tasks in a range/overdue/undated, create/update/delete (port of `src/main/tasks.js`) |
| `src/freetime.js` | Free time in working hours for find_free_time (copy of `src/main/freetime.js`) |
| `src/deletes.js` | Delete with Undo for events and tasks (6-second window, finished by the request or the cron) |
| `src/sync.js` | Settings shared with the desktop app (`/api/sync`, checked with the desktop app's Google token) |
| `src/reminders.js` | Push reminders: subscribe/test endpoints and the every-minute cron (rules from `src/main/notifier.js`) |
| `src/webpush.js` | Web Push encryption (RFC 8291) and VAPID signing (RFC 8292) with Web Crypto |
| `src/prefs.js` / `models.js` | Settings and the Claude model list |
| `src/tz.js` | Time-zone math: the server runs in UTC, you don't |
| `src/crypto.js` | Random ids, hashing, AES-GCM encryption of stored Google tokens |
| `src/mock-google.js`, `src/mock-claude.js` | Fake Google Calendar / Claude for local testing only |
| `migrations/` | D1 database tables |
| `test/` | `npm test`: assistant (caching, plan-first, short ids, limits, cost), tasks, free time, settings sync |
| `scripts/make-vapid-keys.mjs` | Prints a VAPID key pair for push (`npm run vapid`, once) |
| `scripts/make-mobile-icons.cjs` | Renders the Home Screen PNG icons (`npm run icons`) |
| `scripts/build-mobile-assets.mjs` | Copies the Fluent icons and app icon into `../mobile` (`npm run assets`) |

The phone app itself is plain HTML/CSS/JS modules in `../mobile` (no build step):
`js/app.js` starts it; `views/` draws Agenda, Day/3-day and Month; `sheet.js` is the
bottom-sheet component; `details.js`, `editor.js`, `quickadd.js`, `chat.js` and
`settings.js` are the sheets; `tasks.js` is Google Tasks (Today's tasks, task sheets); `push.js` turns reminders on/off; `../mobile/sw.js` is the service worker (offline + notifications); `touch.js` handles long-press-and-drag; `api.js` is the
only file that talks to this Worker.

## Run it locally with sample data (no Google or Claude account needed)

```shell
cd worker
npm install
copy .dev.vars.example .dev.vars    # then put a long random string in TOKEN_KEY
npm run db:local                    # create the local database tables
npm run dev:mock                    # http://localhost:8787 with a FAKE calendar
```

Open <http://localhost:8787/auth/dev-login> to sign in as the first `ALLOWED_EMAILS`
address against the fake calendar. `dev-login` and the fake calendar only work on
localhost; the deployed Worker refuses them. With no `ANTHROPIC_API_KEY`, the
assistant answers from a short script ("add X", "delete X", "what's today").

`npm run dev` (without `:mock`) uses your real Google account and needs the Web
OAuth client set up. See `SETUP-IPHONE.md` (written in Phase 5).
