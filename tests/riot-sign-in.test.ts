// App side of Riot Sign On (src/enrichment/riot-sign-in.ts): a sign-in is
// accepted only when it answers the request this install made, and the old
// paste-your-own-key setting is purged.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  beginRiotSignIn, completeRiotSignIn, signOutOfRiot, SIGN_IN_WINDOW_MS,
} from '../src/enrichment/riot-sign-in';
import { loadSettings, hasLinkedAccount, hasExpiredAccount } from '../src/persistence/settings';
import worker, { type Env } from '../server/rso-worker/src/index';

const BACKEND = 'https://coachv-rso.test.workers.dev';

let store: Map<string, string>;
let opened: string[];

beforeEach(() => {
  store = new Map();
  opened = [];
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  vi.stubGlobal('overwolf', { utils: { openUrlInDefaultBrowser: (url: string) => opened.push(url) } });
  vi.stubGlobal('__COACHV_BACKEND_URL__', BACKEND);
});

afterEach(() => { vi.unstubAllGlobals(); });

function startAndGetState(now = Date.now()): string {
  expect(beginRiotSignIn(now)).toBe(true);
  return new URL(opened.at(-1)!).searchParams.get('state')!;
}

function link(params: Record<string, string>): string {
  return `coachv://rso?${new URLSearchParams(params).toString()}`;
}

const SIGNED_IN = { session: 'v1.payload.sig', expiresAt: String(Date.now() + 86_400_000), puuid: 'puuid-1', gameName: 'Player', tagLine: 'VN2' };

describe('beginRiotSignIn', () => {
  it('does nothing in a build without a backend', () => {
    vi.stubGlobal('__COACHV_BACKEND_URL__', '');
    expect(beginRiotSignIn()).toBe(false);
    expect(opened).toHaveLength(0);
  });

  it('opens the backend login in the browser with a fresh random state', () => {
    const first = startAndGetState();
    const second = startAndGetState();
    expect(opened[0].startsWith(`${BACKEND}/rso/login?state=`)).toBe(true);
    expect(first).toMatch(/^[0-9a-f]{48}$/);
    expect(second).not.toBe(first);
  });
});

describe('completeRiotSignIn', () => {
  it('saves the account when the link answers our request, once', () => {
    const state = startAndGetState();
    const result = completeRiotSignIn(link({ state, ...SIGNED_IN }));
    expect(result.ok).toBe(true);
    const settings = loadSettings();
    expect(settings.account?.puuid).toBe('puuid-1');
    expect(hasLinkedAccount(settings)).toBe(true);
    // Replaying the same link does nothing.
    expect(completeRiotSignIn(link({ state, ...SIGNED_IN }))).toEqual({ ok: false, reason: 'no_pending' });
  });

  it('rejects a link carrying someone else\'s state, and keeps waiting for ours', () => {
    const state = startAndGetState();
    expect(completeRiotSignIn(link({ state: 'f'.repeat(48), ...SIGNED_IN }))).toEqual({ ok: false, reason: 'state_mismatch' });
    expect(loadSettings().account).toBeUndefined();
    expect(completeRiotSignIn(link({ state, ...SIGNED_IN })).ok).toBe(true);
  });

  it('rejects a sign-in finished after the window closed', () => {
    const start = Date.now();
    const state = startAndGetState(start);
    const result = completeRiotSignIn(link({ state, ...SIGNED_IN }), start + SIGN_IN_WINDOW_MS + 1);
    expect(result).toEqual({ ok: false, reason: 'expired' });
    expect(loadSettings().account).toBeUndefined();
  });

  it('reports a cancelled sign-in', () => {
    const state = startAndGetState();
    expect(completeRiotSignIn(link({ state, error: 'access_denied' }))).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('accepts the link URL-encoded, as Overwolf passes it', () => {
    const state = startAndGetState();
    expect(completeRiotSignIn(encodeURIComponent(link({ state, ...SIGNED_IN }))).ok).toBe(true);
  });

  it('ignores links that are not a coachv sign-in', () => {
    startAndGetState();
    expect(completeRiotSignIn('https://example.com/?state=x')).toEqual({ ok: false, reason: 'not_ours' });
    expect(completeRiotSignIn('coachv://something-else')).toEqual({ ok: false, reason: 'not_ours' });
  });

  it('completes end to end against the Worker\'s real callback page', async () => {
    const env: Env = {
      RSO_CLIENT_ID: 'id', RSO_CLIENT_SECRET: 'secret', RIOT_API_KEY: 'key',
      SESSION_SECRET: 'session-secret-for-tests', PUBLIC_URL: BACKEND,
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/token')
      ? new Response(JSON.stringify({ access_token: 'at' }))
      : new Response(JSON.stringify({ puuid: 'puuid-9', gameName: 'Real', tagLine: 'EUW' }))));

    const state = startAndGetState();
    const page = await (await worker.fetch(new Request(`${BACKEND}/rso/callback?code=c&state=${state}`), env)).text();
    const href = page.match(/id="back" href="([^"]+)"/)![1].replace(/&amp;/g, '&');

    const result = completeRiotSignIn(href);
    expect(result.ok && result.account.gameName).toBe('Real');
  });
});

describe('settings', () => {
  it('purges a personal API key stored by an earlier build', () => {
    store.set('tft:settings', JSON.stringify({ riotApiKey: 'RGAPI-old', platform: 'euw1', gameName: 'A', tagLine: 'B', puuid: 'p' }));
    const settings = loadSettings();
    expect(settings).toEqual({ platform: 'euw1' });
    expect(store.get('tft:settings')).not.toContain('RGAPI');
  });

  it('treats a lapsed session as signed out but remembered', () => {
    store.set('tft:settings', JSON.stringify({
      platform: 'na1',
      account: { puuid: 'p', gameName: 'A', tagLine: 'B', session: 's', expiresAt: Date.now() - 1 },
    }));
    const settings = loadSettings();
    expect(hasLinkedAccount(settings)).toBe(false);
    expect(hasExpiredAccount(settings)).toBe(true);
  });

  it('sign out forgets the account but keeps the server choice', () => {
    store.set('tft:settings', JSON.stringify({
      platform: 'kr',
      account: { puuid: 'p', gameName: 'A', tagLine: 'B', session: 's', expiresAt: Date.now() + 1e6 },
    }));
    signOutOfRiot();
    expect(loadSettings()).toEqual({ platform: 'kr' });
  });
});
