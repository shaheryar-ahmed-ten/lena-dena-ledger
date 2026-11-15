# Lena Dena Ledger

A money ledger for you and your friends: who owes you, who you owe, per-person balances, one-tap "settle up", edit/delete, voice entry (Whisper + AI), CSV export, import from Google Sheets, accounts with Google sign-in.

**Stack:** React 19 (Vite) frontend · Express 5 API · TypeScript everywhere · Upstash Redis · deployed on Vercel.

## Project layout

```
client/                  React app (Vite builds it into dist/)
  index.html             page shell, fonts
  src/main.tsx           starts React + the router
  src/App.tsx            routes and the "am I logged in?" check
  src/api.ts             fetch helper for /api calls
  src/recorder.ts        microphone recording with auto-stop
  src/pages/             AuthPage (login + sign-up), LedgerPage, PrivacyPage
  src/components/        VoiceEntry ("Say it" panel)
server/                  Express API
  app.ts                 creates the app, mounts routes, error handler
  index.ts               local server (npm run dev / npm start)
  middleware.ts          requireUser, request origin helper
  routes/                auth, entries (+ CSV), dictionary, voice (parse/transcribe), legacy, oauth, google (Sheets import)
  lib/                   store (Redis), auth (passwords, cookies, token encryption), oauth (Google, via openid-client), sheets, ai, stt (Whisper), models
shared/                  code used by BOTH sides
  types.ts               Entry, Draft, WordPair…
  ledger.ts              entry kinds, balances, validation
  parse.ts               rule-based sentence → entries parser
api/index.ts             Vercel function: exports the Express app
vercel.json              build settings + routing (/api/* → Express, everything else → React)
```

## How a request flows

- **Pages** (`/`, `/login`, `/signup`, `/privacy`): Vercel serves `dist/index.html`; React Router picks the page in the browser. `App.tsx` calls `GET /api/me` to see who's logged in.
- **API** (`/api/...`): `vercel.json` rewrites every `/api/*` request to the `api/index.ts` function, which is the Express app. Express matches the route (`server/routes/*`), checks the session cookie (`requireUser`), and reads/writes Redis (`server/lib/store.ts`).
- **Google sign-in**: the button is a normal link to `/api/oauth/google/start`; Express redirects to Google; Google redirects back to `/api/oauth/google/callback`; Express sets the session cookie and redirects to `/`.
- **Import from Google Sheets**: the same Google round trip with `mode=drive` asks for one extra permission (`drive.file`: only files the user picks). Google's Picker runs in the page; Express reads the picked sheet with the Sheets API and saves the rows the user confirms. See [docs/google-sheets-import.md](docs/google-sheets-import.md).

## Run it on your computer

Needs Node.js 18 or newer.

```
npm install
npm run dev
```

Open http://localhost:5173. `npm run dev` starts two things: the Express API on port 3001 and Vite on port 5173 (Vite forwards `/api` calls to Express). Without the Redis variables, data is kept in memory and disappears when the server restarts.

To use your real settings locally, `npx vercel env pull .env.local`, then run with them loaded, e.g. in PowerShell:

```
Get-Content .env.local | ForEach-Object { if ($_ -match '^(\w+)="?(.*?)"?$') { Set-Item "env:$($matches[1])" $matches[2] } }
npm run dev
```

Other scripts: `npm run build` (React → `dist/`), `npm start` (build, then one Express server on port 3001 serving both the pages and the API), `npm run typecheck` (TypeScript checks for server and client).

## Deploy

```
npx vercel --prod
```

`vercel.json` tells Vercel to build the React app (`npm run build` → `dist/`) and to run `api/index.ts` as a Node function. Environment variables are the same as before; nothing to change in Vercel or Google.

## Environment variables

| Name | Required | What it is |
| --- | --- | --- |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Yes, on Vercel | Added automatically when you connect Upstash Redis |
| `APP_URL` | For Google sign-in | Your main address, e.g. `https://lena-dena-ledger.vercel.app` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | For Google sign-in | From Google Auth Platform → Clients |
| `GOOGLE_API_KEY`, `GOOGLE_PROJECT_NUMBER` | For importing from Google Sheets | A browser API key for the Google Picker, and the Cloud project number (see below) |
| `GROQ_API_KEY` | For AI + accurate speech | Free key from console.groq.com/keys |
| `SIGNUP_CODE` | No | If set, people need this invite code to sign up |
| `SESSION_SECRET` | No | Signs login cookies; generated and stored in Redis if unset |
| `LEDGER_PASSCODE` | No | Only for importing the old single-passcode ledger into an account |
| `AI_MODEL`, `STT_MODEL` | No | Choose specific Groq models (the app switches automatically if one is retired) |

Google needs this redirect URI registered: `https://lena-dena-ledger.vercel.app/api/oauth/google/callback`.

### Import from Google Sheets (optional)

Uses the same Google client as sign-in. The panel appears only when both variables below are set. In the same Google Cloud project:

1. **APIs & Services → Library:** enable **Google Drive API**, **Google Sheets API** and **Google Picker API**.
2. **APIs & Services → Credentials → Create credentials → API key.** Restrict it to the *Google Picker API*, and to the websites `http://localhost:5173/*` and `https://lena-dena-ledger.vercel.app/*`. Put it in `GOOGLE_API_KEY`.
3. **Project number** (Cloud console home → Project info) → `GOOGLE_PROJECT_NUMBER`.
4. **Google Auth Platform → Data Access → Add or remove scopes:** add `https://www.googleapis.com/auth/drive.file`. It's a non-sensitive scope, so Google needs no extra review.

How it works is described in [docs/google-sheets-import.md](docs/google-sheets-import.md).

## Accounts and security

- Passwords: scrypt with a random salt per user. Sessions: an HMAC-signed, httpOnly cookie (`ledger_session`, 30 days).
- Every API route that touches data uses the user ID from the verified cookie, so users can't read or change each other's ledgers.
- 10 wrong passwords lock a username for 15 minutes. Each user gets 100 voice/AI requests per hour.
- Google sign-in uses OpenID Connect via the [`openid-client`](https://github.com/panva/openid-client) library: state + nonce + PKCE, with the ID token validated (issuer, audience, expiry, nonce). These values are carried in a signed 10-minute cookie (`ledger_oauth`, path `/api/oauth`). Accounts are linked by Google's permanent user ID (`sub`), never by email.

## How balances work

| Entry | Effect |
| --- | --- |
| I lent money | they owe you more |
| I borrowed money | you owe them more |
| They paid me back | they owe you less |
| I paid them back | you owe them less |
