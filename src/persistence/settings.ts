// localStorage-backed settings for the optional Riot account link.
//
// The account comes from Riot Sign On (src/enrichment/riot-sign-in.ts): the
// player signs in on Riot's own page and the coachv backend
// (server/rso-worker) hands back a session bound to that account. The app
// never asks for, stores or sends a Riot API key — the production key lives
// only on the backend. Earlier builds had players paste a personal key here;
// loadSettings() drops any such key still on disk.
//
// Storage layout: tft:settings → JSON RiotSettings

const SETTINGS_KEY = 'tft:settings';

export type RiotContinent = 'americas' | 'asia' | 'europe' | 'sea';
export type RiotPlatform =
  | 'na1' | 'br1' | 'la1' | 'la2'
  | 'euw1' | 'eun1' | 'tr1' | 'ru'
  | 'kr' | 'jp1'
  | 'oc1' | 'vn2' | 'sg2' | 'th2' | 'tw2' | 'ph2';

// Who signed in, and the backend session that reads their rank and matches.
export interface LinkedRiotAccount {
  puuid: string;
  gameName: string;
  tagLine: string;
  session: string;
  expiresAt: number; // epoch ms
}

export interface RiotSettings {
  // The server the player plays on — routes rank and match lookups. Riot
  // sign-in identifies the account, not where it plays.
  platform: RiotPlatform;
  account?: LinkedRiotAccount;
}

const DEFAULTS: RiotSettings = {
  platform: 'na1',
};

// Riot routes account-v1 and tft-match-v1 to DIFFERENT continent values for
// the same platform — not one continent per platform. Confirmed live
// (2026-07-12) against a real VN2 account: account-v1 needs "asia" for VN2
// (requesting "sea" there returns 403), while tft-match-v1 needs "sea" for
// VN2 (requesting "asia" there returns an empty match list with a 200 — no
// error, just silently wrong data). A single stored "continent" setting
// (the old design) cannot represent this split; both are now derived from
// the one platform the user actually picks.
//
// The other SEA-cluster platforms (oc1/sg2/th2/tw2/ph2) follow Riot's
// documented 2023 routing split the same way VN2 does, but only VN2 has been
// individually live-verified here — if one of the others is wrong, it'll
// show up as tft-match-v1 silently returning no matches, the same failure
// this fixes for VN2.
const ACCOUNT_CONTINENT: Record<RiotPlatform, 'americas' | 'asia' | 'europe'> = {
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe',
  kr: 'asia', jp1: 'asia',
  oc1: 'asia', vn2: 'asia', sg2: 'asia', th2: 'asia', tw2: 'asia', ph2: 'asia',
};

const MATCH_CONTINENT: Record<RiotPlatform, RiotContinent> = {
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea', vn2: 'sea', sg2: 'sea', th2: 'sea', tw2: 'sea', ph2: 'sea',
};

export function accountContinentForPlatform(platform: RiotPlatform): 'americas' | 'asia' | 'europe' {
  return ACCOUNT_CONTINENT[platform];
}

export function matchContinentForPlatform(platform: RiotPlatform): RiotContinent {
  return MATCH_CONTINENT[platform];
}

export function loadSettings(): RiotSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const stored = JSON.parse(raw) as Partial<RiotSettings> & { riotApiKey?: unknown };
    const settings: RiotSettings = {
      platform: stored.platform ?? DEFAULTS.platform,
      ...(stored.account ? { account: stored.account } : {}),
    };
    // A personal key pasted into an earlier build: forget it for good.
    if ('riotApiKey' in stored) saveSettings(settings);
    return settings;
  } catch (e) {
    console.error('[settings] loadSettings failed:', e);
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: RiotSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch (e) {
    console.error('[settings] saveSettings failed:', e);
  }
}

// True while a signed-in account's session is still valid — the gate for the
// rank refresh and placement cross-check.
export function hasLinkedAccount(s: RiotSettings, now = Date.now()): boolean {
  return !!s.account && s.account.expiresAt > now;
}

// Signed in once, but the session has lapsed: the UI asks to sign in again.
export function hasExpiredAccount(s: RiotSettings, now = Date.now()): boolean {
  return !!s.account && s.account.expiresAt <= now;
}
