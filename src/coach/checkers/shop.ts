// SHOP_001: CANDIDATE (defined 2026-11-11, status in data/core/rules.core.json)
// — a third copy of a held pair was in a shop the player saw, while the
// fights were going badly, and it was not bought.
//
// Until shops were kept per roll (RoundSnapshot.shopsSeen), the coach could
// only guess what a roll had shown. This reads what was on screen: every
// shop GEP sent that round, so "a copy was shown" is a fact, not an estimate
// of the odds. It stays narrow on purpose. All of these must hold at once:
//   - a stage 3-5 player round, entered after losing 2 of the last 3 fights;
//   - the unit was a pair (two 1-star copies on board and bench) at the end
//     of the previous round, so one copy made a 2-star;
//   - a shop this round showed that unit;
//   - it was not bought this round, and it was still a pair at round end
//     (a copy bought from another shop would have made the 2-star);
//   - the round ended with at least the unit's price in gold.
// Thresholds were fixed before the rule was run against any match; it stays
// out of reports until games recorded after that date confirm it.

import type { MatchSnapshot, DecisionPoint, MetaData, RoundSnapshot } from '../../shared/types';
import { pairsHeld } from '../upgrades';
import { getChampionName } from '../../enrichment/meta-lookup';

const STAGES = [3, 4, 5];
const RECENT = 3;
const MIN_RECENT_LOSSES = 2;

function stageOf(label: string): number {
  return Number(label.split('-')[0]) || 0;
}

function lost(match: MatchSnapshot, r: RoundSnapshot): boolean {
  if (r.outcome) return r.outcome === 'loss';
  const i = match.rounds.indexOf(r);
  return i > 0 && r.health < match.rounds[i - 1].health;
}

export function checkShop(match: MatchSnapshot, meta: MetaData = {} as MetaData): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  const rounds = match.rounds;

  for (let i = 1; i < rounds.length; i++) {
    const r = rounds[i];
    if (r.type !== 'PVP' || !STAGES.includes(stageOf(r.label))) continue;
    if (!r.shopsSeen?.length) continue;

    const pairsBefore = pairsHeld(rounds[i - 1], meta);
    if (pairsBefore.length === 0) continue;

    const before = rounds.slice(0, i).filter(x => x.type === 'PVP').slice(-RECENT);
    const losses = before.filter(x => lost(match, x)).length;
    if (before.length < 2 || losses < MIN_RECENT_LOSSES) continue;

    const pairsAfter = new Set(pairsHeld(r, meta));
    const bought = new Set(r.bought ?? []);
    const shown = new Map<string, number>();
    for (const shop of r.shopsSeen) for (const id of shop) if (pairsBefore.includes(id)) shown.set(id, (shown.get(id) ?? 0) + 1);

    const passed = [...shown].filter(([id]) => {
      const price = meta.champions?.[id]?.tier;
      return !bought.has(id) && pairsAfter.has(id) && price !== undefined && price <= r.goldEnd;
    });
    if (passed.length === 0) continue;

    const names = passed.map(([id, n]) => `${getChampionName(id, meta)}${n > 1 ? ` (×${n})` : ''}`);
    const one = passed.length === 1;
    points.push({
      ruleId:   'SHOP_001',
      round:    r.label,
      category: 'rolling',
      severity: 'moderate',
      observed: `Shops at ${r.label} showed ${names.join(' and ')} while you held the pair; ${one ? 'it was' : 'they were'} not bought and you ended on ${r.goldEnd}g, after losing ${losses} of the last ${before.length} fights`,
      recommended: `A third copy of a held pair is a 2-star for the unit's price; when the fights are going badly, taking it is the usual line unless the unit is not one you plan to field`,
      reasonMetrics: { units: names.join(', '), copiesShown: passed.reduce((a, [, n]) => a + n, 0), goldEnd: r.goldEnd, recentLosses: losses, recentFights: before.length },
      coaching_text: `At ${r.label} you had lost ${losses} of the last ${before.length} player fights and held a pair of ${names.join(' and ')}. The shops the game sent that round (every roll, not only the last shop) showed ${one ? 'a third copy' : 'third copies'}, and ${one ? 'it was' : 'they were'} still ${one ? 'a pair' : 'pairs'} at round end with ${r.goldEnd}g in the bank. A 2-star from a pair is the cheapest upgrade in the game, so taking it is the usual line when the board is losing; passing can be right when the unit is bench fodder you plan to sell, or the gold was for a level the same round.`,
    });
  }
  return points;
}
