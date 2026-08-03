# Sauna House — Conversion Tracker

Internal tool for logging non-member visits vs. membership sales. Staff log
their own daily entries; management sees raw data across the whole team,
sets the conversion target, and manages staff accounts.

Real auth and storage, via [Supabase](https://supabase.com) (free tier).
Deploys as a static site + one small serverless function on
[Netlify](https://netlify.com) (free tier).

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → New project (free tier is fine).
2. Once it's provisioned, open **SQL Editor** and run the entire contents of
   [`supabase/schema.sql`](supabase/schema.sql). This creates the tables,
   the manager/staff role logic, and row-level security policies.
3. Go to **Authentication → Providers → Email** and turn **off** "Confirm
   email". This app has no outbound email dependency by design — accounts
   are created directly (by the bootstrap flow or by a manager), so email
   confirmation would just add friction with no benefit here.
4. Go to **Project Settings → API** and copy three values, you'll need them
   below:
   - **Project URL**
   - **anon / public key**
   - **service_role key** (click "reveal" — keep this one secret)

## 2. Fill in the client config

Open [`config.js`](config.js) and replace the placeholders:

```js
export const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
```

The anon key is meant to be public — it's safe to commit. Access control is
enforced server-side by the RLS policies in `schema.sql`, not by keeping
this key secret.

## 3. Push to GitHub and connect Netlify

1. Create a new (private is fine) GitHub repo and push this folder to it.
2. In Netlify: **Add new site → Import an existing project** → pick the repo.
   Netlify will detect `netlify.toml` automatically — no build command needed.
3. Before the first deploy (or right after, then redeploy), go to
   **Site configuration → Environment variables** and add:
   - `SUPABASE_URL` — same Project URL as above
   - `SUPABASE_SERVICE_ROLE_KEY` — the service_role key (**never** put this
     in `config.js` or anywhere else that ships to the browser — it's only
     read server-side by the functions in `netlify/functions/`)
   - `SENDGRID_API_KEY` — from [SendGrid](https://sendgrid.com) → Settings →
     API Keys (needed for the daily email report, see below)
   - `SENDGRID_FROM_EMAIL` — the address the report is sent *from*. It must
     be a verified sender in SendGrid (Settings → Sender Authentication —
     either verify a single address or authenticate your whole domain)
   - `REPORT_TO_EMAIL` — optional, defaults to `manager@mysaunahouse.com`
     if unset; set this if the report should go somewhere else
4. Deploy.
5. Enable the scheduled daily report by adding this block to the end of
   `netlify.toml` (not added automatically — see `netlify/functions/daily-report.js`
   for what it sends and when):
   ```toml
   [functions."daily-report"]
     schedule = "0 * * * *"
   ```
   It runs hourly and only actually sends once it's 8pm in
   `America/New_York` (edit `REPORT_TIMEZONE`/`REPORT_HOUR` at the top of
   the function file to change that), so the send time stays correct
   across DST without needing to guess a fixed UTC cron time. It reports
   that day's visits/sold/revenue per staff member, plus anyone scheduled
   that day (via **Schedule**) who never logged a tracker entry.

## 4. Bootstrap the first manager account

Open the deployed site. Since no manager exists yet, you'll land on
**"Create the management account"**. Fill in your name, email, and a
password (8+ characters) — this becomes the one and only way to sign in as
management from now on.

After that, no one else can self-register: new accounts are only ever
created by a manager, from inside the app.

## 5. Add staff

As the manager, go to **Manage staff**, enter a name and email, and click
**Add**. A temporary password is generated and shown once — copy it and
share it with that staff member however you'd normally share a password
(text, in person, etc). They sign in with their email + that password, and
can change it afterward from **Change password** on their home screen.

To remove someone, click **remove** next to their name — this deletes their
login and all their logged entries. This can't be undone.

## How it's put together

- `index.html` — the whole app (sign-in, staff view, management view).
  Talks to Supabase directly from the browser using the anon key; access is
  restricted per-row by Postgres row-level security, not by anything in
  the client code.
- `supabase/schema.sql` — `profiles` (role: staff/manager), `entries`
  (daily visits/sold per staff member), `settings` (the target %), plus the
  RLS policies and the trigger that turns the very first signed-up user
  into a manager.
- `netlify/functions/create-staff.js`, `delete-staff.js` — use the private
  `service_role` key to manage staff logins. Both check the caller is a
  signed-in manager before doing anything.
- `netlify/functions/daily-report.js` — scheduled function (see setup step
  5 above) that emails the manager a daily sold/revenue/missed-tracker
  summary via SendGrid. Also uses the `service_role` key, but has no
  caller to check since it's only ever invoked by Netlify's scheduler.

## Local preview

No build step, so you can preview it with any static file server, e.g.:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080`. Note the Netlify Functions (add/remove
staff) won't work from a plain static server — those need an actual Netlify
deploy (or `netlify dev` with the [Netlify CLI](https://docs.netlify.com/cli/get-started/),
if you want to test functions locally).
