// LOBBY_001: Level behind the lobby at a stage checkpoint, while not ahead on HP.
// LOBBY_002: HP far below the lobby in the early game, before any HP rule looks.
//
// Every other checker in this project measures the player against a fixed
// constant — an interest bracket, a board-cost benchmark, level 8 by 4-2.
// Those constants describe an average lobby, and the player was not in an
// average lobby; they were in one specific lobby whose seven other players set
// the real tempo and took the real HP. A benchmark can read "fine" while the
// whole table is a level ahead, and that is exactly the game a player loses
// without ever being told why.
//
// GEP exposes only health and level per opponent (roster.player_status, see
// src/coach/lobby-context.ts), so nothing here infers anything about their
// gold, boards, items or comps.

import type { MatchSnapshot, DecisionPoint, Severity } from '../../shared/types';
import { standingFor, ordinal } from '../lobby-context';

// Stage-entry checkpoints, matching the rounds hp.ts and items.ts already
// evaluate at, so a lobby note lands alongside the other stage-entry notes
// rather than at some round of its own.
const LEVEL_CHECKPOINTS = ['3-1', '4-1', '5-1'];

// LOBBY_002 deliberately stops before stage 4. HP_002 (4-1) and HP_003 (5-1)
// already judge those checkpoints, and both now carry a lobby clause appended
// by rule-engine.ts's attachLobbyContext — so firing here too would print the
// same comparison twice under two rule ids. Stages 2 and 3 are where nothing
// else looks at HP at all.
const HP_CHECKPOINTS = ['2-1', '3-1'];

// Below this many living opponents the lobby is too thinned out to read a
// table-wide tempo from — at 2 opponents it is one player's decision.
const MIN_OPPONENTS = 3;

// LOBBY_002 needs the player to be both near the bottom of the table AND a real
// distance below it. Rank alone would fire on a healthy lobby where last place
// is 4 HP off first.
const HP_BOTTOM_RANKS = 2;
const MIN_HP_BELOW_MEDIAN = 20;

export function checkLobby(match: MatchSnapshot): DecisionPoint[] {
  return [
    ...checkLevelBehindLobby(match),
    ...checkHealthBehindLobby(match),
  ];
}

// LOBBY_001
function checkLevelBehindLobby(match: MatchSnapshot): DecisionPoint[] {
  const points: DecisionPoint[] = [];

  for (const round of match.rounds) {
    if (!LEVEL_CHECKPOINTS.includes(round.label)) continue;

    const standing = standingFor(round);
    if (!standing) continue;
    if (standing.opponents < MIN_OPPONENTS) continue;

    // "Most of the table is ahead" — a strict majority of living opponents.
    const majority = Math.floor(standing.opponents / 2) + 1;
    if (standing.opponentsAhead < majority) continue;

    // Being behind on level while HEALTHIER than the table is not a mistake —
    // it is what a working econ or reroll line looks like from the outside. The
    // player is converting the levels they skipped into gold and HP, and
    // telling them to "match the lobby's tempo" would be telling them to stop
    // doing the thing that is working.
    //
    // Not hypothetical: tests/goldens/2026-07-04-rank-1.jsonl is a FIRST-PLACE
    // finish that sat 7th of 8 on level at both 4-1 and 5-1, while holding 67
    // HP against a lobby median of 58 and then 32 against 27. Without this gate
    // that match collects two critical-severity notes for the strategy that
    // won it.
    //
    // isRerollComp / plan.econStyle don't cover this case — that match reads as
    // econStyle 'standard' — so the suppression keys off the HP the player
    // actually banked rather than off an archetype label.
    if (standing.health >= standing.medianOpponentHealth) continue;

    const behindBy = standing.topOpponentLevel - standing.level;
    const everyone = standing.opponentsAhead === standing.opponents;

    // Severity tracks how much of the game is left to recover in. Falling a
    // level behind the table at 5-1 is close to terminal; the same gap at 3-1
    // is a tempo choice stage 4 can still repay.
    const severity: Severity =
      round.label === '3-1' ? 'minor' :
      everyone || behindBy >= 2 ? 'critical' : 'moderate';

    const aheadText = everyone
      ? `every one of the ${standing.opponents} opponents still alive`
      : `${standing.opponentsAhead} of the ${standing.opponents} opponents still alive`;

    points.push({
      ruleId:   'LOBBY_001',
      round:    round.label,
      category: 'leveling',
      severity,
      observed: `Level ${standing.level} at ${round.label} — ${ordinal(standing.levelRank)} of ${standing.alive} in the lobby, behind ${aheadText}, at ${standing.health} HP against a median of ${standing.medianOpponentHealth}`,
      recommended: behindBy > 0
        ? `The table was up to level ${standing.topOpponentLevel} here and you had no HP lead to pay for staying low; levelling at the next window is the usual answer unless you were saving for a planned roll-down`
        : `The rest of the table had already taken this level; consider taking it at ${round.label} too unless you were saving for a planned roll-down`,
      reasonMetrics: {
        level:                standing.level,
        levelRank:            standing.levelRank,
        alive:                standing.alive,
        opponentsAhead:       standing.opponentsAhead,
        topOpponentLevel:     standing.topOpponentLevel,
        medianOpponentLevel:  standing.medianOpponentLevel,
        health:               standing.health,
        medianOpponentHealth: standing.medianOpponentHealth,
      },
      coaching_text:
        `At ${round.label} you were level ${standing.level} while ${aheadText} had already levelled past you` +
        `${behindBy > 0 ? `, the highest at ${standing.topOpponentLevel}` : ''}` +
        `. That is ${ordinal(standing.levelRank)} of ${standing.alive} on level, against a lobby median of ${standing.medianOpponentLevel}. ` +
        `Staying low on level is a real strategy when it buys gold or HP, and it was not buying HP here: you were on ${standing.health} HP ` +
        `against a median of ${standing.medianOpponentHealth}, so you were behind the table on both. The players ahead of you were seeing better ` +
        `shop odds and fielding more units in the exact fights you had to survive. Level benchmarks describe an average lobby; this one was faster, ` +
        `and the lobby is the target that matters. Measured from the real roster, not a benchmark.`,
    });
  }

  return points;
}

// LOBBY_002
function checkHealthBehindLobby(match: MatchSnapshot): DecisionPoint[] {
  const points: DecisionPoint[] = [];

  for (const round of match.rounds) {
    if (!HP_CHECKPOINTS.includes(round.label)) continue;

    const standing = standingFor(round);
    if (!standing) continue;
    if (standing.opponents < MIN_OPPONENTS) continue;

    const bottomRank = standing.alive - HP_BOTTOM_RANKS + 1;
    if (standing.hpRank < bottomRank) continue;

    const belowMedian = standing.medianOpponentHealth - standing.health;
    if (belowMedian < MIN_HP_BELOW_MEDIAN) continue;

    const stage = round.label.split('-')[0];

    points.push({
      ruleId:   'LOBBY_002',
      round:    round.label,
      category: 'hp',
      severity: 'moderate',
      observed: `${standing.health} HP at ${round.label} — ${ordinal(standing.hpRank)} of ${standing.alive}, ${belowMedian} below the lobby median of ${standing.medianOpponentHealth}`,
      recommended: `If the HP was not traded for a planned loss streak, ${round.label} is a cheap point to spend on board strength: you were paying more HP per round than the rest of the table`,
      reasonMetrics: {
        health:               standing.health,
        hpRank:               standing.hpRank,
        alive:                standing.alive,
        medianOpponentHealth: standing.medianOpponentHealth,
        belowMedian,
      },
      coaching_text:
        `At ${round.label} you were on ${standing.health} HP — ${ordinal(standing.hpRank)} of the ${standing.alive} players alive, and ${belowMedian} below ` +
        `the lobby median of ${standing.medianOpponentHealth}. Nothing else in this report looks at HP this early: the usual checkpoints are 4-1 and 5-1, ` +
        `and a gap this size at those points goes with a low finish in the audited games. A deficit like this in stage ${stage} means your board was ` +
        `losing fights the rest of the table was winning, which is fine if it was a planned loss streak and costly if it was not. If it was not, this is ` +
        `the cheapest point to answer it: slamming held components and fielding the strongest units available, even off-comp. Measured against the ` +
        `real lobby, not a benchmark.`,
    });
  }

  return points;
}
