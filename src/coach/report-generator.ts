// Deterministic report generator. No LLM call exists in this codebase yet —
// this template-fills the CoachingReport shape directly from the rule
// engine's DecisionPoints. See instruction.md's "Implementation status" note.

import type { MatchBrief, CoachingReport, CoachingNote, DecisionPoint, DecisionCategory } from '../shared/types';

export async function generateCoachingReport(brief: MatchBrief): Promise<CoachingReport> {
  const notes = [...brief.resolvedNotes, ...brief.decisionPoints.map(toCoachingNote)]
    .sort((a, b) => roundToNumber(a.round_label) - roundToNumber(b.round_label));

  return {
    overall_placement: brief.placement,
    overall_grade: gradeFromPlacement(brief.placement, notes),
    tldr: buildTldr(brief, notes),
    notes,
    strengths: buildStrengths(brief, notes),
    round_trajectory: brief.roundTrajectory,
  };
}

function toCoachingNote(dp: DecisionPoint): CoachingNote {
  return {
    round_label: dp.round,
    category: dp.category,
    severity: dp.severity,
    tier: dp.tier,
    what_happened: dp.observed,
    what_should_have_happened: dp.recommended,
    why: dp.coaching_text ?? buildWhy(dp.reasonMetrics, dp.recommended),
  };
}

function buildWhy(reasonMetrics: Record<string, number | string>, recommended: string): string {
  const context = Object.entries(reasonMetrics)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  return context
    ? `Context: ${context}. The better line was to ${lowercaseFirst(recommended)}.`
    : `The better line was to ${lowercaseFirst(recommended)}.`;
}

function buildTldr(brief: MatchBrief, notes: CoachingNote[]): string {
  const themes = topCategories(notes);
  const noteCount = notes.length;
  const placementText = `You finished ${ordinal(brief.placement)} with ${noteCount} coaching note${noteCount === 1 ? '' : 's'}.`;
  if (themes.length === 0) {
    return `${placementText} The report stayed lightweight because the rule engine resolved most of the match.`;
  }
  return `${placementText} The main pressure points were ${joinList(themes)}.`;
}

// Categories with zero notes get credit here — these are actual performance
// signals, unlike commentary about how many notes the rule engine resolved.
const CLEAN_CATEGORY_STRENGTHS: Partial<Record<DecisionCategory, string>> = {
  econ:        'Economy management was clean — no missed interest or roll-discipline mistakes flagged.',
  leveling:    'Leveling timing stayed on curve all game — no late-level checkpoints flagged.',
  rolling:     'Rolling decisions were efficient — no over-rolling or under-rolling flagged.',
  hp:          'No dangerous-HP checkpoints — health stayed in a safe range at every stage transition.',
  positioning: 'Positioning adapted well — no repeated-carry or missing-frontline issues flagged.',
  items:       'Itemization stayed on track — the carry was appropriately itemized on schedule.',
  streak:      'Streak management was clean — no avoidable streak breaks flagged.',
  traits:      'Trait execution was efficient — no prolonged one-away breakpoints.',
};

function buildStrengths(brief: MatchBrief, notes: CoachingNote[]): string[] {
  const strengths: string[] = [];

  if (brief.placement <= 4) {
    strengths.push(`Converted the game into a top-${brief.placement} finish.`);
  }

  const hpValues = brief.roundTrajectory.map(r => r.hp);
  if (hpValues.length > 0) {
    const minHp = Math.min(...hpValues);
    if (minHp >= 60) {
      strengths.push(`Never dropped below ${minHp} HP the entire game — strong HP management kept you out of danger.`);
    }
  }

  const flaggedCategories = new Set(notes.map(n => n.category));
  for (const [category, label] of Object.entries(CLEAN_CATEGORY_STRENGTHS)) {
    if (strengths.length >= 3) break;
    if (!flaggedCategories.has(category as DecisionCategory)) strengths.push(label);
  }

  if (strengths.length === 0) {
    strengths.push(`Finished ${ordinal(brief.placement)} — the notes above are the clearest paths to a higher placement next game.`);
  }

  return strengths.slice(0, 3);
}

function gradeFromPlacement(placement: number, notes: CoachingNote[]): CoachingReport['overall_grade'] {
  const severityPenalty = notes.reduce((sum, note) => {
    if (note.severity === 'critical') return sum + 1.5;
    if (note.severity === 'moderate') return sum + 0.75;
    return sum + 0.25;
  }, 0);

  const score = placement + severityPenalty;
  if (score <= 2.5) return 'S';
  if (score <= 4.0) return 'A';
  if (score <= 5.5) return 'B';
  if (score <= 7.0) return 'C';
  return 'D';
}

function topCategories(notes: CoachingNote[]): string[] {
  const counts = new Map<DecisionCategory, { count: number; firstIndex: number }>();

  notes.forEach((note, index) => {
    const current = counts.get(note.category);
    if (!current) {
      counts.set(note.category, { count: 1, firstIndex: index });
      return;
    }
    current.count += 1;
  });

  return [...counts.entries()]
    .sort((left, right) => {
      const countDiff = right[1].count - left[1].count;
      if (countDiff !== 0) return countDiff;
      return left[1].firstIndex - right[1].firstIndex;
    })
    .slice(0, 3)
    .map(([category]) => CATEGORY_LABELS[category]);
}

const CATEGORY_LABELS: Record<DecisionCategory, string> = {
  econ: 'economy',
  streak: 'streak management',
  leveling: 'leveling',
  items: 'itemization',
  rolling: 'rolling',
  traits: 'traits',
  augments: 'augments',
  positioning: 'positioning',
  hp: 'HP management',
  board: 'board strength',
  comp: 'comp direction',
  set_mechanic: 'set mechanics',
};

function lowercaseFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function joinList(values: string[]): string {
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function ordinal(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1: return `${value}st`;
    case 2: return `${value}nd`;
    case 3: return `${value}rd`;
    default: return `${value}th`;
  }
}

function roundToNumber(label: string): number {
  const [stage, round] = label.split('-').map(Number);
  return (stage ?? 0) * 100 + (round ?? 0);
}
