# Godlike Partners

A working affiliate platform: partner signup/login, wallet with payout requests,
tracking links, postback settings, referral-based multi-admin management — plus
an admin panel to manage partners, credit balances, and process payout requests.

- **Backend:** Node.js + Express + SQLite (using Node's built-in `node:sqlite` —
  no native compilation, no separate database service to set up)
- **Partner site:** `public/partner/index.html` (English) — served at `/`
- **Admin panel:** `public/admin/index.html` (Russian) — served at `/admin`
- Single process serves both the API and the static frontend — one `npm start` runs everything.

**Requires Node.js 22.5 or newer** (check with `node -v`). This app uses Node's
built-in SQLite module instead of a third-party database package, specifically
to avoid native-compilation issues when deploying to a host you don't fully
control.

## 1. Run it locally

```bash
npm install
cp .env.example .env      # then edit .env, at least JWT_SECRET and ADMIN_PASSWORD
npm start
```

Open:
- Partner site: http://localhost:3000
- Admin panel: http://localhost:3000/admin

On first run, a default **super-admin** account is created automatically using
`ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env` (defaults: `admin@godlikepartners.com`
/ `changeme123` if you don't set them). **Log in at `/admin` and click "Сменить
пароль" (Change password) in the top bar right away** to set your own password.

Data is stored in `data/godlike.db`, a single SQLite file. Back this file up —
it's your entire database.

## 2. Multi-admin & referral links

Every admin account (super-admin or regular) has its own referral link, shown
at the top of the admin panel (`yoursite.com/?ref=CODE`). Partners who sign up
through that link are automatically assigned to that admin.

- **Super-admin** (the first/default account): sees every partner across all
  admins, plus a fourth "Админы" tab to create or remove other admin accounts.
- **Regular admin**: only sees, messages, credits, and manages partners who
  signed up through their own referral link. They cannot see or act on another
  admin's partners.
- Deleting an admin unassigns (does not delete) their partners — those partners
  become visible to super-admins until reassigned.

To create additional admins, log in as the super-admin, open the "Админы" tab,
and add them by name/email/password.

## 3. What's real vs. what's a placeholder

| Feature | Status |
|---|---|
| Registration, login, sessions (JWT in an httpOnly cookie) | Real |
| Referral attribution (partner → admin) | Real |
| Partner wallet: balance, payout methods, payout requests | Real |
| Admin: partner list (scoped by referral), credit balance, block/unblock, reset password | Real |
| Admin: payout queue, mark as paid / reject | Real |
| Admin: manage other admin accounts (super-admin only) | Real |
| Postback settings (save/load per partner) | Real |
| Postback "Test" button | Real — sends one live HTTP request to the URL you entered |
| Discord / Telegram notifications (signups, logins, payouts, postback activity) | Real, if configured |
| Tracking links (`/go/:offerId`) | Logs the click to the `clicks` table, then just shows a placeholder page |
| Dashboard/Statistics charts and numbers | Placeholder — always zero. There's no click/conversion tracking wired to real stats yet (see below) |
| Actually sending money out (crypto/bank transfer) | Not implemented — payouts sit in a queue for the admin to pay manually and mark as done |

## 4. Next steps to make it fully production-ready

1. **Wire up real click/conversion tracking.** `GET /go/:offerId` in `server.js`
   currently logs a row to the `clicks` table and shows a placeholder message.
   Replace it with `res.redirect(realOfferUrl)`, then when the casino platform
   reports a conversion back to you, match it to the click and update the
   partner's `tier_volume` / a real stats table. Once that exists, fire the
   partner's configured postback URLs automatically (the `/api/postbacks/test`
   route already shows how to make that HTTP call).

2. **Automate real payouts.** A payout request currently just sits in the
   admin queue (`GET /api/admin/payouts`) for a human to pay by hand and click
   "Выплачено". To automate it, integrate a payment provider inside the
   `settle` route in `src/routes/admin.js` — e.g. a crypto payout API for
   USDT, or a banking API for transfers.

3. **Email.** There's no email sending yet. Password reset
   (`POST /api/admin/partners/:id/reset-password`) currently returns a temp
   password directly in the API response for the admin to relay manually —
   fine for a small team, add a real "forgot password" email flow before you
   scale up.

4. **Tighten security before scaling up:**
   - Change `JWT_SECRET` and `ADMIN_PASSWORD` in `.env` (never use the defaults in production).
   - The Content-Security-Policy is disabled in `server.js` because the
     frontend uses inline `<style>`/inline handlers. Consider moving
     CSS/JS into separate files and re-enabling a strict CSP.
   - Add email verification on signup.

## 5. Deploying it today (Railway)

1. Push this folder to a GitHub repo (files at the repo root, not nested in a subfolder).
2. On railway.app, New Project → Deploy from GitHub repo.
3. Attach a Volume to the service (any mount path) — Railway automatically
   provides `RAILWAY_VOLUME_MOUNT_PATH` at runtime and this app picks it up on
   its own, no manual variable needed. On other hosts, set `DATA_DIR` instead.
4. Add environment variables from `.env.example` under the service's
   **Variables** tab: `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
   `NODE_ENV=production`.
5. Settings → Networking → Generate Domain for a public HTTPS URL.
6. Visit the URL, confirm the partner site loads, then `/admin` and change the
   default admin password immediately.

## 6. Discord / Telegram notifications

Get pinged automatically on new registrations, logins, payout requests, and
postback activity (each includes email, IP, and device where relevant). Both
are optional and independent.

**Discord:** Server Settings → Integrations → Webhooks → New Webhook → copy
the URL → set `DISCORD_WEBHOOK_URL` in your environment.

**Telegram:** message **@BotFather** on Telegram → `/newbot` → follow the
prompts → copy the token it gives you into `TELEGRAM_BOT_TOKEN`. Then message
your new bot at least once (so it can message you back), open
`https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser, and find
your numeric chat id in the response → set that as `TELEGRAM_CHAT_ID`.

Leave either blank to skip it. If a webhook is misconfigured or unreachable,
the exact error is logged server-side and it never blocks registration,
login, or payouts.

## 7. Project structure

```
server.js                   entry point — mounts routes, serves static files
src/db.js                   SQLite schema (creates data/godlike.db on first run)
src/middleware/auth.js      JWT auth, admin role check
src/utils/notify.js         Discord/Telegram notification helper
src/routes/auth.js          register / login / logout (+ referral attribution)
src/routes/partner.js       profile, wallet, links, postbacks, messages (requires login)
src/routes/admin.js         partner management, payouts, offers, admin accounts (requires admin role)
public/partner/index.html   partner-facing site (English)
public/admin/index.html     admin panel (Russian)
data/godlike.db             the database (created automatically, back this up)
```
