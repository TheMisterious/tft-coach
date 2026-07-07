// COMP_002: Bench clutter — 5+ off-comp units on bench for 3+ consecutive rounds

import type { MatchSnapshot, DecisionPoint } from '../../shared/types';

// Minimum bench units outside the active comp before flagging.
const CLUTTER_THRESHOLD = 5;
// Consecutive rounds of clutter before flagging.
const CLUTTER_STREAK    = 3;

export function checkComp(match: MatchSnapshot): DecisionPoint[] {
  return checkBenchClutter(match);
}

// COMP_002
function checkBenchClutter(match: MatchSnapshot): DecisionPoint[] {
  // Build the "active comp" as the set of unit names most commonly on the board
  // across all PvP rounds (plurality vote).
  const nameFreq: Record<string, number> = {};
  for (const round of match.rounds) {
    if (round.type !== 'PVP') continue;
    for (const cell of Object.values(round.board)) {
      if (!cell?.name || cell.name === '0') continue;
      nameFreq[cell.name] = (nameFreq[cell.name] ?? 0) + 1;
    }
  }
  // Active comp = names that appear in the majority (>50%) of PvP rounds.
  const pvpCount  = match.rounds.filter(r => r.type === 'PVP').length;
  const activeComp = new Set(
    Object.entries(nameFreq)
      .filter(([, count]) => count > pvpCount * 0.5)
      .map(([name]) => name)
  );

  let streak = 0;
  let streakStart = '';

  for (const round of match.rounds) {
    const [stageStr] = round.label.split('-').map(Number);
    if (stageStr < 3) continue;

    const offComp = Object.values(round.bench).filter(
      c => c?.name && c.name !== '0' && !activeComp.has(c.name)
    );

    if (offComp.length >= CLUTTER_THRESHOLD) {
      if (streak === 0) streakStart = round.label;
      streak++;
    } else {
      streak = 0;
    }

    if (streak === CLUTTER_STREAK) {
      const goldLocked = offComp.reduce((sum, c) => {
        // Approximate sell value: 1-cost = 1g sell, higher costs scale; use 2g average.
        return sum + 2;
      }, 0);

      return [{
        ruleId:   'COMP_002',
        round:    round.label,
        category: 'comp',
        severity: 'minor',
        observed: `${offComp.length} off-comp units on bench for ${streak} consecutive rounds (since ${streakStart})`,
        recommended: `Sell bench units not in your active comp — that's ~${goldLocked}g that could fund interest threshold management or extra rolls`,
        reasonMetrics: { clutterCount: offComp.length, rounds: streak, goldLocked },
        coaching_text: `You've held ${offComp.length} bench units outside your active composition for ${streak} rounds in a row. Those units represent ~${goldLocked}g of locked gold. Selling them would let you push an interest bracket, buy a key unit, or roll for upgrades. If you're holding them as pivot options, that window typically closes by stage 4 — sell anything you haven't deployed in 2+ rounds.`,
      }];
    }
  }

  return [];
}
