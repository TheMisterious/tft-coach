// Set data derived from Riot's own match records (tft-match-v1): what top
// players actually build and play, in place of hand curation.
//
// Pure: takes already-fetched matches, returns the three things the app's set
// data was missing for Set 18 — every Set 18 champion was role "flex", and
// carry-bis.json and comps.json were empty, so carry detection, the
// "carry items on a tank" rule, positioning's frontline checks and reroll
// detection all had nothing to work with. scripts/fetch-riot-meta.ts does the
// fetching and writing.
//
// Riot's match records hold only each player's FINAL board (units, stars,
// items), placement, level and active traits. Nothing per round — so no gold
// curve, and econ-benchmarks.json cannot come from here.
//
// Every threshold below was fixed before running this on any real data.

import type { CarryBisEntry, CompArchetype } from '../../src/shared/types';

export interface RiotUnit { character_id: string; itemNames?: string[]; tier: number }
export interface RiotTrait { name: string; tier_current: number; num_units?: number }
export interface RiotParticipant {
  puuid?: string;
  placement: number;
  level: number;
  units: RiotUnit[];
  traits?: RiotTrait[];
}
export interface RiotMatchFull {
  metadata: { match_id: string };
  info: {
    tft_set_number?: number;
    game_version?: string;
    game_datetime?: number;
    participants: RiotParticipant[];
  };
}

export interface ChampionEntry { name: string; tier: number; role: string; traits: string[] }
export interface ItemEntry { name: string; isComponent: boolean; composition?: string[]; tags?: string[] }

export interface DeriveInput {
  matches: RiotMatchFull[];
  champions: Record<string, ChampionEntry>;
  itemData: Record<string, ItemEntry>;
  // Riot trait apiName -> display name (from Community Dragon), for key_traits.
  traitNames?: Record<string, string>;
  source: string; // e.g. "vn2 Challenger-Master, patches 18.4-18.5"
}

export type DerivedRole = 'carry' | 'tank' | 'flex';

export interface DeriveOutput {
  roles: Record<string, DerivedRole>;
  carryBis: Record<string, CarryBisEntry>;
  comps: CompArchetype[];
  stats: {
    matches: number;
    boards: number;
    topFourBoards: number;
    patches: string[];
    unmappedChampions: Record<string, number>;
    unknownItems: Record<string, number>;
    // Per champion: boards it appeared on, boards it held 2+ combat items on,
    // offensive and defensive item counts among those, and top-4 boards it
    // appeared on. The app reads appearances over boards as the unit's
    // prevalence (MetaData.metaUnits, src/enrichment/meta-lookup.ts).
    roleEvidence: Record<string, { appearances: number; itemized: number; offense: number; tank: number; topFour: number }>;
  };
}

// ─── Thresholds (fixed in advance) ──────────────────────────────────────────

// A champion needs this many board appearances before its role is read at all.
export const MIN_APPEARANCES = 25;
// Share of appearances carrying 2+ completed items, and the share of those
// items that are offensive (or defensive), to call a unit a carry (or tank).
export const CARRY_ITEMIZED = 0.30;
export const TANK_ITEMIZED = 0.20;
export const ROLE_ITEM_SHARE = 0.65;
// BiS needs this many top-4 boards with the unit holding a completed item.
export const MIN_BIS_BOARDS = 15;
// A reroll board: a cost 1-3 unit at 3 stars, holding 2+ completed items (it
// is the carry, not a 3-star that came along), on a board that stayed low —
// level at most cost + REROLL_LEVEL_OVER_COST (1-costs at 6, 2-costs at 7,
// 3-costs at 8). The first run counted every cheap 3-star in a top-4 board and
// produced 40 "reroll comps" with a median level of 8-9: late-game boards that
// happened to 3-star a 1-cost, which would have marked ordinary games as
// reroll and switched off the early-rolling advice in them.
export const MIN_REROLL_BOARDS = 8;
export const REROLL_MAX_COST = 3;
export const REROLL_LEVEL_OVER_COST = 5;
export const REROLL_MIN_ITEMS = 2;

// ─── Ids ────────────────────────────────────────────────────────────────────

export function championResolver(champions: Record<string, ChampionEntry>): (riotId: string) => string | undefined {
  const byLower = new Map(Object.keys(champions).map(k => [k.toLowerCase(), k]));
  return riotId => champions[riotId] ? riotId : byLower.get(riotId.toLowerCase());
}

// Radiant copies (from augments) count as the base item they upgrade.
export function itemResolver(itemData: Record<string, ItemEntry>): (riotId: string) => string | undefined {
  const byLower = new Map(Object.keys(itemData).map(k => [k.toLowerCase(), k]));
  return riotId => {
    const id = itemData[riotId] ? riotId : byLower.get(riotId.toLowerCase());
    if (!id) return undefined;
    const base = id.replace(/Radiant$/, '');
    return base !== id && itemData[base] ? base : id;
  };
}

// Set 18's DA_ items carry no offense/tank tags in the catalogue, but share a
// display name with an older, tagged copy (DA_InfinityEdge / TFT_Item_InfinityEdge,
// both "Infinity Edge"). Borrow the tags by name.
export function itemTagger(itemData: Record<string, ItemEntry>): (id: string) => string[] {
  const byName = new Map<string, string[]>();
  for (const item of Object.values(itemData)) {
    if (item.tags?.length && !byName.has(item.name)) byName.set(item.name, item.tags);
  }
  return id => {
    const item = itemData[id];
    if (!item) return [];
    return item.tags?.length ? item.tags : byName.get(item.name) ?? [];
  };
}

// Completed combat items only: components, emblems and consumables say
// nothing about what a unit is for.
function isCombatItem(item: ItemEntry | undefined): boolean {
  if (!item || item.isComponent) return false;
  return !/Emblem|Remover|Reforger|Duplicator|Magnetic|Consumable/i.test(item.name);
}

// ─── Derivation ─────────────────────────────────────────────────────────────

interface UnitTally {
  appearances: number;
  itemized: number;
  offense: number;
  tank: number;
  topFour: number;
  topFourItemCounts: Map<string, number>;
  topFourItemizedBoards: number;
}

export function deriveSetMeta(input: DeriveInput): DeriveOutput {
  const { matches, champions, itemData } = input;
  const champ = championResolver(champions);
  const item = itemResolver(itemData);
  const tags = itemTagger(itemData);

  const tallies = new Map<string, UnitTally>();
  const tally = (id: string) => {
    let t = tallies.get(id);
    if (!t) tallies.set(id, t = { appearances: 0, itemized: 0, offense: 0, tank: 0, topFour: 0, topFourItemCounts: new Map(), topFourItemizedBoards: 0 });
    return t;
  };
  const unmappedChampions: Record<string, number> = {};
  const unknownItems: Record<string, number> = {};
  const rerollBoards = new Map<string, Array<{ placement: number; level: number; traits: RiotTrait[] }>>();
  const patches = new Set<string>();
  let boards = 0;
  let topFourBoards = 0;

  for (const match of matches) {
    const patch = /(\d+\.\d+)/.exec(match.info.game_version ?? '')?.[1];
    if (patch) patches.add(patch);

    for (const p of match.info.participants) {
      boards++;
      const topFour = p.placement <= 4;
      if (topFour) topFourBoards++;

      for (const unit of p.units ?? []) {
        const id = champ(unit.character_id);
        if (!id) {
          unmappedChampions[unit.character_id] = (unmappedChampions[unit.character_id] ?? 0) + 1;
          continue;
        }
        const t = tally(id);
        t.appearances++;
        if (topFour) t.topFour++;

        const combat: string[] = [];
        for (const raw of unit.itemNames ?? []) {
          const itemId = item(raw);
          if (!itemId) { unknownItems[raw] = (unknownItems[raw] ?? 0) + 1; continue; }
          if (isCombatItem(itemData[itemId])) combat.push(itemId);
        }
        if (combat.length >= 2) {
          t.itemized++;
          for (const itemId of combat) {
            const itemTags = tags(itemId);
            if (itemTags.includes('offense')) t.offense++;
            if (itemTags.includes('tank')) t.tank++;
          }
        }
        if (topFour && combat.length > 0) {
          t.topFourItemizedBoards++;
          for (const itemId of new Set(combat)) t.topFourItemCounts.set(itemId, (t.topFourItemCounts.get(itemId) ?? 0) + 1);
        }

        const cost = champions[id]?.tier ?? 99;
        if (topFour && unit.tier >= 3 && cost <= REROLL_MAX_COST
            && p.level <= cost + REROLL_LEVEL_OVER_COST && combat.length >= REROLL_MIN_ITEMS) {
          const list = rerollBoards.get(id) ?? [];
          list.push({ placement: p.placement, level: p.level, traits: p.traits ?? [] });
          rerollBoards.set(id, list);
        }
      }
    }
  }

  // Roles
  const roles: Record<string, DerivedRole> = {};
  const roleEvidence: DeriveOutput['stats']['roleEvidence'] = {};
  for (const [id, t] of tallies) {
    roleEvidence[id] = { appearances: t.appearances, itemized: t.itemized, offense: t.offense, tank: t.tank, topFour: t.topFour };
    if (t.appearances < MIN_APPEARANCES) continue;
    const itemizedShare = t.itemized / t.appearances;
    const tagged = t.offense + t.tank;
    const offenseShare = tagged > 0 ? t.offense / tagged : 0;
    const tankShare = tagged > 0 ? t.tank / tagged : 0;
    roles[id] =
      itemizedShare >= CARRY_ITEMIZED && offenseShare >= ROLE_ITEM_SHARE ? 'carry' :
      itemizedShare >= TANK_ITEMIZED && tankShare >= ROLE_ITEM_SHARE ? 'tank' :
      'flex';
  }

  // Carry BiS
  const carryBis: Record<string, CarryBisEntry> = {};
  for (const [id, role] of Object.entries(roles)) {
    if (role !== 'carry') continue;
    const t = tallies.get(id)!;
    if (t.topFourItemizedBoards < MIN_BIS_BOARDS) continue;
    const ranked = [...t.topFourItemCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const bis = ranked.slice(0, 3).map(([itemId]) => itemId);
    const components = new Map<string, number>();
    for (const itemId of bis) for (const c of itemData[itemId]?.composition ?? []) components.set(c, (components.get(c) ?? 0) + 1);
    const share = (itemId: string) => Math.round(100 * (t.topFourItemCounts.get(itemId) ?? 0) / t.topFourItemizedBoards);
    carryBis[id] = {
      role: 'carry',
      items_bis: bis,
      items_alt: ranked.slice(3, 5).map(([itemId]) => itemId),
      components_priority: [...components].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([c]) => c),
      notes: `Most built on ${champions[id].name} in ${t.topFourItemizedBoards} top-4 boards (${input.source}): ` +
        bis.map(itemId => `${itemData[itemId]?.name ?? itemId} ${share(itemId)}%`).join(', ') + '.',
    };
  }

  // Reroll comps
  const comps: CompArchetype[] = [];
  for (const [id, list] of [...rerollBoards].sort((a, b) => b[1].length - a[1].length)) {
    if (list.length < MIN_REROLL_BOARDS) continue;
    const levels = list.map(b => b.level).sort((a, b) => a - b);
    const traitCounts = new Map<string, number>();
    for (const b of list) for (const t of b.traits) {
      if (t.tier_current > 0 && (t.num_units ?? 2) > 1) traitCounts.set(t.name, (traitCounts.get(t.name) ?? 0) + 1);
    }
    const keyTraits = [...traitCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2)
      .map(([t]) => input.traitNames?.[t] ?? t);
    const avg = list.reduce((n, b) => n + b.placement, 0) / list.length;
    comps.push({
      id: `${id}_reroll`,
      name: `${champions[id].name} reroll`,
      type: 'reroll',
      optimal_level: levels[Math.floor(levels.length / 2)],
      primary_carry_ids: [id],
      key_traits: keyTraits,
      notes: `${champions[id].name} 3-starred in ${list.length} top-4 boards, average placement ${avg.toFixed(1)} (${input.source}).`,
    });
  }

  // Forms Riot's records never name: Set 18 records every Lux element as
  // DA_Lux18_Base, so DA_18_Lux_Inferno never appears. Added after BiS, which
  // needs a tally of the unit's own.
  Object.assign(roles, variantRoles(champions, roles));

  return {
    roles, carryBis, comps,
    stats: { matches: matches.length, boards, topFourBoards, patches: [...patches].sort(), unmappedChampions, unknownItems, roleEvidence },
  };
}

// A champion named "<Base> (<form>)" — "Lux (Inferno)" — with no role of its
// own takes the carry/tank role of the one champion named exactly <Base>. It
// is the same unit in another form, not a judgement about it. Nothing is
// inherited when the base name is ambiguous or only reads as flex.
export function variantRoles(
  champions: Record<string, ChampionEntry>, roles: Record<string, DerivedRole>,
): Record<string, DerivedRole> {
  const idsByName = new Map<string, string[]>();
  for (const [id, c] of Object.entries(champions)) {
    if (c?.name) idsByName.set(c.name, [...(idsByName.get(c.name) ?? []), id]);
  }
  const inherited: Record<string, DerivedRole> = {};
  for (const [id, c] of Object.entries(champions)) {
    if (roles[id] || !c?.name) continue;
    const base = /^(.+) \([^)]+\)$/.exec(c.name)?.[1];
    const baseIds = base ? idsByName.get(base) : undefined;
    const baseRole = baseIds?.length === 1 ? roles[baseIds[0]] : undefined;
    if (baseRole && baseRole !== 'flex') inherited[id] = baseRole;
  }
  return inherited;
}
