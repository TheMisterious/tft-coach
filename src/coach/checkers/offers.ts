// ITEM_006: CANDIDATE (defined 2026-11-11, status in data/core/rules.core.json)
// — an item choice offered a component the carry's usual items are built
// from, and a different component was taken while the carry still had slots.
//
// Unlike augments, item choices ARE captured with their options:
// match_info.item_select lists the four offers and picked_item the one taken
// (RoundSnapshot.itemOffers). So this is the one place the coach can compare
// a pick with what was passed. "Usual" comes from data/sets/set{N}/
// carry-bis.json's components_priority, derived from top-4 boards by
// scripts/fetch-riot-meta.ts, never invented. The carry is the one
// identifyCarry names on that round's board (role, commitment, real damage).
// All of these must hold:
//   - the carry has a carry-bis entry with a components_priority list;
//   - it held fewer than 3 completed items at the time;
//   - the offer held a priority component, and the pick was a different
//     component (an artifact or finished item taken instead is another
//     decision, not judged here).
// Thresholds were fixed before the rule was run against any match; it stays
// out of reports until games recorded after that date confirm it.

import type { MatchSnapshot, DecisionPoint, MetaData, MatchContext } from '../../shared/types';
import { NEUTRAL_CONTEXT, computeActiveComp, computeCarryDamage } from '../match-context';
import { identifyCarry, boardUnits } from '../../ledger/merge';
import { getChampionName, getItemName, resolveItemId } from '../../enrichment/meta-lookup';
import { completedItems, isComponent } from './items';

const MAX_CARRY_ITEMS = 3;

export function checkOffers(match: MatchSnapshot, meta: MetaData = {} as MetaData, context: MatchContext = NEUTRAL_CONTEXT): DecisionPoint[] {
  if (!meta.carryBis || Object.keys(meta.carryBis).length === 0) return [];
  const points: DecisionPoint[] = [];
  const activeComp = context.activeComp.size > 0 ? context.activeComp : computeActiveComp(match);
  const carryDamage = computeCarryDamage(match);

  for (const r of match.rounds) {
    for (const offer of r.itemOffers ?? []) {
      if (!offer.picked || offer.offered.length === 0) continue;
      const units = boardUnits(r.board);
      if (units.length === 0) continue;
      const carry = identifyCarry(units, meta, activeComp, carryDamage);
      const bis = meta.carryBis[carry.name];
      if (!bis?.components_priority?.length) continue;
      const held = completedItems(carry, meta).length;
      if (held >= MAX_CARRY_ITEMS) continue;

      const priority = new Set(bis.components_priority.map(id => resolveItemId(id, meta)));
      const offeredPriority = offer.offered.map(id => resolveItemId(id, meta)).filter(id => priority.has(id));
      const picked = resolveItemId(offer.picked, meta);
      if (offeredPriority.length === 0 || priority.has(picked) || !isComponent(picked, meta)) continue;

      const carryName = getChampionName(carry.name, meta);
      const wanted = [...new Set(offeredPriority)].map(id => getItemName(id, meta)).join(' or ');
      const taken = getItemName(picked, meta);
      points.push({
        ruleId:   'ITEM_006',
        round:    r.label,
        category: 'items',
        severity: 'moderate',
        observed: `The item choice at ${r.label} offered ${wanted}, a priority component for ${carryName} in top-4 boards, and you took ${taken}; ${carryName} held ${held} completed item${held === 1 ? '' : 's'}`,
        recommended: `While the carry has item slots open, its priority components are the usual pick unless the one taken builds an item the board needed more, or the carry was about to change`,
        reasonMetrics: { carry: carryName, offered: wanted, picked: taken, carryItems: held },
        coaching_text: `At ${r.label} the game offered a choice of components. ${wanted} is what top-4 boards most often build ${carryName}'s items from (${bis.notes}), and ${carryName} held ${held} completed item${held === 1 ? '' : 's'} at the time; you took ${taken}. A component only matters through the item it ends up in, so the usual pick is the one the carry's items need while slots are open. Taking ${taken} can be right when the board needed a tank or sustain item more than carry damage that round, or when ${carryName} was not the unit you were building toward.`,
      });
    }
  }
  return points;
}
