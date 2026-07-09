// ITEM_001: Delayed item slam — 2+ components on bench for 3+ consecutive rounds
// ITEM_002: Carry items on tank units (requires champion role data)
// ITEM_003: Under-itemised carry at stage 4 (<2 completed items)
// ITEM_004: Items spread across 4+ units with no unit holding 2+
// ITEM_005: A real, buildable completed item was left as unbuilt components
//           for 3+ consecutive rounds — see data/core/item-data.json

import type { MatchSnapshot, DecisionPoint, MetaData, MatchContext, Cell, ItemData } from '../../shared/types';
import { getChampionName, getItemName } from '../../enrichment/meta-lookup';
import { NEUTRAL_CONTEXT } from '../match-context';
import { boardItemIds, identifyCarry } from '../../ledger/merge';

function byHp(hp: number, t: { low: string; mid: string; high: string }): string {
  if (hp <= 40) return t.low;
  if (hp >= 70) return t.high;
  return t.mid;
}

function isComponent(id: string, meta: MetaData): boolean {
  return !!meta.itemData[id]?.isComponent;
}

function isOffenseItem(id: string, meta: MetaData): boolean {
  return !!meta.itemData[id]?.tags.includes('offense');
}

function unitItems(cell: Cell): string[] {
  return [cell.item_1, cell.item_2, cell.item_3].filter(i => i && i !== '0');
}

export function checkItems(match: MatchSnapshot, meta: MetaData, context: MatchContext = NEUTRAL_CONTEXT): DecisionPoint[] {
  return [
    ...checkSlamTiming(match, meta),
    ...checkCarryItemsOnTank(match, meta),
    ...checkUnderItemisedCarry(match, meta),
    ...checkItemSpread(match, meta),
    ...checkComponentConversionOpportunity(match, meta, context),
  ];
}

// ITEM_001 — components held for 3+ consecutive rounds (was 2-stage threshold)
function checkSlamTiming(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  let consecutiveHolding = 0;

  for (const round of match.rounds) {
    const [stageStr] = round.label.split('-');
    if (Number(stageStr) < 2) continue;

    const benchComps = boardItemIds(round.bench).filter(id => isComponent(id, meta));
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
          coaching_text: `You kept ${benchComps.length} unbuilt components on your bench for at least 3 rounds in a row. Every fight you played with those components unslammed was a fight where your board was weaker than it needed to be. Slam items on any reasonable holder — even an imperfect completed item provides more combat power than components waiting for the "perfect" recipient.`,
        });
      }
    } else {
      consecutiveHolding = 0;
    }
  }
  return points;
}

// ITEM_002 — offense-tagged items on tank-role units
function checkCarryItemsOnTank(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  const lastRound = match.rounds.at(-1);
  if (!lastRound) return [];

  for (const [, cell] of Object.entries(lastRound.board)) {
    if (!cell?.name || cell.name === '0') continue;
    const champMeta = meta.champions[cell.name];
    if (!champMeta || champMeta.role !== 'tank') continue;

    const damageItems = unitItems(cell).filter(id => isOffenseItem(id, meta));
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

  const carry      = identifyCarry(units, meta);
  const carryName  = getChampionName(carry.name, meta);
  const itemCount  = unitItems(carry).filter(id => !isComponent(id, meta)).length;
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
function checkItemSpread(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const r42 = match.rounds.find(r => r.label === '4-2');
  if (!r42) return [];

  const units = Object.values(r42.board).filter(c => c?.name && c.name !== '0');
  const itemCounts = units.map(u => unitItems(u).filter(id => !isComponent(id, meta)).length);
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

// ── ITEM_005 — component conversion opportunity ────────────────────────────
// Real recipe/stat data only (data/core/item-data.json, fetched from Community
// Dragon — see scripts/fetch-ddragon.js). No BiS list, no per-champion curation:
// this looks at exactly what components the player held and what real
// completed item they could build from them, judged against the round's
// actual situation (HP crisis -> defense/sustain need, otherwise -> offense).

type Need = 'offense' | 'tank' | 'sustain';

const NEED_STAT_KEYS: Record<Need, string[]> = {
  offense: ['AD', 'AP', 'CritChance', 'AS'],
  tank:    ['Health', 'Armor', 'MagicResist', 'BonusPercentHP', 'PercentMaxHP'],
  sustain: ['LifeSteal', 'StatOmnivamp'],
};

const STAT_LABELS: Record<string, string> = {
  Health: 'Health', Armor: 'Armor', MagicResist: 'Magic Resist',
  LifeSteal: 'Life Steal', StatOmnivamp: 'Omnivamp',
  BonusPercentHP: 'Bonus Max HP', PercentMaxHP: 'Bonus Max HP',
  AD: 'Attack Damage', AP: 'Ability Power', CritChance: 'Crit Chance', AS: 'Attack Speed',
};

// Community Dragon stores some stats as a flat number (Health: 500) and others
// as a fraction of a percentage (AD: 0.15 -> +15% bonus AD) — cross-checked
// against known real item values (B.F. Sword AD:10 flat, Bloodthirster
// AD:0.15 = the real known +15% bonus AD), not guessed.
function formatStat(key: string, value: number): string {
  const label = STAT_LABELS[key] ?? key;
  if (value < 1) return `+${Math.round(value * 100)}% ${label}`;
  return `+${Math.round(value)} ${label}`;
}

// Describes the completed item's stats most relevant to `need`, falling back
// to whatever real stats it has if none of the need-specific keys are present.
function describeStatsForNeed(data: ItemData, need: Need): string {
  const wanted  = NEED_STAT_KEYS[need].filter(k => data.keyStats[k] !== undefined);
  const chosen  = (wanted.length > 0 ? wanted : Object.keys(data.keyStats)).slice(0, 2);
  return chosen.map(k => formatStat(k, data.keyStats[k])).join(', ');
}

function matchesNeed(data: ItemData, need: Need): boolean {
  if (need === 'offense') return data.tags.includes('offense');
  return data.tags.includes('tank') || data.tags.includes('sustain');
}

// Finds the real completed item built from exactly these 2 components
// (order-independent), or undefined if no such recipe exists in item-data.json.
function findCompletedItem(compA: string, compB: string, meta: MetaData): string | undefined {
  const wanted = [compA, compB].sort().join('+');
  for (const [id, data] of Object.entries(meta.itemData)) {
    if (data.isComponent || data.composition.length !== 2) continue;
    if ([...data.composition].sort().join('+') === wanted) return id;
  }
  return undefined;
}

interface BuildablePair {
  pairKey: string;
  comps: [string, string];
  resultId: string;
}

// Every real recipe reachable from the held components right now, accounting
// for holding 2 of the same component (e.g. 2x Chain Vest -> Bramble Vest).
function findBuildablePairs(heldComponentIds: string[], meta: MetaData): BuildablePair[] {
  const counts = new Map<string, number>();
  for (const id of heldComponentIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const unique = [...counts.keys()];

  const pairs: BuildablePair[] = [];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i; j < unique.length; j++) {
      const a = unique[i], b = unique[j];
      if (a === b && (counts.get(a) ?? 0) < 2) continue;
      const resultId = findCompletedItem(a, b, meta);
      if (!resultId) continue;
      pairs.push({ pairKey: [a, b].sort().join('+'), comps: [a, b], resultId });
    }
  }
  return pairs;
}

function checkComponentConversionOpportunity(match: MatchSnapshot, meta: MetaData, context: MatchContext): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  const streaks    = new Map<string, number>();
  const firedPairs = new Set<string>();

  for (const round of match.rounds) {
    const [stageStr] = round.label.split('-');
    if (Number(stageStr) < 2) continue;

    const benchComps = boardItemIds(round.bench).filter(id => isComponent(id, meta));
    const pairs       = findBuildablePairs(benchComps, meta);
    const currentKeys = new Set(pairs.map(p => p.pairKey));

    for (const key of [...streaks.keys()]) {
      if (!currentKeys.has(key)) streaks.delete(key);
    }

    for (const pair of pairs) {
      const streak = (streaks.get(pair.pairKey) ?? 0) + 1;
      streaks.set(pair.pairKey, streak);
      if (streak !== 3 || firedPairs.has(pair.pairKey)) continue;
      firedPairs.add(pair.pairKey);

      const resultData = meta.itemData[pair.resultId];
      if (!resultData) continue;
      const inCrisis = context.hpCrisisRounds.has(round.label);
      const need: Need = inCrisis ? 'tank' : 'offense';
      const fits = matchesNeed(resultData, need);
      const resultName = getItemName(pair.resultId, meta);
      const compNames   = pair.comps.map(id => getItemName(id, meta)).join(' + ');
      // If the buildable item doesn't fit the round's need, still describe its
      // real stats (whatever tag it actually has) rather than the need's stats.
      const describeNeed = fits ? need : (resultData.tags[0] as Need | undefined) ?? need;
      const statText = describeStatsForNeed(resultData, describeNeed);

      points.push({
        ruleId:   'ITEM_005',
        round:    round.label,
        category: 'items',
        severity: fits ? 'moderate' : 'minor',
        observed: `Held ${compNames} unbuilt for 3+ consecutive rounds${inCrisis ? ` during an HP crisis (${round.health} HP)` : ''}`,
        recommended: fits
          ? `Combine into ${resultName} (${statText}) — matches what your board needed right then`
          : `Combine into ${resultName} (${statText}) — real value, just not the kind this round's situation called for`,
        reasonMetrics: { components: compNames, result: resultName, consecutiveRounds: streak },
        coaching_text: fits
          ? `You held ${compNames} unbuilt for 3+ consecutive rounds${inCrisis ? `, right as you were in an HP crisis at ${round.health} HP` : ''}. Combined, those build ${resultName} (${statText}) — exactly the kind of stats your board needed at that point. Sitting on the raw components instead of slamming them cost you that value for multiple fights.`
          : `You held ${compNames} unbuilt for 3+ consecutive rounds. Combined, those build ${resultName} (${statText}) — real value left on the bench, though it isn't what this specific round's situation called for. Still better to slam it than let the components sit idle.`,
      });
    }
  }
  return points;
}
