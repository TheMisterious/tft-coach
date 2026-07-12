// Augment checker
//
// GEP captures picks only — not what was offered — so we can only reason about
// what was chosen, never what was passed.
//
// AUGMENT_001: Economy augment chosen while critically low HP (<45)
// AUGMENT_002: No augment data at all by stage 4 in a bottom-4 finish (data gap warning)
// AUGMENT_003: A "<Champion>Carry"-style augment was picked but that champion
//              never made the final board, or made it under-itemised
// AUGMENT_004: An item-shaping augment (augments.json 'items' category) was
//              picked but no unit on the final board ended with 2+ completed items
//
// Detection timing: confirmed against 23 real ledgers that GEP's
// me.picked_augment update does NOT land in the same round snapshot as the
// actual pick round (2-1/3-2/4-2) — it arrives several rounds late, and
// which round varies per match. Diffing augmentsPicked only at those three
// fixed labels (the original approach) meant the new pick almost never
// showed up there, so AUGMENT_001 essentially never fired. Fix: diff every
// round against its predecessor and react to a new augment wherever it
// actually appears, using the HP at that detection round (a same-or-later
// snapshot of HP than the true pick moment — the gap only means we may
// occasionally under-flag a crisis that recovered before detection, never
// over-flag a healthy pick as a crisis one).

import type { MatchSnapshot, DecisionPoint, RoundSnapshot, MetaData, MatchContext, ChampionMeta } from '../../shared/types';
import { getAugmentName } from '../../enrichment/meta-lookup';
import { NEUTRAL_CONTEXT } from '../match-context';
import { isComponent, unitItems } from './items';

const HP_CRISIS_THRESHOLD = 45;

export function checkAugments(
  match: MatchSnapshot,
  meta: MetaData = {} as MetaData,
  context: MatchContext = NEUTRAL_CONTEXT
): DecisionPoint[] {
  return [
    ...checkEconAugmentOnCrisis(match, meta, context),
    ...checkMissingAugmentData(match),
    ...checkCarryAugmentUnrealised(match, meta),
    ...checkItemAugmentWithoutBuiltCarry(match, meta),
  ];
}

// AUGMENT_001 — picked an econ augment when already bleeding HP. Fast-tempo
// games (see MatchContext.isFastTempo) get a sharper message: that game
// ended up leveling fast specifically because it forwent long-term econ for
// board power, so an econ pick under HP pressure is doubly counter to how
// the game actually played out, not just generically risky.
function checkEconAugmentOnCrisis(match: MatchSnapshot, meta: MetaData, context: MatchContext): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  const economyAugments = new Set(meta.augments?.economy ?? []);

  for (let i = 0; i < match.rounds.length; i++) {
    const round = match.rounds[i];

    const prev     = match.rounds[i - 1];
    const prevSet  = new Set(prev?.augmentsPicked ?? []);
    const newAugs  = round.augmentsPicked.filter(a => !prevSet.has(a));

    for (const aug of newAugs) {
      if (!economyAugments.has(aug)) continue;
      if (round.health >= HP_CRISIS_THRESHOLD) continue;

      const shortName = getAugmentName(aug, meta);
      const tempoNote = context.isFastTempo
        ? ` This game also ended up on a fast-leveling curve — once you're committed to buying levels instead of playing for long-term gold, an economy augment's payoff window shrinks even further than the HP alone suggests.`
        : '';

      points.push({
        ruleId:   'AUGMENT_001',
        round:    round.label,
        category: 'augments',
        severity: round.health < 30 ? 'critical' : 'moderate',
        observed: `Picked economy augment ${shortName} at ${round.health} HP`,
        recommended: 'Below 45 HP, prioritise combat or item augments — econ augments pay off over time, but you may not have time',
        reasonMetrics: { augment: shortName, hp: round.health },
        coaching_text: byHp(round, {
          low: `At only ${round.health} HP you chose ${shortName}, an economy augment. Economy augments compound over many rounds — but at ${round.health} HP you are likely to be eliminated before that income materialises. A combat augment here would have added immediate board strength when you needed it most.${tempoNote}`,
          mid: `You picked ${shortName} (econ augment) at ${round.health} HP — below the safe threshold. Econ augments are correct when you're healthy and econ'ing; at ${round.health} HP the priority shifts toward stabilising your board with a combat or item augment.${tempoNote}`,
        }),
      });
    }
  }

  return points;
}

// AUGMENT_002 — no augment data recorded in a bottom-4 finish
function checkMissingAugmentData(match: MatchSnapshot): DecisionPoint[] {
  if (match.augments.length > 0) return [];
  if (match.finalPlacement <= 4) return []; // top-4 finish is fine even without data

  return [{
    ruleId:   'AUGMENT_002',
    round:    'match',
    category: 'augments',
    severity: 'minor',
    observed: 'No augment picks were recorded for this match',
    recommended: 'Augment data was unavailable — coaching on augment decisions is skipped for this match',
    reasonMetrics: { augmentsRecorded: 0 },
    coaching_text: 'GEP did not capture augment picks for this match, so augment decisions cannot be evaluated. This typically happens when the game ends very early or GEP had a registration delay. Future matches should capture this data normally.',
  }];
}

function byHp(round: RoundSnapshot, t: { low: string; mid: string }): string {
  return round.health < 30 ? t.low : t.mid;
}

// Matches the set-wide "<Champion>Carry" augment naming convention (e.g.
// TFT17_Augment_AatroxCarry, TFT17_Augment_JaxCarry) — not every set-mechanics
// augment fits this shape, but every one that does is unambiguous.
const CARRY_AUGMENT_RE = /_Augment_([A-Za-z]+)Carry$/;

// Champion display names can contain punctuation/spaces the augment id strips
// (e.g. "Dr. Mundo" -> "DrMundoCarry") — compare on letters only.
function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

function findChampByCarryAugment(augId: string, meta: MetaData): { id: string; champ: ChampionMeta } | undefined {
  const m = CARRY_AUGMENT_RE.exec(augId);
  if (!m) return undefined;
  const wanted = normaliseName(m[1]);
  const entry = Object.entries(meta.champions ?? {}).find(([, c]) => normaliseName(c.name) === wanted);
  return entry ? { id: entry[0], champ: entry[1] } : undefined;
}

// AUGMENT_003 — picked a "<Champion>Carry" augment but that champion either
// never reached the final board (benched/sold/never hit) or made it with
// fewer than 2 completed items, i.e. the augment's entire payoff went unused.
function checkCarryAugmentUnrealised(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const points: DecisionPoint[] = [];

  for (const augId of match.augments) {
    const found = findChampByCarryAugment(augId, meta);
    if (!found) continue;
    const { id: champId, champ } = found;
    const augName = getAugmentName(augId, meta);

    const cell = Object.values(match.finalBoard).find(c => c?.name === champId);
    if (!cell) {
      points.push({
        ruleId:   'AUGMENT_003',
        round:    'match',
        category: 'augments',
        severity: 'moderate',
        observed: `Picked ${augName} but ${champ.name} was not on the final board`,
        recommended: `Build toward ${champ.name} after picking a carry-designating augment, or don't take it if ${champ.name} isn't reachable this game`,
        reasonMetrics: { augment: augName, champion: champ.name },
        coaching_text: `You picked ${augName}, which specifically boosts ${champ.name} — but ${champ.name} never made your final board. That augment's entire value was left on the table; a generic augment would have helped regardless of your final comp.`,
      });
      continue;
    }

    const completedItems = unitItems(cell).filter(id => !isComponent(id, meta)).length;
    if (completedItems >= 2) continue;

    points.push({
      ruleId:   'AUGMENT_003',
      round:    'match',
      category: 'augments',
      severity: 'minor',
      observed: `Picked ${augName} but ${champ.name} finished with only ${completedItems} completed item(s)`,
      recommended: `Prioritise items on ${champ.name} once you've committed to a carry-designating augment`,
      reasonMetrics: { augment: augName, champion: champ.name, completedItems },
      coaching_text: `You picked ${augName}, built around ${champ.name}, but ${champ.name} finished the game with only ${completedItems} completed item(s). The augment's power spike needs ${champ.name} itemised to pay off — without items, you're only getting a fraction of what you drafted for.`,
    });
  }

  return points;
}

// AUGMENT_004 — picked an item-shaping augment (augments.json 'items'
// category — Crests/Crowns/Circlets and similar) but no unit on the final
// board ended with 2+ completed items to actually receive that payoff.
function checkItemAugmentWithoutBuiltCarry(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const itemAugments = new Set(meta.augments?.items ?? []);
  const picked = match.augments.find(a => itemAugments.has(a));
  if (!picked) return [];

  const cells = Object.values(match.finalBoard).filter(c => c?.name && c.name !== '0');
  const maxItems = Math.max(0, ...cells.map(c => unitItems(c).filter(id => !isComponent(id, meta)).length));
  if (maxItems >= 2) return [];

  const augName = getAugmentName(picked, meta);
  return [{
    ruleId:   'AUGMENT_004',
    round:    'match',
    category: 'augments',
    severity: 'moderate',
    observed: `Picked item-shaping augment ${augName} but no unit on the final board had 2+ completed items`,
    recommended: `Item-shaping augments like ${augName} need a built carry to pay off — commit items to one unit early`,
    reasonMetrics: { augment: augName, maxItems },
    coaching_text: `You picked ${augName}, an item-shaping augment — those only pay off once a unit is actually itemised around them. Your best-built unit finished with just ${maxItems} completed item(s), so the augment's bonus went mostly unused.`,
  }];
}
