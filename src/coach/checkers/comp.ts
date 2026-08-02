// COMP_002: Bench clutter — 5+ off-comp units on bench for 3+ consecutive rounds

import type { MatchSnapshot, DecisionPoint, MetaData, Cell } from '../../shared/types';
import { computeActiveComp } from '../match-context';

// Minimum bench units outside the active comp before flagging.
const CLUTTER_THRESHOLD = 5;
// Consecutive rounds of clutter before flagging.
const CLUTTER_STREAK    = 3;

export function checkComp(match: MatchSnapshot, meta: MetaData = {} as MetaData): DecisionPoint[] {
  return checkBenchClutter(match, meta);
}

// Real per-unit sell-value estimate instead of a flat guess — reuses
// board.ts's same cost×star-level multiplier convention (1-star = cost,
// 2-star = 3×cost, 3-star = 9×cost; a real 2 is board.ts's own fallback for
// champions not yet catalogued in champions.json), applied to actual
// champion tier data from meta.champions instead of a fixed "2g" placeholder.
function estimateSellValue(cell: Cell, meta: MetaData): number {
  const cost = meta.champions?.[cell.name]?.tier ?? 2;
  const mult = cell.level >= 3 ? 9 : cell.level >= 2 ? 3 : 1;
  return cost * mult;
}

// COMP_002 — fires every fresh clutter streak, not just the first one in the
// whole match (same "don't silently swallow a second real occurrence" fix
// already applied to ECON_002's idle-overcap streak — see checkers/econ.ts).
// A player can clear their bench once and then let it clutter up again later
// in the same game; the old single `return` on first fire made that second
// occurrence invisible.
function checkBenchClutter(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const activeComp = computeActiveComp(match);
  const points: DecisionPoint[] = [];

  let streak = 0;
  let streakStart = '';

  for (const round of match.rounds) {
    const [stageStr] = round.label.split('-').map(Number);
    if (stageStr < 3) continue;

    const offComp = Object.values(round.bench).filter(
      (c): c is Cell => !!c?.name && c.name !== '0' && !activeComp.has(c.name)
    );

    if (offComp.length >= CLUTTER_THRESHOLD) {
      if (streak === 0) streakStart = round.label;
      streak++;
    } else {
      streak = 0;
    }

    if (streak === CLUTTER_STREAK) {
      const goldLocked = offComp.reduce((sum, c) => sum + estimateSellValue(c, meta), 0);

      points.push({
        ruleId:   'COMP_002',
        round:    round.label,
        category: 'comp',
        severity: 'minor',
        observed: `${offComp.length} off-comp units on bench for ${streak} consecutive rounds (since ${streakStart})`,
        recommended: `Sell bench units not in your active comp — that's ~${goldLocked}g that could fund interest threshold management or extra rolls`,
        reasonMetrics: { clutterCount: offComp.length, rounds: streak, goldLocked },
        coaching_text: `You've held ${offComp.length} bench units outside your active composition for ${streak} rounds in a row. Those units represent ~${goldLocked}g of locked sell value. Selling them would let you push an interest bracket, buy a key unit, or roll for upgrades. If you're holding them as pivot options, that window typically closes by stage 4 — sell anything you haven't deployed in 2+ rounds.`,
      });
      streak = 0;
    }
  }

  return points;
}
