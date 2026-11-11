// LOBBY_001: Level behind the lobby at a stage checkpoint, while not ahead on HP.
// LOBBY_002: HP far below the lobby in the early game, before any HP rule looks.
// ROLL_006:  CANDIDATE — behind the lobby at a roll-down window, gold banked, no
//            roll, with an upgrade on offer.
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

import type { MatchSnapshot, DecisionPoint, Severity, MetaData } from '../../shared/types';
import { standingFor, ordinal } from '../lobby-context';
import { upgradeWasOnOffer } from '../upgrades';

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

export function checkLobby(match: MatchSnapshot, meta?: MetaData): DecisionPoint[] {
  return [
    ...checkLevelBehindLobby(match),
    ...checkHealthBehindLobby(match),
    ...checkBehindAtRolldownWindow(match, meta),
    ...checkLowestWithBank(match),
  ];
}

// LOBBY_003 — CANDIDATE (defined 2026-11-11, status in data/core/rules.core.json).
//
// Placement is relative: the player with the lowest HP goes out first, and
// gold held then buys nothing. This fires on a stage 4+ player round the
// player ENTERED as the strictly lowest HP of four or more still in (the
// roster read before the fight, so the fight's own damage does not decide the
// rank), with 30g+ banked, at most one roll and no XP that round, and the
// fight lost. Once per run of such rounds. Thresholds were fixed before the
// rule was run against any match; it stays out of reports until games
// recorded after that date confirm it.
const LOWEST_STAGE = 4;
const LOWEST_MIN_ALIVE = 4;
const LOWEST_BANK = 30;
const LOWEST_MAX_ROLLS = 1;

function checkLowestWithBank(match: MatchSnapshot): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  const rounds = match.rounds;
  let inRun = false;

  for (let i = 1; i < rounds.length; i++) {
    const r = rounds[i];
    if (r.type !== 'PVP' || Number(r.label.split('-')[0]) < LOWEST_STAGE) { inRun = false; continue; }
    const entering = rounds[i - 1];
    const standing = standingFor(entering);
    if (!standing || standing.alive < LOWEST_MIN_ALIVE) { inRun = false; continue; }

    // Ties share the better rank, so a rank equal to the count alive is the
    // one player below everyone else.
    const lowest = standing.hpRank === standing.alive;
    const banked = r.goldStart >= LOWEST_BANK && r.rollsSpent <= LOWEST_MAX_ROLLS && !r.xpBought;
    const lostFight = r.outcome ? r.outcome === 'loss' : r.health < entering.health;
    if (!(lowest && banked && lostFight)) { inRun = false; continue; }
    if (inRun) continue;
    inRun = true;

    points.push({
      ruleId:   'LOBBY_003',
      round:    r.label,
      category: 'hp',
      severity: 'moderate',
      observed: `Entered ${r.label} as the lowest HP of the ${standing.alive} players still in (${standing.health} against a median of ${standing.medianOpponentHealth}), held ${r.goldStart}g, rolled ${r.rollsSpent === 0 ? 'nothing' : 'once'} and bought no XP, and lost the fight (${entering.health} → ${r.health})`,
      recommended: 'As the lowest HP in the lobby, the usual line is to spend the bank on the next fights before anything else, unless nothing in the pool can change them or the players just above you are about to go out',
      reasonMetrics: {
        health: standing.health, medianOpponentHealth: standing.medianOpponentHealth, alive: standing.alive,
        gold: r.goldStart, rolls: r.rollsSpent, hpAfter: r.health,
      },
      coaching_text:
        `Going into ${r.label} you were the lowest HP of the ${standing.alive} players still in: ${standing.health} against a median of ${standing.medianOpponentHealth}, so you were the one placed to go out first. ` +
        `You held ${r.goldStart}g, rolled ${r.rollsSpent === 0 ? 'nothing' : 'once'}, bought no XP, and lost the fight (${entering.health} → ${r.health}). ` +
        `Gold held when you are knocked out buys nothing, and interest has only a round or two left to pay from here, so the usual line is to spend what the next fight needs now. ` +
        `Holding can still be right when nothing in the pool would change the fight, or when the players just above you are about to go out before you; the lobby table shows where they stood.`,
    });
  }
  return points;
}

// ROLL_006 — CANDIDATE (defined 2026-10-14, status in data/core/rules.core.json).
//
// "Behind the lobby, so roll" is a beginner heuristic: being behind does not by
// itself mean a roll would have helped. This only fires at a roll-down window
// when every condition that makes the roll plausible holds at once — level
// below the lobby median, no HP lead paying for staying low (the same gate
// LOBBY_001 uses), gold banked, no roll-down that round, and something a roll
// could hit (a held unit in the shop, or a pair one copy short). Thresholds
// were fixed before the rule was run against any match; it stays out of
// reports until games recorded after that date confirm it.
const ROLLDOWN_WINDOWS = ['3-2', '4-1', '4-2'];
const BANKED_GOLD = 30;
const MAX_ROLLS_NOT_A_ROLLDOWN = 2;

function checkBehindAtRolldownWindow(match: MatchSnapshot, meta?: MetaData): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  for (const round of match.rounds) {
    if (!ROLLDOWN_WINDOWS.includes(round.label)) continue;
    const standing = standingFor(round);
    if (!standing || standing.opponents < MIN_OPPONENTS) continue;
    if (standing.level >= standing.medianOpponentLevel) continue;
    if (standing.health >= standing.medianOpponentHealth) continue;
    if (round.goldEnd < BANKED_GOLD || round.rollsSpent > MAX_ROLLS_NOT_A_ROLLDOWN) continue;
    if (!upgradeWasOnOffer(round, meta)) continue;

    points.push({
      ruleId:   'ROLL_006',
      round:    round.label,
      category: 'rolling',
      severity: 'moderate',
      observed: `At ${round.label}: level ${standing.level} against a lobby median of ${standing.medianOpponentLevel}, ${standing.health} HP against ${standing.medianOpponentHealth}, ${round.goldEnd}g banked and ${round.rollsSpent} roll${round.rollsSpent === 1 ? '' : 's'}, with an upgrade on offer`,
      recommended: `If the gold was not saved for a planned level, ${round.label} is a usual point to roll for the upgrade on offer`,
      reasonMetrics: {
        level: standing.level, medianOpponentLevel: standing.medianOpponentLevel,
        health: standing.health, medianOpponentHealth: standing.medianOpponentHealth,
        gold: round.goldEnd, rolls: round.rollsSpent,
      },
      coaching_text:
        `${round.label} is a common roll-down point. You were behind the lobby on level (${standing.level} against a median of ${standing.medianOpponentLevel}) ` +
        `and on HP (${standing.health} against ${standing.medianOpponentHealth}), held ${round.goldEnd}g, and rolled ${round.rollsSpent} time${round.rollsSpent === 1 ? '' : 's'}, ` +
        `while a roll had something to hit: a unit you held was in the shop, or you held a pair one copy short. Whether rolling would have changed the ` +
        `fight depends on what the shops would have shown, which the recording cannot tell.`,
    });
  }
  return points;
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
