// Loads hand-curated set-specific meta data from /data/sets/set{N}/*.json.
// All strategic knowledge lives in those JSON files — swapping sets requires
// only creating a new folder, never changing TypeScript code.

import type { AugmentEffect, LedgerEntry, MetaData, CarryBisEntry, TraitBreakpoint, EconBenchmark, ChampionMeta, AugmentModifiers, AugmentItemOverride, AugmentFrontlineExemption, CompArchetype, ItemData } from '../shared/types';
import { loadAggregateMetaTable } from '../persistence/meta-cache';
import { setIdFromChampionId, UNKNOWN_SET_ID } from '../shared/set-id';

const EMPTY_AUGMENT_MODIFIERS: AugmentModifiers = {
  itemBisOverrides: {},
  traitCountBonuses: {},
  frontlineExemptions: {},
};

// Detect which TFT set is active from the champion ids on the board (see
// shared/set-id.ts for the per-set id schemes). Returns UNKNOWN_SET_ID rather
// than guessing a set when no id says which one it is: the old 'set17'
// fallback is how every Set 18 match was silently coached from set 17 data.
export function detectSet(entries: LedgerEntry[]): string {
  for (const entry of entries) {
    if (entry.kind === 'info' && entry.feature === 'board' && entry.key === 'board_pieces') {
      const board = entry.value as Record<string, { name?: string }>;
      for (const cell of Object.values(board ?? {})) {
        const setId = setIdFromChampionId(cell?.name);
        if (setId) return setId;
      }
    }
  }
  console.warn('[meta] no champion id in this ledger names a set — set is unknown');
  return UNKNOWN_SET_ID;
}

// Load all meta JSON for a given set, plus core (set-agnostic) data.
//
// A set with no data/sets/<setId>/ folder (every new set until its folder is
// curated — set18 until 2026-10-13 — plus UNKNOWN_SET_ID) gets the core tables only, comes
// back flagged `setDataMissing`, and says so with a console.error. Decided
// 2026-10-13, against both alternatives:
//  - NOT another set's folder. Ids change scheme between sets (TFT17_Akali vs
//    DA_18_Akali_AD), so set 17's tables match nothing in a Set 18 ledger and
//    the checkers fill the gaps with defaults. Replaying a real Set 18 match
//    that way produced "Board cost sum at stage 2: ~10 (benchmark >=12)" from
//    a guessed cost of 2 per unit, stated as fact.
//  - NOT a throw. Econ, HP, leveling and streak coaching read no set table and
//    are as true in Set 18 as in 17, so the player still gets those. The rule
//    engine runs only those checkers on flagged meta (SET_AGNOSTIC_CHECKERS in
//    rule-engine.ts), and the report toast says the rest was skipped.
export async function loadMeta(setId: string): Promise<MetaData> {
  const setDataMissing = !(await hasSetData(setId));
  if (setDataMissing) {
    const why = setId === UNKNOWN_SET_ID
      ? 'no champion id in the ledger names a set'
      : `no data/sets/${setId}/ folder — curate one to coach this set fully`;
    console.error(`[meta] set-specific coaching is OFF for this match (econ/HP/leveling/streak only): ${why}`);
  }
  const meta = await loadMetaFiles(setId);
  return setDataMissing ? { ...meta, setDataMissing } : meta;
}

// Every set folder carries champions.json (tests/data-sets-schema.test.ts
// enforces it), so its absence means there is no folder for this set at all.
async function hasSetData(setId: string): Promise<boolean> {
  try {
    return (await fetch(`/data/sets/${setId}/champions.json`)).ok;
  } catch {
    return false;
  }
}

// Files are fetched relative to the app root. A missing set-specific file
// falls back to its empty table (see fetchJson).
async function loadMetaFiles(setId: string): Promise<MetaData> {
  const base = `/data/sets/${setId}`;
  console.log('[meta] loading set data from:', base);
  const [carryBis, traitBreakpoints, econBenchmarks, champions, items, itemData, itemAliases, augments, augmentNames, augmentModifiersRaw, comps, augmentUnitGrants, augmentEffects] = await Promise.all([
    fetchJson<Record<string, CarryBisEntry>>(`${base}/carry-bis.json`, {}),
    fetchJson<TraitBreakpoint[]>(`${base}/trait-breakpoints.json`, []),
    fetchJson<EconBenchmark[]>(`${base}/econ-benchmarks.json`, []),
    fetchJson<Record<string, ChampionMeta>>(`${base}/champions.json`, {}),
    fetchJson<Record<string, string>>(`/data/core/items.json`, {}),
    fetchJson<Record<string, ItemData>>(`/data/core/item-data.json`, {}),
    fetchJson<Record<string, string>>(`/data/core/item-aliases.json`, {}),
    fetchJson<Record<string, string[]>>(`${base}/augments.json`, {}),
    fetchJson<Record<string, string>>(`/data/core/augment-names.json`, {}),
    fetchJson<Partial<AugmentModifiers>>(`${base}/augment-modifiers.json`, {}),
    fetchJson<CompArchetype[]>(`${base}/comps.json`, []),
    fetchJson<Record<string, string>>(`${base}/augment-unit-grants.json`, {}),
    fetchJson<Record<string, AugmentEffect>>(`${base}/augment-effects.json`, {}),
  ]);
  // Merge over defaults — a set without an augment-modifiers.json file (or a
  // file missing a bucket) falls back to "no overrides" for that bucket rather
  // than crashing every checker that reads meta.augmentModifiers.*.
  const augmentModifiers: AugmentModifiers = { ...EMPTY_AUGMENT_MODIFIERS, ...augmentModifiersRaw };
  // Runtime-only, sourced from the user's own Riot-API-driven meta crawl
  // (src/enrichment/meta-crawler.ts), not a data/ file — undefined until a
  // Riot account is linked and a first crawl cycle completes. Read
  // synchronously/defensively (loadAggregateMetaTable already try/catches a
  // missing localStorage global, same as every other persistence accessor).
  const metaTierTable = loadAggregateMetaTable();
  console.log(`[meta] loaded — champions:${Object.keys(champions ?? {}).length} carryBis:${Object.keys(carryBis ?? {}).length} traits:${(traitBreakpoints as unknown[])?.length ?? 0} econBenchmarks:${(econBenchmarks as unknown[])?.length ?? 0} items:${Object.keys(items ?? {}).length} itemData:${Object.keys(itemData ?? {}).length} augments:${Object.keys(augments ?? {}).length} augmentNames:${Object.keys(augmentNames ?? {}).length} augmentModifiers:${Object.keys(augmentModifiers.itemBisOverrides).length} comps:${comps?.length ?? 0} augmentUnitGrants:${Object.keys(augmentUnitGrants ?? {}).length} augmentEffects:${Object.keys(augmentEffects ?? {}).length} metaTierTable:${metaTierTable ? metaTierTable.matchSampleCount : 'none'}`);
  return { carryBis, traitBreakpoints, econBenchmarks, champions, items, itemData, itemAliases, augments, augmentNames, augmentModifiers, comps, augmentUnitGrants, augmentEffects, metaTierTable };
}

// Friendly display name for a champion id (e.g. "TFT17_AurelionSol" -> "Aurelion Sol").
// Falls back to a humanized id when the champion isn't in champions.json yet.
export function getChampionName(championId: string, meta: MetaData): string {
  const known = meta.champions?.[championId]?.name;
  return known ?? humanize(championId, /^TFT\d+_/);
}

/**
 * Turns the id GEP reports into the id this project's data files are keyed by.
 *
 * Three real, separately-confirmed mismatches (2026-08-07, measured against
 * every ledger on disk — 18.1% of all equipped item instances resolved to
 * nothing before this existed):
 *
 *  1. Set-mechanic items arrive as an ICON PATH, not an id:
 *     `ASSETS/Maps/TFT/Icons/Items/Hexcore/TFT17_AnimaSquadItem_Annihilator_T2`
 *     for catalogue key `TFT17_AnimaSquadItem_Tier2_Annihilator`. Same rewrite
 *     the local combat-sim sandbox already proved out (964 recovered
 *     instances there): take the basename, drop the optional
 *     `.TFT_SetNN` suffix, move the `_T<N>` tier marker into Riot's `Tier<N>_`
 *     position. GEP genuinely writes `AnimSquadItem` without the "a" sometimes,
 *     and case drifts between sources, so both are handled rather than smoothed.
 *  2. Renamed items keep their old apiName upstream while GEP names them after
 *     the CURRENT display name — see data/core/item-aliases.json.
 *  3. Everything else already matches.
 *
 * Returns the input unchanged when nothing applies, so an unknown id stays
 * visible as itself rather than being silently rewritten into a wrong one.
 */
export function resolveItemId(itemId: string, meta: MetaData): string {
  if (!itemId) return itemId;
  if (meta.itemData?.[itemId] || meta.items?.[itemId]) return itemId;

  let candidate = itemId;
  if (candidate.includes('/')) {
    candidate = candidate.slice(candidate.lastIndexOf('/') + 1);
  }
  candidate = candidate.replace(/\.TFT_Set\d+$/i, '');
  // `TFT17_AnimaSquadItem_Annihilator_T2` -> `TFT17_AnimaSquadItem_Tier2_Annihilator`
  // Greedy on the family prefix: the tier marker goes after the item FAMILY,
  // not after the set number.
  const tiered = /^(.*)_([^_]+)_T(\d+)$/.exec(candidate);
  if (tiered) candidate = `${tiered[1]}_Tier${tiered[3]}_${tiered[2]}`;
  candidate = candidate.replace(/AnimSquadItem/i, 'AnimaSquadItem');
  // PsyOps mods use a different shape again: GEP writes
  // `TFT17_PsyOps_Mod_DroneMod`, the catalogue keys it `TFT17_Item_PsyOps_DroneMod`.
  // Same family, same trailing name — only the segment layout differs.
  candidate = candidate.replace(/^(TFT\d*)_PsyOps_Mod_/i, '$1_Item_PsyOps_');

  if (meta.itemData?.[candidate] || meta.items?.[candidate]) return candidate;

  // Case drifts between GEP and the catalogue (UwUBlaster/UwuBlaster,
  // TargetLockMod/TargetlockMod), so fall back to a case-insensitive match.
  const lower = candidate.toLowerCase();
  for (const key of Object.keys(meta.itemData ?? {})) {
    if (key.toLowerCase() === lower) return key;
  }

  const alias = meta.itemAliases?.[itemId] ?? meta.itemAliases?.[candidate];
  if (alias) return alias;

  // Artifacts: upstream keys them `..._Artifact_<Champion>Artifact` while GEP
  // names them after the display name, which Riot sometimes changes out from
  // under it (`..._Artifact_EvelynnFang` is upstream's "Evelynn's Instinct").
  // The champion segment is the stable part and there is exactly one artifact
  // per champion, so the prefix map generated at fetch time resolves it.
  const artifact = /^(TFT\d*_Item_Artifact_)([A-Z][a-z]+)/.exec(candidate);
  if (artifact) {
    const byPrefix = meta.itemAliases?._artifactPrefixes as unknown as Record<string, string> | undefined;
    const hit = byPrefix?.[artifact[1] + artifact[2]];
    if (hit) return hit;
  }

  return candidate;
}

/**
 * Ids that are real in the feed but are not equippable items at all, so they
 * must count as neither "held" nor "unresolved". `TFT_Item_EmptyBag` is a real
 * Set 17 catalogue entry whose upstream NAME is the empty string — the same
 * class of placeholder as `TFT_Item_Blank`, which the fetch already drops.
 */
const NON_ITEM_IDS = new Set(['TFT_Item_EmptyBag', 'TFT_Item_Blank']);

export function isNonItemId(itemId: string, meta: MetaData): boolean {
  return NON_ITEM_IDS.has(resolveItemId(itemId, meta));
}

/** The item's real catalogue entry, or undefined when nothing resolves it. */
export function getItemData(itemId: string, meta: MetaData): ItemData | undefined {
  return meta.itemData?.[resolveItemId(itemId, meta)];
}

// Friendly display name for an item id (e.g. "TFT_Item_RabadonsDeathcap" -> "Rabadons Deathcap").
// Falls back to a humanized id when the item isn't in data/core/items.json yet.
export function getItemName(itemId: string, meta: MetaData): string {
  const resolved = resolveItemId(itemId, meta);
  const known = meta.items?.[resolved] ?? meta.itemData?.[resolved]?.name;
  // An unresolved id must never reach coaching text as a prettified asset path
  // ("ASSETS/Maps/TFT/Icons/... Rocket Swarm T1" was really being shown). Say
  // it is unknown instead — that is honest and it is also a visible bug report.
  if (known) return known;
  return resolved.includes('/') ? 'an unknown item' : humanize(resolved, /^TFT\d*_(Item|Emblem)_/);
}

// Friendly display name for an augment id (e.g. "TFT_Augment_GoldReserve" -> "Gold Reserve").
// Prefers data/core/augment-names.json (auto-fetched via scripts/fetch-ddragon.js),
// falling back to a humanized id for augments not yet in that catalog.
export function getAugmentName(augmentId: string, meta?: MetaData): string {
  const known = meta?.augmentNames?.[augmentId];
  return known ?? humanize(augmentId, /^TFT_Augment_/);
}

function humanize(id: string, prefix: RegExp): string {
  return id
    .replace(prefix, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
}

// Look up a champion's BiS build. Returns null if champion isn't in the meta file.
export function getCarryBis(championId: string, meta: MetaData): CarryBisEntry | null {
  return meta.carryBis[championId] ?? null;
}

// If any picked augment upgrades itemId to BiS-equivalent, returns the override
// (with the reason to surface in coaching text). Otherwise null.
export function getAugmentItemOverride(
  itemId: string,
  pickedAugments: string[],
  meta: MetaData
): AugmentItemOverride | null {
  for (const aug of pickedAugments) {
    const override = meta.augmentModifiers?.itemBisOverrides?.[aug];
    if (override?.items.includes(itemId)) return override;
  }
  return null;
}

// Sum of extra effective trait count granted by picked augments for this trait.
// Lets checkers count "board units + augment bonus" instead of board units alone.
export function getAugmentTraitBonus(
  trait: string,
  pickedAugments: string[],
  meta: MetaData
): number {
  let bonus = 0;
  for (const aug of pickedAugments) {
    const entry = meta.augmentModifiers?.traitCountBonuses?.[aug];
    if (entry?.trait === trait) bonus += entry.bonus;
  }
  return bonus;
}

// If any picked augment substitutes for having a tank-role unit on board
// (e.g. a shield/damage-reduction augment), returns the exemption. Otherwise null.
export function getFrontlineExemption(
  pickedAugments: string[],
  meta: MetaData
): AugmentFrontlineExemption | null {
  for (const aug of pickedAugments) {
    const exemption = meta.augmentModifiers?.frontlineExemptions?.[aug];
    if (exemption) return exemption;
  }
  return null;
}

// Return active trait tiers for the given set of champion IDs on the board.
// Requires champions.json (trait membership) — kept in data/sets/set{N}/champions.json.
export async function getActiveTraits(
  setId: string,
  championIds: string[]
): Promise<Array<{ trait: string; count: number; activeTier: number; nextTier: number | null }>> {
  const champData = await fetchJson<Record<string, { traits: string[] }>>(
    `/data/sets/${setId}/champions.json`, {}
  );
  const traitCounts: Record<string, number> = {};

  for (const id of championIds) {
    const entry = champData[id];
    if (!entry) continue;
    for (const trait of entry.traits) {
      traitCounts[trait] = (traitCounts[trait] ?? 0) + 1;
    }
  }

  const breakpointData = await fetchJson<TraitBreakpoint[]>(
    `/data/sets/${setId}/trait-breakpoints.json`, []
  );
  const breakpointMap: Record<string, number[]> = {};
  for (const tb of breakpointData) breakpointMap[tb.trait] = tb.tiers;

  return Object.entries(traitCounts)
    .map(([trait, count]) => {
      const tiers      = breakpointMap[trait] ?? [];
      const activeTier = tiers.filter(t => count >= t).pop() ?? 0;
      const nextTier   = tiers.find(t => t > count) ?? null;
      return { trait, count, activeTier, nextTier };
    })
    .filter(t => t.activeTier > 0 || t.nextTier !== null);
}

// fallback must match T's shape ([] for array types, {} for record types) —
// previously this guessed via Array.isArray(undefined), which is always false,
// so every failed fetch silently returned {} even for array-typed meta files
// (traitBreakpoints, econBenchmarks, comps) and crashed the first .filter()/.find().
//
// A rejected fetch() gets the same fallback as a 404. Node's test polyfill
// answers a missing file with !ok, but a browser fetch rejects outright on a
// network-level failure, and nobody has checked which one Overwolf's
// extension scheme gives for a missing packaged file. Either way it is a
// missing table, and a missing table must not cost the player the report.
async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path);
  } catch (e) {
    console.warn(`[meta-lookup] could not load ${path}:`, e);
    return fallback;
  }
  if (!res.ok) {
    console.warn(`[meta-lookup] could not load ${path}: ${res.status}`);
    return fallback;
  }
  return res.json() as Promise<T>;
}
