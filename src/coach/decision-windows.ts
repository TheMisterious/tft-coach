// The spot at each round where a plan is usually set, read whole.
//
// A checker asks one question about one thing. A coach looking over a
// shoulder at 3-2 asks all of them at once: how many losses are left, what
// the bank is, where the level sits against the table, what the last three
// fights looked like, which pairs are one copy away, who else is on the
// carry, and what the shops this round actually showed. This module reads
// that spot for 2-1, 3-2, 4-1, 4-2 and 5-1 (and the round the player went
// out), then lists the usual lines from it with the condition each one needs.
//
// OBSERVATIONS AND CONDITIONAL LINES, NEVER A VERDICT. Every line is "the
// usual answer from this spot is X, unless Y". The recording shows what the
// player did; it cannot show what the next shop would have held or what the
// player knew, so nothing here says the choice made was wrong.

import type { MatchSnapshot, MetaData, RoundSnapshot, DecisionWindow, DecisionWindowState, LobbyRead } from '../shared/types';
import { loadRuleNetwork, lossesLeft, type RuleNetwork } from './rule-network';
import { readFights, readBoard, describeBoard, outclassed, isComponent, stageOf } from './fights';
import { pairsHeld, upgradeCopiesAcrossShops } from './upgrades';
import { standingFor } from './lobby-context';
import { getChampionName, unitPrevalence } from '../enrichment/meta-lookup';
import { readLobby } from './lobby-map';
import { boardUnits } from '../ledger/merge';

const WINDOWS: Record<string, string> = {
  '2-1': 'first augment, the opener set',
  '3-2': 'second augment, first roll-down window',
  '4-1': 'stage 4 entry, level 7 window',
  '4-2': 'third augment, level 8 window',
  '5-1': 'stage 5 entry, losses get dearer',
};
const RECENT = 3;

function roundNumber(label: string): number {
  const [s, r] = label.split('-').map(Number);
  return (s || 0) * 100 + (r || 0);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function readDecisionWindows(match: MatchSnapshot, meta: MetaData, net: RuleNetwork = loadRuleNetwork(match.setId), lobby: LobbyRead | undefined = readLobby(match, meta)): DecisionWindow[] {
  const fights = readFights(match, meta);
  const out: DecisionWindow[] = [];
  const labels = Object.keys(WINDOWS).filter(l => match.rounds.some(r => r.label === l));
  const last = match.rounds[match.rounds.length - 1];
  const knockedOut = last && match.finalPlacement > 1 && match.placementSource !== 'none' && stageOf(last.label) >= 2;
  if (knockedOut && !labels.includes(last.label)) labels.push(last.label);

  for (const label of labels.sort((a, b) => roundNumber(a) - roundNumber(b))) {
    const i = match.rounds.findIndex(r => r.label === label);
    const r = match.rounds[i];
    const state = readState(match, i, meta, net, fights, lobby);
    const did = whatHappened(r, meta);
    const title = WINDOWS[label] ?? (label === last?.label ? 'the round you went out' : '');
    out.push({ round: label, stage: stageOf(label), title, state, did, lines: usualLines(state, r, did) });
  }
  return out;
}

function readState(match: MatchSnapshot, i: number, meta: MetaData, net: RuleNetwork, fights: ReturnType<typeof readFights>, lobby?: LobbyRead): DecisionWindowState {
  const r = match.rounds[i];
  const stage = stageOf(r.label);
  const hp = i > 0 ? match.rounds[i - 1].health : r.health;
  const base = net.values.stageBase ?? {};
  const left = lossesLeft(hp, stage, base);
  // The roster as the round was entered: a round's own roster is read after
  // its fight, which would rank the player by the HP the fight just took.
  const entering = i > 0 && match.rounds[i - 1].lobby?.length ? match.rounds[i - 1] : r;
  const s = standingFor(entering);
  const me = entering.lobby?.find(p => p.isLocal);
  const below = me ? (entering.lobby ?? []).filter(p => !p.isLocal && p.health > 0 && p.health < me.health).length : undefined;

  const board = readBoard(r.board, meta);
  const loose = board.components + r.benchItems.filter(id => id && isComponent(id, meta)).length;
  const pairs = pairsHeld(r, meta).map(id => getChampionName(id, meta));

  const before = fights.filter(f => roundNumber(f.round) < roundNumber(r.label)).slice(-RECENT);
  const losses = before.filter(f => f.result === 'loss').length;
  const outclassedCount = before.filter(f => f.result === 'loss' && outclassed(f)).length;
  const recentFights = before.length === 0
    ? 'no player fights recorded before this round'
    : `lost ${losses} of the last ${plural(before.length, 'player fight')}${outclassedCount ? ` (their board was clearly stronger in ${outclassedCount})` : ''}`;

  const contested = (lobby?.opponents ?? []).flatMap(o => o.contested.filter(c => roundNumber(c.round) <= roundNumber(r.label)).map(c => ({ ...c, by: o.name })));
  const byUnit = new Map<string, { name: string; by: Set<string> }>();
  for (const c of contested) {
    const e = byUnit.get(c.id) ?? { name: c.name, by: new Set<string>() };
    e.by.add(c.by);
    byUnit.set(c.id, e);
  }
  // With the set's Riot records, say how usual contest is for the unit.
  const describe = (id: string, e: { name: string; by: Set<string> }) => {
    const p = unitPrevalence(id, meta);
    return `${e.name} (${plural(e.by.size, 'opponent')}${p ? `, on ${Math.round(p.share * 100)}% of top-player boards` : ''})`;
  };

  return {
    hp,
    ...(left !== undefined ? { lossesLeft: left } : {}),
    ...(s ? { hpRank: s.hpRank, alive: s.alive, medianLevel: s.medianOpponentLevel, levelRank: s.levelRank } : {}),
    ...(below !== undefined ? { playersBelow: below } : {}),
    gold: r.goldStart,
    goldEnd: r.goldEnd,
    level: r.level,
    streak: r.streakType === 'none' || r.streakCount === 0 ? 'none' : plural(r.streakCount, r.streakType === 'win' ? 'win' : 'loss', r.streakType === 'win' ? 'wins' : 'losses'),
    board: describeBoard(board),
    twoStars: board.twoStars,
    finishedItems: board.items,
    looseComponents: loose,
    pairs,
    recentFights,
    recentLosses: losses,
    contested: [...byUnit].sort((a, b) => b[1].by.size - a[1].by.size).map(([id, e]) => describe(id, e)),
  };
}

function whatHappened(r: RoundSnapshot, meta: MetaData): string[] {
  const did: string[] = [];
  const rolled = r.rollsSpent * 2;
  const shops = r.shopsSeen?.length ?? 0;
  did.push(rolled > 0
    ? `Rolled ${plural(r.rollsSpent, 'time')} (${rolled}g)${shops ? `, ${plural(shops, 'shop')} seen` : ''}; ${r.goldStart}g → ${r.goldEnd}g.`
    : `No rolls; ${r.goldStart}g → ${r.goldEnd}g.`);
  if (r.xpBought) did.push(`Bought XP (level ${r.level} at round end).`);
  const bought = (r.bought ?? []).map(id => getChampionName(id, meta));
  if (bought.length) did.push(`Bought ${bought.join(', ')}.`);
  const copies = upgradeCopiesAcrossShops(r, meta);
  const offered = [...copies.values()].reduce((a, b) => a + b, 0);
  if (offered > 0) {
    const top = [...copies].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, n]) => `${getChampionName(id, meta)} ×${n}`).join(', ');
    // Units bought this round are held by round end, so their copies count
    // among those shown; say how many of the shown copies were taken.
    const taken = (r.bought ?? []).filter(id => copies.has(id)).length;
    did.push(`Shops showed ${plural(offered, 'copy', 'copies')} of units you held (${top}); you bought ${taken} of them.`);
  }
  if (r.scouted !== undefined) {
    did.push(r.scouted.length > 0 ? `Looked at ${plural(r.scouted.length, 'other board')} before the fight.` : 'Looked at no other board before the fight.');
  }
  const units = boardUnits(r.board).length;
  if (units < r.level && r.type === 'PVP') did.push(`Fielded ${units} of ${r.level} slots.`);
  return did;
}

// The usual lines from this spot. Each is conditional on the state that
// makes it the usual one, and names the case where it is not.
function usualLines(s: DecisionWindowState, r: RoundSnapshot, did: string[]): string[] {
  const lines: string[] = [];
  const stage = stageOf(r.label);
  const losing = s.recentLosses >= 2;
  const bank = s.gold;
  const behindLevel = s.medianLevel !== undefined && s.level < s.medianLevel;
  const hpLead = s.alive !== undefined && s.hpRank !== undefined && s.hpRank <= Math.ceil(s.alive / 2);
  const spent = r.rollsSpent > 0 || r.xpBought;

  if (s.lossesLeft !== undefined && s.lossesLeft <= 2 && stage >= 3) {
    lines.push(`About ${plural(s.lossesLeft, 'loss', 'losses')} left at this stage's prices: the usual line is to spend what the next fight needs now, unless nothing in the pool can change it.`);
  }
  if (stage >= 3 && losing && bank >= 50 && !spent) {
    lines.push(`Lost most of the recent fights with ${bank}g banked and nothing spent here: above 50 the gold earns no interest, so a level or a roll is the usual use of the excess, unless a named roll-down round is next.`);
  }
  if (s.pairs.length >= 3 && bank >= 30 && r.rollsSpent < 5) {
    lines.push(`Holding ${s.pairs.length} pairs (${s.pairs.slice(0, 3).join(', ')}): each is one copy from a 2-star, so a short roll of about 10g is cheap here, unless the pairs are not units you plan to field.`);
  }
  if (behindLevel && !hpLead && stage >= 3) {
    lines.push(`Below the lobby median on level (${s.level} against ${s.medianLevel}) without an HP lead to show for it: the usual line is to take the level at this window, unless the gold is set aside for a planned roll-down.`);
  }
  if (behindLevel && hpLead && stage >= 3) {
    lines.push(`Below the lobby on level but in the top half on HP: the levels skipped are paying in gold and HP, so banking to the next window is the usual line as long as the fights keep going this way.`);
  }
  if (stage >= 3 && r.xpBought && r.level >= 7 && s.twoStars <= 1 && r.rollsSpent * 2 < 20 && !hpLead) {
    lines.push(`Took level ${r.level} this round and rolled ${r.rollsSpent * 2}g on it with ${plural(s.twoStars, 'two-star')} on the board: a level pays off through the rolls made on its odds, so the usual line is to roll the bank down to a stop right after the level, unless the next round is the planned roll-down.`);
  }
  if (s.contested.length > 0 && stage >= 3) {
    lines.push(`${s.contested[0]} was on other boards you met: every extra player on a unit raises the cost of its 2-star, so the usual answer is to count copies before a roll-down and look for a line that uses the same items, unless you are already ahead on copies.`);
  }
  if (s.looseComponents >= 2 && stage >= 3 && losing) {
    lines.push(`${plural(s.looseComponents, 'unbuilt component')} while losing: a finished item fights and a component does not, so slamming one into a serviceable item is the usual line, unless the ideal holder is a round away.`);
  }
  if (s.playersBelow === 0 && s.alive !== undefined && s.alive >= 4 && stage >= 4) {
    lines.push(`Lowest HP of the ${s.alive} still in: placement is decided by who goes out first, so the usual line is to spend for the next fights before anything else, unless the players above you are also about to go.`);
  }
  if (stage === 2 && r.label === '2-1') {
    lines.push(`Stage 2 is where HP is cheapest (a loss costs 2 plus units left): the usual line is to commit to winning or losing the opener rather than trading, and to keep early gold for levels and the stage 3 spike, unless pairs are there to finish.`);
  }
  if (s.streak !== 'none' && s.streak.endsWith('wins') && Number(s.streak.split(' ')[0]) >= 3 && stage <= 3) {
    lines.push(`On a ${s.streak} streak: a long win streak pays more each round it lasts, so a spend that holds the streak for several fights is usually worth it, unless it only delays one loss.`);
  }
  if (lines.length === 0) {
    lines.push(`Nothing in this spot pressed for a change: the usual line is to keep the plan and spend at the next window that fits it.`);
  }
  void did;
  return lines;
}
