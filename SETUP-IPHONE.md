# iPhone setup (one time, ~30 minutes)

This puts Desk Calendar on your iPhone as a Home Screen app. It's a web app (a
"PWA") served by a small **Cloudflare Worker**, a free server that:

- keeps you signed in to Google (it holds the sign-in, not the phone),
- keeps your Claude API key off the phone,
- sends reminder notifications, and
- only lets **your** Google account in.

It's optional: the desktop app (Windows or Mac) works on its own and isn't changed by any of
this. You can also set up only the phone app. Every step works the same from a Windows PC or a Mac.

> Website menus change now and then. If a label below doesn't match exactly, look
> for the closest equivalent. The steps don't change.

**You'll need:**

- an iPhone on **iOS 16.4 or later** (Settings → General → About)
- a Windows PC or a Mac with [Node.js](https://nodejs.org/) 22 or newer and this repository
  cloned. The commands below are typed in PowerShell on Windows or Terminal on a Mac; they're
  the same in both.
- the Google account whose calendar you use, with a Google Cloud project set up as in
  [SETUP-GOOGLE.md](SETUP-GOOGLE.md) steps 1–3 (project, Calendar API, consent screen with
  the calendar scopes and you as a test user). The "Desktop app" client in its step 4 is
  only needed for the desktop app.
- a Claude API key from <https://platform.claude.com/> (for the assistant; everything
  else works without it)
- a free Cloudflare account (step 1)

All commands below are typed in the repository's `worker` folder:

```shell
cd path/to/desk-calendar/worker
```

(On Windows the slashes can go either way, e.g. `cd C:\Users\you\desk-calendar\worker`;
on a Mac, e.g. `cd ~/desk-calendar/worker`.)

```shell
npm install
```

---

## 1. Create a Cloudflare account (free)

1. Go to <https://dash.cloudflare.com/sign-up>, sign up with your email, and verify it.
2. You don't need a domain or a paid plan. The **Workers Free** plan covers this app
   comfortably: 100,000 requests a day, a free database, and a once-a-minute timer
   (the app uses a few thousand requests a day).

## 2. Connect this computer to your Cloudflare account

```shell
npx wrangler login
```

Your browser opens a Cloudflare page. Click **Allow**. The terminal says
"Successfully logged in". (This saves a login token in your user folder, not in the
project.)

### Pick your workers.dev address (first time only)

Your app's address will be `https://desk-calendar.<your-subdomain>.workers.dev`.

1. In the Cloudflare dashboard, open **Workers & Pages** (left menu, under Compute).
2. If it asks you to choose a **workers.dev subdomain**, pick something short (for
   example your initials plus a word) and confirm. You can see it later under
   Workers & Pages → **Account details** / **Subdomain**.

## 3. Create the database

```shell
npm run setup:db
```

This creates a free Cloudflare D1 database called `desk-calendar`, writes its id into
`worker/wrangler.toml`, and creates the tables. Type `y` when it asks to apply the
migrations. Running it again later is safe.

> The database id in `wrangler.toml` isn't a secret; it's fine to commit it.

## 4. Deploy the app

```shell
npm run deploy
```

At the end it prints your app's address, e.g.
`https://desk-calendar.jsmith.workers.dev`. **Write it down**; you need it in the next
steps. (Opening it now shows "Not set up yet" when you try to sign in. That's expected.)

## 5. Add a Web OAuth client in Google Cloud

The desktop app uses a "Desktop app" client. The phone version needs its own
**Web application** client, because Google sends you back to the Worker after you
sign in. Same project, same consent screen.

1. Go to <https://console.cloud.google.com/> and select the **Desk Calendar** project
   in the project picker at the top.
2. Left menu ☰ → **APIs & Services** → **Credentials** (or Google Auth Platform →
   **Clients**) → **Create client** / **Create credentials → OAuth client ID**.
3. Application type: **Web application**. Name: `Desk Calendar (iPhone)`.
4. Under **Authorized redirect URIs**, click **Add URI** and enter your app's address
   followed by `/auth/callback`, exactly:

   ```
   https://desk-calendar.<your-subdomain>.workers.dev/auth/callback
   ```

   (No "Authorized JavaScript origins" are needed.)
5. Click **Create**. Copy the **Client ID** and **Client secret** (or click
   **Download JSON**). Google shows the secret only now; if you miss it, delete the
   client and make a new one.

### Google Tasks: turn on the API and add the scope

The phone shows your Google Tasks ("Today's tasks", tasks in the Agenda, planning with
the assistant). If you already did this for the desktop app, skip to the next section.

1. Left menu ☰ → **APIs & Services** → **Library**. Search for **Google Tasks API**,
   open it and click **Enable**. (Without it the app says "The Google Tasks API is
   turned off".)
2. Google Auth Platform → **Data Access** → **Add or remove scopes**. Filter for "tasks",
   tick `.../auth/tasks` (*Create, edit, organize, and delete all your tasks*), click
   **Update**, then **Save**.

**Scopes in total:** the two calendar scopes from SETUP-GOOGLE.md plus `.../auth/tasks`.
The app also asks for `openid` and `email`, which Google allows without listing them;
the Worker uses your email only to check it against the allow-list.

On Google's sign-in screen, leave all permissions ticked. If you untick Tasks, the
calendar still works and the app shows a **Connect Google Tasks** button instead of your
tasks; tapping it signs in again so you can allow it (Google keeps the rest).

### Stay signed in: publish the app (recommended)

While the consent screen is in **Testing**, Google expires the sign-in every **7 days**,
so the phone would ask you to sign in again every week. To stop that:

1. Google Auth Platform → **Audience** → **Publish app** → **Confirm**.
2. The status becomes **In production**. Because the calendar scopes are "sensitive"
   and the app isn't verified, you'll still see the **"Google hasn't verified this
   app"** warning when signing in (click **Continue**). For a personal app with fewer
   than 100 users, Google doesn't require verification.

Only your account can sign in either way: the Worker's allow-list (next step)
refuses everyone else, even if Google lets them through. This also stops the weekly
sign-ins in the desktop app.

## 6. Put the secrets on the Worker

```shell
npm run secrets
```

This sets everything the Worker needs, on Cloudflare only (nothing is saved in the
project):

| Secret | Where it comes from |
|---|---|
| `TOKEN_KEY` | Made for you (encrypts the stored Google sign-in) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Made for you (sign the reminder notifications) |
| `GOOGLE_CLIENT_ID` | **You paste it**: the Client ID from step 5 |
| `GOOGLE_CLIENT_SECRET` | **You paste it**: the Client secret from step 5 |
| `ANTHROPIC_API_KEY` | **You paste it**: your Claude API key (`sk-ant-…`) |
| `ALLOWED_EMAILS` | **You type it**: your Gmail address (the only account allowed in) |

What you paste isn't shown on screen; that's normal. Secrets apply right away.
To change one later: `npx wrangler secret put NAME` (for example
`npx wrangler secret put ANTHROPIC_API_KEY`).

> Don't re-make `TOKEN_KEY` or the VAPID keys unless you mean to: a new `TOKEN_KEY`
> signs you out, new VAPID keys turn reminders off on your phone until you turn them
> on again. `npm run secrets` keeps existing ones.

## 7. Check it on your computer (optional, 1 minute)

Open your app's address in a browser on your computer (Chrome, Edge or Safari), click
**Sign in with Google**, pick your account, click **Continue** on the "unverified app"
screen, and allow both calendar permissions. Your calendar appears. (Signing in on the
computer doesn't sign in the phone: each device signs in once.)

## 8. Install it on your iPhone

On iPhone, a Home Screen app keeps its own sign-in, separate from Safari. So add it
to the Home Screen **first**, then sign in from the icon:

1. On the iPhone, open **Safari** and go to your app's address.
2. Tap the **Share** button (the square with an arrow) → scroll down → **Add to Home
   Screen**. Keep the name ("Desk Cal") or change it, and tap **Add**.
3. Close Safari. Open **Desk Cal from its Home Screen icon**. It opens full-screen.
4. Tap **Sign in with Google**. Google's sign-in page opens inside the app. Sign in,
   tap **Continue** on the "unverified app" screen, allow both calendar permissions.
5. You're back in Desk Calendar with your calendar. You stay signed in: the session
   lasts 180 days and renews itself whenever you open the app.

## 9. Turn on reminders

1. In the app, tap the **gear** (top right) → **Reminders**.
2. Choose **Remind me** (for example *10 minutes before*).
3. Turn on **This device**, and tap **Allow** when iPhone asks about notifications.
4. Tap **Send a test reminder**. A notification arrives within a few seconds, even
   with the app closed.

Reminders come for timed events on the calendars shown in the app; all-day events and
meetings you declined are skipped (same rules as the desktop app). Tapping one opens
the event. They're sent "silent", but iPhone decides: if you hear a sound, turn it off
in the iPhone **Settings** app → **Notifications** → **Desk Cal** → **Sounds**.

## 10. Tasks and planning (optional)

- **Today's tasks** sits at the top of the Agenda: tasks due today plus unfinished ones
  from earlier days (marked *Overdue*). Tap the circle to tick one off. Type in **Add a
  task**: "call mom friday" is due Friday; with no date it's due today. Later days list
  their tasks above their events. Tap a task to edit, delete (with Undo) or
  **Schedule with assistant**.
- **Settings → Tasks**: choose which task lists show and where new tasks go.
- **Settings → About you**: your working days and hours, lunch, best focus time, block
  lengths, breaks, free time around meetings, the color for time blocks, and anything
  else in your own words. The assistant follows it when you ask "plan my tasks for this
  week": it shows the plan first and only adds the time blocks after you say yes.
- **Settings → Assistant → Spending** shows what the last message and this month cost.

## 11. Link the desktop app (optional)

Your calendar and tasks are always the same on both, because both use your Google
account. Linking also keeps these settings the same: which calendars and task lists are
shown, default calendar and task list, default event length, time format, week start,
reminder minutes, and **About you**.

1. In the desktop app (Windows or Mac): **Settings → Account → Phone app**.
2. Paste your app's address (`https://desk-calendar.<your-subdomain>.workers.dev`) and
   click **Link**. It says "Linked · synced 3:02 PM" when it worked.

No code or extra sign-in: the desktop app proves who you are with the Google sign-in it
already has, and the Worker checks with Google that it's your allowed account in your
Desk Calendar project. The first time, settings you already changed on the phone win;
the computer's values fill in the rest. After that, a change on either side reaches the other
within a few minutes (immediately on the computer's side; the phone picks changes up when you
open it). Reminders on/off, the view, and the assistant's provider, model and
conversation stay separate on each device. **Unlink** in the same place stops it.

---

## Updating after code changes

```shell
npm run deploy
```

This refreshes the app files, applies any new database tables, and deploys. The phone
picks up the new version the next time you open the app (sometimes the time after).

To watch the Worker's live log (sign-ins, errors, reminders sent):

```shell
npm run logs
```

## Trying changes locally first (no real calendar)

```shell
npm run db:local
```

```shell
npm run dev:mock
```

Then open <http://localhost:8787/auth/dev-login> in a browser. That signs you in to a
**fake** calendar with sample events (and a scripted assistant if `.dev.vars` has no
Claude key). See `worker/README.md`.

## Troubleshooting

- **"Not set up yet" after tapping Sign in.** `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
  are missing: run `npm run secrets`.
- **Google says "redirect_uri_mismatch".** The redirect URI in step 5 must be exactly
  your address + `/auth/callback`, starting with `https://`, no trailing slash.
- **"Not allowed" after signing in.** You signed in with a different Google account
  than `ALLOWED_EMAILS`. Run `npx wrangler secret put ALLOWED_EMAILS` to fix the
  address, or sign in with the right account.
- **"Access blocked: Desk Calendar has not completed the Google verification process".**
  The app is in Testing and the account isn't a test user: add it under Audience →
  Test users, or publish the app (step 5).
- **Signed in, but the Home Screen app shows the sign-in screen again.** iPhone may have
  finished the Google sign-in in Safari instead of in the app. Delete the Home Screen
  icon, add it again (step 8), and sign in from the icon. If it keeps happening, tell
  Claude: a "sign in with a code" fallback can be added.
- **You get signed out once a week.** The Google project is still in Testing; see
  "Stay signed in" in step 5.
- **The Reminders switch says to open it from the Home Screen.** You're in Safari. Open
  the app from its Home Screen icon instead (iPhone only allows notifications there).
- **"Notifications are blocked".** iPhone Settings → Notifications → Desk Cal → turn on
  **Allow Notifications**, then try the switch again.
- **"Connect Google Tasks" instead of your tasks.** Your sign-in doesn't include Tasks
  yet (it's from before Tasks were added, or Tasks was unticked). Tap it and allow Tasks.
- **"The Google Tasks API is turned off".** Enable it (step 5, "Google Tasks").
- **The assistant says the Claude key is missing or rejected.** Run
  `npx wrangler secret put ANTHROPIC_API_KEY` and paste a valid key.
- **Something else.** `npm run logs`, then repeat what failed: the log shows the error.

## Removing it

- On the phone: Settings (gear) → **Sign out everywhere** removes Desk Calendar's
  access to your Google account and turns off reminders on every device. Then delete
  the Home Screen icon.
- Google access can also be removed at <https://myaccount.google.com/permissions>.
- Cloudflare: dashboard → **Workers & Pages** → `desk-calendar` → Settings → **Delete**,
  and **Storage & Databases** → **D1** → `desk-calendar` → Delete.

## Where your data lives

| What | Where |
|---|---|
| Google sign-in (refresh token) | Your Cloudflare D1 database, encrypted with `TOKEN_KEY` |
| Claude API key, Google client secret, VAPID private key | Cloudflare Worker secrets (encrypted by Cloudflare; not readable back, even by you) |
| Your settings and the assistant conversation | Your D1 database |
| Last-loaded events (for offline use) | On the phone, in the app's own storage; deleted when you sign out |
| Your calendar itself | Google, as always. The Worker reads and writes it only when you (or a reminder) ask |
