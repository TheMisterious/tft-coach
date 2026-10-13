import { describe, it, expect } from 'vitest';
import { checkAugments } from '../src/coach/checkers/augments';
import type { MatchSnapshot, RoundSnapshot, MetaData, BoardState, ChampionMeta } from '../src/shared/types';
import itemData from '../data/core/item-data.json';

function makeRound(overrides: Partial<RoundSnapshot>): RoundSnapshot {
  return {
    label: '2-1',
    type: 'PVP',
    goldStart: 0,
    goldEnd: 0,
    health: 100,
    level: 4,
    rollsSpent: 0,
    xpBought: false,
    board: {},
    bench: {},
    benchItems: [],
    shop: [],
    augmentsPicked: [],
    opponentBoard: {},
    interestEarned: 0,
    streakCount: 0,
    streakType: 'none',
    ...overrides,
  };
}

function makeMatch(overrides: Partial<MatchSnapshot>): MatchSnapshot {
  return {
    pseudoMatchId: 'test-match',
    setId: 'set17',
    gameMode: 'tft',
    rounds: [makeRound({})],
    finalPlacement: 4,
    finalBoard: {},
    augments: [],
    godPicks: [],
    ...overrides,
  };
}

function makeMeta(overrides: Partial<MetaData> = {}): MetaData {
  return {
    carryBis: {},
    traitBreakpoints: [],
    econBenchmarks: [],
    champions: {},
    items: {},
    itemData: itemData as MetaData['itemData'],
    augments: { economy: [], combat: [], items: [], units: [] },
    augmentNames: {},
    augmentModifiers: { itemBisOverrides: {}, traitCountBonuses: {}, frontlineExemptions: {} },
    comps: [],
    ...overrides,
  };
}

function cell(name: string, items: string[] = []): BoardState[string] {
  return { name, level: 1, item_1: items[0] ?? '0', item_2: items[1] ?? '0', item_3: items[2] ?? '0' };
}

const NASUS: ChampionMeta = { name: 'Nasus', tier: 3, role: 'carry', traits: [] };

describe('AUGMENT_003 — carry augment payoff unrealised', () => {
  it('fires when the named champion never made the final board', () => {
    const meta = makeMeta({ champions: { TFT17_Nasus: NASUS } });
    const match = makeMatch({ augments: ['TFT17_Augment_NasusCarry'], finalBoard: {} });
    const points = checkAugments(match, meta);
    const hit = points.find(p => p.ruleId === 'AUGMENT_003');
    expect(hit).toBeTruthy();
    expect(hit!.observed).toContain('Nasus');
    expect(hit!.observed).toContain('not on the final board');
  });

  it('fires (minor) when the champion is on board but under-itemised', () => {
    const meta = makeMeta({ champions: { TFT17_Nasus: NASUS } });
    const match = makeMatch({
      augments: ['TFT17_Augment_NasusCarry'],
      finalBoard: { cell_1: cell('TFT17_Nasus', ['TFT_Item_BFSword']) },
    });
    const points = checkAugments(match, meta);
    const hit = points.find(p => p.ruleId === 'AUGMENT_003');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('minor');
  });

  it('does not fire when the champion is on board with 2+ completed items', () => {
    const meta = makeMeta({ champions: { TFT17_Nasus: NASUS } });
    const match = makeMatch({
      augments: ['TFT17_Augment_NasusCarry'],
      finalBoard: {
        cell_1: cell('TFT17_Nasus', ['TFT_Item_Bloodthirster', 'TFT_Item_GuinsoosRageblade', 'TFT_Item_TitansResolve']),
      },
    });
    const points = checkAugments(match, meta);
    expect(points.find(p => p.ruleId === 'AUGMENT_003')).toBeUndefined();
  });

  it('does not fire for augment ids that are not the "<Champion>Carry" shape and have no augmentUnitGrants entry', () => {
    const meta = makeMeta({ champions: { TFT17_Nasus: NASUS } });
    const match = makeMatch({ augments: ['TFT17_Augment_Arbiter_DivineAmendment'], finalBoard: {} });
    const points = checkAugments(match, meta);
    expect(points.find(p => p.ruleId === 'AUGMENT_003')).toBeUndefined();
  });

  // Real fix (2026-07-28): AUGMENT_003 used to only catch the narrow
  // "_Augment_<Name>Carry" id shape — ~20 of the real ~63 champion-granting
  // augments in augments.json's 'units' bucket. meta.augmentUnitGrants
  // (auto-fetched, scripts/fetch-ddragon.js) covers the rest via real Data
  // Dragon description text, e.g. "TFT17_Augment_Arbiter_DivineAmendment"
  // ("Gain a Leona...") doesn't match the id-shape regex at all.
  it('fires via augmentUnitGrants for a champion-granting augment that does not match the "Carry" id shape', () => {
    const meta = makeMeta({
      champions: { TFT17_Leona: { name: 'Leona', tier: 2, role: 'flex', traits: [] } },
      augmentUnitGrants: { TFT17_Augment_Arbiter_DivineAmendment: 'TFT17_Leona' },
    });
    const match = makeMatch({ augments: ['TFT17_Augment_Arbiter_DivineAmendment'], finalBoard: {} });
    const points = checkAugments(match, meta);
    const hit = points.find(p => p.ruleId === 'AUGMENT_003');
    expect(hit).toBeTruthy();
    expect(hit!.observed).toContain('Leona');
  });

  it('does not fire when the augmentUnitGrants-resolved champion is on board and itemised', () => {
    const meta = makeMeta({
      champions: { TFT17_Leona: { name: 'Leona', tier: 2, role: 'flex', traits: [] } },
      augmentUnitGrants: { TFT17_Augment_Arbiter_DivineAmendment: 'TFT17_Leona' },
    });
    const match = makeMatch({
      augments: ['TFT17_Augment_Arbiter_DivineAmendment'],
      finalBoard: { cell_1: cell('TFT17_Leona', ['TFT_Item_Bloodthirster', 'TFT_Item_WarmogsArmor']) },
    });
    const points = checkAugments(match, meta);
    expect(points.find(p => p.ruleId === 'AUGMENT_003')).toBeUndefined();
  });
});

describe('AUGMENT_004 — item-shaping augment without a built carry', () => {
  it('fires when an "items"-category augment was picked but no unit has 2+ completed items', () => {
    const meta = makeMeta({ augments: { economy: [], combat: [], items: ['TFT15_Augment_ChallengerCrest'], units: [] } });
    const match = makeMatch({
      augments: ['TFT15_Augment_ChallengerCrest'],
      finalBoard: { cell_1: cell('TFT17_Nasus', ['TFT_Item_BFSword']) },
    });
    const points = checkAugments(match, meta);
    const hit = points.find(p => p.ruleId === 'AUGMENT_004');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('moderate');
  });

  it('does not fire when some unit ended with 2+ completed items', () => {
    const meta = makeMeta({ augments: { economy: [], combat: [], items: ['TFT15_Augment_ChallengerCrest'], units: [] } });
    const match = makeMatch({
      augments: ['TFT15_Augment_ChallengerCrest'],
      finalBoard: { cell_1: cell('TFT17_Nasus', ['TFT_Item_Bloodthirster', 'TFT_Item_GuinsoosRageblade']) },
    });
    const points = checkAugments(match, meta);
    expect(points.find(p => p.ruleId === 'AUGMENT_004')).toBeUndefined();
  });

  it('does not fire when no items-category augment was picked', () => {
    const meta = makeMeta({ augments: { economy: [], combat: [], items: ['TFT15_Augment_ChallengerCrest'], units: [] } });
    const match = makeMatch({ augments: ['TFT_Augment_SomeOtherAugment'], finalBoard: {} });
    const points = checkAugments(match, meta);
    expect(points.find(p => p.ruleId === 'AUGMENT_004')).toBeUndefined();
  });
});

// ─── Derived augment effects (Phase 4, 2026-08-26) ───────────────────────────
// augments.json's hand-curated buckets only cover what someone got around to:
// 10 of the 22 augment ids picked across tests/goldens/ had no bucket at all,
// so AUGMENT_001 and AUGMENT_004 silently skipped them. augment-effects.json
// (scripts/derive-augment-effects.js) fills that in from real Data Dragon
// description text. These tests prove the fallback actually changes rule
// behaviour, rather than just sitting in MetaData.

describe('augment classification falls back to derived effects', () => {
  const crisisMatch = makeMatch({
    augments: ['TFT_Augment_ExplosiveGrowth'],
    rounds: [
      makeRound({ label: '3-1', health: 80, augmentsPicked: [] }),
      makeRound({ label: '3-2', health: 30, augmentsPicked: ['TFT_Augment_ExplosiveGrowth'] }),
    ],
  });

  it('AUGMENT_001 stays silent when nothing classifies the augment', () => {
    // The pre-Phase-4 state: uncurated, no derived data, rule can't evaluate it.
    const points = checkAugments(crisisMatch, makeMeta());
    expect(points.filter(p => p.ruleId === 'AUGMENT_001')).toEqual([]);
  });

  it('AUGMENT_001 fires on a derived economy augment that no bucket covers', () => {
    const meta = makeMeta({
      augmentEffects: { TFT_Augment_ExplosiveGrowth: { economy: 'XP' } },
    });
    const points = checkAugments(crisisMatch, meta);
    expect(points.filter(p => p.ruleId === 'AUGMENT_001').length).toBe(1);
  });

  it('hand curation still wins — a curated bucket alone is enough', () => {
    const meta = makeMeta({
      augments: { economy: ['TFT_Augment_ExplosiveGrowth'], combat: [], items: [], units: [] },
    });
    expect(checkAugments(crisisMatch, meta).filter(p => p.ruleId === 'AUGMENT_001').length).toBe(1);
  });

  it('AUGMENT_004 fires on a derived item augment that no bucket covers', () => {
    const match = makeMatch({
      augments: ['TFT9_Augment_BigGrabBag'],
      finalBoard: { cell_1: { name: 'TFT17_Jinx', level: 2, item_1: 'TFT_Item_BFSword', item_2: '0', item_3: '0' } } as unknown as BoardState,
    });
    const meta = makeMeta({
      augmentEffects: { TFT9_Augment_BigGrabBag: { economy: 'gold', items: 'Gain 3 random components' } },
    });
    expect(checkAugments(match, meta).filter(p => p.ruleId === 'AUGMENT_004').length).toBe(1);
  });

  it('never treats a Realm of the Gods blessing as a regular augment', () => {
    // God blessings ride the same picked_augment feed but are judged by
    // checkers/set17.ts from the match_info god_* fields. Feeding one to the
    // augment rules would produce advice about a pick the player never made in
    // the augment sense.
    const godMatch = makeMatch({
      augments: ['TFT17_Augment_SorakaGodAugment'],
      rounds: [
        makeRound({ label: '3-1', health: 80, augmentsPicked: [] }),
        makeRound({ label: '3-2', health: 30, augmentsPicked: ['TFT17_Augment_SorakaGodAugment'] }),
      ],
    });
    const meta = makeMeta({
      augmentEffects: { TFT17_Augment_SorakaGodAugment: { godAugment: true } },
    });
    const points = checkAugments(godMatch, meta);
    expect(points.filter(p => p.ruleId === 'AUGMENT_001')).toEqual([]);
    expect(points.filter(p => p.ruleId === 'AUGMENT_004')).toEqual([]);
  });

  it('AUGMENT_002 still reports a data gap when only blessings were captured', () => {
    // A match that recorded three god blessings and zero real augments has no
    // augment data at all, however full match.augments looks.
    const match = makeMatch({
      finalPlacement: 7,
      augments: ['TFT17_Augment_SorakaGodAugment', 'TFT17_Augment_ThreshGodAugment'],
    });
    const meta = makeMeta({
      augmentEffects: {
        TFT17_Augment_SorakaGodAugment: { godAugment: true },
        TFT17_Augment_ThreshGodAugment: { godAugment: true },
      },
    });
    expect(checkAugments(match, meta).filter(p => p.ruleId === 'AUGMENT_002').length).toBe(1);
  });
});
