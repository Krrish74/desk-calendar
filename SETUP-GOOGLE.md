# Google Cloud Console setup (one time, ~10 minutes)

This gives Desk Calendar its own "OAuth client": an ID that Google uses to know
which app is asking for access to your calendar. You do all of this in your
browser, signed in with the Google account whose calendar you want to see.

**Everyone who runs Desk Calendar does this for themselves.** Don't share your `credentials.json`,
and don't ask someone else for theirs: your own project costs nothing and keeps your calendar access
under your control.

> Google renames menu items now and then. If a label below doesn't match
> exactly, look for the closest equivalent. The concepts don't change.

---

## 1. Create a project

1. Go to <https://console.cloud.google.com/>.
2. Click the **project picker** at the top left (next to the Google Cloud logo).
3. Click **New Project**.
4. Name: `Desk Calendar`. Leave Organization as "No organization" if it asks.
5. Click **Create**, wait a few seconds, then select the new project in the
   project picker. Check that the top bar shows **Desk Calendar** before you continue.

## 2. Enable the Google Calendar API and the Google Tasks API

1. Left menu ☰ → **APIs & Services** → **Library**.
2. Search for **Google Calendar API**, open it and click **Enable**.
3. Go back to the Library, search for **Google Tasks API**, open it and click **Enable**
   (for "Today's tasks" and the assistant's task tools).

APIs are off by default for every project. Without this step, every call
returns `403 accessNotConfigured`.

## 3. Configure the OAuth consent screen (stays in Testing mode)

This is the screen you see when the app asks "Desk Calendar wants to access
your Google Account".

1. Left menu ☰ → **APIs & Services** → **OAuth consent screen**.
   (This opens the **Google Auth Platform** page.) Click **Get started**.
2. **App information:** App name `Desk Calendar`, user support email = your Gmail. **Next**.
3. **Audience:** choose **External**. **Next**.
   (Use *Internal* only if you're on a Google Workspace account and only
   people in your organization will use it.)
4. **Contact information:** your email. **Next**.
5. Tick the agreement box, then click **Continue** → **Create**.

### Add the scopes (what the app is allowed to do)

1. In the Google Auth Platform sidebar, open **Data Access** → **Add or remove scopes**.
2. Filter for "calendar" and tick these two:
   - `.../auth/calendar.readonly`: see your calendar list, colors and events
   - `.../auth/calendar.events`: create, edit and delete events
3. Clear the filter, filter for "tasks" and tick:
   - `.../auth/tasks`: see, add, complete and delete your Google Tasks
4. Click **Update**, then **Save**.

### Add yourself as a test user

1. Sidebar → **Audience**. **Publishing status** should say **Testing**. Leave it that way.
2. Under **Test users**, click **Add users**, enter your Gmail address, and click **Save**.

While the app is in Testing, **only the test users listed here can sign in**.
Anyone else gets "Access blocked". That's what you want for a personal app.

## 4. Create the Desktop OAuth client and download the credentials

1. Sidebar → **Clients** → **Create client**.
2. Application type: **Desktop app**. Name: `Desk Calendar (desktop)`. The same client works for
   the Windows and the Mac app, so if you use both, load the same `credentials.json` on each.
3. Click **Create**.
4. In the dialog that appears, click **Download JSON** right away. Google now
   shows the client secret only at creation time. If you miss it, delete
   the client and create a new one.
5. Rename the downloaded file (`client_secret_xxxx.json`) to **`credentials.json`**.

### Where to put `credentials.json`

- **Recommended:** run the app, click **Load credentials.json…** on the
  first-run screen, and pick the file. The app copies it into your private
  app-data folder (`%APPDATA%\desk-calendar\` on Windows,
  `~/Library/Application Support/desk-calendar/` on a Mac), so it's never inside the project.
- **Developer shortcut:** drop it in the project root (`desk-calendar/credentials.json`).
  It's listed in `.gitignore` so git won't commit it, and it's excluded from
  the packaged installer.

> **Is the client secret actually secret?** For "Desktop app" clients, Google
> treats the secret as *not* confidential, because anything shipped inside a
> desktop app can be extracted. Real protection comes from PKCE (a one-time
> random code the app generates per sign-in) and the loopback redirect, both
> of which this app uses. Still, keep it out of git: there's no reason to
> publish it.

## 5. First sign-in

1. In the app, click **Sign in with Google**. Your browser opens.
2. Pick your account. You'll see **"Google hasn't verified this app"**. That's
   expected for Testing mode. Click **Continue**.
3. Allow both calendar permissions. The browser tab says "Signed in. You can
   close this tab", and the app loads your events.

## Already signed in from an older version?

Desk Calendar now also asks for Google Tasks. If you signed in before that, the sidebar shows
**Connect Google Tasks**: enable the Google Tasks API (step 2), add the tasks scope (step 3), then click
that button and allow access. Your calendar keeps working the whole time.

## Things to know about Testing mode

- **Sign-in expires every 7 days.** Google expires refresh tokens for
  External apps in Testing after 7 days, so the app will ask you to sign in
  again about once a week. To stop this, go to **Audience** → **Publish app**.
  For a personal app with fewer than 100 users you can publish without
  verification. You'll keep seeing the "unverified app" warning, but tokens
  stop expiring weekly.
- To revoke access at any time: <https://myaccount.google.com/permissions>.
