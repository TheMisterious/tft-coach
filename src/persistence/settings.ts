// localStorage-backed settings for the optional Riot API integration.
// Bring-your-own-key: each user pastes their own personal Riot API key here.
// Never bundled into the build, never written to the ledger/goldens — this is
// the only place the key lives, and it never leaves the local machine except
// as an Authorization-style header on requests to api.riotgames.com.
//
// Storage layout: tft:settings → JSON RiotSettings

const SETTINGS_KEY = 'tft:settings';

export type RiotContinent = 'americas' | 'asia' | 'europe' | 'sea';
export type RiotPlatform =
  | 'na1' | 'br1' | 'la1' | 'la2'
  | 'euw1' | 'eun1' | 'tr1' | 'ru'
  | 'kr' | 'jp1'
  | 'oc1' | 'vn2' | 'sg2' | 'th2' | 'tw2' | 'ph2';

export interface RiotSettings {
  riotApiKey: string;
  platform: RiotPlatform;
  gameName: string;
  tagLine: string;
  // Cached after the first successful account-v1 resolve, so it doesn't need
  // re-resolving on every launch.
  puuid?: string;
}

const DEFAULTS: RiotSettings = {
  riotApiKey: '',
  platform: 'na1',
  gameName: '',
  tagLine: '',
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
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<RiotSettings>) };
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

// True once enough is saved to attempt an account resolve.
export function hasRiotCredentials(s: RiotSettings): boolean {
  return !!(s.riotApiKey && s.gameName && s.tagLine);
}

// True once a puuid has been resolved and cached — the only state needed for
// the rank-refresh / placement-cross-check background calls.
export function hasLinkedAccount(s: RiotSettings): boolean {
  return !!(s.riotApiKey && s.puuid);
}
