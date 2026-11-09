// ECON_001: Missed interest — ended 1-3g below a 10g bracket
// ECON_002: Interest overcap — sat >50g for 3+ rounds without rolling/leveling
// ECON_003: Pre-stage-3 excessive rolls — >10g spent on rolls before 3-1
// ECON_004: Below the set's curated econ-benchmark curve at a checkpoint round
// ECON_005: CANDIDATE — idle gold above 50 while losing fights, with an upgrade on offer

import type { MatchSnapshot, DecisionPoint, RoundSnapshot, MetaData, MatchContext } from '../../shared/types';
import { NEUTRAL_CONTEXT } from '../match-context';
import { pivotContextClause } from '../plan-builder';
import { boardChampionIds } from '../../ledger/merge';
import { upgradeWasOnOffer } from '../upgrades';

function byHp(round: RoundSnapshot, t: { low: string; mid: string; high: string }): string {
  if (round.health <= 40) return t.low;
  if (round.health >= 70) return t.high;
  return t.mid;
}

const INTEREST_CAP = 50;
const INTEREST_TIERS = [10, 20, 30, 40, 50];

// Interest is capped at 50g (5 interest) — 51g and 50g earn the exact same
// interest, so being 1-3g over the cap isn't a real mistake to act on: the
// recommended fix (roll for 2g, or buy XP for 4g) would drop you back BELOW
// the bracket you're already sitting in, sacrificing the interest tier to
// "fix" a problem that was costing nothing. XP is the pricier of the two
// actions (4g) — require enough surplus that spending doesn't immediately
// undo itself.
const OVERCAP_ACTIONABLE_SURPLUS = 4;

// Stage number from a "3-2"-style round label; 0 for "match"/unparseable.
function stageOf(label: string): number {
  return Number(label.split('-')[0]) || 0;
}

export function checkEcon(
  match: MatchSnapshot,
  meta: MetaData = {} as MetaData,
  context: MatchContext = NEUTRAL_CONTEXT
): DecisionPoint[] {
  const points: DecisionPoint[] = [
    ...checkMissedInterest(match, meta, context),
    ...checkInterestOvercap(match, context),
    ...checkEarlyRolling(match, context),
    ...checkEconBenchmarks(match, meta),
    ...checkIdleGoldWhileLosing(match, meta),
  ];
  return points;
}

// ECON_005 — CANDIDATE (defined 2026-10-14, status in data/core/rules.core.json).
//
// ECON_002 flags idle gold above 50 whatever else is going on, and holding is
// sometimes right: saving for a planned level or roll-down. This narrower
// version only fires when the three things that make holding hard to defend
// are all true in the same stage — the gold sat idle, the player kept losing,
// and a roll could have bought an upgrade (a held unit in the shop, or a pair
// one copy short). Every threshold below was fixed before the rule was run
// against any match; it is not shown in reports until games recorded AFTER
// that date confirm it (scripts/rule-audit.ts).
const IDLE_GOLD = 50;
const IDLE_STAGES = [3, 4, 5];
const MIN_IDLE_ROUNDS = 2;
const MIN_LOSSES = 2;

function checkIdleGoldWhileLosing(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  for (const stage of IDLE_STAGES) {
    const rounds = match.rounds.filter(r => stageOf(r.label) === stage);
    const idle = rounds.filter(r => r.goldEnd >= IDLE_GOLD && r.rollsSpent === 0 && !r.xpBought);
    const fights = rounds.filter(r => r.type === 'PVP' && r.outcome);
    const losses = fights.filter(r => r.outcome === 'loss').length;
    const withUpgrade = idle.filter(r => upgradeWasOnOffer(r, meta));
    if (idle.length < MIN_IDLE_ROUNDS || losses < MIN_LOSSES || withUpgrade.length === 0) continue;

    const last = idle[idle.length - 1];
    const maxGold = Math.max(...idle.map(r => r.goldEnd));
    points.push({
      ruleId:   'ECON_005',
      round:    last.label,
      category: 'econ',
      severity: 'moderate',
      observed: `Held up to ${maxGold}g idle in ${idle.length} rounds of stage ${stage} while losing ${losses} of ${fights.length} fights, with an upgrade on offer in ${withUpgrade.length} of them`,
      recommended: 'If the gold was not saved for a planned level or roll-down, spending some of it on the upgrades on offer is the usual way to slow the losses',
      reasonMetrics: { stage, idleRounds: idle.length, losses, fights: fights.length, maxGold, upgradeRounds: withUpgrade.length },
      coaching_text: `In stage ${stage} your gold sat at ${IDLE_GOLD}g or more without a roll or a level in ${idle.length} rounds, while you lost ${losses} of ${fights.length} fights. In ${withUpgrade.length} of those rounds a roll had something to hit: a unit you held was in the shop, or you held a pair one copy short. Holding can still be right when it is saved for a specific level or roll-down; the observations show what the HP and the lobby were doing meanwhile.`,
    });
  }
  return points;
}

// ECON_004 — below the season-curated gold benchmark at a checkpoint round.
// Benchmarks live in data/sets/set{N}/econ-benchmarks.json so they can be retuned per set/patch
// without touching checker code.
function checkEconBenchmarks(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  const benchmarks = meta.econBenchmarks ?? [];

  for (const benchmark of benchmarks) {
    const round = match.rounds.find(r => r.label === benchmark.round);
    if (!round) continue;
    if (round.goldEnd >= benchmark.minGold) continue;

    const deficit = benchmark.minGold - round.goldEnd;
    points.push({
      ruleId:   'ECON_004',
      round:    round.label,
      category: 'econ',
      severity: deficit >= 15 ? 'critical' : 'moderate',
      observed: `Ended ${round.label} with ${round.goldEnd}g — ${deficit}g below the ${benchmark.minGold}g benchmark for this checkpoint`,
      recommended: benchmark.notes,
      reasonMetrics: { goldEnd: round.goldEnd, benchmark: benchmark.minGold, deficit },
      coaching_text: `At ${round.label} you had ${round.goldEnd}g, ${deficit}g short of the ${benchmark.minGold}g benchmark for this checkpoint. ${benchmark.notes}`,
    });
  }

  return points;
}

// ECON_001
// "Sell a bench unit" is only free advice for a standard comp. In a reroll
// comp, bench copies of the primary carry ARE the strategy — selling one to
// cross an interest bracket burns roll equity for +1g/round, a bad trade.
// Only suppressed when the bench actually holds one of those carries at this
// specific round (a reroll game can still have genuine bench junk to sell).
function checkMissedInterest(
  match: MatchSnapshot,
  meta: MetaData,
  context: MatchContext
): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  const rerollCarryIds = context.isRerollComp
    ? new Set(meta.comps?.find(c => c.id === context.matchedComp?.id)?.primary_carry_ids ?? [])
    : new Set<string>();

  for (const round of match.rounds) {
    const gold = round.goldEnd;
    if (gold >= INTEREST_CAP) continue;

    for (const tier of INTEREST_TIERS) {
      const gap = tier - gold;
      if (gap > 0 && gap <= 3) {
        const benchHasRerollCarry = rerollCarryIds.size > 0 &&
          boardChampionIds(round.bench).some(id => rerollCarryIds.has(id));
        const sellHint = benchHasRerollCarry ? '' : ' (or sell a bench unit)';
        const rerollNote = benchHasRerollCarry
          ? ` Your bench copies are reroll fodder for this comp, so selling them just to cross a bracket is usually not worth it.`
          : '';

        points.push({
          ruleId:   'ECON_001',
          round:    round.label,
          category: 'econ',
          // Severity is impact, not proximity. This used to be
          // `gap === 1 ? 'critical' : 'moderate'` — being ONE gold short
          // outranked being three short, and since rule-engine.ts sorts by
          // severity first, the most trivial econ miss in the match took slot
          // #1 of the report. Real output from tests/goldens/2026-07-04-rank-6:
          // "1g below the 30g interest tier" (critical) ranked above "carry had
          // 0 completed items at stage 4" (also critical, but genuinely so).
          // A missed bracket is worth +1g per remaining round, so the earlier
          // it happens the more it compounds — that, not closeness, is the
          // real severity axis. Never critical: no single interest bracket is
          // a match-losing mistake. MVP_RANK (data/rules.mvp.json) already
          // carries this rule's teaching priority as a tiebreaker.
          severity: stageOf(round.label) <= 3 ? 'moderate' : 'minor',
          observed: `Ended ${round.label} at ${gold}g — ${gap}g below the ${tier}g interest tier`,
          recommended: `Unless the spend bought something the board needed that round, holding ${gap}g more${sellHint} crosses the ${tier}g bracket for +1 interest per round`,
          reasonMetrics: { goldEnd: gold, tier, gap },
          coaching_text: byHp(round, {
            low:  `At ${round.label} you were ${gap}g short of the ${tier}g bracket, at ${round.health} HP. This low, winning fights usually matters more than interest, so the question is whether that spend made the board stronger. If it did not, stopping on the ${tier}g line would have kept +1g per round.${rerollNote}`,
            mid:  `At ${round.label} you ended on ${gold}g, ${gap}g short of the ${tier}g interest bracket: 1g less interest every round until you cross it. At ${round.health} HP there is still room to play for econ, so a near-miss like this is usually worth avoiding unless the gold went into an upgrade.${rerollNote}`,
            high: `At ${round.label} you ended on ${gold}g, ${gap}g below the ${tier}g bracket. At ${round.health} HP you have room to play for interest, and holding ${gap}g more would have earned +1g per round from here. Consider stopping on the bracket unless the spend hit something you needed.${rerollNote}`,
          }) + pivotContextClause(context.plan, round.label),
        });
        break;
      }
    }
  }

  return points;
}

// ECON_002 — reroll-aware: sitting overcap and idle is always a minor
// inefficiency in a standard game, but it directly contradicts a reroll
// comp's whole plan (gold should be funding rolls, not sitting idle), so it's
// upgraded to moderate and the message names the strategy conflict directly.
function checkInterestOvercap(match: MatchSnapshot, context: MatchContext): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  let streak = 0;
  let streakStart = '';
  const rounds = match.rounds;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const overCap = r.goldEnd >= INTEREST_CAP + OVERCAP_ACTIONABLE_SURPLUS;
    const idle    = r.rollsSpent === 0 && !r.xpBought;

    if (overCap && idle) {
      if (streak === 0) streakStart = r.label;
      streak++;
    } else {
      streak = 0;
    }

    // Fire once per fresh idle-overcap streak (not just the first in the whole
    // match) — a player can stabilise, spend down, and then fall back into the
    // same mistake later (e.g. during a late-game death spiral where they're
    // sitting on 80g+ but barely rolling). Resetting streak after each fire
    // requires 3 more idle-overcap rounds before the next one can fire.
    if (streak === 3) {
      const rerollNote = context.isRerollComp
        ? ` You're running ${context.matchedComp?.name ?? 'a reroll comp'}, where gold above the cap usually funds rolls toward the 3-star rather than sitting idle.`
        : '';

      points.push({
        ruleId:   'ECON_002',
        round:    r.label,
        category: 'econ',
        severity: context.isRerollComp ? 'moderate' : 'minor',
        observed: `Held ${r.goldEnd}g (above the ${INTEREST_CAP}g cap) for ${streak} consecutive rounds without rolling or leveling`,
        recommended: context.isRerollComp
          ? 'You are playing a reroll comp — spend this gold rolling for your carry, not holding it above the interest cap'
          : 'Gold above 50 earns no extra interest; a level or a roll-down is usually the better use of it, unless you were saving for a specific spike',
        reasonMetrics: { goldEnd: r.goldEnd, streak, streakStartRound: streakStart },
        coaching_text: `You sat above ${INTEREST_CAP}g for ${streak} rounds in a row (starting ${streakStart}) without rolling or buying XP. Interest stops at 50g, so the gold above it earned nothing. Holding can still be right when it is saved for a specific level or roll-down; the observations show what your HP and the lobby were doing meanwhile.${rerollNote}` + pivotContextClause(context.plan, r.label),
      });
      streak = 0;
    }
  }

  return points;
}

// ECON_003 — suppressed for a detected reroll archetype (context.isRerollComp):
// rolling early is the correct, intentional play for that strategy, not a
// mistake. Previously this checker flagged every early-roller "critical" and
// only hedged in the prose ("unless you were playing a dedicated reroll
// comp") without ever actually checking — see src/coach/match-context.ts.
function checkEarlyRolling(match: MatchSnapshot, context: MatchContext): DecisionPoint[] {
  if (context.isRerollComp) return [];

  let goldSpent = 0;

  for (const round of match.rounds) {
    const [stageStr] = round.label.split('-');
    if (Number(stageStr) >= 3) break;
    goldSpent += round.rollsSpent * 2;
  }

  if (goldSpent <= 10) return [];

  return [{
    ruleId:   'ECON_003',
    round:    '2-x',
    category: 'econ',
    severity: 'critical',
    observed: `Spent ${goldSpent}g rolling before stage 3-1`,
    recommended: 'Outside a reroll comp, gold is usually held through stage 2 so interest can build, unless the rolls were saving a losing board',
    reasonMetrics: { goldSpent },
    coaching_text: `You spent ${goldSpent}g rolling shops before stage 3, and no reroll comp was detected. Each 10g spent under the 50g cap is 1g less interest per round until it is earned back, so early rolls are usually kept for steadying a board that keeps losing or finishing a pair you are building around. If neither was happening here, holding that gold is the usual line.`,
  }];
}
