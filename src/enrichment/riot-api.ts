// Runtime Riot API client (bring-your-own-key — see src/persistence/settings.ts).
//
// Uses the browser-global `fetch` (available in Overwolf's CEF windows) rather
// than the build-time `https`-module pattern in scripts/fetch-ddragon.js, which
// only works in the Node context that runs that script, not inside a bundled
// background/desktop window.
//
// Scope: account-v1 (Riot ID -> puuid), tft-league-v1 (rank), tft-match-v1
// (final-result cross-check only — no round-by-round data exists in this API,
// see report-generator.ts / the ledger pipeline for that). spectator-tft-v5
// and tft-status-v1 are deliberately not wired up — no concrete use yet.

import type { RiotAccount, RiotLeagueEntry } from '../shared/types';
import type { RiotContinent, RiotPlatform } from '../persistence/settings';

export class RiotApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'RiotApiError';
  }
}

// ─── Simple request queue ──────────────────────────────────────────────────
// The given personal-key rate limits (20 req/1s, 100 req/2min app-wide) are
// generous for this app's call volume (a handful of calls per finished match
// plus the occasional settings-panel verify) — a sequential queue with a
// fixed minimum gap between requests is enough, no token-bucket needed.

const MIN_GAP_MS = 60; // well under 1000ms / 20 = 50ms/request ceiling
let queueTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    const result = await fn();
    await new Promise(r => setTimeout(r, MIN_GAP_MS));
    return result;
  });
  // Swallow rejection on the shared tail so one failed call doesn't wedge
  // every call queued after it.
  queueTail = run.catch(() => undefined);
  return run;
}

async function riotFetch<T>(url: string, apiKey: string): Promise<T> {
  return enqueue(async () => {
    const res = await fetch(url, { headers: { 'X-Riot-Token': apiKey } });
    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      throw new RiotApiError(429, `rate limited, retry after ${retryAfter ?? '?'}s`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new RiotApiError(res.status, 'invalid or unauthorized Riot API key');
    }
    if (res.status === 404) {
      throw new RiotApiError(404, 'not found');
    }
    if (!res.ok) {
      throw new RiotApiError(res.status, `Riot API error ${res.status}`);
    }
    return res.json() as Promise<T>;
  });
}

// ─── account-v1 ──────────────────────────────────────────────────────────────

export async function getAccountByRiotId(
  gameName: string, tagLine: string, apiKey: string, continent: RiotContinent
): Promise<RiotAccount> {
  const url = `https://${continent}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  const data = await riotFetch<{ puuid: string; gameName: string; tagLine: string }>(url, apiKey);
  return { puuid: data.puuid, gameName: data.gameName, tagLine: data.tagLine };
}

// ─── tft-league-v1 ───────────────────────────────────────────────────────────

export async function getLeagueEntriesByPuuid(
  puuid: string, apiKey: string, platform: RiotPlatform
): Promise<RiotLeagueEntry[]> {
  const url = `https://${platform}.api.riotgames.com/tft/league/v1/by-puuid/${puuid}`;
  const data = await riotFetch<Array<{
    queueType: string; tier: string; rank: string;
    leaguePoints: number; wins: number; losses: number;
  }>>(url, apiKey);
  return data.map(e => ({
    queueType: e.queueType, tier: e.tier, rank: e.rank,
    leaguePoints: e.leaguePoints, wins: e.wins, losses: e.losses,
  }));
}

// Shared formatting so the settings-verify preview and the StatusBar readout
// never drift apart on what "ranked" queue type to prefer.
export function formatRiotRank(entries: RiotLeagueEntry[]): string {
  const ranked = entries.find(e => e.queueType.toLowerCase().includes('tft'));
  if (!ranked) return 'Unranked';
  return `${ranked.tier} ${ranked.rank} · ${ranked.leaguePoints} LP`;
}

// ─── tft-match-v1 ────────────────────────────────────────────────────────────
// Final-result only — placement, augments, final board. No round-by-round
// timeline. Used solely as a ground-truth cross-check on GEP's finalPlacement.

export async function getMatchIdsByPuuid(
  puuid: string, apiKey: string, continent: RiotContinent, count = 1
): Promise<string[]> {
  const url = `https://${continent}.api.riotgames.com/tft/match/v1/matches/by-puuid/${puuid}/ids?count=${count}`;
  return riotFetch<string[]>(url, apiKey);
}

export interface RiotMatchParticipant {
  puuid: string;
  placement: number;
}

export interface RiotMatch {
  info: {
    game_datetime: number; // epoch ms
    participants: RiotMatchParticipant[];
  };
}

export async function getMatchById(
  matchId: string, apiKey: string, continent: RiotContinent
): Promise<RiotMatch> {
  const url = `https://${continent}.api.riotgames.com/tft/match/v1/matches/${matchId}`;
  return riotFetch<RiotMatch>(url, apiKey);
}
