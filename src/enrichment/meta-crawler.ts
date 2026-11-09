// Cross-player "current meta" crawler — pulls comp/champion/augment frequency
// and placement stats from many high-elo players via Riot's OFFICIAL
// league-v1 (Challenger/GM/Master leaderboards) + match-v1 APIs, under the
// user's own bring-your-own-key. Replaces the *purpose* of the unofficial,
// ToS-gray scripts/fetch-metatft.js (never wired into the app) with a
// legitimate, Riot-sanctioned data source — league-v1's leaderboard
// endpoints and match-v1 are explicitly designed for third-party tools to
// consume this way.
//
// Runs as small, bounded, resumable ticks (runMetaCrawlTick), never a single
// blocking crawl — see src/background/main.ts for the periodic driver. All
// network calls go through riot-api.ts's dedicated 1300ms-gap crawl queue
// (`'crawl'` RiotQueue), fully separate from the reactive per-match queue.

import type {
  MetaCrawlState, AggregateMetaTable, AggregateStatBucket, HarvestedParticipant, MetaData,
} from '../shared/types';
import type { RiotPlatform } from '../persistence/settings';
import { matchContinentForPlatform } from '../persistence/settings';
import {
  getChallengerLeague, getGrandmasterLeague, getMasterLeague,
  getMatchIdsByPuuid, getMatchById, riotUnitsToBoardState,
} from './riot-api';
import { computeActiveTraitSet, traitSetKey } from '../coach/match-context';
import { EMPTY_CRAWL_STATE } from '../persistence/meta-cache';

// A Riot API key and the platform to crawl. Not the app's settings: the app no
// longer holds a key (Riot sign-in, see src/persistence/settings.ts), so this
// only runs where one exists — a backend job, or a developer's machine.
export interface CrawlCredentials {
  riotApiKey: string;
  platform: RiotPlatform;
}

const MAX_SEEDS = 200;               // bounds total crawl duration per cycle
const SEED_STALE_MS = 24 * 60 * 60 * 1000; // refresh the top-player list at most once/day
const TICK_SIZE = 10;                // seed players advanced per call — keeps one tick fast

async function refreshSeedList(state: MetaCrawlState, settings: CrawlCredentials): Promise<MetaCrawlState> {
  try {
    const [challenger, grandmaster, master] = await Promise.all([
      getChallengerLeague(settings.riotApiKey, settings.platform),
      getGrandmasterLeague(settings.riotApiKey, settings.platform),
      getMasterLeague(settings.riotApiKey, settings.platform),
    ]);
    const seedPuuids = [...challenger, ...grandmaster, ...master]
      .sort((a, b) => b.leaguePoints - a.leaguePoints)
      .slice(0, MAX_SEEDS)
      .map(e => e.puuid);
    return { ...state, seedPuuids, cursor: 0, seedFetchedAt: Date.now(), seenMatchIds: [], accumulator: [] };
  } catch (e) {
    console.warn('[meta-crawler] failed to refresh top-player seed list, will retry next tick:', e);
    return state;
  }
}

// One bounded chunk of crawl work: refreshes the seed list if stale, then
// advances TICK_SIZE seed players' worth of match pulls. Returns the updated
// state to persist, plus a freshly-finalized `table` only on the tick where a
// full cycle through the seed list completes.
export async function runMetaCrawlTick(
  state: MetaCrawlState,
  settings: CrawlCredentials,
  meta: MetaData
): Promise<{ state: MetaCrawlState; table?: AggregateMetaTable }> {
  if (!settings.riotApiKey) return { state };

  let next = state;
  const seedStale = next.seedPuuids.length === 0 || (Date.now() - next.seedFetchedAt) > SEED_STALE_MS;
  if (seedStale) next = await refreshSeedList(next, settings);
  if (next.seedPuuids.length === 0) return { state: next }; // league fetch failed/empty — try again next tick

  const continent = matchContinentForPlatform(settings.platform);
  const batch = next.seedPuuids.slice(next.cursor, next.cursor + TICK_SIZE);
  const accumulator = [...next.accumulator];
  const seenMatchIds = [...next.seenMatchIds];

  for (const puuid of batch) {
    try {
      const ids = await getMatchIdsByPuuid(puuid, settings.riotApiKey, continent, 1, 'crawl');
      const matchId = ids[0];
      if (!matchId || seenMatchIds.includes(matchId)) continue;
      seenMatchIds.push(matchId);

      // One fetch harvests ALL participants in the match, not just the seed
      // player — top players share lobbies constantly, so this multiplies
      // sample yield roughly 8x per API call versus one-call-per-player.
      const match = await getMatchById(matchId, settings.riotApiKey, continent, 'crawl');
      for (const participant of match.info.participants) {
        const board = riotUnitsToBoardState(participant.units);
        accumulator.push({
          matchId,
          placement: participant.placement,
          championIds: participant.units.map(u => u.character_id),
          traitKey: traitSetKey(computeActiveTraitSet(board, meta)),
          augmentIds: participant.augments ?? [],
        });
      }
    } catch (e) {
      // One bad seed (stale puuid, transient error) shouldn't abort the tick.
      console.warn('[meta-crawler] skipping a seed puuid after an error:', e);
    }
  }

  const cursor = next.cursor + batch.length;
  next = { ...next, cursor, accumulator, seenMatchIds };

  if (cursor >= next.seedPuuids.length) {
    // Full cycle through the seed list — finalize this cycle's table and
    // reset harvesting state for the next pass (seedPuuids/seedFetchedAt are
    // kept — the same top players will have new matches to harvest next
    // cycle; the seed list itself only refreshes when stale, above).
    const table = computeAggregateTable(accumulator);
    return { state: { ...next, cursor: 0, seenMatchIds: [], accumulator: [] }, table };
  }

  return { state: next };
}

function bucketFrom(placements: number[]): AggregateStatBucket {
  const samples = placements.length;
  const avgPlacement = samples > 0 ? placements.reduce((a, b) => a + b, 0) / samples : 0;
  const top4Rate = samples > 0 ? placements.filter(p => p <= 4).length / samples : 0;
  return { samples, avgPlacement, top4Rate };
}

// Pure aggregation — no network, fully unit-testable against synthetic
// HarvestedParticipant records (see tests/meta-crawler.test.ts).
export function computeAggregateTable(records: HarvestedParticipant[]): AggregateMetaTable {
  const champPlacements: Record<string, number[]> = {};
  const traitPlacements: Record<string, number[]> = {};
  const augPlacements: Record<string, number[]> = {};
  const matchIds = new Set<string>();

  for (const r of records) {
    matchIds.add(r.matchId);
    for (const champId of r.championIds) (champPlacements[champId] ??= []).push(r.placement);
    (traitPlacements[r.traitKey] ??= []).push(r.placement);
    for (const augId of r.augmentIds) (augPlacements[augId] ??= []).push(r.placement);
  }

  const toBucketMap = (m: Record<string, number[]>): Record<string, AggregateStatBucket> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, bucketFrom(v)]));

  return {
    champions: toBucketMap(champPlacements),
    traitCombos: toBucketMap(traitPlacements),
    augments: toBucketMap(augPlacements),
    computedAt: Date.now(),
    matchSampleCount: matchIds.size,
  };
}
