# coachv backend (Cloudflare Worker)

Riot Sign On (RSO) for the app, plus the two Riot API reads it makes for a
signed-in player. It exists so that neither the RSO client secret nor the
production API key ever ships inside the app.

| Route | What it does |
| --- | --- |
| `GET /rso/login?state=…` | Redirects to Riot's sign-in page. `state` is the app's own random value. |
| `GET /rso/callback` | Riot redirects here. Exchanges the code (`client_secret_basic`), reads the account from `accounts/me`, and hands a signed session back to the app through a `coachv://rso?…` link. |
| `GET /tft/rank?platform=…` | The signed-in player's TFT league entries. Cached for 5 minutes. |
| `GET /tft/latest-match?platform=…` | The player's latest match, trimmed to their own participant entry. Cached for 60 seconds. |

The two `/tft/*` routes need `Authorization: Bearer <session>`. A session is an
HMAC-signed claim of one PUUID with a 30-day expiry (`src/session.ts`). It can
only read that account's data, and the Worker keeps no Riot tokens.

## What you need from Riot

1. **A production API key.** Approved apps get one in the Riot developer portal.
2. **An RSO client.** This is separate from the key: Riot sets it up for approved
   production apps. It gives you a client ID and client secret.
3. **A registered redirect URI** for that client, exactly
   `https://<your-worker-origin>/rso/callback`.

## Deploy

```bash
cd server/rso-worker
npx wrangler login
npx wrangler deploy
```

Then set `PUBLIC_URL` in `wrangler.toml` to the deployed origin and deploy
again. Set the four secrets yourself, one at a time (each command prompts for
the value):

```bash
npx wrangler secret put RIOT_API_KEY
npx wrangler secret put RSO_CLIENT_ID
npx wrangler secret put RSO_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
```

`SESSION_SECRET` is any long random string, for example the output of
`openssl rand -base64 48`. Changing it signs every player out.

Never commit these values, and never put them in the app build. Anything
inside an `.opk` can be read back out of it.

## Point the app at it

Build the app with the Worker's origin:

```bash
COACHV_BACKEND_URL=https://<your-worker-origin> npm run build
```

In PowerShell:

```powershell
$env:COACHV_BACKEND_URL = "https://<your-worker-origin>"; npm run build
```

Without it, the app's Riot sign-in button is disabled and explains why.
Coaching reports work either way.
