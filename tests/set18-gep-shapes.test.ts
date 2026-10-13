// Regression coverage for the first Set 18 matches, every one of which crashed
// the report pipeline with `TypeError: id.includes is not a function`.
//
// Set 18's GEP changed three things the ledger code assumed would never change:
//  - item_bench.bench_items elements went from id strings to one object per
//    stack, { name, count } (the crash);
//  - champion ids went from TFT17_Akali to DA_18_Akali_AD / DA_Gromp18_AP, so
//    detectSet() never matched and every match was coached from set 17 data;
//  - augment ids lost their `_Augment_` marker (DA_Kingslayer), so every pick
//    was filtered out.
//
// The payloads below are minimal hand-written copies of the real shapes
// (two recorded Set 18 matches, 2026-08-26 and 2026-08-31). The real ledgers
// are not committed: they carry other players' Riot IDs (see .gitignore).

import { describe, it, expect } from 'vitest';
import { reconstructSnapshots, benchItemIds } from '../src/ledger/rounds';
import { detectSet, loadMeta } from '../src/enrichment/meta-lookup';
import { extractDecisionPoints } from '../src/coach/rule-engine';
import { setIdFromChampionId } from '../src/shared/set-id';
import type { LedgerEntry } from '../src/shared/types';

let ts = 0;
const info = (feature: string, key: string, value: unknown): LedgerEntry =>
  ({ ts: ++ts, kind: 'info', feature, key, value });
const event = (name: string, data: unknown = {}): LedgerEntry =>
  ({ ts: ++ts, kind: 'event', name, data });

const unit = (name: string) => ({ name, level: '1', item_1: '', item_2: '', item_3: '' });

// One PVP round at 2-1 with the given item_bench and picked_augment payloads.
function oneRoundLedger(champions: string[], benchItems: unknown[], pickedAugment: Record<string, { name: string }>): LedgerEntry[] {
  return [
    info('match_info', 'game_mode', 'TFT'),
    info('roster', 'player_status', {
      Me:            { health: 100, xp: 4, localplayer: true },
      'Little Legend': { health: 100, xp: 4, localplayer: false },
    }),
    info('match_info', 'round_type', { stage: '2-1', type: 'PVP', native_name: 'PVP' }),
    event('round_start', { type: 'PVP' }),
    info('board', 'board_pieces', Object.fromEntries(champions.map((c, i) => [`cell_${i + 1}`, unit(c)]))),
    info('bench', 'item_bench', [
      { summoner: 'Little Legend', tag_line: '', bench_items: [{ name: 'DA_Component_ChainVest', count: 1 }] },
      { summoner: 'Me',            tag_line: '', bench_items: benchItems },
    ]),
    event('round_end'),
    info('me', 'picked_augment', pickedAugment),
  ];
}

const SET18_LEDGER = oneRoundLedger(
  ['DA_18_Akali_AD', 'DA_Gromp18_AP'],
  [
    { name: 'DA_Consumable_ItemRemover',     count: 4 },
    { name: 'DA_Component_TearOfTheGoddess', count: 2 },
    { name: 'DA_Component_BFSword',          count: 1 },
  ],
  {
    slot_1: { name: 'DA_Replication' },
    slot_2: { name: 'DA_Kingslayer' },
    slot_3: { name: 'DA_18_RiftbeastTraitAugment' },
    slot_4: { name: '' },
  },
);

describe('Set 18 GEP shapes', () => {
  it('reconstructs a Set 18 item_bench without throwing, one entry per item held', () => {
    const snapshot = reconstructSnapshots(SET18_LEDGER);
    expect(snapshot.rounds).toHaveLength(1);
    // count expands to copies; the consumable's 4 charges are filtered out;
    // the other player's bench is not ours.
    expect(snapshot.rounds[0].benchItems).toEqual([
      'DA_Component_TearOfTheGoddess',
      'DA_Component_TearOfTheGoddess',
      'DA_Component_BFSword',
    ]);
  });

  it('keeps Set 18 augments, which carry no _Augment_ marker', () => {
    const snapshot = reconstructSnapshots(SET18_LEDGER);
    expect(snapshot.augments).toEqual(['DA_Replication', 'DA_Kingslayer', 'DA_18_RiftbeastTraitAugment']);
    expect(snapshot.rounds[0].augmentsPicked).toEqual(['DA_Replication']); // slot_1 is picked at 2-1
  });

  it('labels the match set18 / tft', () => {
    const snapshot = reconstructSnapshots(SET18_LEDGER);
    expect(snapshot.setId).toBe('set18');
    expect(snapshot.gameMode).toBe('tft'); // GEP sends "TFT"
    expect(detectSet(SET18_LEDGER)).toBe('set18');
  });

  it('still reads the Set 17 shapes the same way', () => {
    const ledger = oneRoundLedger(
      ['TFT17_Ahri'],
      ['TFT_Item_BFSword', 'TFT_Item_BFSword', 'TFT_Consumable_ItemRemover'],
      {
        slot_1: { name: 'TFT_Augment_LateGameScaling' },
        slot_2: { name: 'TFT6_Augment_PandorasItems' },
        slot_3: { name: 'TFT_Augment_JustSlayer' },
        slot_4: { name: 'TFT17_ChampionItem_Chosen_Kindred' },
      },
    );
    const snapshot = reconstructSnapshots(ledger);
    expect(snapshot.rounds[0].benchItems).toEqual(['TFT_Item_BFSword', 'TFT_Item_BFSword']);
    expect(snapshot.augments).toEqual(['TFT_Augment_LateGameScaling', 'TFT6_Augment_PandorasItems', 'TFT_Augment_JustSlayer']);
    expect(snapshot.setId).toBe('set17');
    expect(detectSet(ledger)).toBe('set17');
  });
});

describe('benchItemIds', () => {
  it('normalises both element shapes to one id per item', () => {
    expect(benchItemIds('TFT_Item_BFSword')).toEqual(['TFT_Item_BFSword']);
    expect(benchItemIds({ name: 'DA_Component_BFSword', count: 3 })).toEqual(Array(3).fill('DA_Component_BFSword'));
    expect(benchItemIds({ name: 'DA_Component_BFSword' })).toEqual(['DA_Component_BFSword']);
  });

  it('drops elements that name no item rather than throwing', () => {
    expect(benchItemIds({ name: 'DA_Component_BFSword', count: 0 })).toEqual([]);
    expect(benchItemIds({ count: 2 })).toEqual([]);
    expect(benchItemIds('')).toEqual([]);
    expect(benchItemIds(null)).toEqual([]);
    expect(benchItemIds(42)).toEqual([]);
  });
});

describe('setIdFromChampionId', () => {
  it.each([
    ['TFT17_Ahri',        'set17'],
    ['DA_18_Akali_AD',    'set18'],
    ['DA_18_Sentry',      'set18'],
    ['DA_Gromp18_AP',     'set18'],
    ['DA_Taric18',        'set18'],
    ['TFT_Krug',          undefined], // PvE monster shared across sets
    ['DA_Component_BFSword', undefined],
    [undefined,           undefined],
  ])('%s -> %s', (id, expected) => {
    expect(setIdFromChampionId(id)).toBe(expected);
  });

  it('detectSet reports an unrecognised set as unknown, not set17', () => {
    expect(detectSet(oneRoundLedger(['TFT_Krug'], [], {}))).toBe('unknown');
  });
});

// set18 got its data/sets/ folder on 2026-10-13, so a set id with no folder
// stands in for the next set to roll in before anyone curates it.
const NO_FOLDER_SET = 'set99';

describe('loadMeta for a set with no data folder', () => {
  it('flags the meta instead of borrowing another set', async () => {
    const meta = await loadMeta(NO_FOLDER_SET);
    expect(meta.setDataMissing).toBe(true);
    expect(meta.champions).toEqual({});
    expect(Object.keys(meta.itemData).length).toBeGreaterThan(0); // core tables still load

    expect((await loadMeta('set17')).setDataMissing).toBeUndefined();
  });

  it('runs only the set-agnostic checkers on flagged meta', async () => {
    const snapshot = reconstructSnapshots(SET18_LEDGER);
    const meta = await loadMeta(NO_FOLDER_SET);
    // Two units priced at board.ts's default cost of 2 against the stage-2
    // benchmark of 12: BOARD_001 fires on empty tables...
    const ungated = extractDecisionPoints(snapshot, { ...meta, setDataMissing: undefined });
    expect(ungated.some(p => p.ruleId === 'BOARD_001')).toBe(true);
    // ...and must not when the tables are empty because the set has no data.
    const gated = extractDecisionPoints(snapshot, meta);
    expect(gated.some(p => p.ruleId === 'BOARD_001')).toBe(false);
  });
});
