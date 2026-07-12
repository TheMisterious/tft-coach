// ECON_001: Missed interest — ended 1-3g below a 10g bracket
// ECON_002: Interest overcap — sat >50g for 3+ rounds without rolling/leveling
// ECON_003: Pre-stage-3 excessive rolls — >10g spent on rolls before 3-1
// ECON_004: Below the set's curated econ-benchmark curve at a checkpoint round

import type { MatchSnapshot, DecisionPoint, RoundSnapshot, MetaData, MatchContext } from '../../shared/types';
import { NEUTRAL_CONTEXT } from '../match-context';
import { boardChampionIds } from '../../ledger/merge';

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
  ];
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
          ? ` Your bench copies are reroll fodder for this comp — don't sell into them just to cross a bracket.`
          : '';

        points.push({
          ruleId:   'ECON_001',
          round:    round.label,
          category: 'econ',
          severity: gap === 1 ? 'critical' : 'moderate',
          observed: `Ended ${round.label} at ${gold}g — ${gap}g below the ${tier}g interest tier`,
          recommended: `Hold ${gap}g more${sellHint} to cross the ${tier}g bracket and earn +1 interest`,
          reasonMetrics: { goldEnd: gold, tier, gap },
          coaching_text: byHp(round, {
            low:  `At ${round.label} you were ${gap}g short of the ${tier}g bracket — and already at ${round.health} HP. You cannot afford to lose fights AND give up interest income simultaneously. Immediately cross the ${tier}g line before spending anything else; that +1g per round is the cheapest form of comeback available to you.${rerollNote}`,
            mid:  `At ${round.label} you ended on ${gold}g — just ${gap}g short of the ${tier}g interest bracket. That single gold costs you +1 interest every round from here. At ${round.health} HP sub-bracket endings like this compound: you lose both income and the HP cushion to play for econ.${rerollNote}`,
            high: `At ${round.label} you ended on ${gold}g — ${gap}g below the ${tier}g bracket. At ${round.health} HP you have the luxury of playing the interest game properly; ending ${gap}g short is a pure inefficiency. Hold ${gap}g more before spending and this never costs you.${rerollNote}`,
          }),
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
        ? ` You're running ${context.matchedComp?.name ?? 'a reroll comp'} — that gold has one job here: funding rolls toward your 3-star, not sitting idle. Holding it past the cap isn't a normal econ slip, it's working against the strategy you already committed to.`
        : '';

      points.push({
        ruleId:   'ECON_002',
        round:    r.label,
        category: 'econ',
        severity: context.isRerollComp ? 'moderate' : 'minor',
        observed: `Held ${r.goldEnd}g (above the ${INTEREST_CAP}g cap) for ${streak} consecutive rounds without rolling or leveling`,
        recommended: context.isRerollComp
          ? 'You are playing a reroll comp — spend this gold rolling for your carry, not holding it above the interest cap'
          : 'Plan a spend — level up or roll down — when you are above the 50g interest cap and HP is stable',
        reasonMetrics: { goldEnd: r.goldEnd, streak, streakStartRound: streakStart },
        coaching_text: `You sat above ${INTEREST_CAP}g for ${streak} rounds in a row (starting ${streakStart}) without rolling or buying XP. Interest caps at 50g — every gold above that earns nothing extra. Plan a level-up or rolldown spike when you are overcap and your HP is not critical.${rerollNote}`,
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
    recommended: 'In most games, save gold until Stage 4 — early rolls destroy the interest snowball',
    reasonMetrics: { goldSpent },
    coaching_text: `You spent ${goldSpent}g rolling shops before Stage 3. This wasn't a detected reroll strategy, so that gold was better held: every 2g rolled below an interest bracket costs you +1 gold per round for the rest of the game. Pre-3-1 rolls compound into 8–20g of lost income by Stage 5.`,
  }];
}
