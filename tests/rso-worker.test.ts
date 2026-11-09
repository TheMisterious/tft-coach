// The coachv backend (server/rso-worker): Riot Sign On and the signed-in
// player's rank/match reads. Riot is never called — fetch is stubbed and every
// request the Worker makes is recorded.

import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { type Env } from '../server/rso-worker/src/index';
import { signSession, verifySession, isValidState, SESSION_TTL_MS } from '../server/rso-worker/src/session';
import { MATCH_CLUSTER } from '../server/rso-worker/src/routing';
import { matchContinentForPlatform, type RiotPlatform } from '../src/persistence/settings';

const ENV: Env = {
  RSO_CLIENT_ID: 'client-id',
  RSO_CLIENT_SECRET: 'client-secret',
  RIOT_API_KEY: 'test-production-key',
  SESSION_SECRET: 'test-session-secret-0123456789',
  PUBLIC_URL: 'https://coachv-rso.test.workers.dev',
};
const STATE = 'abcdef0123456789abcdef0123456789';

type Recorded = { url: string; init?: RequestInit };

function stubRiot(handler: (url: string, init?: RequestInit) => Response): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }));
  return calls;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(new Request(`${ENV.PUBLIC_URL}${path}`, { headers }), ENV);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('session tokens', () => {
  it('round-trips the PUUID until expiry', async () => {
    const now = 1_800_000_000_000;
    const { token, expiresAt } = await signSession('puuid-1', ENV.SESSION_SECRET, now);
    expect(expiresAt).toBe(now + SESSION_TTL_MS);
    expect(await verifySession(token, ENV.SESSION_SECRET, now + 1000)).toBe('puuid-1');
    expect(await verifySession(token, ENV.SESSION_SECRET, expiresAt)).toBeNull();
  });

  it('rejects a token signed with another secret or with an edited claim', async () => {
    const { token } = await signSession('puuid-1', ENV.SESSION_SECRET);
    expect(await verifySession(token, 'another-secret')).toBeNull();
    const [v, , sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'someone-else', exp: Date.now() + 1e9 })).toString('base64url');
    expect(await verifySession(`${v}.${forged}.${sig}`, ENV.SESSION_SECRET)).toBeNull();
    expect(await verifySession('garbage', ENV.SESSION_SECRET)).toBeNull();
  });

  it('accepts only long URL-safe states', () => {
    expect(isValidState(STATE)).toBe(true);
    expect(isValidState('short')).toBe(false);
    expect(isValidState(`${STATE}"><script>`)).toBe(false);
    expect(isValidState(null)).toBe(false);
  });
});

describe('platform routing', () => {
  it('matches the app\'s own match-cluster table for every platform', () => {
    for (const [platform, cluster] of Object.entries(MATCH_CLUSTER)) {
      expect(matchContinentForPlatform(platform as RiotPlatform)).toBe(cluster);
    }
  });
});

describe('GET /rso/login', () => {
  it('sends the player to Riot with the registered redirect and the app\'s state', async () => {
    const res = await get(`/rso/login?state=${STATE}`);
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get('Location')!);
    expect(target.origin + target.pathname).toBe('https://auth.riotgames.com/authorize');
    expect(target.searchParams.get('client_id')).toBe('client-id');
    expect(target.searchParams.get('redirect_uri')).toBe(`${ENV.PUBLIC_URL}/rso/callback`);
    expect(target.searchParams.get('response_type')).toBe('code');
    expect(target.searchParams.get('state')).toBe(STATE);
  });

  it('refuses a missing or malformed state', async () => {
    expect((await get('/rso/login')).status).toBe(400);
    expect((await get('/rso/login?state=x')).status).toBe(400);
  });
});

describe('GET /rso/callback', () => {
  function appLinkFrom(html: string): URL {
    const href = html.match(/id="back" href="([^"]+)"/)![1].replace(/&amp;/g, '&');
    return new URL(href);
  }

  it('exchanges the code, reads the account, and returns a session for that PUUID', async () => {
    const calls = stubRiot(url => {
      if (url === 'https://auth.riotgames.com/token') return json({ access_token: 'riot-access-token' });
      if (url.endsWith('/riot/account/v1/accounts/me')) return json({ puuid: 'puuid-1', gameName: 'Player', tagLine: 'VN2' });
      return json({}, 404);
    });

    const res = await get(`/rso/callback?code=the-code&state=${STATE}`);
    expect(res.status).toBe(200);

    const token = calls[0];
    expect(token.init?.method).toBe('POST');
    expect((token.init?.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('client-id:client-secret')}`);
    const body = new URLSearchParams(String(token.init?.body));
    expect(body.get('code')).toBe('the-code');
    expect(body.get('redirect_uri')).toBe(`${ENV.PUBLIC_URL}/rso/callback`);
    expect((calls[1].init?.headers as Record<string, string>).Authorization).toBe('Bearer riot-access-token');

    const link = appLinkFrom(await res.text());
    expect(link.protocol).toBe('coachv:');
    expect(link.searchParams.get('state')).toBe(STATE);
    expect(link.searchParams.get('gameName')).toBe('Player');
    expect(await verifySession(link.searchParams.get('session')!, ENV.SESSION_SECRET)).toBe('puuid-1');
    // The production key never leaves the Worker.
    expect(link.toString()).not.toContain(ENV.RIOT_API_KEY);
  });

  it('passes a cancelled sign-in back to the app without calling Riot', async () => {
    const calls = stubRiot(() => json({}));
    const res = await get(`/rso/callback?error=access_denied&state=${STATE}`);
    const link = appLinkFrom(await res.text());
    expect(link.searchParams.get('error')).toBe('access_denied');
    expect(link.searchParams.get('session')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('reports a failed exchange as a failed sign-in', async () => {
    stubRiot(() => json({ error: 'invalid_grant' }, 400));
    const link = appLinkFrom(await (await get(`/rso/callback?code=bad&state=${STATE}`)).text());
    expect(link.searchParams.get('error')).toBe('sign_in_failed');
  });
});

describe('Riot reads for the signed-in player', () => {
  async function bearer(puuid = 'puuid-1') {
    return { Authorization: `Bearer ${(await signSession(puuid, ENV.SESSION_SECRET)).token}` };
  }

  it('requires a valid session', async () => {
    expect((await get('/tft/rank?platform=vn2')).status).toBe(401);
    expect((await get('/tft/rank?platform=vn2', { Authorization: 'Bearer forged' })).status).toBe(401);
  });

  it('rejects a platform outside the allowlist before calling Riot', async () => {
    const calls = stubRiot(() => json([]));
    const res = await get('/tft/rank?platform=evil.example.com%2F', await bearer());
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('reads rank for the session\'s own PUUID with the production key', async () => {
    const calls = stubRiot(() => json([{ queueType: 'RANKED_TFT', tier: 'GOLD', rank: 'II', leaguePoints: 40, wins: 1, losses: 2 }]));
    const res = await get('/tft/rank?platform=vn2&puuid=someone-else', await bearer('puuid-1'));
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe('https://vn2.api.riotgames.com/tft/league/v1/by-puuid/puuid-1');
    expect((calls[0].init?.headers as Record<string, string>)['X-Riot-Token']).toBe(ENV.RIOT_API_KEY);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('returns the latest match trimmed to the player, on the right cluster', async () => {
    const calls = stubRiot(url => {
      if (url.includes('/ids?count=1')) return json(['VN2_123']);
      return json({
        metadata: { match_id: 'VN2_123' },
        info: { game_datetime: 42, participants: [{ puuid: 'other', placement: 1 }, { puuid: 'puuid-1', placement: 4 }] },
      });
    });
    const res = await get('/tft/latest-match?platform=vn2', await bearer('puuid-1'));
    const data = await res.json() as { match: { info: { participants: Array<{ puuid: string; placement: number }> } } };
    expect(calls[0].url).toBe('https://sea.api.riotgames.com/tft/match/v1/matches/by-puuid/puuid-1/ids?count=1');
    expect(data.match.info.participants).toEqual([{ puuid: 'puuid-1', placement: 4 }]);
  });

  it('passes Riot\'s rate limit through as a 429', async () => {
    stubRiot(() => new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }));
    const res = await get('/tft/rank?platform=na1', await bearer());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('7');
  });
});
