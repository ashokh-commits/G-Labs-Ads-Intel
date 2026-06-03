# G6 Labs — Integrations Setup Guide

This covers the three features added: **WhatsApp daily summary**, **TikTok Ads**, and **Google Ads**.

---

## 1. WhatsApp Daily Summary (Evolution API)

A cron (`/api/daily-summary`) runs every morning at **9:30 AM Malaysia time** (`30 1 * * *` UTC) and sends a formatted summary of all accounts to a WhatsApp group via your Evolution API.

### Add these env vars in Vercel → Project → Settings → Environment Variables:

| Variable | Example | Notes |
|----------|---------|-------|
| `EVOLUTION_API_URL` | `https://evo.yourserver.com` | Base URL of your Evolution API instance (no trailing slash) |
| `EVOLUTION_API_KEY` | `B6D711FC...` | Your Evolution global or instance API key |
| `EVOLUTION_INSTANCE` | `g6labs` | The instance name you created in Evolution |
| `EVOLUTION_WA_GROUP` | `120363040123456789@g.us` | Target group JID (or `60123456789@s.whatsapp.net` for an individual) |
| `CRON_SECRET` *(optional)* | `any-random-string` | If set, manual calls must include `?key=<value>` |

### How to find your group JID
In Evolution API, call `GET /group/fetchAllGroups/{instance}` (with your apikey header) — each group has an `id` ending in `@g.us`. Use that as `EVOLUTION_WA_GROUP`.

### Test it manually
After deploying, open in browser (or curl):
```
https://your-app.vercel.app/api/daily-summary
```
(Add `?key=YOUR_CRON_SECRET` if you set `CRON_SECRET`.)
The JSON response includes a `preview` field showing the exact message that was sent. If Evolution isn't configured, it returns `whatsapp: { skipped: true }` and still shows the preview.

### Message format
```
🟠 G6 Labs — Daily Ads Summary
📅 Friday, 30 May 2026

🏢 ALL ACCOUNTS — MTD (May 2026)
💰 Total Spend: RM 184,302.55
📞 Total Leads: 4,231
📅 Yesterday (Thursday, 29 May): 💰 RM 8,120.40 · 📞 187 leads
━━━━━━━━━━━━━━━

📊 I-Sihat Dental Care 2
📆 MTD (May 2026): 💰 RM 34,872 · 📞 2,323 leads · CTR 0.38% · CPL RM 15.01
📅 Yesterday: 💰 RM 1,283 · 📞 87 leads
🔴 2 alerts · 1 warning

📊 Ang Dental
...
— G6 Labs Ads Intelligence
```

---

## 2. TikTok Ads

### Step 1 — Get API access
1. Go to [TikTok for Business Developers](https://business-api.tiktok.com/portal/)
2. Create an app → note the **App ID** and **App Secret**
3. Authorize your advertiser account and generate a **long-term Access Token** (valid ~1 year)
4. Find your **Advertiser ID** in TikTok Ads Manager (top-left account dropdown)

### Step 2 — Add env var in Vercel
| Variable | Notes |
|----------|-------|
| `TIKTOK_ACCESS_TOKEN` | The long-term access token |

### Step 3 — Add the account in `index.html`
In the `ACCOUNTS` array, uncomment/add:
```javascript
{ id:'YOUR_ADVERTISER_ID', name:'Client TikTok', group:'other', platform:'tiktok' },
```

That's it. The account appears in the sidebar with a pink **TikTok** badge, and all tabs (Overview, Ad Intelligence, Health Check, History) work automatically — the proxy returns data in the same shape as Meta.

---

## 3. Google Ads

### Step 1 — Get API access (allow ~1 week for token approval)
1. Apply for a **developer token** at [Google Ads API Center](https://ads.google.com/aw/apicenter) (Basic access is enough)
2. In [Google Cloud Console](https://console.cloud.google.com/), create an **OAuth 2.0 Client ID** (type: Web application)
3. Use the [OAuth Playground](https://developers.google.com/oauthplayground/):
   - Settings (gear) → check "Use your own OAuth credentials" → paste Client ID + Secret
   - Authorize scope: `https://www.googleapis.com/auth/adwords`
   - Exchange for a **refresh token**
4. Find your **Customer ID** (10 digits, top-right in Google Ads — remove dashes)

### Step 2 — Add env vars in Vercel
| Variable | Notes |
|----------|-------|
| `GOOGLE_DEVELOPER_TOKEN` | From API Center |
| `GOOGLE_CLIENT_ID` | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | From OAuth Playground |
| `GOOGLE_LOGIN_CUSTOMER_ID` *(optional)* | Your MCC/manager ID (digits only) if the account sits under a manager |

### Step 3 — Add the account in `index.html`
```javascript
{ id:'1234567890', name:'Client Google', group:'other', platform:'google' },
```
(Use the customer ID with no dashes.) The account appears with a yellow **Google** badge.

---

## Notes

- **History/backfill** currently works for Meta accounts only. TikTok/Google show live data in Overview/Ad Intelligence/Health, but the daily-snapshot auto-save and backfill panel are skipped for them. (Can be extended later if needed.)
- The daily WhatsApp summary covers the 8 core Meta accounts listed in `api/daily-summary.js`. Edit that `ACCOUNTS` array to add/remove accounts from the summary.
- All proxies enforce the same JWT auth and client account-access control as the Meta proxy.
