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

import type { RiotAccount, RiotLeagueEntry, BoardState } from '../shared/types';
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

// Confirmed live (2026-07-12) against 4 real VN2 matches: character_id uses
// the same TFT{N}_<Champion> ids GEP does, itemNames uses the same
// TFT_Item_*/TFT{N}_Item_* ids GEP does (no separate id space to map) —
// e.g. { character_id: "TFT17_Samira", itemNames: ["TFT_Item_InfinityEdge",
// "TFT_Item_LastWhisper", "TFT_Item_SpearOfShojin"], tier: 3 }. `tier` is
// star level (1/2/3), matching Cell.level's real meaning — NOT player level
// (that's participant.level, a sibling field, separately confirmed present).
// No cell/position field exists in this API at all — final board only, same
// limitation already documented for placement/augments (see file header).
export interface RiotMatchUnit {
  character_id: string;
  itemNames: string[];
  tier: number;
}

export interface RiotMatchParticipant {
  puuid: string;
  placement: number;
  units: RiotMatchUnit[];
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

// Converts Riot's final-board units into this app's BoardState shape so it
// can be dropped straight into MatchSnapshot.finalBoard as a ground-truth
// override — see runRiotEnrichment in src/background/main.ts. Cell keys are
// synthetic (riot_0, riot_1, ...) since Riot's API has no position data;
// every finalBoard consumer (AUGMENT_003/004's item counts, brief-builder's
// final-comp display) only reads Object.values(), never real cell ids.
export function riotUnitsToBoardState(units: RiotMatchUnit[]): BoardState {
  const board: BoardState = {};
  units.forEach((u, i) => {
    board[`riot_${i}`] = {
      name:   u.character_id,
      level:  u.tier,
      item_1: u.itemNames[0] ?? '0',
      item_2: u.itemNames[1] ?? '0',
      item_3: u.itemNames[2] ?? '0',
    };
  });
  return board;
}

// Total equipped item slots across a board — shared comparison metric used
// to decide whether Riot's board is meaningfully more complete than GEP's.
export function countBoardItems(board: BoardState): number {
  return Object.values(board).reduce(
    (n, c) => n + [c.item_1, c.item_2, c.item_3].filter(i => i && i !== '0').length,
    0
  );
}
