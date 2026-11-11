// Deterministic report generator. No LLM call exists in this codebase yet —
// this template-fills the CoachingReport shape directly from the rule
// engine's DecisionPoints. See instruction.md's "Implementation status" note.

import type { MatchBrief, CoachingReport, CoachingNote, DecisionPoint, DecisionCategory, PriorityFix, Grade, Severity } from '../shared/types';
import { CATEGORY_LABELS } from './scoring';
import { getRuleEvidence } from './rules-loader';
import { isHabit } from './history-context';

export async function generateCoachingReport(brief: MatchBrief): Promise<CoachingReport> {
  const allNotes = [...brief.resolvedNotes, ...brief.decisionPoints.map(toCoachingNote)]
    .sort((a, b) => roundToNumber(a.round_label) - roundToNumber(b.round_label));

  // Only rules with a measured link to placement (scripts/rule-audit.ts) lead
  // the report and feed the priority fix; the rest are kept, collapsed. A brief
  // whose notes carry no evidence at all predates the audit and is left whole.
  const audited = allNotes.some(n => n.evidence);
  const notes = audited ? allNotes.filter(isMeasured) : allNotes;
  const otherNotes = audited ? allNotes.filter(n => !isMeasured(n)) : undefined;

  return {
    overall_placement: brief.placement,
    overall_grade: brief.overallGrade,
    category_grades: brief.categoryGrades,
    ...(brief.ungradedReasons ? { ungraded_reasons: brief.ungradedReasons } : {}),
    ...(brief.captureNotes?.length ? { capture_notes: brief.captureNotes } : {}),
    tldr: otherNotes ? buildAuditedTldr(brief, notes, otherNotes) : buildTldr(brief, notes),
    priority_fix: buildPriorityFix(brief, notes),
    notes,
    ...(otherNotes ? { other_notes: otherNotes } : {}),
    ...(brief.commonPatterns?.length ? { common_patterns: brief.commonPatterns } : {}),
    // Every note, measured or not, plus the rules that left only a common-
    // pattern line or nothing: a category is only credited as clean when
    // nothing at all was flagged in it.
    strengths: buildStrengths(brief, allNotes),
    round_trajectory: brief.roundTrajectory,
    plan: brief.plan,
    ...(brief.gameStory ? { game_story: brief.gameStory } : {}),
    ...(brief.fights?.length ? { fights: brief.fights } : {}),
    ...(brief.lobby ? { lobby: brief.lobby } : {}),
    ...(brief.decisions?.length ? { decisions: brief.decisions } : {}),
    ...(brief.style ? { style: brief.style } : {}),
  };
}

function isMeasured(note: CoachingNote): boolean {
  return note.evidence?.verdict === 'predictive';
}

const GRADE_RANK: Record<Grade, number> = { D: 4, C: 3, B: 2, A: 1, S: 0 };
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, moderate: 1, minor: 2 };

// Picks the single category dragging the match down the most (worst grade,
// ties broken by note count), then the most severe note within it — reduces
// a scattered note list to the one thing worth changing next game.
function buildPriorityFix(brief: MatchBrief, notes: CoachingNote[]): PriorityFix | undefined {
  const byCategory = new Map<DecisionCategory, CoachingNote[]>();
  for (const note of notes) {
    const list = byCategory.get(note.category) ?? [];
    list.push(note);
    byCategory.set(note.category, list);
  }
  if (byCategory.size === 0) return undefined;

  // An ungraded category ranks as S here: it never outranks a graded one.
  const rank = (cat: DecisionCategory) => GRADE_RANK[brief.categoryGrades[cat] ?? 'S'];
  const [category, categoryNotes] = [...byCategory.entries()].sort(([catA, notesA], [catB, notesB]) => {
    const gradeDiff = rank(catB) - rank(catA);
    if (gradeDiff !== 0) return gradeDiff;
    return notesB.length - notesA.length;
  })[0];

  // A habit outranks severity: the note that recurs across the player's
  // recent matches is the one practising changes, whatever this match's
  // single worst round was. Severity breaks the tie as before.
  const habitual = (n: CoachingNote) => !!n.habit && isHabit(n.habit);
  const topNote = [...categoryNotes].sort((a, b) =>
    Number(habitual(b)) - Number(habitual(a)) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0];

  return {
    category,
    occurrences: categoryNotes.length,
    action: topNote.what_should_have_happened,
    why: topNote.why,
    patterns: buildPatterns(categoryNotes, topNote),
    ...(topNote.habit ? {
      habit: `This also happened in ${topNote.habit.count} of your previous ${topNote.habit.sample} matches` +
        (habitual(topNote) ? ', so of everything in this report it is the pattern most worth practising.' : '.'),
    } : {}),
  };
}

// Every note in the priority category beyond the one `action`/`why` already
// quotes — deduplicated by round+what_happened (diversifyRepeatedNotes in
// brief-builder.ts already rewrites true repeats of the SAME rule into short
// "same pattern recurring" references, so anything still distinct here is a
// genuinely different underlying issue within the category, not a restated
// duplicate). Capped at 4 so a category with a dozen firings still reads as
// a short list, not a wall of text.
const MAX_PATTERNS = 4;

function buildPatterns(categoryNotes: CoachingNote[], topNote: CoachingNote): string[] | undefined {
  const seen = new Set([`${topNote.round_label}:${topNote.what_happened}`]);
  const patterns: string[] = [];

  for (const note of categoryNotes) {
    const key = `${note.round_label}:${note.what_happened}`;
    if (seen.has(key)) continue;
    seen.add(key);
    patterns.push(`${note.round_label} — ${note.what_happened}`);
    if (patterns.length >= MAX_PATTERNS) break;
  }

  return patterns.length > 0 ? patterns : undefined;
}

function toCoachingNote(dp: DecisionPoint): CoachingNote {
  return {
    round_label: dp.round,
    category: dp.category,
    severity: dp.severity,
    tier: dp.tier,
    evidence: getRuleEvidence(dp.ruleId),
    ...(dp.contributing ? { contributing: dp.contributing } : {}),
    ...(dp.habit ? { habit: dp.habit } : {}),
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
  const criticalCount = notes.filter(n => n.severity === 'critical').length;
  const placementText = `You finished ${ordinal(brief.placement)} with ${noteCount} coaching note${noteCount === 1 ? '' : 's'}.`;
  if (themes.length === 0) {
    return `${placementText} The report stayed lightweight because the rule engine resolved most of the match.`;
  }
  // Naming the critical count directly gives a concrete "how bad is this
  // really" signal alongside the theme list — a match with 8 minor notes and
  // a match with 2 critical ones both produce a short theme list, but they're
  // not the same severity of game.
  const criticalClause = criticalCount > 0
    ? ` ${criticalCount} of those ${criticalCount === 1 ? 'is' : 'are'} critical — start there.`
    : '';
  return `${placementText} The main pressure points were ${joinList(themes)}.${criticalClause}`;
}

function buildAuditedTldr(brief: MatchBrief, measured: CoachingNote[], other: CoachingNote[]): string {
  const placementText = `You finished ${ordinal(brief.placement)}.`;
  const otherClause = other.length > 0
    ? ` ${other.length} other observation${other.length === 1 ? '' : 's'} ${other.length === 1 ? 'is' : 'are'} listed below, from rules with no measured link to placement in audited games.`
    : '';
  if (measured.length === 0) {
    return `${placementText} None of the rules linked to placement in audited games fired this game.${otherClause}`;
  }
  const themes = topCategories(measured);
  return `${placementText} ${measured.length} note${measured.length === 1 ? '' : 's'} from rules linked to worse placement in audited games, in ${joinList(themes)} — start there.${otherClause}`;
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
  combat:      'Your itemized carry consistently led team damage in real fights — good positioning and target access.',
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

  // Clean means graded and unflagged — a category the match never let us
  // judge (see src/coach/coverage.ts) is not a strength. Always-on rules leave
  // no note, only a common-pattern line, so their categories come from the
  // brief: an 8th that missed interest twice was once told its economy was
  // clean, right under the line saying so.
  const flaggedCategories = new Set([...notes.map(n => n.category), ...(brief.flaggedCategories ?? [])]);
  for (const [category, label] of Object.entries(CLEAN_CATEGORY_STRENGTHS)) {
    if (strengths.length >= 3) break;
    const cat = category as DecisionCategory;
    if (brief.categoryGrades[cat] !== undefined && !flaggedCategories.has(cat)) strengths.push(label);
  }

  if (strengths.length === 0) {
    strengths.push(`Finished ${ordinal(brief.placement)} — the notes above are the clearest paths to a higher placement next game.`);
  }

  return strengths.slice(0, 3);
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
