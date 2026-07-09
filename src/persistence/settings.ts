// localStorage-backed settings for the optional Riot API integration.
// Bring-your-own-key: each user pastes their own personal Riot API key here.
// Never bundled into the build, never written to the ledger/goldens — this is
// the only place the key lives, and it never leaves the local machine except
// as an Authorization-style header on requests to api.riotgames.com.
//
// Storage layout: tft:settings → JSON RiotSettings

const SETTINGS_KEY = 'tft:settings';

export type RiotContinent = 'americas' | 'asia' | 'europe';
export type RiotPlatform =
  | 'na1' | 'br1' | 'la1' | 'la2' | 'oc1'
  | 'euw1' | 'eun1' | 'tr1' | 'ru'
  | 'kr' | 'jp1';

export interface RiotSettings {
  riotApiKey: string;
  continent: RiotContinent;
  platform: RiotPlatform;
  gameName: string;
  tagLine: string;
  // Cached after the first successful account-v1 resolve, so it doesn't need
  // re-resolving on every launch.
  puuid?: string;
}

const DEFAULTS: RiotSettings = {
  riotApiKey: '',
  continent: 'americas',
  platform: 'na1',
  gameName: '',
  tagLine: '',
};

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
