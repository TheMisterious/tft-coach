// Unit coverage for src/ledger/merge.ts's identifyCarry — previously had zero
// dedicated tests. Added after a real match report misidentified a 5-cost
// Jhin (briefly on board, uncurated role:'flex') as "the carry" over a
// 3-cost Samira the player was actually rerolling and playing all game
// (also uncurated role:'flex') — the old cost-first fallback had no way to
// tell a one-off pickup from the unit the player actually committed to.

import { describe, it, expect } from 'vitest';
import { identifyCarry } from '../src/ledger/merge';
import type { Cell, MetaData, ChampionMeta } from '../src/shared/types';

function cell(name: string, overrides: Partial<Cell> = {}): Cell {
  return { name, level: 1, item_1: '0', item_2: '0', item_3: '0', ...overrides };
}

function makeMeta(champions: Record<string, ChampionMeta>): MetaData {
  return {
    carryBis: {},
    traitBreakpoints: [],
    econBenchmarks: [],
    champions,
    items: {},
    itemData: {},
    augments: {},
    augmentNames: {},
    augmentModifiers: { itemBisOverrides: {}, traitCountBonuses: {}, frontlineExemptions: {} },
    comps: [],
  };
}

describe('identifyCarry', () => {
  it('prefers a curated role:carry tag over everything else', () => {
    const meta = makeMeta({
      TFT17_Tagged: { name: 'Tagged', tier: 2, role: 'carry', traits: [] },
      TFT17_Pricier: { name: 'Pricier', tier: 5, role: 'flex', traits: [] },
    });
    const units = [cell('TFT17_Pricier'), cell('TFT17_Tagged')];
    expect(identifyCarry(units, meta).name).toBe('TFT17_Tagged');
  });

  it('regression: a unit committed to across the match (activeComp) beats a pricier one-off pickup when neither has curated role data', () => {
    const meta = makeMeta({
      TFT17_Samira: { name: 'Samira', tier: 3, role: 'flex', traits: [] },
      TFT17_Jhin:   { name: 'Jhin',   tier: 5, role: 'flex', traits: [] },
    });
    const units = [cell('TFT17_Jhin'), cell('TFT17_Samira')];
    const activeComp = new Set(['TFT17_Samira']); // the unit actually played all game

    expect(identifyCarry(units, meta, activeComp).name).toBe('TFT17_Samira');
    // Without the activeComp signal, the old cost-first fallback picked the
    // 5-cost Jhin purely because 5 > 3 — confirm that's still the fallback
    // when no activeComp signal is available at all (no regression there).
    expect(identifyCarry(units, meta).name).toBe('TFT17_Jhin');
  });

  it('falls back to cost when neither unit is in the active comp', () => {
    const meta = makeMeta({
      TFT17_A: { name: 'A', tier: 2, role: 'flex', traits: [] },
      TFT17_B: { name: 'B', tier: 4, role: 'flex', traits: [] },
    });
    const units = [cell('TFT17_A'), cell('TFT17_B')];
    const activeComp = new Set(['TFT17_Someone_Else']);
    expect(identifyCarry(units, meta, activeComp).name).toBe('TFT17_B');
  });

  it('breaks ties within the active comp by item count, then star level', () => {
    const meta = makeMeta({
      TFT17_A: { name: 'A', tier: 3, role: 'flex', traits: [] },
      TFT17_B: { name: 'B', tier: 3, role: 'flex', traits: [] },
    });
    const activeComp = new Set(['TFT17_A', 'TFT17_B']);
    const units = [
      cell('TFT17_A', { item_1: 'TFT_Item_BFSword' }),
      cell('TFT17_B'),
    ];
    expect(identifyCarry(units, meta, activeComp).name).toBe('TFT17_A');
  });

  it('regression: real commitment (activeComp) beats a stale role:carry tag on a different unit — Akali reroll misread as "Caitlyn carry"', () => {
    // Real bug: Caitlyn is one of the original hand-curated champions and IS
    // tagged role:'carry' (a true general fact — she's a real carry in some
    // comps), but this match's board was an Akali reroll (role:'flex',
    // uncurated). The old logic picked Caitlyn outright because the
    // tagged-carry branch short-circuited before activeComp was checked.
    const meta = makeMeta({
      TFT17_Caitlyn: { name: 'Caitlyn', tier: 1, role: 'carry', traits: ['N.O.V.A.', 'Fateweaver'] },
      TFT17_Akali:   { name: 'Akali',   tier: 2, role: 'flex',  traits: ['N.O.V.A.', 'Marauder'] },
    });
    const units = [cell('TFT17_Caitlyn'), cell('TFT17_Akali')];
    const activeComp = new Set(['TFT17_Akali']); // the unit actually rerolled and played all game

    expect(identifyCarry(units, meta, activeComp).name).toBe('TFT17_Akali');
    // Without an activeComp signal at all, the tagged carry is still the
    // right fallback (no real match evidence to contradict it with).
    expect(identifyCarry(units, meta).name).toBe('TFT17_Caitlyn');
  });

  it('prefers a unit that is both tagged carry AND committed over a committed-only unit', () => {
    const meta = makeMeta({
      TFT17_TaggedCommitted: { name: 'TaggedCommitted', tier: 2, role: 'carry', traits: [] },
      TFT17_CommittedOnly:   { name: 'CommittedOnly',   tier: 4, role: 'flex',  traits: [] },
    });
    const units = [cell('TFT17_TaggedCommitted'), cell('TFT17_CommittedOnly')];
    const activeComp = new Set(['TFT17_TaggedCommitted', 'TFT17_CommittedOnly']);
    expect(identifyCarry(units, meta, activeComp).name).toBe('TFT17_TaggedCommitted');
  });

  it('regression: real damage beats cost when two committed units both carry the curated role:carry tag — Aurelion Sol misread as carry over a Zoe/Viktor Mecha reroll', () => {
    // Real bug: Viktor (tier 3) AND Aurelion Sol (tier 4) are both curated
    // role:'carry' (a true general fact about each kit) and both rode along
    // on board >50% of PvP rounds (shared Mecha/Conduit traits), so both
    // landed in the tagged-AND-committed pool together. The pool's final
    // tiebreak used to be cost-first, so Aurelion Sol (tier 4 > tier 3) won
    // outright even though he never received an item all game and Viktor was
    // the one actually dealing damage.
    const meta = makeMeta({
      TFT17_Viktor:      { name: 'Viktor',      tier: 3, role: 'carry', traits: ['Psionic', 'Conduit'] },
      TFT17_AurelionSol: { name: 'AurelionSol', tier: 4, role: 'carry', traits: ['Mecha', 'Conduit'] },
    });
    const units = [cell('TFT17_AurelionSol'), cell('TFT17_Viktor', { item_1: 'TFT_Item_BFSword' })];
    const activeComp = new Set(['TFT17_Viktor', 'TFT17_AurelionSol']);
    const carryDamage = new Map([['TFT17_Viktor', 4200], ['TFT17_AurelionSol', 300]]);

    expect(identifyCarry(units, meta, activeComp, carryDamage).name).toBe('TFT17_Viktor');
    // Without real damage evidence, cost is still the documented fallback —
    // confirms this is additive, not a behavior change for existing callers.
    expect(identifyCarry(units, meta, activeComp).name).toBe('TFT17_AurelionSol');
  });

  it('regression: a unit that just joined via a mid-match comp pivot wins on damage once activeComp (windowed) includes her — Nami misread as flex behind Riven/Tahm Kench', () => {
    // Real bug (same match, two separate reports): a pivot at 4-1 brought in
    // Nami as the actual carry. She went on to outdamage everyone else on
    // the team by a 3x+ margin, but match-context.ts's old computeActiveComp
    // measured her board presence against the *whole* match's PvP round
    // count — a bar she could never clear having joined partway through, so
    // she was excluded from the committed pool entirely and lost to
    // whichever pre-existing unit won the cost/item fallback (Riven at 4-1,
    // Tahm Kench in later combat checks). This test passes activeComp
    // exactly as match-context.ts's fixed, windowed computeActiveComp would
    // now compute it for that scenario (Nami counted as committed).
    const meta = makeMeta({
      TFT17_Nami:      { name: 'Nami',      tier: 4, role: 'flex', traits: ['Space Groove', 'Replicator'] },
      TFT17_Riven:     { name: 'Riven',     tier: 4, role: 'flex', traits: ['Timebreaker', 'Rogue'] },
      TFT17_TahmKench: { name: 'TahmKench', tier: 4, role: 'flex', traits: ['Oracle', 'Brawler'] },
    });
    const units = [
      cell('TFT17_Nami'),
      cell('TFT17_Riven', { item_1: 'TFT_Item_BFSword' }),
      cell('TFT17_TahmKench', { item_1: 'TFT_Item_WarmogsArmor', item_2: 'TFT_Item_GargoyleStoneplate' }),
    ];
    const activeComp = new Set(['TFT17_Nami', 'TFT17_Riven', 'TFT17_TahmKench']);
    const carryDamage = new Map([
      ['TFT17_Nami', 97547],
      ['TFT17_Riven', 33363],
      ['TFT17_TahmKench', 11040],
    ]);

    expect(identifyCarry(units, meta, activeComp, carryDamage).name).toBe('TFT17_Nami');
  });
});
