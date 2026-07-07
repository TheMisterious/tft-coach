// Loads hand-curated set-specific meta data from /data/sets/set{N}/*.json.
// All strategic knowledge lives in those JSON files — swapping sets requires
// only creating a new folder, never changing TypeScript code.

import type { LedgerEntry, MetaData, CarryBisEntry, TraitBreakpoint, EconBenchmark, ChampionMeta, AugmentModifiers, AugmentItemOverride, AugmentFrontlineExemption, CompArchetype } from '../shared/types';

const EMPTY_AUGMENT_MODIFIERS: AugmentModifiers = {
  itemBisOverrides: {},
  traitCountBonuses: {},
  frontlineExemptions: {},
};

// Detect which TFT set is active by reading TFT{N}_ champion name prefixes.
export function detectSet(entries: LedgerEntry[]): string {
  for (const entry of entries) {
    if (entry.kind === 'info' && entry.feature === 'board' && entry.key === 'board_pieces') {
      const board = entry.value as Record<string, { name?: string }>;
      for (const cell of Object.values(board)) {
        const m = (cell?.name ?? '').match(/^TFT(\d+)_/);
        if (m) return `set${m[1]}`;
      }
    }
  }
  return 'set17'; // fallback
}

// Load all meta JSON for a given set, plus core (set-agnostic) data.
// Files are fetched relative to the app root.
export async function loadMeta(setId: string): Promise<MetaData> {
  const base = `/data/sets/${setId}`;
  console.log('[meta] loading set data from:', base);
  const [carryBis, traitBreakpoints, econBenchmarks, champions, items, augments, augmentNames, augmentModifiersRaw, comps] = await Promise.all([
    fetchJson<Record<string, CarryBisEntry>>(`${base}/carry-bis.json`, {}),
    fetchJson<TraitBreakpoint[]>(`${base}/trait-breakpoints.json`, []),
    fetchJson<EconBenchmark[]>(`${base}/econ-benchmarks.json`, []),
    fetchJson<Record<string, ChampionMeta>>(`${base}/champions.json`, {}),
    fetchJson<Record<string, string>>(`/data/core/items.json`, {}),
    fetchJson<Record<string, string[]>>(`${base}/augments.json`, {}),
    fetchJson<Record<string, string>>(`/data/core/augment-names.json`, {}),
    fetchJson<Partial<AugmentModifiers>>(`${base}/augment-modifiers.json`, {}),
    fetchJson<CompArchetype[]>(`${base}/comps.json`, []),
  ]);
  // Merge over defaults — a set without an augment-modifiers.json file (or a
  // file missing a bucket) falls back to "no overrides" for that bucket rather
  // than crashing every checker that reads meta.augmentModifiers.*.
  const augmentModifiers: AugmentModifiers = { ...EMPTY_AUGMENT_MODIFIERS, ...augmentModifiersRaw };
  console.log(`[meta] loaded — champions:${Object.keys(champions ?? {}).length} carryBis:${Object.keys(carryBis ?? {}).length} traits:${(traitBreakpoints as unknown[])?.length ?? 0} econBenchmarks:${(econBenchmarks as unknown[])?.length ?? 0} items:${Object.keys(items ?? {}).length} augments:${Object.keys(augments ?? {}).length} augmentNames:${Object.keys(augmentNames ?? {}).length} augmentModifiers:${Object.keys(augmentModifiers.itemBisOverrides).length} comps:${comps?.length ?? 0}`);
  return { carryBis, traitBreakpoints, econBenchmarks, champions, items, augments, augmentNames, augmentModifiers, comps };
}

// Friendly display name for a champion id (e.g. "TFT17_AurelionSol" -> "Aurelion Sol").
// Falls back to a humanized id when the champion isn't in champions.json yet.
export function getChampionName(championId: string, meta: MetaData): string {
  const known = meta.champions?.[championId]?.name;
  return known ?? humanize(championId, /^TFT\d+_/);
}

// Friendly display name for an item id (e.g. "TFT_Item_RabadonsDeathcap" -> "Rabadons Deathcap").
// Falls back to a humanized id when the item isn't in data/core/items.json yet.
export function getItemName(itemId: string, meta: MetaData): string {
  const known = meta.items?.[itemId];
  return known ?? humanize(itemId, /^TFT_Item_/);
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
async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    console.warn(`[meta-lookup] could not load ${path}: ${res.status}`);
    return fallback;
  }
  return res.json() as Promise<T>;
}
