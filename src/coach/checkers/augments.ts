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
import { metaAugmentClause } from '../meta-blend';
import { isComponent, unitItems } from './items';
import { boardUnits } from '../../ledger/merge';

const HP_CRISIS_THRESHOLD = 45;

// ─── Augment classification ──────────────────────────────────────────────────
// Two sources, checked in this order:
//
//   1. augments.json's hand-curated category buckets. Authoritative wherever
//      they exist — a human judged the augment's PRIMARY purpose, which is a
//      judgment call no text analysis can reproduce (measured: a keyword
//      classifier forced to pick one bucket agrees with curation only 75% of
//      the time, because real augments are genuinely multi-category).
//   2. augment-effects.json's derived flags, as a fallback for anything not
//      curated. These answer narrower, factual questions about Data Dragon's
//      real description text — does it grant gold/XP, does it grant an item —
//      each stored with the phrase that justified it. Measured against the
//      hand-curated buckets: economy 46/46, items 143/146, with 6/87 and 2/87
//      firing inside the combat bucket (all of them real).
//
// Curation only covers what someone got around to: 10 of the 22 augment ids
// picked across tests/goldens/ had no bucket at all, so AUGMENT_001 and
// AUGMENT_004 silently never evaluated them. See
// scripts/derive-augment-effects.js.

// Set 17's Realm of the Gods blessings arrive on the same picked_augment feed
// but are not augments in the sense these rules mean — they are the alignment
// reward, already judged by checkers/set17.ts from the match_info god_* fields.
// Skipped outright rather than counted as uncategorised.
function isGodAugment(aug: string, meta: MetaData): boolean {
  return meta.augmentEffects?.[aug]?.godAugment === true;
}

function isEconomyAugment(aug: string, meta: MetaData): boolean {
  if (isGodAugment(aug, meta)) return false;
  if (meta.augments?.economy?.includes(aug)) return true;
  return !!meta.augmentEffects?.[aug]?.economy;
}

function isItemAugment(aug: string, meta: MetaData): boolean {
  if (isGodAugment(aug, meta)) return false;
  if (meta.augments?.items?.includes(aug)) return true;
  return !!meta.augmentEffects?.[aug]?.items;
}

export function checkAugments(
  match: MatchSnapshot,
  meta: MetaData = {} as MetaData,
  context: MatchContext = NEUTRAL_CONTEXT
): DecisionPoint[] {
  return [
    ...checkEconAugmentOnCrisis(match, meta, context),
    ...checkMissingAugmentData(match, meta),
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

  for (let i = 0; i < match.rounds.length; i++) {
    const round = match.rounds[i];

    const prev     = match.rounds[i - 1];
    const prevSet  = new Set(prev?.augmentsPicked ?? []);
    const newAugs  = round.augmentsPicked.filter(a => !prevSet.has(a));

    for (const aug of newAugs) {
      if (!isEconomyAugment(aug, meta)) continue;
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
        recommended: 'Below 45 HP, a combat or item augment is the usual pick when one is offered — econ augments pay off over rounds you may not have',
        reasonMetrics: { augment: shortName, hp: round.health },
        coaching_text: byHp(round, {
          low: `At only ${round.health} HP you chose ${shortName}, an economy augment. Economy augments pay off over many rounds, and at ${round.health} HP there may not be many left. If a combat or item augment was on offer, it would have added board strength right away.${tempoNote}`,
          mid: `You picked ${shortName} (econ augment) at ${round.health} HP, under the 45 HP mark this rule watches. Econ augments suit a healthy board that is playing for gold; at ${round.health} HP the usual priority is stabilising the board, so a combat or item augment, if one was offered, is the common pick.${tempoNote}`,
        }) + metaAugmentClause(meta, aug),
      });
    }
  }

  return points;
}

// AUGMENT_002 — no augment data recorded in a bottom-4 finish
function checkMissingAugmentData(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  // God blessings don't count as augment data. They ride the same feed, so a
  // match that captured three blessings and zero real augments would otherwise
  // look fully covered while every augment rule had nothing to judge.
  const realAugments = match.augments.filter(a => !isGodAugment(a, meta));
  if (realAugments.length > 0) return [];
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

// Which champion an augment "designates" as its build-around target — checked
// two ways: `meta.augmentUnitGrants` (real, id-precise, auto-fetched from Data
// Dragon description text — see scripts/fetch-ddragon.js; covers augments.json's
// whole 'units' bucket, minus ones that genuinely grant 2+ champions and were
// left unresolved rather than guessed at) first, falling back to the narrow
// "_Augment_<Name>Carry" id-suffix pattern for anything the grants map missed
// (e.g. an older cached MetaData without it, or a name-shape match the
// description-text extraction didn't catch).
function findChampGrantedByAugment(augId: string, meta: MetaData): { id: string; champ: ChampionMeta } | undefined {
  const grantedId = meta.augmentUnitGrants?.[augId];
  if (grantedId) {
    const champ = meta.champions?.[grantedId];
    if (champ) return { id: grantedId, champ };
  }

  const m = CARRY_AUGMENT_RE.exec(augId);
  if (!m) return undefined;
  const wanted = normaliseName(m[1]);
  const entry = Object.entries(meta.champions ?? {}).find(([, c]) => normaliseName(c.name) === wanted);
  return entry ? { id: entry[0], champ: entry[1] } : undefined;
}

// AUGMENT_003 — picked a champion-designating augment but that champion
// either never reached the final board (benched/sold/never hit) or made it
// with fewer than 2 completed items, i.e. the augment's entire payoff went
// unused.
function checkCarryAugmentUnrealised(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const points: DecisionPoint[] = [];

  for (const augId of match.augments) {
    const found = findChampGrantedByAugment(augId, meta);
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
        recommended: `A carry augment for ${champ.name} usually pays off only when ${champ.name} is reachable this game, so it is worth either building toward or passing on`,
        reasonMetrics: { augment: augName, champion: champ.name },
        coaching_text: `You picked ${augName}, which specifically boosts ${champ.name} — but ${champ.name} never made your final board, so the augment added little to the board you finished with. Unless the plan changed for a good reason, a carry augment is usually taken when that carry is already likely.` + metaAugmentClause(meta, augId),
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
      recommended: `After a carry augment for ${champ.name}, items on ${champ.name} are usually what make it pay off`,
      reasonMetrics: { augment: augName, champion: champ.name, completedItems },
      coaching_text: `You picked ${augName}, built around ${champ.name}, but ${champ.name} finished the game with only ${completedItems} completed item(s). The augment's power spike needs ${champ.name} itemised to pay off — without items, you're only getting a fraction of what you drafted for.` + metaAugmentClause(meta, augId),
    });
  }

  return points;
}

// AUGMENT_004 — picked an item-shaping augment (augments.json 'items'
// category — Crests/Crowns/Circlets and similar) but no unit on the final
// board ended with 2+ completed items to actually receive that payoff.
function checkItemAugmentWithoutBuiltCarry(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const picked = match.augments.find(a => isItemAugment(a, meta));
  if (!picked) return [];

  const cells = boardUnits(match.finalBoard);
  const maxItems = Math.max(0, ...cells.map(c => unitItems(c).filter(id => !isComponent(id, meta)).length));
  if (maxItems >= 2) return [];

  const augName = getAugmentName(picked, meta);
  return [{
    ruleId:   'AUGMENT_004',
    round:    'match',
    category: 'augments',
    severity: 'moderate',
    observed: `Picked item-shaping augment ${augName} but no unit on the final board had 2+ completed items`,
    recommended: `Item-shaping augments like ${augName} usually need one unit holding 2+ completed items to pay off`,
    reasonMetrics: { augment: augName, maxItems },
    coaching_text: `You picked ${augName}, an item-shaping augment — those only pay off once a unit is actually itemised around them. Your best-built unit finished with just ${maxItems} completed item(s), so the augment's bonus went mostly unused.` + metaAugmentClause(meta, picked),
  }];
}
