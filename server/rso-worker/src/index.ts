// coachv backend: Riot Sign On (RSO), plus the two Riot API reads the app makes
// for a signed-in player.
//
// Why a backend at all: the RSO client secret and the production API key must
// never ship inside the app (anything in an .opk can be read back out of it),
// and Riot does not allow players to be asked for API keys of their own. This
// Worker holds both as secrets and exposes only:
//
//   GET /rso/login?state=…        → Riot's sign-in page
//   GET /rso/callback?code&state  → code exchange, account lookup, then back
//                                   into the app via a coachv:// link
//   GET /tft/rank?platform=…           (Authorization: Bearer <session>)
//   GET /tft/latest-match?platform=…   (Authorization: Bearer <session>)
//
// Both reads are pinned to the session's own PUUID (see session.ts) and
// briefly cached, so one player cannot spend the app's rate limit on anyone
// else or hammer it for themselves. Deploy and configuration: README.md.

import { signSession, verifySession, isValidState } from './session';
import { MATCH_CLUSTER, ACCOUNT_CLUSTER, isPlatform, type Platform } from './routing';

export interface Env {
  RSO_CLIENT_ID: string;
  RSO_CLIENT_SECRET: string;
  RIOT_API_KEY: string;
  SESSION_SECRET: string;
  // This Worker's public origin, e.g. https://coachv-rso.example.workers.dev.
  // `${PUBLIC_URL}/rso/callback` is the redirect URI registered with Riot.
  PUBLIC_URL: string;
  APP_SCHEME?: string;
}

const RIOT_AUTH = 'https://auth.riotgames.com';
const RANK_CACHE_S = 300;
const MATCH_CACHE_S = 60;

class UpstreamError extends Error {
  constructor(public step: string, public status: number, public retryAfter?: string | null) {
    super(`${step} failed with ${status}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (e) {
      if (e instanceof UpstreamError) {
        const status = e.status === 429 ? 429 : 502;
        return json({ error: e.step, upstreamStatus: e.status }, status, e.retryAfter ? { 'Retry-After': e.retryAfter } : {});
      }
      console.error('[coachv] unhandled', e);
      return json({ error: 'internal' }, 500);
    }
  },
};

async function route(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return json({ error: 'method' }, 405);

  const url = new URL(request.url);
  switch (url.pathname) {
    case '/rso/login':         return login(url, env);
    case '/rso/callback':      return callback(url, env);
    case '/tft/rank':          return rank(request, url, env);
    case '/tft/latest-match':  return latestMatch(request, url, env);
    default:                   return json({ error: 'not_found' }, 404);
  }
}

// ─── Riot Sign On ────────────────────────────────────────────────────────────

function callbackUrl(env: Env): string {
  return `${env.PUBLIC_URL.replace(/\/+$/, '')}/rso/callback`;
}

function login(url: URL, env: Env): Response {
  const state = url.searchParams.get('state');
  if (!isValidState(state)) return json({ error: 'state' }, 400);
  const authorize = new URL(`${RIOT_AUTH}/authorize`);
  authorize.searchParams.set('client_id', env.RSO_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', callbackUrl(env));
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'openid');
  authorize.searchParams.set('state', state);
  return Response.redirect(authorize.toString(), 302);
}

async function callback(url: URL, env: Env): Promise<Response> {
  const state = url.searchParams.get('state');
  if (!isValidState(state)) return json({ error: 'state' }, 400);

  const scheme = env.APP_SCHEME ?? 'coachv';
  const back = (params: Record<string, string>) =>
    `${scheme}://rso?${new URLSearchParams({ state, ...params }).toString()}`;

  // Riot sends error=access_denied when the player cancels.
  const riotError = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  if (riotError || !code) return returnPage(back({ error: riotError ?? 'no_code' }), 'Sign-in was cancelled.');

  try {
    const accessToken = await exchangeCode(code, env);
    const account = await accountMe(accessToken);
    const session = await signSession(account.puuid, env.SESSION_SECRET);
    return returnPage(
      back({
        session: session.token,
        expiresAt: String(session.expiresAt),
        puuid: account.puuid,
        gameName: account.gameName,
        tagLine: account.tagLine,
      }),
      `Signed in as ${account.gameName}#${account.tagLine}.`,
    );
  } catch (e) {
    console.error('[coachv] sign-in failed', e);
    return returnPage(back({ error: 'sign_in_failed' }), 'Sign-in failed. Please try again from coachv.');
  }
}

async function exchangeCode(code: string, env: Env): Promise<string> {
  const res = await fetch(`${RIOT_AUTH}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.RSO_CLIENT_ID}:${env.RSO_CLIENT_SECRET}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl(env) }),
  });
  if (!res.ok) throw new UpstreamError('token', res.status);
  const data = await res.json() as { access_token?: string };
  if (!data.access_token) throw new UpstreamError('token', 502);
  return data.access_token;
}

async function accountMe(accessToken: string): Promise<{ puuid: string; gameName: string; tagLine: string }> {
  const res = await fetch(`https://${ACCOUNT_CLUSTER}.api.riotgames.com/riot/account/v1/accounts/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new UpstreamError('account', res.status);
  const data = await res.json() as { puuid?: string; gameName?: string; tagLine?: string };
  if (!data.puuid) throw new UpstreamError('account', 502);
  return { puuid: data.puuid, gameName: data.gameName ?? '', tagLine: data.tagLine ?? '' };
}

// A page, not a bare redirect to coachv://: browsers ask before opening an
// app, and a player who declines (or has no handler) should still see what
// happened and have a button to retry.
function returnPage(appLink: string, message: string): Response {
  const href = escapeHtml(appLink);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>coachv sign-in</title>
<style>body{font-family:Segoe UI,system-ui,sans-serif;background:#1e1e2e;color:#cdd6f4;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:420px;padding:24px;text-align:center}a{display:inline-block;margin-top:16px;padding:8px 16px;border-radius:6px;background:#313244;color:#cdd6f4;text-decoration:none;border:1px solid #45475a}
p{color:#9399b2;line-height:1.5}</style></head>
<body><main><h1 style="font-size:18px">${escapeHtml(message)}</h1>
<p>Returning you to coachv. If nothing happens, use the button below. You can close this tab afterwards.</p>
<a id="back" href="${href}">Open coachv</a></main>
<script>location.href = document.getElementById('back').getAttribute('href');</script>
</body></html>`;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    },
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ─── Riot API reads for the signed-in player ────────────────────────────────

async function authorize(request: Request, url: URL, env: Env): Promise<{ puuid: string; platform: Platform } | Response> {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const puuid = token ? await verifySession(token, env.SESSION_SECRET) : null;
  if (!puuid) return json({ error: 'session' }, 401);
  const platform = url.searchParams.get('platform');
  if (!isPlatform(platform)) return json({ error: 'platform' }, 400);
  return { puuid, platform };
}

async function rank(request: Request, url: URL, env: Env): Promise<Response> {
  const auth = await authorize(request, url, env);
  if (auth instanceof Response) return auth;
  const { puuid, platform } = auth;
  return cached(`rank/${platform}/${puuid}`, RANK_CACHE_S, () =>
    riotGet(`https://${platform}.api.riotgames.com/tft/league/v1/by-puuid/${encodeURIComponent(puuid)}`, env, 'rank'));
}

// The player's most recent match, trimmed to their own participant entry —
// all the app reads (placement, final board, game time).
async function latestMatch(request: Request, url: URL, env: Env): Promise<Response> {
  const auth = await authorize(request, url, env);
  if (auth instanceof Response) return auth;
  const { puuid, platform } = auth;
  const cluster = MATCH_CLUSTER[platform];

  return cached(`match/${platform}/${puuid}`, MATCH_CACHE_S, async () => {
    const ids = await riotGet(
      `https://${cluster}.api.riotgames.com/tft/match/v1/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=1`, env, 'match_ids',
    ) as string[];
    if (!ids[0]) return { match: null };
    const match = await riotGet(
      `https://${cluster}.api.riotgames.com/tft/match/v1/matches/${encodeURIComponent(ids[0])}`, env, 'match',
    ) as { metadata?: { match_id?: string }; info?: { game_datetime?: number; participants?: Array<{ puuid?: string }> } };
    const self = match.info?.participants?.find(p => p.puuid === puuid);
    if (!self) return { match: null };
    return {
      match: {
        metadata: { match_id: match.metadata?.match_id ?? ids[0] },
        info: { game_datetime: match.info?.game_datetime ?? 0, participants: [self] },
      },
    };
  });
}

async function riotGet(url: string, env: Env, step: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'X-Riot-Token': env.RIOT_API_KEY } });
  if (!res.ok) throw new UpstreamError(step, res.status, res.headers.get('Retry-After'));
  return res.json();
}

async function cached(key: string, ttlSeconds: number, produce: () => Promise<unknown>): Promise<Response> {
  const cache = typeof caches !== 'undefined' ? await caches.open('coachv-riot') : undefined;
  const cacheKey = new Request(`https://cache.coachv.internal/${key}`);
  const hit = await cache?.match(cacheKey);
  if (hit) return withCors(hit);

  const res = json(await produce(), 200, { 'Cache-Control': `max-age=${ttlSeconds}` });
  await cache?.put(cacheKey, res.clone());
  return res;
}

// ─── Responses ──────────────────────────────────────────────────────────────

// Bearer tokens, never cookies — so any origin may call; it proves nothing.
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...headers },
  });
}

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}
