---
name: mimonim-domain
description: Point a domain at the Square Inch site, move it to a new domain, or fix DNS for mimonim.com. Use when asked to change the domain, set up DNS, add a custom domain on Render, fix a certificate error, or when the domain serves a GoDaddy parking page instead of the app. Covers the five places a domain is configured, the exact GoDaddy records, why the Google redirect URI must NOT change, and the caching traps that make a correct change look broken.
---

# Domains and DNS

Current: **`mimonim.com`** at GoDaddy, pointing at Render. `www` 301s to the
apex.

## The thing to understand first

**The domain points at Render, never at Supabase.** Supabase is reached by the
browser directly at `zhwathzwrqxzgizanabn.supabase.co` as an API call. It has
no DNS of yours and needs none. This confuses people constantly.

```
browser ─> mimonim.com ──────> Render (the app + /api)
   └─────> …supabase.co ─────> database, auth, storage
```

## Current records (GoDaddy → DNS → Records)

| Type | Name | Value |
|---|---|---|
| A | `@` | `216.24.57.1` |
| CNAME | `www` | `mamenli.onrender.com` |
| TXT | `resend._domainkey` | DKIM key (email) |
| CNAME | `rsend` | `rsend-apne1.forge.rmta.net` |
| CNAME | `send` | `send.forge.rmta.net` |

The apex is an **A record, not a CNAME** — GoDaddy cannot put a CNAME on the
root, and offers no ALIAS/ANAME. Render's apex IP is `216.24.57.1`; confirm it
in Render rather than trusting this file, since it can change.

## Moving to a new domain

Five places. Missing any one breaks something quietly.

1. **Render** → service Settings → Custom Domains → add apex *and* `www`.
2. **Registrar DNS** → `A @ → 216.24.57.1`, `CNAME www → mamenli.onrender.com`.
   Delete any parking or forwarding record first.
3. **Render env** → `PUBLIC_BASE_URL=https://newdomain.com` and
   `CANONICAL_HOST=newdomain.com`. Without these, Stripe returns buyers to the
   old domain and `www` never folds into the apex.
4. **Supabase** → Authentication → URL Configuration → Site URL and Redirect
   URLs (`https://newdomain.com/**`). Sign-in breaks silently otherwise. The
   `/**` wildcard matters: the app returns to whatever page it left from, so an
   exact-match entry rejects every page but the root.
5. **Google Cloud** → Clients → Authorised JavaScript origins.

**The Google redirect URI does NOT change.** It stays
`https://zhwathzwrqxzgizanabn.supabase.co/auth/v1/callback`. It belongs to
Supabase, which mints the session and then bounces the browser back to your
site. Putting your own domain there is the usual cause of
`redirect_uri_mismatch`.

Email is separate: re-verify the new domain in Resend and update the sender.

## GoDaddy-specific traps

- **GoDaddy appends the domain to the Name field.** A record for
  `resend._domainkey.mimonim.com` is entered with Name `resend._domainkey`.
  Pasting the full hostname creates `resend._domainkey.mimonim.com.mimonim.com`
  and verification never completes, with no useful error anywhere.
- **Domain Forwarding overrides your DNS entirely.** While it is on, GoDaddy
  serves the domain from its own infrastructure no matter what the A record
  says. Symptom: `Server: DPS/2.0.0` in the response headers, and a certificate
  issued by GoDaddy rather than Let's Encrypt. Find Forwarding and delete it.
- The default **Website Builder / Airo** A record does the same thing. Delete it
  before adding Render's.

## Diagnosing "I changed it and it still shows the old site"

Check in this order:

```powershell
# 1. What do public resolvers say?
node -e "const d=require('dns');const r=new d.promises.Resolver();r.setServers(['8.8.8.8']);r.resolve4('mimonim.com').then(console.log)"

# 2. What is actually answering, and who issued the cert?
curl -s -o /dev/null -w "%{remote_ip}\n" https://mimonim.com/
curl -s -I https://mimonim.com/ | grep -i "^server:"
```

- Resolvers say Render's IP but curl connects elsewhere → **stale OS DNS
  cache**. `ipconfig /flushdns` and retry. This cost real time here: every
  public resolver had the new value while Windows still held the old one.
- `Server: DPS/…` or a GoDaddy-issued certificate → **forwarding is still on**.
- `Server: cloudflare` → that is Render (it fronts with Cloudflare). Correct.

## Certificates

Render issues via Let's Encrypt automatically once DNS resolves. "Certificate
Error" immediately after verifying is normal — it usually clears within
minutes, sometimes up to an hour. The apex and `www` are issued separately, so
one working while the other does not is expected for a while.
