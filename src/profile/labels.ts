// Set-specific vocabulary for a match — comp identity, traits, augments,
// econ style. Kept structurally separate from FeatureVector (feature-vector.ts)
// so this is the only part of a Player Trends record a new set changeover
// invalidates. Used for narrative grouping only ("this pattern shows up in
// your reroll games") — never fed into stats.ts's regression/clustering.

import type { MatchSnapshot, MatchContext, MatchLabels } from '../shared/types';

export function extractMatchLabels(match: MatchSnapshot, context: MatchContext): MatchLabels {
  return {
    setId: match.setId,
    matchedCompId: context.matchedComp?.id,
    finalTraits: context.plan?.finalTraits ?? [],
    augmentsPicked: match.augments,
    econStyle: context.plan?.econStyle ?? 'standard',
  };
}
