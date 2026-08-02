// Links real, quantifiable causal chains across DecisionPoint categories that
// the rule engine already had the numbers for but previously reported as
// isolated, single-category notes. Each link here is a specific, targeted
// pairing chosen because there's a real mechanical reason the earlier note's
// numbers explain the later note's — not a generic "these happened near each
// other" correlation (see design/06-checkers-map.md's "Compounding patterns"
// section for the reasoning behind each one, and board.ts's 2026-08-02 fix
// history for why an unverified correlation claim is exactly what this file
// is careful not to repeat).
//
// Only appends a clause to the LATER note's coaching_text — never touches
// severity, ruleId, or reasonMetrics. This is presentation-layer synthesis of
// facts the engine already computed, not a new judgment call.

import type { DecisionPoint } from '../shared/types';

export function linkCompoundingPatterns(points: DecisionPoint[]): DecisionPoint[] {
  return points.map(p => {
    const clause = clauseFor(p, points);
    return clause ? { ...p, coaching_text: (p.coaching_text ?? '') + clause } : p;
  });
}

function find(points: DecisionPoint[], ruleId: string, round: string): DecisionPoint | undefined {
  return points.find(p => p.ruleId === ruleId && p.round === round);
}

function joinList(values: string[]): string {
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function clauseFor(p: DecisionPoint, all: DecisionPoint[]): string | undefined {
  switch (p.ruleId) {
    case 'ECON_001': return benchClutterClause(p, all);
    case 'HP_002':   return boardWeaknessClause(all, '4-1', ['3-1', '4-1']);
    case 'HP_003':   return boardWeaknessClause(all, '5-1', ['4-1', '5-1']);
    default:         return undefined;
  }
}

// ECON_001 (missed an interest bracket by a few gold) <- COMP_002 (bench
// clutter, real sell-value estimate — see checkers/comp.ts's 2026-08-02 fix)
// at the SAME round. Only links when the clutter's real gold-locked estimate
// is enough to have actually closed the gap — a quantified, checkable claim,
// not "these both happened this round."
function benchClutterClause(econ: DecisionPoint, all: DecisionPoint[]): string | undefined {
  const clutter = find(all, 'COMP_002', econ.round);
  if (!clutter) return undefined;

  const goldLocked = Number(clutter.reasonMetrics.goldLocked);
  const gap = Number(econ.reasonMetrics.gap);
  if (!(goldLocked >= gap)) return undefined;

  return ` That gap traces directly back to the ~${goldLocked}g of bench clutter already flagged this same round — selling even one held unit would have crossed the bracket.`;
}

// HP_002 (stage-4 entry below the safe HP threshold) / HP_003 (stage-5
// lethal zone) <- ITEM_003 (carry under-itemized, always evaluated at 4-1 —
// see checkers/items.ts) and/or BOARD_001 (weighted board-cost deficit at a
// stage-start checkpoint). Both are real structural-weakness signals that
// predate or coincide with the HP checkpoint being flagged; when either
// fired for this match, name it specifically instead of leaving the HP note
// to read as an isolated, unexplained bleed.
function boardWeaknessClause(all: DecisionPoint[], hpRound: string, boardRounds: string[]): string | undefined {
  const contributors: string[] = [];

  const item003 = find(all, 'ITEM_003', '4-1');
  if (item003) {
    contributors.push(`the under-itemized carry (${item003.reasonMetrics.itemCount} completed item(s)) flagged at 4-1`);
  }

  for (const round of boardRounds) {
    const board = find(all, 'BOARD_001', round);
    if (board) {
      contributors.push(`the board-cost deficit flagged at ${round} (${board.reasonMetrics.deficit} below benchmark)`);
    }
  }

  if (contributors.length === 0) return undefined;
  return ` This isn't isolated — it lines up with ${joinList(contributors)} already flagged this game. Structural board weakness at those checkpoints compounds directly into the HP bleed you're seeing at ${hpRound}.`;
}
