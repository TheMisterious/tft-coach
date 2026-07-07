// ITEM_001: Delayed item slam — 2+ components on bench for 2+ stages
// ITEM_002: Carry items on tank units (requires champion role data)
// ITEM_003: Under-itemised carry at stage 4 (<2 completed items)
// ITEM_004: Items spread across 4+ units with no unit holding 2+

import type { MatchSnapshot, DecisionPoint, RoundSnapshot, MetaData, Cell } from '../../shared/types';
import { getChampionName, getItemName, getAugmentItemOverride } from '../../enrichment/meta-lookup';

function byHp(hp: number, t: { low: string; mid: string; high: string }): string {
  if (hp <= 40) return t.low;
  if (hp >= 70) return t.high;
  return t.mid;
}
import { boardItemIds } from '../../ledger/merge';

const COMPONENT_IDS = new Set([
  'TFT_Item_BFSword', 'TFT_Item_ChainVest', 'TFT_Item_GiantsBelt',
  'TFT_Item_NeedlesslyLargeRod', 'TFT_Item_NegatronCloak', 'TFT_Item_RecurveBow',
  'TFT_Item_SparringGloves', 'TFT_Item_Spatula', 'TFT_Item_TearoftheGoddess',
]);

// Items whose primary purpose is damage/offense.
const DAMAGE_ITEM_PREFIXES = [
  'TFT_Item_InfinityEdge', 'TFT_Item_GuinsoosRageblade', 'TFT_Item_JeweledGauntlet',
  'TFT_Item_GiantSlayer', 'TFT_Item_Deathblade', 'TFT_Item_Bloodthirster',
  'TFT_Item_HandOfJustice', 'TFT_Item_BlueBuff', 'TFT_Item_NashorsTooth',
  'TFT_Item_RabadonsDeathcap', 'TFT_Item_SpearOfShojin', 'TFT_Item_ArchangelsStaff',
  'TFT_Item_RunaansHurricane', 'TFT_Item_LastWhisper',
];
const DAMAGE_ITEMS = new Set(DAMAGE_ITEM_PREFIXES);

function isDamageItem(id: string): boolean {
  return DAMAGE_ITEMS.has(id);
}

function unitItems(cell: Cell): string[] {
  return [cell.item_1, cell.item_2, cell.item_3].filter(i => i && i !== '0');
}

function identifyCarry(units: Cell[]): Cell {
  return units.reduce((best, u) => {
    const uItems = unitItems(u).length;
    const bItems = unitItems(best).length;
    if (u.level > best.level) return u;
    if (u.level === best.level && uItems > bItems) return u;
    return best;
  });
}

export function checkItems(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  return [
    ...checkSlamTiming(match),
    ...checkCarryItemsOnTank(match, meta),
    ...checkUnderItemisedCarry(match, meta),
    ...checkItemSpread(match),
    ...checkOffBisCarry(match, meta),
  ];
}

// ITEM_001 — components held for 3+ consecutive rounds (was 2-stage threshold)
function checkSlamTiming(match: MatchSnapshot): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  let consecutiveHolding = 0;

  for (const round of match.rounds) {
    const [stageStr] = round.label.split('-');
    if (Number(stageStr) < 2) continue;

    const benchComps = boardItemIds(round.bench).filter(id => COMPONENT_IDS.has(id));
    if (benchComps.length >= 2) {
      consecutiveHolding++;
      if (consecutiveHolding === 3) {
        points.push({
          ruleId:   'ITEM_001',
          round:    round.label,
          category: 'items',
          severity: 'moderate',
          observed: `${benchComps.length} unbuilt component(s) held for 3+ consecutive rounds`,
          recommended: 'Slam components into serviceable items — any completed item outperforms raw components on the bench',
          reasonMetrics: { components: benchComps.length, consecutiveRounds: consecutiveHolding },
          coaching_text: `You kept ${benchComps.length} unbuilt components on your bench for at least 3 rounds in a row. Every fight you played with those components unslammed was a fight where your board was weaker than it needed to be. Slam items on any reasonable holder — even an off-BiS completed item provides more combat power than components waiting for the "perfect" recipient.`,
        });
      }
    } else {
      consecutiveHolding = 0;
    }
  }
  return points;
}

// ITEM_002 — damage items on tank-role units
function checkCarryItemsOnTank(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  const lastRound = match.rounds.at(-1);
  if (!lastRound) return [];

  for (const [, cell] of Object.entries(lastRound.board)) {
    if (!cell?.name || cell.name === '0') continue;
    const champMeta = meta.champions[cell.name];
    if (!champMeta || champMeta.role !== 'tank') continue;

    const damageItems = unitItems(cell).filter(isDamageItem);
    if (damageItems.length < 2) continue;
    const damageItemNames = damageItems.map(id => getItemName(id, meta));

    points.push({
      ruleId:   'ITEM_002',
      round:    lastRound.label,
      category: 'items',
      severity: 'moderate',
      observed: `Tank unit ${champMeta.name} is holding ${damageItems.length} damage item(s): ${damageItemNames.join(', ')}`,
      recommended: `Move damage items to a carry unit — ${champMeta.name} benefits from defensive items instead`,
      reasonMetrics: { unit: champMeta.name, damageItemCount: damageItems.length },
      coaching_text: `${champMeta.name} is a tank-role unit but finished the game holding ${damageItems.length} damage items. Damage items on tanks provide almost no value — the unit does not have the attack speed, ability power, or crit interactions to leverage them. Those items on a carry unit would multiply damage output significantly.`,
    });
  }
  return points;
}

// ITEM_003 — carry has <2 completed items at round 4-1
function checkUnderItemisedCarry(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const r41 = match.rounds.find(r => r.label === '4-1');
  if (!r41) return [];

  const units = Object.values(r41.board).filter(c => c?.name && c.name !== '0');
  if (units.length === 0) return [];

  const carry      = identifyCarry(units);
  const carryName  = getChampionName(carry.name, meta);
  const itemCount  = unitItems(carry).filter(id => !COMPONENT_IDS.has(id)).length;
  if (itemCount >= 2) return [];

  return [{
    ruleId:   'ITEM_003',
    round:    '4-1',
    category: 'items',
    severity: 'critical',
    observed: `Main carry ${carryName} had only ${itemCount} completed item(s) at stage 4 entry`,
    recommended: 'Two God rounds have occurred by 4-1 — your carry should have at least 2 completed items',
    reasonMetrics: { carry: carryName, itemCount },
    coaching_text: byHp(r41.health, {
      low:  `${carryName} entered stage 4 with only ${itemCount} completed item(s) — and you're already at ${r41.health} HP. This is the worst combination: a weak board AND a low-HP position. Every fight from here where your carry underperforms accelerates elimination. Slam any available components immediately onto ${carryName}, even off-BiS items.`,
      mid:  `Your carry (${carryName}) entered stage 4 with only ${itemCount} item(s) at ${r41.health} HP. Two component rounds have already occurred — the carry should have at least 2 completed items by now. An under-itemised carry in stage 4 dramatically reduces your win rate and HP stability.`,
      high: `${carryName} entered stage 4 with only ${itemCount} completed item(s). You're at ${r41.health} HP so you have room to recover, but the itemisation gap is still costing you — a fully-itemised carry would close out fights faster and preserve that health lead into the late game.`,
    }),
  }];
}

// ITEM_004 — items spread across 4+ units at stage 4 with no unit holding 2+
function checkItemSpread(match: MatchSnapshot): DecisionPoint[] {
  const r42 = match.rounds.find(r => r.label === '4-2');
  if (!r42) return [];

  const units = Object.values(r42.board).filter(c => c?.name && c.name !== '0');
  const itemCounts = units.map(u => unitItems(u).filter(id => !COMPONENT_IDS.has(id)).length);
  const unitsWithItems = itemCounts.filter(n => n >= 1).length;
  const maxItems       = Math.max(0, ...itemCounts);

  if (unitsWithItems < 4 || maxItems >= 2) return [];

  return [{
    ruleId:   'ITEM_004',
    round:    '4-2',
    category: 'items',
    severity: 'minor',
    observed: `Items spread across ${unitsWithItems} units at 4-2 — no unit holds 2+ items`,
    recommended: 'Concentrate 2–3 items on your primary carry for multiplicative stat interactions',
    reasonMetrics: { unitsWithItems, maxItems },
    coaching_text: `At round 4-2 you had items spread across ${unitsWithItems} different units with none holding more than ${maxItems}. Item multiplicative interactions (crit + IE + JG, AP + Rabadons + JG) require concentration on one unit. One fully-itemised carry almost always outperforms four units with one item each.`,
  }];
}

// Off-BiS carry detection (existing logic, migrated here)
function checkOffBisCarry(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const lastRound = match.rounds.at(-1);
  if (!lastRound) return [];

  const units = Object.values(lastRound.board).filter(c => c?.name && c.name !== '0');
  if (units.length === 0) return [];

  const carry     = identifyCarry(units);
  const carryName = getChampionName(carry.name, meta);
  const bisEntry  = meta.carryBis[carry.name];
  if (!bisEntry) return [];

  const actual  = unitItems(carry).filter(id => !COMPONENT_IDS.has(id));
  if (actual.length < 3) return [];

  const bisSet  = new Set(bisEntry.items_bis);
  const altSet  = new Set(bisEntry.items_alt);
  const rawOffBis = actual.filter(i => !bisSet.has(i) && !altSet.has(i));
  if (rawOffBis.length === 0) return [];

  // An augment picked this match (e.g. Deadlier Blades → Deathblade) can make an
  // otherwise off-BiS item a legitimate choice. Don't penalise those — they aren't
  // mistakes, they're a different correct build for this specific match.
  const excused: string[] = [];
  const offBis = rawOffBis.filter(id => {
    const override = getAugmentItemOverride(id, match.augments, meta);
    if (override) { excused.push(id); return false; }
    return true;
  });
  if (offBis.length === 0) return [];

  const offBisNames = offBis.map(id => getItemName(id, meta));
  const bisNames    = bisEntry.items_bis.map(id => getItemName(id, meta));
  const excusedNote = excused.length > 0
    ? ` (${excused.map(id => getItemName(id, meta)).join(', ')} is/are fine this match — an augment you picked upgrades it.)`
    : '';

  return [{
    ruleId:   'ITEM_005',
    round:    lastRound.label,
    category: 'items',
    severity: 'moderate',
    observed: `${carryName} finished with ${offBis.length} off-BiS item(s): ${offBisNames.join(', ')}`,
    recommended: `BiS for ${carryName}: ${bisNames.join(', ')}`,
    reasonMetrics: { carry: carryName, offBisCount: offBis.length },
    coaching_text: `Your final ${carryName} carried ${offBis.length} item(s) outside its optimal build. The BiS is ${bisNames.join(', ')}. Off-BiS items don't synergise with the kit, which reduces damage output in the fights that decide final placement.${excusedNote}`,
  }];
}
