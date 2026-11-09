// What a match's recording can and cannot support.
//
// Every checker reads RoundSnapshot fields that start as defaults (level 1,
// 0 gold, an empty board). When GEP never sends the real value, the default
// reads as a fact: a QA report on a deliberately poor game said "empty board
// slots at level 1" at 6-3 and graded economy and leveling S, from a ledger
// that held nothing but post-elimination spectating. Two things went wrong and
// this module owns the fix for both:
//
//  1. A note is only as good as its inputs — a category whose inputs were never
//     observed gets no notes and no grade.
//  2. No note is not a clean game. A category is graded only when the match
//     reached the rounds its rules look at; otherwise it is "not graded", never
//     an S by default.
//
// Snapshots without `capture` (hand-built in tests) count as fully observed,
// so only the round-reach checks apply to them.

import type { MatchSnapshot, DecisionCategory } from '../shared/types';
import { ALL_CATEGORIES } from './scoring';

function roundKey(label: string): number {
  const [stage, round] = label.split('-').map(Number);
  return (stage || 0) * 100 + (round || 0);
}

function reached(match: MatchSnapshot, label: string): boolean {
  const key = roundKey(label);
  return match.rounds.some(r => roundKey(r.label) >= key);
}

// Whether the recording is the player's own match at all. A ledger that never
// saw the player's gold or board, or saw them only after they were out, is
// spectating noise or a stray fragment — no report should come from it.
export function isUsableCapture(match: MatchSnapshot): boolean {
  if (match.rounds.length === 0) return false;
  const c = match.capture;
  if (!c) return true;
  if (!c.goldSeen || !c.boardSeen) return false;
  return !c.healthSeen || match.rounds.some(r => r.health > 0);
}

// Categories whose inputs the recording actually observed. A note outside this
// set is built on a default value, so the rule engine drops it.
export function observedCategories(match: MatchSnapshot): Set<DecisionCategory> {
  const c = match.capture;
  const seen = {
    gold:     c?.goldSeen     ?? true,
    health:   c?.healthSeen   ?? true,
    level:    c?.levelSeen    ?? true,
    board:    c?.boardSeen    ?? true,
    shop:     c?.shopSeen     ?? true,
    augments: c?.augmentsSeen ?? true,
  };

  const ok: Record<DecisionCategory, boolean> = {
    econ:         seen.gold,
    leveling:     seen.level,
    rolling:      seen.shop && seen.gold,
    streak:       true,
    hp:           seen.health,
    // BOARD_003 counts empty slots against the level.
    board:        seen.board && seen.level,
    items:        seen.board,
    traits:       seen.board,
    comp:         seen.board,
    positioning:  seen.board,
    combat:       seen.board,
    augments:     seen.augments,
    set_mechanic: true,
  };

  return new Set(ALL_CATEGORIES.filter(cat => ok[cat]));
}

// Categories this match can be judged on: observed (above), and the match got
// to the rounds that category's rules look at.
export function gradableCategories(match: MatchSnapshot): Set<DecisionCategory> {
  const observed = observedCategories(match);
  const stage2 = reached(match, '2-1');

  const reach: Record<DecisionCategory, boolean> = {
    econ:         stage2,
    // Every LEVEL_* checkpoint is 3-1 or later.
    leveling:     reached(match, '3-1'),
    rolling:      stage2,
    streak:       match.rounds.some(r => r.outcome !== undefined),
    hp:           stage2,
    board:        stage2,
    items:        stage2,
    traits:       stage2,
    comp:         stage2,
    positioning:  stage2,
    combat:       match.rounds.some(r => r.battleStats?.own?.length),
    // A hand-built snapshot with no augments has nothing to grade either.
    augments:     match.augments.length > 0,
    // Only Set 17 has set-mechanic rules (checkers/set17.ts), and they need
    // the god picks GEP sometimes withholds.
    set_mechanic: match.setId === 'set17' && match.godPicks.length > 0,
  };

  return new Set(ALL_CATEGORIES.filter(cat => observed.has(cat) && reach[cat]));
}

// The overall grade folds every category into one letter, so it needs the
// whole match: the start (stage 1-2 decisions), the core signals, and a real
// placement rather than the placeholder 8th.
export function canGradeOverall(match: MatchSnapshot): boolean {
  if (match.placementSource === 'none') return false;
  const c = match.capture;
  if (!c) return true;
  return !c.missedStart && c.goldSeen && c.healthSeen && c.levelSeen && c.boardSeen;
}

// What the report says about gaps, in the player's terms.
export function captureNotes(match: MatchSnapshot): string[] {
  const notes: string[] = [];
  const c = match.capture;

  if (c?.missedStart && c.firstRound) {
    notes.push(`Recording started at ${c.firstRound}, so nothing before it was checked and the match has no overall grade.`);
  }
  if (match.placementSource === 'none') {
    notes.push('The game never reported your final placement, so the match has no overall grade.');
  }
  if (c && !c.levelSeen) {
    notes.push('The game never reported your level, so leveling and board-size checks were skipped.');
  }
  if (c && !c.augmentsSeen) {
    notes.push('The game did not report your augment picks for this match, so augments are not graded.');
  }
  return notes;
}
