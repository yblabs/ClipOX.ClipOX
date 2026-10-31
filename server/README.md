# Framewright — admin feedback server

A small Node + Express service that stores site feedback in SQLite, exposes a
public submission API, and backs the **admin-only** moderation console
(`admin-login.html` / `admin.html`). It also serves your existing static site
and proxies `/api`, `/media` and `/fonts` to the FastAPI app, so **everything
runs on one origin** and the httpOnly session cookie just works.

```
wayin-site/
├── index.html · pricing.html · editor.html · clip-maker.html …  (unchanged site)
├── admin-login.html          ← admin sign in (noindex, not linked publicly)
├── admin.html                ← moderation dashboard (data is server-protected)
├── assets/css/admin.css      ← styles for the two admin pages (theme.css tokens)
├── assets/js/admin-login.js  ← login logic
├── assets/js/admin.js        ← dashboard logic
├── assets/js/feedback.js     ← widget now POSTs to /api/feedback + reads the approved feed
└── server/                   ← this folder
    ├── index.js              ← Express app: public API → admin API → static → proxy
    ├── lib/auth.js           ← bcrypt compare, JWT session, CSRF guard, login limiter
    ├── lib/store.js          ← SQLite (node:sqlite, no native modules), parameterised SQL
    ├── lib/sanitize.js       ← input validation + sanitisation
    ├── data/feedback.db      ← created on first run (git-ignored)
    ├── .env                  ← YOUR SECRETS (git-ignored)
    ├── .env.example          ← copy this to .env
    └── package.json
```

---

## 1. Requirements

* **Node.js 22.5 or newer** (the database uses the built-in `node:sqlite`;
  nothing native has to compile).
  - macOS: `brew install node` (or https://nodejs.org)
  - Windows: the MSI from https://nodejs.org (LTS is fine)
* Your existing Python backend for the video features
  (`uvicorn app.main:app --port 8000`, unchanged).
* `ffmpeg` on PATH for rendering (unchanged).

Check: `node -v` → `v22.5.0` or higher.

---

## 2. First-time setup

**macOS / Linux (Terminal)**

```bash
cd wayin-site/server
npm install
cp .env.example .env
```

**Windows (PowerShell or CMD)**

```bat
cd wayin-site\server
npm install
copy .env.example .env
```

Then open `server/.env` in an editor and fill in:

| Key              | What to put                                                       |
|------------------|-------------------------------------------------------------------|
| `ADMIN_LOGIN`    | your admin ID (e.g. `yblabs.clips`) — **not** an email, no validation |
| `ADMIN_PASSWORD` | a long, unique passphrase                                         |
| `JWT_SECRET`     | 64+ random characters: `openssl rand -hex 48` (macOS/Linux) or in PowerShell: `-join ((1..64) \| ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })` |
| `PORT`           | `4000`                                                            |
| `UPSTREAM`       | `http://127.0.0.1:8000` (where FastAPI runs)                      |
| `SITE_ORIGINS`   | every origin you serve from, comma separated                      |
| `COOKIE_SECURE`  | `false` locally, **`true` behind HTTPS in production**            |

`.env` is ignored by git (both `wayin-site/.gitignore` and `server/.gitignore`).

---

## 3. Running it (two terminals)

**Terminal 1 — your existing backend (unchanged):**

```bash
cd wayin-site/backend
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

**Terminal 2 — the site + admin server:**

```bash
cd wayin-site/server
npm start          # or: npm run dev   (auto-restart on changes)
```

### URLs

| Page                     | URL                                                    |
|--------------------------|--------------------------------------------------------|
| Site (main page)         | http://127.0.0.1:4000/index.html                       |
| **Admin sign in**        | http://127.0.0.1:4000/admin-login.html                 |
| **Admin dashboard**      | http://127.0.0.1:4000/admin.html                       |
| FastAPI docs / dev UI    | http://127.0.0.1:8000/docs (site also still served there) |

**Open the admin pages on port 4000** — that is the origin that holds the
session. If you open `admin.html` on port 8000 (or any server that is not this
one) the page shows a clear *"the admin console lives on the Node server"*
panel with a button that jumps to the right URL, because the cookie is
`SameSite=Strict` and the CSRF guard rejects cross-site/cross-port requests
by design.

The public site and the feedback widget work on either port: `feedback.js`
probes `api/reviews/approved`, and if this origin has no API it falls back to
`http://127.0.0.1:4000`, and to a localStorage demo store if neither answers.

---

## 4. API surface

**Public**

| Method | Path                        | Notes                                                     |
|--------|-----------------------------|-----------------------------------------------------------|
| POST   | `/api/feedback`             | validates, sanitises, honeypot, 10 submissions / 10 min / IP, always stored `pending` |
| GET    | `/api/reviews/approved`     | approved reviews only → drives the public carousel        |

**Admin (all require the session cookie, all return 401 otherwise)**

| Method | Path                              | Purpose                                    |
|--------|-----------------------------------|--------------------------------------------|
| POST   | `/api/admin/login`                | `{adminId, password}` → sets JWT cookie    |
| POST   | `/api/admin/logout`               | clears the cookie                          |
| GET    | `/api/admin/me`                   | session check (dashboard boot)             |
| GET    | `/api/admin/stats`                | counters for the stat cards                |
| GET    | `/api/admin/feedback`             | `type, status, rating, q, from, to, page, pageSize, sort, dir` |
| PUT    | `/api/admin/feedback/:id`         | edit name, role, message, rating, status   |
| DELETE | `/api/admin/feedback/:id`         | delete one                                  |
| POST   | `/api/admin/feedback/bulk`        | `{ids, action}` → `approved` \| `hidden` \| `deleted` |

State-changing requests also need the `X-Requested-With: XMLHttpRequest`
header (CSRF guard) and a same-site `Origin`.

---

## 5. Security checklist

- [x] Password lives only in `server/.env`; hashed with bcrypt **in memory at boot**, never stored, never returned, never present in any HTML/CSS/JS (verified by grep).
- [x] Login compares in constant time (`crypto.timingSafeEqual` on SHA-256 for the ID, `bcrypt.compare` always runs even when the ID is wrong) and answers one generic *"Invalid credentials"* — no field is ever identified.
- [x] No email validation on the login field (it is an admin ID, e.g. `yblabs.clips`).
- [x] Login rate limit: 5 failures per 15 minutes per IP → **423 + 15-minute lockout** (verified live).
- [x] Session = HS256 JWT in an **httpOnly, SameSite=Strict** cookie, 2-hour expiry, `Secure` when `COOKIE_SECURE=true`; verified server-side on every admin route.
- [x] CSRF: `X-Requested-With` header + `Origin` allowlist + `Sec-Fetch-Site` check, on top of `SameSite=Strict`.
- [x] `helmet` headers, referrer policy `no-referrer`, `X-Powered-By` disabled.
- [x] CORS limited to `SITE_ORIGINS` with credentials.
- [x] Parameterised SQL everywhere; only whitelisted columns in `SET`/`ORDER BY`.
- [x] All user text escaped before rendering (`esc()` / `textContent`).
- [x] Honeypot + per-IP rate limit on the public form; status can never be set by the client.
- [x] Both admin pages carry `<meta name="robots" content="noindex, nofollow">` and are not linked from any public page.
- [x] `.env` is git-ignored in two places.

**Do this too:** keep `NODE_ENV=production` + `COOKIE_SECURE=true` behind HTTPS,
put the admin behind a VPN/firewall or basic auth at the edge, and never expose
port 8000 publicly.

---

## 6. Deploying later

1. Put the site behind **HTTPS** (Caddy / Nginx / Cloudflare). Set
   `COOKIE_SECURE=true`, `NODE_ENV=production`, `TRUST_PROXY=1` if a proxy
   rewrites IPs, and set `SITE_ORIGINS=https://yourdomain.com`.
2. Set `PORT=4000` (or whatever the reverse proxy expects) and run
   `npm start` under a process manager: `pm2 start index.js --name framewright`
   (macOS/Linux) or **NSSM / a Windows Service** on Windows.
3. Keep FastAPI (`uvicorn`) on `127.0.0.1:8000`, firewalled so only the Node
   server can reach it — `UPSTREAM` points there.
4. Back up `server/data/feedback.db` (a single file; copy it while the server
   runs is fine thanks to WAL).
5. Rotate `ADMIN_PASSWORD` / `JWT_SECRET` by editing `.env` and restarting —
   rotating the secret invalidates all sessions immediately (a useful emergency
   "log everyone out" button).

---

## 7. Reversing the widget wiring

`assets/js/feedback.js` has a `API_ENDPOINT` config. Set it to `''` to return
the demo localStorage store (no server), or keep `api/feedback` for the real
one. Approval always happens in `admin.html`.
