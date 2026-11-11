// Self-relative comparison: does this mistake keep happening?
//
// Every checker judges one match against a fixed standard, and lobby-context.ts
// adds the other seven players. Neither can answer the question a player
// actually improves from: "is this a bad round, or is this my habit?" A note
// saying "you ended 2g short of a bracket at 3-1" is a measurement. The same
// note saying "and this is the 7th of your last 10 games where that happened"
// is coaching — it separates variance from the one leak worth practising.
//
// The data already exists. src/profile/feature-vector.ts extracts ~30 numeric
// behaviours per match and src/persistence/db.ts stores them; they were built
// for the Player Trends model and nothing in the report has ever read them.
//
// LAYERING: this module takes history as a plain argument and never imports
// src/persistence. Architectural invariant 5 (design/01-architecture-overview.md)
// says persistence never becomes part of the coaching logic, so the caller that
// already owns storage — src/background/main.ts — loads the records and passes
// them in. That also keeps the whole rule engine a pure function of its inputs,
// which is what makes tests/replay-harness.ts able to replay a match at all.

import type { DecisionPoint, FeatureVector, MatchLabels } from '../shared/types';

/**
 * One prior match's behavioural fingerprint. Structurally compatible with
 * persistence's FeatureVectorRecord, so callers can pass those straight in.
 * `labels` (the set vocabulary: traits, econ style) is read only by the
 * player style (src/profile/style.ts), never by a rule.
 */
export interface MatchHistoryEntry {
  matchId: string;
  featureVector: FeatureVector;
  placement: number;
  labels?: MatchLabels;
}

// Below this many prior matches, "3 of your last 4" is noise dressed as a
// pattern. Mirrors MIN_PAIRS_FOR_CORRELATION in src/profile/trend-model.ts,
// which draws the same line for the same reason.
const MIN_HISTORY = 5;

// A single prior occurrence is a coincidence. Two is the first point at which
// "again" is a fair word.
const MIN_OCCURRENCES = 2;

// Only the most recent matches count. A leak the player fixed four months ago
// should stop being mentioned, and a 200-match lifetime rate would hide that.
const WINDOW = 10;

// At or above this share of the window, the note is upgraded from "this
// recurs" to "this is one of your most repeated leaks", and the report's
// priority fix prefers it (src/coach/report-generator.ts).
export const HABIT_RATE = 0.6;

/**
 * Whether a past match exhibited the behaviour a given rule flags.
 *
 * Each predicate mirrors its rule's OWN condition and threshold rather than
 * inventing a parallel one — HP_002 fires under 60 HP at 4-1, so its predicate
 * asks exactly that. A predicate that drifted from its rule would produce the
 * worst possible output: a confident, specific frequency claim about something
 * subtly different from what the note above it just said.
 *
 * Rules absent from this table simply get no history clause. That is the
 * correct outcome for anything with no matching feature (the AUGMENT_* family,
 * the SET17_* family, TRAIT_001), and deliberately so for LOBBY_001/LOBBY_002 —
 * their comparison is to a different lobby every game, so a frequency across
 * matches would be comparing incomparable tables.
 */
const RECURRENCE: Record<string, (v: FeatureVector) => boolean> = {
  ECON_001:     v => v.interestMissedRoundCount > 0,
  ECON_002:     v => v.overcapRoundCount > 0,
  ECON_003:     v => v.preStage3RollGold > 10,
  ROLL_003:     v => v.postStabilizationOverrollGold > 0,
  ROLL_004:     v => v.level6RollDuringLossStreakGold > 0,
  STREAK_001:   v => v.streakBreakCount > 0,
  ITEM_001:     v => v.componentHoldRoundRatio > 0,
  ITEM_003:     v => v.carryItemCountAt41 < 2,
  ITEM_005:     v => v.componentConversionsMissedCount > 0,
  POSITION_001: v => v.positioningNoAdjustStreakAvg >= 2,
  POSITION_002: v => v.noFrontlineRoundRatio > 0,
  HP_002:       v => v.hpAtStage4Entry !== null && v.hpAtStage4Entry < 60,
  HP_003:       v => v.hpAtStage5Entry !== null && v.hpAtStage5Entry <= 25,
  LEVEL_003:    v => v.level8DeltaRounds !== null && v.level8DeltaRounds > 0,
  COMBAT_001:   v => v.carryDamageLeadRate !== null && v.carryDamageLeadRate < 0.5,
  // The 2026-11-11 candidates: each feature counts that rule's own firings,
  // or the exact state it reads (no scout in any stage 3+ round with the feed).
  SHOP_001:     v => v.pairCopiesPassedCount > 0,
  LOBBY_003:    v => v.lowestHpWithBankRounds > 0,
  ITEM_006:     v => v.itemOfferPriorityMissCount > 0,
  SCOUT_001:    v => v.scoutedRoundRatio !== null && v.scoutedRoundRatio === 0,
};

interface Recurrence {
  count: number;
  sample: number;
}

function recurrenceFor(ruleId: string, history: MatchHistoryEntry[]): Recurrence | undefined {
  const predicate = RECURRENCE[ruleId];
  if (!predicate) return undefined;

  const window = history.slice(-WINDOW);
  if (window.length < MIN_HISTORY) return undefined;

  let count = 0;
  for (const entry of window) {
    try {
      if (predicate(entry.featureVector)) count++;
    } catch {
      // A record from an older feature schema can be missing a field the
      // predicate reads. Skip it rather than let one bad row abort the report —
      // db.ts already filters stale schemaVersions, this is belt-and-braces.
    }
  }

  if (count < MIN_OCCURRENCES) return undefined;
  return { count, sample: window.length };
}

/**
 * One sentence placing this note in the player's own history, or '' when there
 * isn't enough evidence to say anything. Callers may concatenate freely.
 *
 * Counts prior matches only — the match being reported on is not in `history`,
 * so "3 of your last 10" always means three OTHER games, never this one padding
 * its own statistic.
 */
export function historyClause(ruleId: string | undefined, history: MatchHistoryEntry[]): string {
  if (!ruleId) return '';
  const recurrence = recurrenceFor(ruleId, history);
  return recurrence ? clauseFor(recurrence) : '';
}

export function isHabit(recurrence: Recurrence): boolean {
  return recurrence.count / recurrence.sample >= HABIT_RATE;
}

function clauseFor(recurrence: Recurrence): string {
  const { count, sample } = recurrence;
  return isHabit(recurrence)
    ? ` This is a habit, not a one-off: it also happened in ${count} of your previous ${sample} matches. Of everything in this report, it is the pattern most worth practising deliberately.`
    : ` For context, this also happened in ${count} of your previous ${sample} matches.`;
}

/**
 * Appends the history clause to every note whose rule has a matching feature.
 * Only `coaching_text` is touched — severity, ruleId and reasonMetrics are left
 * alone, so scoring and the rule-coverage tests are unaffected.
 *
 * At most one note per rule is annotated (the first, which after the engine's
 * sort is the most severe/earliest occurrence). Repeating "this happened in 7
 * of your last 10" under all three capped firings of the same rule would be the
 * exact repetition brief-builder.ts's diversifyRepeatedNotes exists to prevent.
 */
export function attachHistoryContext(
  points: DecisionPoint[],
  history: MatchHistoryEntry[]
): DecisionPoint[] {
  if (history.length < MIN_HISTORY) return points;

  const annotated = new Set<string>();

  return points.map(p => {
    if (!p.ruleId || !p.coaching_text || annotated.has(p.ruleId)) return p;

    const recurrence = recurrenceFor(p.ruleId, history);
    if (!recurrence) return p;

    annotated.add(p.ruleId);
    return { ...p, coaching_text: p.coaching_text + clauseFor(recurrence), habit: recurrence };
  });
}
