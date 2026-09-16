---
name: mimonim-auth
description: Fix or change sign-in for the Square Inch site - Google OAuth, email/password sign-up, email confirmation, or the publisher-vs-brand role. Use when sign-up fails, when a user cannot log in, when adding or changing an OAuth provider, when email confirmation or SMTP needs configuring, or when someone is stuck on the wrong account type. Covers Supabase's restricted built-in mailer, where the settings actually live in the dashboard, and the choose-once role rule.
---

# Sign-in

Two ways in: **Google OAuth** and **email + password**. Both land in the same
`profiles` table via a database trigger.

## Current state

- Google: enabled. Client `817959638983-…`, GCP project `mimonim`.
- Email + password: enabled, **confirmation off**.
- Resend: verified on `mimonim.com`, available for SMTP.

## The one thing that breaks everything

**Supabase's built-in email sender only delivers to your own organisation's
members.** Restricted in late 2024 after abuse. Every other address gets
`Email address not authorized`, and the whole project shares a handful of
messages an hour (`over_email_send_rate_limit`).

So with confirmation **on** and no custom SMTP, sign-up works for you and fails
for every real user — and it fails in a way that looks like a bug in the app.

Two valid resolutions:

1. **Confirmation off** (current). No mail is sent on sign-up; people are in
   immediately. Password reset remains broken until SMTP exists.
2. **Custom SMTP** via Resend, then confirmation can be turned back on.
   Project Settings → Authentication → SMTP Settings:
   `smtp.resend.com` / port `465` / username `resend` / password the Resend API
   key / sender `no-reply@mimonim.com`. No mailbox is needed for the sender —
   Resend only sends.

Then raise Authentication → Rate Limits, which was pinned low only because the
shared sender was.

## Where the settings actually are

The dashboard moves these around; do not trust old docs or old memory. As of
this writing:

| Setting | Location |
|---|---|
| **Confirm email** | Authentication → Sign In / Providers → top of page, under **User Signups** — *not* inside the Email provider panel |
| Google provider | Authentication → Sign In / Providers → Google |
| Site URL / Redirect URLs | Authentication → URL Configuration |
| SMTP | Project Settings → Authentication → SMTP Settings |
| Email rate limits | Authentication → Rate Limits |

The Email provider panel contains only password and OTP settings. Time was lost
hunting "Confirm email" there. If a setting is not where this table says, read
the live state instead of guessing:

```powershell
node -e "require('./server/node_modules/dotenv').config({path:'.env'});fetch(process.env.SUPABASE_URL+'/auth/v1/settings',{headers:{apikey:process.env.SUPABASE_ANON_KEY}}).then(r=>r.json()).then(j=>console.log('autoconfirm:',j.mailer_autoconfirm,'providers:',Object.entries(j.external||{}).filter(([,v])=>v).map(([k])=>k).join(',')))"
```

`mailer_autoconfirm: true` means confirmation is **off**.

## Google OAuth

| Field | Value |
|---|---|
| Authorised JavaScript origins | `https://mimonim.com`, `https://www.mimonim.com`, `http://localhost:8787` |
| Authorised redirect URI | `https://zhwathzwrqxzgizanabn.supabase.co/auth/v1/callback` |

**The redirect URI is Supabase's, not ours.** Google returns to Supabase, which
mints the session and bounces the browser back. Putting `mimonim.com` there is
the classic `redirect_uri_mismatch`.

Check it is live without clicking through:

```powershell
node -e "require('./server/node_modules/dotenv').config({path:'.env'});fetch(process.env.SUPABASE_URL+'/auth/v1/authorize?provider=google&redirect_to=https%3A%2F%2Fmimonim.com%2F',{redirect:'manual'}).then(r=>console.log(r.status,r.headers.get('location')||''))"
```

302 to `accounts.google.com` = working. 400 = provider not enabled.

Note the consent screen starts in **Testing** mode, where only accounts listed
under Audience → Test users can sign in. Publish the app for real users; no
Google review is needed for the `email profile` scopes used here.

## Publisher or brand: chosen once, then frozen

A provider cannot tell us whether someone is here to sell space or buy it. So:

- **Email sign-up** passes `role` in the sign-up metadata → the trigger sets it
  and locks it immediately.
- **OAuth** sends no role → the user lands with `role_locked = false` and the
  app asks once, on first return. That answer locks it.

The lock exists to stop shill bidding: an account cannot list a garment, switch
sides, and bid its own listing up. The server independently refuses a bid from a
listing's owner, so both halves have to be defeated.

`role_locked` is one-way — a database trigger refuses both a second role change
and any attempt to clear the flag.

## Common failures

| Symptom | Cause |
|---|---|
| `email rate limit exceeded` on sign-up | Confirmation is on, built-in mailer, no SMTP |
| `Email address not authorized` | Same. The recipient is not an org member |
| `email_address_invalid` | Supabase rejects fake TLDs like `.test`. Use a real-looking domain |
| `Database error creating new user` | The `handle_new_user` trigger raised. Check for `NULL` in a `NOT NULL` column |
| `redirect_uri_mismatch` | The Google redirect URI is not Supabase's callback |
| Signed in but cannot bid | Account role is `client`. Bidding is for brands |

## Testing without sending mail

`supabase.auth.admin.createUser({ email_confirm: true })` with the service-role
key creates a ready-to-use account and sends nothing, so it sidesteps both the
rate limit and the org-member restriction. That is how the integration suite
makes accounts.
