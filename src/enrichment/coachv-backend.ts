// Client for the coachv backend (server/rso-worker): Riot sign-in, and the
// signed-in player's rank and latest match. Riot API calls go through it
// because the production key must not ship in the app.

import type { RiotLeagueEntry } from '../shared/types';
import type { RiotPlatform } from '../persistence/settings';
import type { RiotMatch } from './riot-api';

declare const __COACHV_BACKEND_URL__: string | undefined;

// Set at build time (webpack.config.js, COACHV_BACKEND_URL). Empty in a build
// without a backend; tests, which skip webpack, set it as a global.
export function backendUrl(): string {
  const configured = typeof __COACHV_BACKEND_URL__ === 'string' ? __COACHV_BACKEND_URL__ : '';
  return configured.replace(/\/+$/, '');
}

export function backendConfigured(): boolean {
  return backendUrl().startsWith('https://');
}

export function signInUrl(state: string): string {
  return `${backendUrl()}/rso/login?state=${encodeURIComponent(state)}`;
}

export class BackendError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'BackendError';
  }
}

async function get<T>(path: string, session: string): Promise<T> {
  const res = await fetch(`${backendUrl()}${path}`, { headers: { Authorization: `Bearer ${session}` } });
  if (res.status === 401) throw new BackendError(401, 'Riot sign-in expired');
  if (res.status === 429) throw new BackendError(429, 'rate limited');
  if (!res.ok) throw new BackendError(res.status, `coachv backend error ${res.status}`);
  return res.json() as Promise<T>;
}

export async function getRank(session: string, platform: RiotPlatform): Promise<RiotLeagueEntry[]> {
  const data = await get<Array<{
    queueType: string; tier: string; rank: string;
    leaguePoints: number; wins: number; losses: number;
  }>>(`/tft/rank?platform=${platform}`, session);
  return data.map(e => ({
    queueType: e.queueType, tier: e.tier, rank: e.rank,
    leaguePoints: e.leaguePoints, wins: e.wins, losses: e.losses,
  }));
}

// The player's most recent Riot match, trimmed by the backend to their own
// participant entry; null before Riot has published any.
export async function getLatestMatch(session: string, platform: RiotPlatform): Promise<RiotMatch | null> {
  const data = await get<{ match: RiotMatch | null }>(`/tft/latest-match?platform=${platform}`, session);
  return data.match;
}
