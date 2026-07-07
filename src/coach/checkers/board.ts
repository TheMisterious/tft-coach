// BOARD_001: Board cost sum below stage benchmark (proxy for underpowered board)
// BOARD_003: Unfilled board slots — playing below max units at stage 3+

import type { MatchSnapshot, DecisionPoint, RoundSnapshot, MetaData } from '../../shared/types';
import { boardChampionIds } from '../../ledger/merge';

// Community-derived benchmarks: stage → minimum weighted cost sum.
// Star multiplier: 1-star = 1×cost, 2-star = 3×cost, 3-star = 9×cost.
const COST_BENCHMARKS: Record<number, number> = { 2: 12, 3: 20, 4: 30, 5: 45 };

// 2 is a safe average fallback for champions not yet catalogued in champions.json.
function estimateCost(champId: string, meta: MetaData): number {
  return meta.champions?.[champId]?.tier ?? 2;
}

function boardCostSum(round: RoundSnapshot, meta: MetaData): number {
  let total = 0;
  for (const cell of Object.values(round.board)) {
    if (!cell?.name || cell.name === '0') continue;
    const cost = estimateCost(cell.name, meta);
    const mult = cell.level >= 3 ? 9 : cell.level >= 2 ? 3 : 1;
    total += cost * mult;
  }
  return total;
}

export function checkBoard(match: MatchSnapshot, meta: MetaData = {} as MetaData): DecisionPoint[] {
  return [
    ...checkBoardCostSum(match, meta),
    ...checkUnfilledSlots(match),
  ];
}

// BOARD_001
function checkBoardCostSum(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const points: DecisionPoint[] = [];

  for (const round of match.rounds) {
    const [stageStr, roundStr] = round.label.split('-').map(Number);
    if (!stageStr || roundStr !== 1) continue; // only check stage-start rounds (X-1)
    if (stageStr < 2 || stageStr > 5) continue;

    const benchmark = COST_BENCHMARKS[stageStr];
    if (!benchmark) continue;

    const costSum = boardCostSum(round, meta);
    const deficit = benchmark - costSum;
    if (deficit <= 0) continue;

    points.push({
      ruleId:   'BOARD_001',
      round:    round.label,
      category: 'board',
      severity: deficit >= 15 ? 'critical' : 'moderate',
      observed: `Board cost sum at stage ${stageStr}: ~${costSum} (benchmark ≥${benchmark})`,
      recommended: `Aim for a weighted board value of ${benchmark}+ at stage ${stageStr} — buy higher-tier units or upgrade existing ones`,
      reasonMetrics: { costSum, benchmark, deficit, stage: stageStr },
      coaching_text: `Your board's weighted cost sum at stage ${stageStr} was approximately ${costSum} — ${deficit} below the expected benchmark of ${benchmark}. This is a proxy for board power and correlates with the HP you lost this stage. Focus on upgrading units to 2-star or adding higher-cost units to close this gap.`,
    });
  }
  return points;
}

// BOARD_003
function checkUnfilledSlots(match: MatchSnapshot): DecisionPoint[] {
  const points: DecisionPoint[] = [];

  for (const round of match.rounds) {
    const [stageStr] = round.label.split('-').map(Number);
    if (stageStr < 3) continue;
    if (round.type !== 'PVP') continue;

    const deployed = Object.values(round.board).filter(c => c?.name && c.name !== '0').length;
    const empty    = round.level - deployed;
    if (empty <= 0) continue;

    points.push({
      ruleId:   'BOARD_003',
      round:    round.label,
      category: 'board',
      severity: empty >= 2 ? 'moderate' : 'minor',
      observed: `${empty} board slot(s) empty at level ${round.level} in stage ${stageStr}`,
      recommended: 'Fill all board slots — even a 1-cost unit adds combat power and potential trait activations',
      reasonMetrics: { empty, level: round.level, deployed, stage: stageStr },
      coaching_text: `At ${round.label} you had ${empty} empty board slot(s) at level ${round.level}. Each empty slot is a unit doing nothing while you paid XP to unlock that slot. Even the cheapest unit in the shop adds hits, absorbs damage, and potentially activates a trait bonus. Fill all slots every fight.`,
    });
  }
  return points;
}
