# Godlike Partners

A working affiliate platform: partner signup/login, wallet with payout requests,
tracking links, postback settings — plus an admin panel to manage partners,
credit balances, and process payout requests.

- **Backend:** Node.js + Express + SQLite (using Node's built-in `node:sqlite` —
  no native compilation, no separate database service to set up)
- **Partner site:** `public/partner/index.html` (English) — served at `/`
- **Admin panel:** `public/admin/index.html` (Russian) — served at `/admin`
- Single process serves both the API and the static frontend — one `npm start` runs everything.

**Requires Node.js 22.5 or newer** (check with `node -v`). This app uses Node's
built-in SQLite module instead of a third-party database package, specifically
to avoid native-compilation issues when deploying to a host you don't fully
control. If your host's Node is older, either upgrade it (most hosts let you
pick a Node version) or ask to swap in PostgreSQL instead.

## 1. Run it locally

```bash
npm install
cp .env.example .env      # then edit .env, at least JWT_SECRET and ADMIN_PASSWORD
npm start
```

Open:
- Partner site: http://localhost:3000
- Admin panel: http://localhost:3000/admin

On first run, a default admin account is created automatically using
`ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env` (defaults: `admin@godlikepartners.com`
/ `changeme123` if you don't set them). **Log in at `/admin` and click "Сменить
пароль" (Change password) in the top bar right away** to set your own password.

Data is stored in `data/godlike.db`, a single SQLite file. Back this file up —
it's your entire database.

## 2. What's real vs. what's a placeholder

| Feature | Status |
|---|---|
| Registration, login, sessions (JWT in an httpOnly cookie) | Real |
| Partner wallet: balance, payout methods, payout requests | Real |
| Admin: partner list, credit balance, block/unblock, reset password | Real |
| Admin: payout queue, mark as paid / reject | Real |
| Postback settings (save/load per partner) | Real |
| Postback "Test" button | Real — sends one live HTTP request to the URL you entered |
| Tracking links (`/go/:offerId`) | Logs the click to the `clicks` table, then just shows a placeholder page |
| Dashboard/Statistics charts and numbers | Not connected — shown as “—” with an explicit empty state. There's no click/conversion tracking wired to real stats yet (see below) |
| Actually sending money out (crypto/bank transfer) | Not implemented — payouts sit in a queue for the admin to pay manually and mark as done |

## 3. Next steps to make it fully production-ready

1. **Wire up real click/conversion tracking.** `GET /go/:offerId` in `server.js`
   currently logs a row to the `clicks` table and shows a placeholder message.
   To make it real:
   - Replace the placeholder response with `res.redirect(realOfferUrl)` to the
     actual casino product's tracking URL for that offer.
   - When the casino platform reports a conversion back to you (usually via
     their own postback/webhook), match it to the click (by `click_id`), find
     which partner's saved link generated it, and update their `tier_volume`
     / insert into a stats table.
   - Once that exists, replace the empty-state blocks in the Dashboard and
     Statistics pages with real numbers.
   - Then fire the partner's own configured postback URLs (from
     `postback_settings`) automatically when those events happen — the
     `/api/postbacks/test` route already shows how to make that HTTP call.

2. **Automate real payouts.** Right now a payout request just sits in the
   admin queue (`GET /api/admin/payouts`) for a human to pay by hand and click
   "Paid". To automate it, integrate a payment provider in
   `src/routes/admin.js` inside the `settle` route — e.g. a crypto payout API
   (a provider like NOWPayments/Coinbase Commerce) for USDT, or a banking API
   for transfers. Call the provider's API before marking the transaction
   `paid`.

3. **Email.** There's no email sending yet. Two places want it:
   - Password reset (`POST /api/admin/partners/:id/reset-password` currently
     returns a temp password directly in the API response for the admin to
     relay manually — fine for a small team, but add a "forgot password" flow
     with a real emailed link before you have many partners).
   - Optional: notify partners by email when a payout is marked paid.

4. **Tighten security before scaling up:**
   - Change `JWT_SECRET` and `ADMIN_PASSWORD` in `.env` (never use the defaults in production).
   - The Content-Security-Policy is disabled in `server.js` (`helmet({ contentSecurityPolicy: false })`)
     because the frontend uses inline `<style>`/inline handlers. Consider moving
     CSS/JS into separate files and re-enabling a strict CSP.
   - Add email verification on signup.
   - Consider 2FA for the admin account, since it can move money.

## 4. Deploying it today

The fastest path is a platform that builds and runs a Node app directly from
your files, gives you HTTPS and a URL immediately, and lets you attach your
own domain after. Railway, Render, and Fly.io all work well for this size of
app. A plain VPS gives you more control but more to configure by hand.

Either way, the steps are the same shape:

1. Push this folder to a private GitHub repo (or upload it directly if your
   host supports that).
2. Create a new Node.js web service pointing at this repo, with the start
   command `npm start`.
3. Set the environment variables from `.env.example` in the host's dashboard
   (`JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `NODE_ENV=production`) —
   don't upload `.env` itself.
4. **Attach persistent storage for the `data/` folder.** SQLite writes to a
   file on disk. Most platforms (Railway, Render, Fly) redeploy on a fresh
   filesystem by default, which would wipe your database — you need to mount
   a persistent volume/disk. **On Railway**, attach a volume to your service
   (mount path can be anything, e.g. `/data`) — Railway automatically
   provides a `RAILWAY_VOLUME_MOUNT_PATH` variable at runtime and this app
   picks it up on its own, no manual variable needed. On other hosts, set
   the `DATA_DIR` environment variable to wherever you mount the volume. If
   you'd rather not deal with a volume at all, swapping to a hosted Postgres
   (Neon/Supabase/Railway Postgres all have a free tier) with the `pg`
   package removes the problem entirely — ask if you want help with that swap.
5. Point your domain at the host: add a CNAME (or the A/ALIAS record your
   host asks for) at your domain registrar, then add the domain in your
   host's dashboard. SSL certificates are issued automatically by all three
   platforms mentioned above.
6. Visit `https://yourdomain.com`, confirm the partner site loads, log into
   `https://yourdomain.com/admin` with your admin credentials, and change the
   admin password.

Once that's live, real partners can register and log in immediately — the
account/wallet/admin system in this package is fully functional today. Stats
and automated payouts are the two pieces still worth building next (section 3).

## 5. Discord / Telegram notifications

Get pinged automatically on new registrations, logins, and payout requests
(each includes email, IP, and device). Both are optional and independent.

**Discord:** Server Settings → Integrations → Webhooks → New Webhook → copy
the URL → set `DISCORD_WEBHOOK_URL` in your environment.

**Telegram:** message **@BotFather** on Telegram → `/newbot` → follow the
prompts → copy the token it gives you into `TELEGRAM_BOT_TOKEN`. Then message
your new bot at least once (so it can message you back), open
`https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser, and find
your numeric chat id in the response → set that as `TELEGRAM_CHAT_ID`.

Leave either blank to skip it. If a webhook is misconfigured or unreachable,
it fails silently in the server logs and never blocks registration, login, or
payouts.

## 6. Project structure

```
server.js                   entry point — mounts routes, serves static files
src/db.js                   SQLite schema (creates data/godlike.db on first run)
src/middleware/auth.js      JWT auth, admin role check
src/routes/auth.js          register / login / logout
src/routes/partner.js       profile, wallet, links, postbacks (requires login)
src/routes/admin.js         partner management, payout queue (requires admin role)
public/partner/index.html   partner-facing site (English)
public/admin/index.html     admin panel (Russian)
data/godlike.db             the database (created automatically, back this up)
```
