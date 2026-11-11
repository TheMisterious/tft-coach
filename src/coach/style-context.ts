// Where this match sat against the player's usual game.
//
// history-context.ts says whether one rule's finding recurs. This says what
// the player's usual game looks like at all (src/profile/style.ts) and where
// the match being reported on differed from it: HP entering stage 4 against
// their average, the scouting rate, the rolls at the windows, how contested
// their units ran. A difference is a fact about this match beside an average
// of the others, not a judgement of either.
//
// LAYERING: history comes in as an argument, as everywhere in the coach;
// nothing here touches persistence.

import type { FeatureVector, StyleRead } from '../shared/types';
import type { MatchHistoryEntry } from './history-context';
import { buildPlayerStyle, traitSpec, formatTrait, NOTABLE_DIFFERENCE } from '../profile/style';

export function readStyleForMatch(history: MatchHistoryEntry[], thisMatch?: FeatureVector): StyleRead | undefined {
  const style = buildPlayerStyle(history.map(h => ({ featureVector: h.featureVector, labels: h.labels, placement: h.placement })));
  if (!style) return undefined;

  const thisGame: string[] = [];
  if (thisMatch) {
    for (const t of style.traits) {
      const spec = traitSpec(t.key);
      const v = thisMatch[t.key];
      if (!spec || typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (Math.abs(v - t.mean) < NOTABLE_DIFFERENCE[spec.unit]) continue;
      thisGame.push(`${t.label}: ${formatTrait(spec.unit, v)} this game against your usual ${t.text} (${t.n} games).`);
    }
  }

  return { sampleSize: style.sampleSize, usual: style.summary, thisGame };
}
