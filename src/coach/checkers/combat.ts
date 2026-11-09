// COMBAT_001: Itemized carry not leading own-team damage across 2+
// consecutive stage-4+ PvP fights.
//
// Every other checker in this project reasons from proxies for board
// strength — item counts, board cost sums, tank-role presence. GEP also
// reports real per-unit combat outcomes for every fight (match_info.battle_stats
// -> RoundSnapshot.battleStats, see src/ledger/rounds.ts), but until now
// nothing consumed the player's OWN side of that data — positioning.ts only
// reads battleStats.opponent, to infer the enemy carry. This checker uses the
// same "most damage this fight" methodology positioning.ts already applies to
// the opponent, applied to the player's own team instead: a fully-itemized
// carry should usually be the unit dealing the most damage on its own team.
// When it consistently isn't, that's measured fact, not a threshold guess —
// no new heuristic constant to tune or get wrong.

import type { MatchSnapshot, DecisionPoint, MetaData } from '../../shared/types';
import { identifyCarry, boardUnits } from '../../ledger/merge';
import { getChampionName } from '../../enrichment/meta-lookup';
import { computeActiveComp, computeCarryDamage } from '../match-context';
import { unitItems, isComponent } from './items';

const STAGE_THRESHOLD = 4;
const REPEAT_THRESHOLD = 2;
// Itemized carry precondition mirrors ITEM_003's "carry should have 2+
// completed items by stage 4" bar — judging damage share on an under-built
// carry would just restate ITEM_003, not add a new signal.
const MIN_COMPLETED_ITEMS = 2;

export function checkCombat(match: MatchSnapshot, meta: MetaData = {} as MetaData): DecisionPoint[] {
  return checkCarryDamageShare(match, meta);
}

interface Evidence {
  round: string;
  carryDamage: number;
  leaderName: string;
  leaderDamage: number;
}

// COMBAT_001
function checkCarryDamageShare(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  const activeComp = computeActiveComp(match);
  const carryDamageByUnit = computeCarryDamage(match);
  let streak: Evidence[] = [];
  let completedItemsAtStreakStart = 0;

  const reset = () => { streak = []; };

  for (const round of match.rounds) {
    const [stageStr] = round.label.split('-').map(Number);
    if (round.type !== 'PVP' || !stageStr || stageStr < STAGE_THRESHOLD) { reset(); continue; }
    if (!round.battleStats?.own?.length) { reset(); continue; }

    const units = boardUnits(round.board);
    if (units.length === 0) { reset(); continue; }

    const carry = identifyCarry(units, meta, activeComp, carryDamageByUnit);
    const completedItems = unitItems(carry).filter(id => !isComponent(id, meta)).length;
    if (completedItems < MIN_COMPLETED_ITEMS) { reset(); continue; }

    const carryStats = round.battleStats.own.find(u => u.name === carry.name);
    if (!carryStats) { reset(); continue; }

    const leader = [...round.battleStats.own].sort((a, b) => b.totalDamage - a.totalDamage)[0];
    // Zero total damage across the team means GEP didn't record a real fight
    // this round (e.g. a bye/ghost round) — not a signal either way.
    if (!leader || leader.totalDamage <= 0) { reset(); continue; }

    if (leader.name === carryStats.name) { reset(); continue; } // carry led — no issue, reset the streak

    // The leader being outdamaged-by is itself a fully-itemized unit — a real
    // second carry pulling more weight this fight, not evidence the
    // identified carry was mispositioned or wrongly itemized (the two
    // explanations this rule offers). Flagging here would tell a player
    // running two legitimate carries (e.g. Miss Fortune main, Viktor
    // secondary) that their secondary carry is "the problem" for not
    // outdamaging a teammate that's doing exactly what it's built to do.
    const leaderCell = units.find(u => u.name === leader.name);
    const leaderCompletedItems = leaderCell ? unitItems(leaderCell).filter(id => !isComponent(id, meta)).length : 0;
    if (leaderCompletedItems >= MIN_COMPLETED_ITEMS) { reset(); continue; }

    if (streak.length === 0) completedItemsAtStreakStart = completedItems;
    streak.push({
      round: round.label,
      carryDamage: carryStats.totalDamage,
      leaderName: getChampionName(leader.name, meta),
      leaderDamage: leader.totalDamage,
    });

    if (streak.length === REPEAT_THRESHOLD) {
      const carryName = getChampionName(carry.name, meta);
      const roundsList = streak.map(e => e.round).join(', ');
      const last = streak.at(-1)!;

      points.push({
        ruleId:   'COMBAT_001',
        round:    round.label,
        category: 'combat',
        severity: 'moderate',
        observed: `Itemized carry ${carryName} was outdamaged by ${last.leaderName} in ${streak.length} consecutive stage-4+ fights (${roundsList})`,
        recommended: `${carryName}'s positioning and target access are the usual things to check — a fully-itemized carry usually leads your team's real damage output`,
        reasonMetrics: {
          carry: carryName,
          consecutiveRounds: streak.length,
          completedItems: completedItemsAtStreakStart,
          lastCarryDamage: last.carryDamage,
          lastLeaderDamage: last.leaderDamage,
        },
        coaching_text: `Across ${roundsList}, your itemized carry ${carryName} (${completedItemsAtStreakStart}+ completed items) dealt less real combat damage than ${last.leaderName} on your own team — most recently ${last.carryDamage} vs ${last.leaderDamage}. A fully-itemized carry usually leads team damage; when it consistently doesn't, the likely cause is positioning (dying or getting locked down before it can attack for long) or the wrong unit being itemized as the carry. This is measured directly from real combat data, not an estimate.`,
      });
      reset();
    }
  }

  return points;
}
