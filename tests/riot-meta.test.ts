// Set 18 data derived from Riot match records (scripts/riot-meta/derive.ts),
// on synthetic matches built from the real Set 18 champion and item ids.

import { describe, it, expect } from 'vitest';
import champions from '../data/sets/set18/champions.json';
import itemData from '../data/core/item-data.json';
import {
  deriveSetMeta, itemTagger, itemResolver, championResolver,
  MIN_APPEARANCES, MIN_REROLL_BOARDS, type RiotMatchFull, type RiotParticipant, type ChampionEntry, type ItemEntry,
} from '../scripts/riot-meta/derive';

const CHAMPS = champions as unknown as Record<string, ChampionEntry>;
const ITEMS = itemData as unknown as Record<string, ItemEntry>;

const CARRY = 'DA_18_Ezreal';      // a 4-cost
const TANK  = 'DA_Sentinel18';     // a 4-cost
const REROLL = 'DA_18_Xayah';      // a 1-cost
const FILLER = 'DA_18_Ornn';

function board(placement: number, over: Partial<RiotParticipant> = {}): RiotParticipant {
  return {
    placement,
    level: 8,
    units: [
      { character_id: CARRY, tier: 2, itemNames: ['DA_InfinityEdge', 'DA_GiantSlayer', 'DA_Bloodthirster'] },
      { character_id: TANK, tier: 2, itemNames: ['DA_WarmogsArmor', 'DA_GargoyleStoneplate'] },
      { character_id: FILLER, tier: 1, itemNames: [] },
    ],
    traits: [{ name: 'DA_18_Slayer', tier_current: 1, num_units: 2 }],
    ...over,
  };
}

function matchesOf(n: number, make: (i: number) => RiotParticipant[]): RiotMatchFull[] {
  return Array.from({ length: n }, (_, i) => ({
    metadata: { match_id: `VN2_${i}` },
    info: { tft_set_number: 18, game_version: 'Version 18.5.123.456', participants: make(i) },
  }));
}

describe('id and tag resolution', () => {
  it('borrows offense/tank tags for Set 18 items from their older, tagged namesakes', () => {
    const tags = itemTagger(ITEMS);
    expect(tags('DA_InfinityEdge')).toContain('offense');
    expect(tags('DA_WarmogsArmor')).toContain('tank');
  });

  it('counts a Radiant item as its base item, and maps ids case-insensitively', () => {
    const item = itemResolver(ITEMS);
    expect(item('DA_InfinityEdgeRadiant')).toBe('DA_InfinityEdge');
    expect(championResolver(CHAMPS)(CARRY.toLowerCase())).toBe(CARRY);
  });
});

describe('deriveSetMeta', () => {
  const matches = matchesOf(MIN_APPEARANCES, () => [board(1), board(3), board(6)]);
  const out = deriveSetMeta({ matches, champions: CHAMPS, itemData: ITEMS, source: 'test' });

  it('reads roles from what top players put on each unit', () => {
    expect(out.roles[CARRY]).toBe('carry');
    expect(out.roles[TANK]).toBe('tank');
    expect(out.roles[FILLER]).toBe('flex');
  });

  it('builds BiS for carries from top-4 boards only, with components and shares', () => {
    const bis = out.carryBis[CARRY];
    expect(bis.items_bis.sort()).toEqual(['DA_Bloodthirster', 'DA_GiantSlayer', 'DA_InfinityEdge']);
    expect(bis.components_priority[0]).toBe('DA_Component_BFSword');
    expect(bis.notes).toMatch(/top-4 boards/);
    expect(out.carryBis[TANK]).toBeUndefined();
  });

  it('leaves a champion with too few appearances out of the role table', () => {
    const few = deriveSetMeta({ matches: matchesOf(3, () => [board(1)]), champions: CHAMPS, itemData: ITEMS, source: 'test' });
    expect(few.roles[CARRY]).toBeUndefined();
  });

  it('finds a reroll comp from cheap units 3-starred in top-4 boards', () => {
    const rerollBoard = (placement: number) => board(placement, {
      level: 6,
      units: [{ character_id: REROLL, tier: 3, itemNames: ['DA_InfinityEdge', 'DA_GiantSlayer'] }, { character_id: FILLER, tier: 2 }],
    });
    const rr = deriveSetMeta({
      matches: matchesOf(MIN_REROLL_BOARDS, () => [rerollBoard(2), rerollBoard(7)]),
      champions: CHAMPS, itemData: ITEMS, traitNames: { DA_18_Slayer: 'Ravager' }, source: 'test',
    });
    const comp = rr.comps.find(c => c.primary_carry_ids[0] === REROLL)!;
    expect(comp.type).toBe('reroll');
    expect(comp.optimal_level).toBe(6);
    expect(comp.key_traits).toEqual(['Ravager']);
    expect(comp.notes).toContain(`3-starred in ${MIN_REROLL_BOARDS} top-4 boards`);
  });

  it('does not call a late-game board that happened to 3-star a cheap unit a reroll comp', () => {
    const lateBoard = (placement: number) => board(placement, {
      level: 9,
      units: [{ character_id: REROLL, tier: 3, itemNames: ['DA_InfinityEdge', 'DA_GiantSlayer'] }],
    });
    const fillerThreeStar = (placement: number) => board(placement, {
      level: 6,
      units: [{ character_id: REROLL, tier: 3, itemNames: [] }],
    });
    const out = deriveSetMeta({
      matches: matchesOf(MIN_REROLL_BOARDS, () => [lateBoard(1), fillerThreeStar(2)]),
      champions: CHAMPS, itemData: ITEMS, source: 'test',
    });
    expect(out.comps).toEqual([]);
  });

  it('reports ids it could not map instead of dropping them silently', () => {
    const odd = deriveSetMeta({
      matches: matchesOf(1, () => [board(1, { units: [{ character_id: 'TFT18_Mystery', tier: 1, itemNames: ['DA_NotAnItem'] }] })]),
      champions: CHAMPS, itemData: ITEMS, source: 'test',
    });
    expect(odd.stats.unmappedChampions).toEqual({ TFT18_Mystery: 1 });
    expect(odd.stats.patches).toEqual(['18.5']);
  });
});
