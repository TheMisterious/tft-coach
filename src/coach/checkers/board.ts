// BOARD_001: Board cost sum below stage benchmark (proxy for underpowered board)
// BOARD_003: Unfilled board slots — playing below max units at stage 3+
// BOARD_004: CANDIDATE — board weaker than the boards actually fought, while losing

import type { MatchSnapshot, DecisionPoint, RoundSnapshot, MetaData } from '../../shared/types';
import { boardChampionIds, boardUnits } from '../../ledger/merge';

// Community-derived benchmarks: stage → minimum weighted cost sum.
// Star multiplier: 1-star = 1×cost, 2-star = 3×cost, 3-star = 9×cost.
const COST_BENCHMARKS: Record<number, number> = { 2: 12, 3: 20, 4: 30, 5: 45 };

// Minimum deficit, as a fraction of the benchmark, before a shortfall is worth
// telling the player about. boardCostSum is an explicitly rough proxy (star
// multipliers, a flat cost-2 guess for uncatalogued champions), so a deficit
// inside its own margin of error is noise dressed up as a finding. Real case
// from tests/goldens/2026-07-04-rank-6: "board cost sum at stage 5: ~44
// (benchmark >=45)" — one point under, on an estimate that cannot resolve one
// point, and it consumed a slot in the 20-note report.
const MIN_RELATIVE_DEFICIT = 0.1;

// 2 is a safe average fallback for champions not yet catalogued in champions.json.
function estimateCost(champId: string, meta: MetaData): number {
  return meta.champions?.[champId]?.tier ?? 2;
}

function boardCostSum(round: RoundSnapshot, meta: MetaData): number {
  return boardValue(round.board, meta);
}

function boardValue(board: RoundSnapshot['board'], meta: MetaData): number {
  let total = 0;
  for (const cell of boardUnits(board)) {
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
    ...checkWeakerThanOpponents(match, meta),
  ];
}

// BOARD_004 — CANDIDATE (defined 2026-11-09, status in data/core/rules.core.json).
//
// BOARD_001 compares the board to a fixed number per stage and fires in nearly
// every audited match, so it cannot tell a weak board from a normal one. This
// compares it to the boards the player actually fought: GEP records the
// current opponent's board (opponent_board_pieces), present in 91% of
// recorded stage-2+ PvP rounds. Same gold-value measure as BOARD_001 (cost x
// 1/3/9 by star), items not counted.
//
// Fires once per run: WINDOW consecutive PvP rounds in stages 3-4 where the
// player's board was under RATIO of the average opponent board across the
// window AND at least MIN_LOSSES of those fights were lost. All three numbers
// were fixed before the rule was run against any match; it stays out of
// reports until games recorded after that date confirm it.
const WEAK_WINDOW = 3;
const WEAK_RATIO = 0.8;
const WEAK_MIN_LOSSES = 2;

function checkWeakerThanOpponents(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const fights = match.rounds.filter(r => {
    const stage = Number(r.label.split('-')[0]);
    return r.type === 'PVP' && stage >= 3 && stage <= 4
      && boardUnits(r.opponentBoard).length > 0 && r.outcome !== undefined;
  });

  for (let i = 0; i + WEAK_WINDOW <= fights.length; i++) {
    const window = fights.slice(i, i + WEAK_WINDOW);
    const own = window.reduce((n, r) => n + boardValue(r.board, meta), 0) / WEAK_WINDOW;
    const opp = window.reduce((n, r) => n + boardValue(r.opponentBoard, meta), 0) / WEAK_WINDOW;
    const losses = window.filter(r => r.outcome === 'loss').length;
    if (opp <= 0 || own >= WEAK_RATIO * opp || losses < WEAK_MIN_LOSSES) continue;

    const first = window[0].label;
    const last = window[WEAK_WINDOW - 1].label;
    const pct = Math.round((1 - own / opp) * 100);
    return [{
      ruleId:   'BOARD_004',
      round:    last,
      category: 'board',
      severity: 'moderate',
      observed: `From ${first} to ${last} your board was worth about ${Math.round(own)} against an average of ${Math.round(opp)} for the boards you fought (${pct}% weaker), and you lost ${losses} of those ${WEAK_WINDOW} fights`,
      recommended: 'When the boards you are meeting are clearly stronger, the usual answers are a level, a roll for two-star upgrades, or slamming held components — unless the losses were a planned streak',
      reasonMetrics: { ownValue: Math.round(own), opponentValue: Math.round(opp), losses, window: WEAK_WINDOW },
      coaching_text:
        `Between ${first} and ${last} you fought boards worth about ${Math.round(opp)} in unit gold value (cost times star level) while yours was about ${Math.round(own)}, ` +
        `${pct}% weaker, and you lost ${losses} of the ${WEAK_WINDOW} fights. This compares you with the players you actually met rather than a stage benchmark. ` +
        `Items are not counted, so a well-itemised board can win from behind on this measure; if these losses were a planned loss streak, this is the price of it.`,
    }];
  }
  return [];
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
    if (deficit < benchmark * MIN_RELATIVE_DEFICIT) continue; // inside the proxy's own error bar

    // Real HP delta across this stage (this round's health -> next stage's
    // X-1 checkpoint), the same "stage-start to stage-start" window hp.ts's
    // checkers already use — replaces the old unquantified "correlates with
    // the HP you lost this stage" claim with the actual number for THIS
    // match, or drops the HP framing entirely when the next checkpoint isn't
    // in the match (e.g. the player was eliminated mid-stage) rather than
    // asserting a number that isn't there.
    const nextStageRound = match.rounds.find(r => r.label === `${stageStr + 1}-1`);
    const hpLostThisStage = nextStageRound ? round.health - nextStageRound.health : undefined;
    const hpClause = hpLostThisStage === undefined
      ? ''
      : hpLostThisStage > 0
        ? ` You went on to lose ${hpLostThisStage} HP over the course of stage ${stageStr} (${round.health} → ${nextStageRound!.health}) — consistent with a board that was under-strength for the fights it had to play.`
        : ` Your HP actually held steady this stage (${round.health} → ${nextStageRound!.health}) despite the deficit, so this is a power gap worth closing before it starts losing fights, not yet a confirmed loss.`;

    points.push({
      ruleId:   'BOARD_001',
      round:    round.label,
      category: 'board',
      severity: deficit >= 15 ? 'critical' : 'moderate',
      observed: `Board cost sum at stage ${stageStr}: ~${costSum} (benchmark ≥${benchmark})`,
      recommended: `Aim for a weighted board value of ${benchmark}+ at stage ${stageStr} — buy higher-tier units or upgrade existing ones`,
      reasonMetrics: { costSum, benchmark, deficit, stage: stageStr, ...(hpLostThisStage !== undefined ? { hpLostThisStage } : {}) },
      coaching_text: `Your board's weighted cost sum at stage ${stageStr} was approximately ${costSum} — ${deficit} below the expected benchmark of ${benchmark}. This is a proxy for board power.${hpClause} Focus on upgrading units to 2-star or adding higher-cost units to close this gap.`,
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

    const deployed = boardUnits(round.board).length;
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
