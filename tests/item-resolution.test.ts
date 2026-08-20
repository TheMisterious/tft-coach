// Coverage for the GEP-id -> catalogue-id resolver (src/enrichment/meta-lookup.ts).
//
// Why this exists: measured 2026-08-07 against every ledger on disk, 18.1% of
// all equipped item instances resolved to NOTHING â€” artifacts, trait emblems,
// Radiant items, Ornn items and set-mechanic items whose GEP id never matched a
// catalogue key. Two consequences, both real and both user-visible: coaching
// text printed prettified asset paths ("ASSETS/Maps/TFT/Icons/... Rocket Swarm
// T1"), and every counting rule treated an unidentifiable id as a COMPLETED
// item, because `isComponent()` returns false for anything it has never heard
// of. Uses the real fetched catalogue, not mocks, so these break for real if
// the fetch or the resolver drifts.
import { describe, it, expect } from 'vitest';
import { resolveItemId, getItemName, getItemData, isNonItemId } from '../src/enrichment/meta-lookup';
import { isKnownItem, completedItems, unresolvedItems } from '../src/coach/checkers/items';
import type { MetaData, Cell } from '../src/shared/types';
import itemData from '../data/core/item-data.json';
import itemNames from '../data/core/items.json';
import itemAliases from '../data/core/item-aliases.json';

const meta = {
  itemData: itemData as unknown as MetaData['itemData'],
  items: itemNames as unknown as MetaData['items'],
  itemAliases: itemAliases as unknown as Record<string, string>,
} as MetaData;

const cell = (...items: string[]): Cell =>
  ({ name: 'TFT17_AurelionSol', level: 2, item_1: items[0], item_2: items[1], item_3: items[2] } as unknown as Cell);

describe('resolveItemId', () => {
  it('leaves an id that already matches the catalogue alone', () => {
    expect(resolveItemId('TFT_Item_JeweledGauntlet', meta)).toBe('TFT_Item_JeweledGauntlet');
  });

  it('rewrites a set-mechanic icon PATH into its catalogue key', () => {
    // Real GEP value, from a recorded match.
    const gep = 'ASSETS/Maps/TFT/Icons/Items/Hexcore/TFT17_AnimaSquadItem_RocketSwarm_T1';
    expect(resolveItemId(gep, meta)).toBe('TFT17_AnimaSquadItem_Tier1_RocketSwarm');
    expect(getItemName(gep, meta)).toBe('Rocket Swarm');
  });

  it('drops the .TFT_SetNN suffix GEP sometimes appends', () => {
    const withSuffix = 'ASSETS/Maps/TFT/Icons/Items/Hexcore/TFT17_PsyOps_Mod_TargetLockMod.TFT_Set17';
    expect(getItemData(withSuffix, meta)).toBeDefined();
  });

  it('follows a rename alias for an id that exists in no catalogue at all', () => {
    // GEP reports the CURRENT display name; Community Dragon still keys it by
    // the original apiName.
    expect(resolveItemId('TFT_Item_SpiritVisage', meta)).toBe('TFT_Item_Redemption');
    expect(getItemName('TFT_Item_SpiritVisage', meta)).toBe('Spirit Visage');
  });

  it('resolves a trait emblem, whose GEP id shares nothing with the catalogue id', () => {
    expect(getItemName('TFT17_Emblem_Meeple', meta)).toBe('Meeple Emblem');
  });

  it('resolves an emblem whose GEP id is the internal trait name, not the display one', () => {
    // Upstream: TFT17_Item_PsyOpsEmblemItem, display name "Psionic Emblem",
    // real trait TFT17_PsyOps = "Psionic". GEP writes the internal name.
    expect(getItemName('TFT17_Emblem_PsyOps', meta)).toBe('Psionic Emblem');
  });

  it('resolves an artifact Riot has renamed, via its champion segment', () => {
    // Upstream `TFT17_Item_Artifact_EvelynnArtifact` is now called "Evelynn's
    // Instinct"; GEP still reports the old name. Only the champion is stable,
    // and there is exactly one artifact per champion.
    expect(resolveItemId('TFT17_Item_Artifact_EvelynnFang', meta)).toBe('TFT17_Item_Artifact_EvelynnArtifact');
    expect(getItemData('TFT17_Item_Artifact_VarusObsession', meta)?.name).toBe('Varus\'s Obsession');
  });

  it('treats a placeholder catalogue entry as neither held nor unresolved', () => {
    // TFT_Item_EmptyBag is a real Set 17 entry whose upstream name is ''.
    expect(isNonItemId('TFT_Item_EmptyBag', meta)).toBe(true);
    const holder = cell('TFT_Item_JeweledGauntlet', 'TFT_Item_EmptyBag');
    expect(completedItems(holder, meta)).toEqual(['TFT_Item_JeweledGauntlet']);
    expect(unresolvedItems(holder, meta)).toEqual([]);
  });

  it('never lets an unresolved id reach coaching text as an asset path', () => {
    const bogus = 'ASSETS/Maps/TFT/Icons/TFT13/TFT13_GoopItem_Icon';
    const shown = getItemName(bogus, meta);
    expect(shown).not.toContain('ASSETS');
    expect(shown).not.toContain('/');
  });
});

describe('counting rules treat an unidentifiable id as unknown, not as a finished item', () => {
  it('counts the real 2026-08-07 carry loadout as three completed items', () => {
    // One ordinary item, one Ornn artifact, one set artifact — the loadout that
    // exposed all of this. Every id resolves now; before, only the first did.
    const carry = cell('TFT_Item_JeweledGauntlet', 'TFT9_Item_OrnnHorizonFocus', 'TFT17_Item_Artifact_VarusObsession');
    expect(completedItems(carry, meta)).toHaveLength(3);
    expect(unresolvedItems(carry, meta)).toEqual([]);
  });

  it('still reports an id that genuinely resolves to nothing', () => {
    // A Set 13 leftover: absent from Community Dragon and outside the Set 17
    // scope, so nothing can identify it and it must not pass as an item.
    const holder = cell('TFT_Item_JeweledGauntlet', 'ASSETS/Maps/TFT/Icons/TFT13/TFT13_GoopItem_Icon');
    expect(completedItems(holder, meta)).toEqual(['TFT_Item_JeweledGauntlet']);
    expect(unresolvedItems(holder, meta)).toHaveLength(1);
  });

  it('does not count a component as a completed item', () => {
    const holder = cell('TFT_Item_BFSword', 'TFT_Item_JeweledGauntlet');
    expect(completedItems(holder, meta)).toEqual(['TFT_Item_JeweledGauntlet']);
  });

  it('knows a real item and does not know a made-up one', () => {
    expect(isKnownItem('TFT_Item_RabadonsDeathcap', meta)).toBe(true);
    expect(isKnownItem('TFT_Item_ThisDoesNotExist', meta)).toBe(false);
  });
});
