// The player's usual game, from their recent recorded matches.
//
// The trend model (trend-model.ts) asks which behaviours go with better or
// worse finishes. This asks a plainer question first: what does this player
// usually do? Which tempo they play, where their HP sits entering stage 4,
// how much they bank and roll, whether they scout, how contested their units
// run, how their board compares with the boards they meet. Averages of what
// was done over the last WINDOW matches, each with the number of matches it
// was measured in. No verdicts: the coach reads this to say where one match
// differed from the player's usual (src/coach/style-context.ts), and to
// prefer the habit over the one-off when it names a priority.

import type { FeatureVector, MatchLabels, PlayerStyle, StyleTrait } from '../shared/types';

export interface StyleRecord {
  featureVector: FeatureVector;
  labels?: MatchLabels;
  placement: number;
}

// Below this many matches an average is a couple of games, not a habit.
// Mirrors MIN_HISTORY in src/coach/history-context.ts.
export const STYLE_MIN_MATCHES = 5;
// Only the most recent matches count, so a changed habit shows within a
// few weeks rather than being averaged against a season of older games.
export const STYLE_WINDOW = 20;
const FAVOURITE_MIN_GAMES = 2;
const FAVOURITES_SHOWN = 3;

type Unit = 'ratio' | 'hp' | 'gold' | 'count';

interface TraitSpec { key: keyof FeatureVector; label: string; unit: Unit }

// Each is a FeatureVector field a player can recognise as a habit. Order is
// the order the summary reads in.
export const STYLE_TRAITS: TraitSpec[] = [
  { key: 'hpAtStage4Entry',            label: 'HP entering stage 4',                          unit: 'hp' },
  { key: 'econBankingPhaseRatio',      label: 'Rounds spent banking rather than spending',     unit: 'ratio' },
  { key: 'preStage3RollGold',          label: 'Gold rolled before stage 3',                   unit: 'gold' },
  { key: 'rolldownWindowRollGold',     label: 'Gold rolled at 3-2, 4-1 and 4-2',              unit: 'gold' },
  { key: 'overcapRoundCount',          label: 'Rounds idle above 50g',                         unit: 'count' },
  { key: 'carryItemCountAt41',         label: 'Completed items on the carry at 4-1',          unit: 'count' },
  { key: 'componentHoldRoundRatio',    label: 'Rounds holding 2+ unbuilt components',          unit: 'ratio' },
  { key: 'scoutedRoundRatio',          label: 'Stage 3+ rounds with a scout before the fight', unit: 'ratio' },
  { key: 'contestedCoreMaxHolders',    label: 'Opponents on your most contested unit',         unit: 'count' },
  { key: 'boardValueVsOpponentsRatio', label: 'Your board value against the boards you met',   unit: 'ratio' },
  { key: 'maxLossStreak',              label: 'Longest loss streak',                           unit: 'count' },
];

// How far a match has to sit from the player's average before the coach
// calls it different (src/coach/style-context.ts).
export const NOTABLE_DIFFERENCE: Record<Unit, number> = { ratio: 0.15, hp: 10, gold: 10, count: 1 };

export function formatTrait(unit: Unit, value: number): string {
  switch (unit) {
    case 'ratio': return `${Math.round(value * 100)}%`;
    case 'hp':    return `${Math.round(value)} HP`;
    case 'gold':  return `${Math.round(value)}g`;
    case 'count': return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
}

export function traitSpec(key: keyof FeatureVector): TraitSpec | undefined {
  return STYLE_TRAITS.find(t => t.key === key);
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * The player's usual game over their last STYLE_WINDOW recorded matches
 * (records oldest first), or undefined below STYLE_MIN_MATCHES.
 */
export function buildPlayerStyle(records: StyleRecord[], now: number = Date.now()): PlayerStyle | undefined {
  const recent = records.slice(-STYLE_WINDOW);
  if (recent.length < STYLE_MIN_MATCHES) return undefined;

  const tempo = { reroll: 0, fastTempo: 0, slowRoll: 0, standard: 0 };
  for (const r of recent) {
    const v = r.featureVector;
    if (v.isRerollComp) tempo.reroll++;
    else if (v.isFastTempo) tempo.fastTempo++;
    else if (v.isSlowRoll) tempo.slowRoll++;
    else tempo.standard++;
  }

  const traits: StyleTrait[] = [];
  for (const spec of STYLE_TRAITS) {
    const values = recent.map(r => r.featureVector[spec.key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (values.length < STYLE_MIN_MATCHES) continue;
    const m = mean(values);
    traits.push({ key: spec.key, label: spec.label, mean: m, n: values.length, text: formatTrait(spec.unit, m) });
  }

  const favouriteLines = favourites(recent);

  return {
    computedAt: now,
    sampleSize: recent.length,
    tempo,
    traits,
    favouriteLines,
    summary: summarise(recent.length, tempo, traits, favouriteLines),
  };
}

// The two traits a board finished on most, as "A/B", with how often and how
// well the player placed on them. Vocabulary only (labels), never a feature.
function favourites(recent: StyleRecord[]): PlayerStyle['favouriteLines'] {
  const byLine = new Map<string, number[]>();
  for (const r of recent) {
    const traits = r.labels?.finalTraits ?? [];
    if (traits.length === 0) continue;
    const line = [...traits].slice(0, 2).sort().join('/');
    byLine.set(line, [...(byLine.get(line) ?? []), r.placement]);
  }
  return [...byLine]
    .filter(([, places]) => places.length >= FAVOURITE_MIN_GAMES)
    .map(([line, places]) => ({ line, games: places.length, avgPlacement: mean(places) }))
    .sort((a, b) => b.games - a.games || a.avgPlacement - b.avgPlacement)
    .slice(0, FAVOURITES_SHOWN);
}

function summarise(n: number, tempo: PlayerStyle['tempo'], traits: StyleTrait[], favourites: PlayerStyle['favouriteLines']): string[] {
  const lines: string[] = [];
  const parts = [
    tempo.reroll ? `reroll lines in ${tempo.reroll}` : '',
    tempo.fastTempo ? `fast tempo in ${tempo.fastTempo}` : '',
    tempo.slowRoll ? `slow-roll in ${tempo.slowRoll}` : '',
    tempo.standard ? `a standard curve in ${tempo.standard}` : '',
  ].filter(Boolean);
  lines.push(`Over your last ${n} recorded games: ${parts.join(', ')}.`);
  for (const t of traits) lines.push(`${t.label}: ${t.text} on average (${t.n} games).`);
  for (const f of favourites) lines.push(`Most played: ${f.line} (${f.games} games, average finish ${f.avgPlacement.toFixed(1)}).`);
  return lines;
}
