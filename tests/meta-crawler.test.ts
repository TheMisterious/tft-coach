// Unit coverage for src/enrichment/meta-crawler.ts. No real network calls —
// riot-api.ts's network-calling functions are mocked (vi.mock), consistent
// with this project's existing convention of never hitting real Riot/GEP/
// HTTP endpoints in tests. computeAggregateTable (pure, no network) is
// tested directly against synthetic data.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MetaData, HarvestedParticipant, ChampionMeta, TraitBreakpoint } from '../src/shared/types';
import type { RiotSettings } from '../src/persistence/settings';
import { EMPTY_CRAWL_STATE } from '../src/persistence/meta-cache';

vi.mock('../src/enrichment/riot-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/enrichment/riot-api')>();
  return {
    ...actual, // keep riotUnitsToBoardState/countBoardItems real (pure, no network)
    getChallengerLeague: vi.fn(),
    getGrandmasterLeague: vi.fn(),
    getMasterLeague: vi.fn(),
    getMatchIdsByPuuid: vi.fn(),
    getMatchById: vi.fn(),
  };
});

import { runMetaCrawlTick, computeAggregateTable } from '../src/enrichment/meta-crawler';
import {
  getChallengerLeague, getGrandmasterLeague, getMasterLeague, getMatchIdsByPuuid, getMatchById,
} from '../src/enrichment/riot-api';

function makeSettings(overrides: Partial<RiotSettings> = {}): RiotSettings {
  return {
    riotApiKey: 'RGAPI-test',
    platform: 'na1',
    gameName: 'Test',
    tagLine: 'NA1',
    puuid: 'local-puuid',
    ...overrides,
  };
}

const CHAMPIONS: Record<string, ChampionMeta> = {
  TFT17_Alpha: { name: 'Alpha', tier: 1, role: 'carry', traits: ['TraitA'] },
  TFT17_Beta:  { name: 'Beta',  tier: 1, role: 'flex',  traits: ['TraitA'] },
};
const TRAIT_BREAKPOINTS: TraitBreakpoint[] = [{ trait: 'TraitA', tiers: [2] }];

function makeMeta(overrides: Partial<MetaData> = {}): MetaData {
  return {
    carryBis: {}, traitBreakpoints: TRAIT_BREAKPOINTS, econBenchmarks: {} as never,
    champions: CHAMPIONS, items: {}, itemData: {}, augments: {}, augmentNames: {},
    augmentModifiers: { itemBisOverrides: {}, traitCountBonuses: {}, frontlineExemptions: {} },
    comps: [],
    ...overrides,
  } as MetaData;
}

function mockMatch(participants: Array<{ puuid: string; placement: number; augments?: string[] }>) {
  return {
    info: {
      game_datetime: Date.now(),
      participants: participants.map(p => ({
        puuid: p.puuid,
        placement: p.placement,
        units: [{ character_id: 'TFT17_Alpha', itemNames: [], tier: 1 }, { character_id: 'TFT17_Beta', itemNames: [], tier: 1 }],
        augments: p.augments ?? [],
      })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runMetaCrawlTick', () => {
  it('no-ops when the Riot account is not linked', async () => {
    const settings = makeSettings({ puuid: undefined });
    const result = await runMetaCrawlTick(EMPTY_CRAWL_STATE, settings, makeMeta());
    expect(result.state).toEqual(EMPTY_CRAWL_STATE);
    expect(getChallengerLeague).not.toHaveBeenCalled();
  });

  it('refreshes an empty seed list before pulling matches', async () => {
    vi.mocked(getChallengerLeague).mockResolvedValue([{ puuid: 'p1', leaguePoints: 1000 }]);
    vi.mocked(getGrandmasterLeague).mockResolvedValue([{ puuid: 'p2', leaguePoints: 900 }]);
    vi.mocked(getMasterLeague).mockResolvedValue([{ puuid: 'p3', leaguePoints: 800 }]);
    vi.mocked(getMatchIdsByPuuid).mockResolvedValue(['MATCH_1']);
    vi.mocked(getMatchById).mockResolvedValue(mockMatch([{ puuid: 'p1', placement: 1 }]) as never);

    const result = await runMetaCrawlTick(EMPTY_CRAWL_STATE, makeSettings(), makeMeta());

    expect(result.state.seedPuuids.sort()).toEqual(['p1', 'p2', 'p3'].sort());
    expect(result.state.seedFetchedAt).toBeGreaterThan(0);
    // All 3 seeds fit in one tick (TICK_SIZE=10) -> cycle completes -> table finalized.
    expect(result.table).toBeDefined();
    expect(result.state.cursor).toBe(0); // reset after finalizing
  });

  it('dedupes a match id shared across multiple seed players in the same tick', async () => {
    const state = { ...EMPTY_CRAWL_STATE, seedPuuids: ['p1', 'p2'], seedFetchedAt: Date.now() };
    vi.mocked(getMatchIdsByPuuid).mockResolvedValue(['SHARED_MATCH']);
    vi.mocked(getMatchById).mockResolvedValue(
      mockMatch([{ puuid: 'p1', placement: 1 }, { puuid: 'p2', placement: 2 }]) as never
    );

    const result = await runMetaCrawlTick(state, makeSettings(), makeMeta());

    // getMatchById should only be called once even though both seeds resolve to the same match id.
    expect(getMatchById).toHaveBeenCalledTimes(1);
    // 2 participants harvested from that one match, not 4.
    expect(result.table?.matchSampleCount).toBe(1);
  });

  it('keeps seedPuuids/seedFetchedAt across a finalized cycle so the next cycle reuses them', async () => {
    const seedFetchedAt = Date.now();
    const state = { ...EMPTY_CRAWL_STATE, seedPuuids: ['p1'], seedFetchedAt };
    vi.mocked(getMatchIdsByPuuid).mockResolvedValue(['M1']);
    vi.mocked(getMatchById).mockResolvedValue(mockMatch([{ puuid: 'p1', placement: 3 }]) as never);

    const result = await runMetaCrawlTick(state, makeSettings(), makeMeta());

    expect(result.state.seedPuuids).toEqual(['p1']);
    expect(result.state.seedFetchedAt).toBe(seedFetchedAt);
    expect(result.state.seenMatchIds).toEqual([]); // reset for the next cycle
    expect(result.state.accumulator).toEqual([]);  // reset for the next cycle
  });

  it('a single bad seed does not abort the whole tick', async () => {
    const state = { ...EMPTY_CRAWL_STATE, seedPuuids: ['bad', 'good'], seedFetchedAt: Date.now() };
    vi.mocked(getMatchIdsByPuuid).mockImplementation(async (puuid: string) => {
      if (puuid === 'bad') throw new Error('simulated 404');
      return ['GOOD_MATCH'];
    });
    vi.mocked(getMatchById).mockResolvedValue(mockMatch([{ puuid: 'good', placement: 5 }]) as never);

    const result = await runMetaCrawlTick(state, makeSettings(), makeMeta());
    expect(result.table?.matchSampleCount).toBe(1);
  });
});

describe('computeAggregateTable', () => {
  function record(overrides: Partial<HarvestedParticipant>): HarvestedParticipant {
    return { matchId: 'm', placement: 4, championIds: [], traitKey: '', augmentIds: [], ...overrides };
  }

  it('computes samples/avgPlacement/top4Rate per champion, trait key, and augment', () => {
    const records: HarvestedParticipant[] = [
      record({ matchId: 'm1', placement: 1, championIds: ['A'], traitKey: 'X', augmentIds: ['Aug1'] }),
      record({ matchId: 'm2', placement: 5, championIds: ['A'], traitKey: 'X', augmentIds: ['Aug1'] }),
    ];
    const table = computeAggregateTable(records);

    expect(table.champions.A).toEqual({ samples: 2, avgPlacement: 3, top4Rate: 0.5 });
    expect(table.traitCombos.X).toEqual({ samples: 2, avgPlacement: 3, top4Rate: 0.5 });
    expect(table.augments.Aug1).toEqual({ samples: 2, avgPlacement: 3, top4Rate: 0.5 });
  });

  it('counts matchSampleCount as unique match ids, not participant count', () => {
    const records: HarvestedParticipant[] = [
      record({ matchId: 'm1', championIds: ['A'] }),
      record({ matchId: 'm1', championIds: ['B'] }), // same match, 2nd participant
      record({ matchId: 'm2', championIds: ['A'] }),
    ];
    const table = computeAggregateTable(records);
    expect(table.matchSampleCount).toBe(2);
  });

  it('returns empty buckets for no records', () => {
    const table = computeAggregateTable([]);
    expect(table.champions).toEqual({});
    expect(table.traitCombos).toEqual({});
    expect(table.augments).toEqual({});
    expect(table.matchSampleCount).toBe(0);
  });
});
