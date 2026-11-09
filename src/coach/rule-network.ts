// The rule network: TFT's mechanics, the strategy principles that follow from
// them, and the checkpoint readings that show where a game stood, joined by
// typed edges. Researched against patch 18.6.
//
// Split like the rule registry: data/core/rule-network.json holds what is true
// in any set, worded without a set's numbers; data/sets/{set}/
// rule-network.season.json adds that set's numbers (stage damage, which the
// detectors use), its own mechanics, and wording that quotes them. A set with
// no season file gets the core network alone, and the detectors that need
// stage damage stay silent rather than price losses with another set's table.
//
// The checkers in src/coach/checkers/ each judge one thing. The network says
// how those things relate — which principle rests on which mechanic, which one
// overrides another, and which breaks tend to lead to which readings later in
// the same game. traceGame() uses the leads_to edges to turn a match's
// separate findings into one ordered account of how the game went.
//
// OBSERVATIONS, NOT VERDICTS, as everywhere in the coach: a step lists what
// the ledger recorded, and a leads_to edge says the first makes the second
// more likely, not that it caused it here. Each step carries its basis (a
// Riot number, arithmetic on Riot numbers, a large-sample benchmark, an
// expert heuristic, or a measured link in this player's games) so the report
// can say how far to trust it.

import type {
  DecisionPoint, MatchSnapshot, RoundSnapshot, MetaData, GameStory, StoryStep, StoryBasis,
} from '../shared/types';
import { getRuleEvidence, getRuleMeta, getAllRules } from './rules-loader';
import { pairsHeld } from './upgrades';
import { standingFor, ordinal } from './lobby-context';
import { getChampionName } from '../enrichment/meta-lookup';
import { readFights, describeBoard, isComponent, type Fight } from './fights';
import { boardUnits } from '../ledger/merge';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const coreNetwork = require('../../data/core/rule-network.json') as CoreNetwork;
// One entry per set folder, as in rules-loader.ts. A new set adds its file here.
const seasonNetworks: Record<string, SeasonNetwork> = {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  set17: require('../../data/sets/set17/rule-network.season.json') as SeasonNetwork,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  set18: require('../../data/sets/set18/rule-network.season.json') as SeasonNetwork,
};

export type NodeKind = 'mechanic' | 'principle' | 'symptom';
export type EdgeType = 'rests_on' | 'refines' | 'enables' | 'trades_off' | 'overrides' | 'leads_to' | 'explains';

export interface NetworkNode {
  id: string;
  kind: NodeKind;
  domain: string;
  basis: StoryBasis;
  name: string;
  statement: string;
  advice?: string;
  unless?: string;
  detector?: DetectorId;
  sources: string[];
  engineRules?: string[];
}

export interface NetworkEdge {
  from: string;
  to: string;
  type: EdgeType;
  why: string;
}

// Per-set numbers. stageBase is the base damage of a lost player round by
// stage ("2" to "7"); each enemy unit left alive adds 1 on top.
export interface NetworkValues {
  stageBase?: Record<string, number>;
}

interface CoreNetwork {
  version: number;
  edgeTypes: Record<EdgeType, string>;
  sources: Record<string, { title: string; url: string }>;
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}

// Fields a set may reword on a core node. Kind, domain, basis, detector and
// mapped checkers belong to the rule itself and stay as the core defines them.
export const OVERRIDABLE = ['name', 'statement', 'advice', 'unless', 'sources'] as const;
type NodeOverride = { id: string } & Partial<Pick<NetworkNode, typeof OVERRIDABLE[number]>>;

export interface SeasonNetwork {
  set: string;
  patch: string;
  values: NetworkValues;
  overrides: NodeOverride[];
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  sources?: Record<string, { title: string; url: string }>;
}

export interface RuleNetwork extends CoreNetwork {
  // Undefined when no season file was merged.
  set?: string;
  patch?: string;
  values: NetworkValues;
}

export const EDGE_TYPES: EdgeType[] = ['rests_on', 'refines', 'enables', 'trades_off', 'overrides', 'leads_to', 'explains'];
const BASES: StoryBasis[] = ['riot', 'sums', 'benchmark', 'heuristic', 'audit', 'recorded'];

export function seasonNetworkFor(setId: string | undefined): SeasonNetwork | undefined {
  return setId ? seasonNetworks[setId] : undefined;
}

export function seasonNetworkSets(): string[] {
  return Object.keys(seasonNetworks);
}

// The core network with a set's layer on top, or the core alone.
export function loadRuleNetwork(setId?: string): RuleNetwork {
  return mergeNetwork(coreNetwork, seasonNetworkFor(setId));
}

export function mergeNetwork(core: CoreNetwork, season?: SeasonNetwork): RuleNetwork {
  if (!season) return { ...core, values: {} };
  const overrides = new Map(season.overrides.map(o => [o.id, o]));
  return {
    ...core,
    set: season.set,
    patch: season.patch,
    values: season.values,
    sources: { ...core.sources, ...season.sources },
    nodes: [...core.nodes.map(n => ({ ...n, ...overrides.get(n.id), id: n.id })), ...season.nodes],
    edges: [...core.edges, ...season.edges],
  };
}

// Problems in a season layer that the merged network would hide: an override
// for a node that does not exist, or one that tries to change what a rule is.
export function validateSeason(season: SeasonNetwork, core: CoreNetwork = coreNetwork): string[] {
  const errors: string[] = [];
  const coreIds = new Set(core.nodes.map(n => n.id));
  for (const o of season.overrides) {
    if (!coreIds.has(o.id)) errors.push(`${season.set}: override for unknown node ${o.id}`);
    for (const k of Object.keys(o)) {
      if (k !== 'id' && !(OVERRIDABLE as readonly string[]).includes(k)) errors.push(`${season.set}: ${o.id} overrides ${k}, which a set may not change`);
    }
  }
  for (const n of season.nodes) if (coreIds.has(n.id)) errors.push(`${season.set}: node ${n.id} already exists in the core`);
  const base = season.values.stageBase ?? {};
  for (const stage of ['2', '3', '4', '5', '6', '7']) {
    if (typeof base[stage] !== 'number') errors.push(`${season.set}: stageBase has no stage ${stage}`);
  }
  return errors;
}

// Structural problems in a network file, empty when it is sound. Run by
// tests/rule-network.test.ts so a bad edit fails the build rather than
// silently dropping steps from reports.
export function validateNetwork(net: RuleNetwork, knownRuleIds: Set<string> = new Set(getAllRules().map(r => r.unique_id))): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const n of net.nodes) {
    if (ids.has(n.id)) errors.push(`duplicate node ${n.id}`);
    ids.add(n.id);
    if (!BASES.includes(n.basis)) errors.push(`${n.id}: unknown basis ${n.basis}`);
    if (n.sources.length === 0) errors.push(`${n.id}: no sources`);
    for (const s of n.sources) if (!net.sources[s]) errors.push(`${n.id}: unknown source ${s}`);
    for (const r of n.engineRules ?? []) if (!knownRuleIds.has(r)) errors.push(`${n.id}: unknown engine rule ${r}`);
    if (n.detector && !DETECTORS[n.detector]) errors.push(`${n.id}: unknown detector ${n.detector}`);
    if (n.kind === 'principle' && !n.advice) errors.push(`${n.id}: a principle needs advice`);
  }
  for (const e of net.edges) {
    if (!ids.has(e.from)) errors.push(`edge from unknown node ${e.from}`);
    if (!ids.has(e.to)) errors.push(`edge to unknown node ${e.to}`);
    if (!EDGE_TYPES.includes(e.type)) errors.push(`${e.from} -> ${e.to}: unknown edge type ${e.type}`);
    if (e.from === e.to) errors.push(`${e.from}: edge to itself`);
  }
  const kindOf = new Map(net.nodes.map(n => [n.id, n.kind]));
  for (const e of net.edges) {
    if (e.type === 'rests_on' && kindOf.get(e.from) === 'mechanic') errors.push(`${e.from}: a mechanic rests on nothing`);
    if (e.type === 'explains' && (kindOf.get(e.from) !== 'principle' || kindOf.get(e.to) !== 'symptom')) {
      errors.push(`${e.from} -> ${e.to}: explains runs from a principle to a symptom`);
    }
  }
  if (hasCycle(net.edges.filter(e => e.type === 'leads_to'))) errors.push('leads_to edges form a cycle');
  return errors;
}

function hasCycle(edges: NetworkEdge[]): boolean {
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 'open') return true;
    if (state.get(id) === 'done') return false;
    state.set(id, 'open');
    for (const next of out.get(id) ?? []) if (visit(next)) return true;
    state.set(id, 'done');
    return false;
  };
  return [...out.keys()].some(visit);
}

// ─── Detectors ───────────────────────────────────────────────────────────────
// Readings the existing checkers do not make. Each returns the rounds it fired
// at, with the facts behind it.

export interface Firing {
  nodeId: string;
  rounds: string[];
  facts: string[];
  // Set when the firing came from an existing checker.
  ruleId?: string;
  // The checker's "likely contributing decisions" and their window, kept
  // apart so a detector covering the same stage can stand in for them.
  window?: string;
  contributing?: string[];
}

type DetectorId = 'belowNextStageFloor' | 'eliminatedWithGold' | 'forcedRollSkipped' | 'noSpikeWhileLosing' | 'lossStreakPastStage2'
  | 'behindOnItems' | 'behindOnBoard' | 'carryContested';
type Detector = (match: MatchSnapshot, net: RuleNetwork, meta?: MetaData) => Omit<Firing, 'nodeId'>[];
type StageBase = Record<string, number>;

// Units left alive assumed when pricing a loss. 3 is the low end of the
// research's 3-to-6 range, so floors and loss counts err toward "not yet".
const UNITS_LEFT = 3;

function stageOf(label: string): number {
  return Number(label.split('-')[0]) || 0;
}

function baseDamage(stage: number, base: StageBase): number | undefined {
  return base[String(Math.min(Math.max(stage, 2), 7))];
}

// What one lost player round costs at a stage (M.PLAYER_DAMAGE), or undefined
// when the set's numbers are unknown.
export function lossCost(stage: number, base: StageBase): number | undefined {
  const b = baseDamage(stage, base);
  return b === undefined ? undefined : b + UNITS_LEFT;
}

// P.COUNT_LOSSES_LEFT: HP divided by a loss, rounded up, minus the loss that ends it.
export function lossesLeft(hp: number, stage: number, base: StageBase): number | undefined {
  const cost = lossCost(stage, base);
  if (cost === undefined) return undefined;
  if (hp <= 0) return 0;
  return Math.ceil(hp / cost) - 1;
}

// P.STABILIZE_FLOOR: two losses at the stage's prices.
export function stageFloor(stage: number, base: StageBase): number | undefined {
  const cost = lossCost(stage, base);
  return cost === undefined ? undefined : 2 * cost;
}

function playerRounds(match: MatchSnapshot): RoundSnapshot[] {
  return match.rounds.filter(r => r.type === 'PVP');
}

function hpBefore(match: MatchSnapshot, round: RoundSnapshot): number {
  const i = match.rounds.indexOf(round);
  return i > 0 ? match.rounds[i - 1].health : 100;
}

function lost(match: MatchSnapshot, round: RoundSnapshot): boolean {
  if (round.outcome) return round.outcome === 'loss';
  return round.health < hpBefore(match, round);
}

function rollGold(rounds: RoundSnapshot[]): number {
  return rounds.reduce((sum, r) => sum + r.rollsSpent * 2, 0);
}

const DETECTORS: Record<DetectorId, Detector> = {
  // S.BELOW_FLOOR: the first round HP ends under two losses at the next
  // stage's prices while the player is among the two lowest of at least four
  // still alive. Late in a game most of the lobby is under the floor; it only
  // presses when no one else is about to go out first (P.OUTLAST_THE_LOBBY).
  // No roster, no reading.
  belowNextStageFloor(match, net) {
    const base = net.values.stageBase ?? {};
    for (const r of match.rounds) {
      const stage = stageOf(r.label);
      if (stage < 2 || stage >= 7 || r.health <= 0) continue;
      const floor = stageFloor(stage + 1, base);
      if (floor === undefined || r.health >= floor) continue;
      const s = standingFor(r);
      if (!s || s.alive < 4 || s.hpRank < s.alive - 1) continue;
      return [{
        rounds: [r.label],
        facts: [
          `After ${r.label}: ${r.health} HP, under the ${floor} that two stage ${stage + 1} losses cost (${baseDamage(stage + 1, base)} base plus ${UNITS_LEFT} units each).`,
          `${ordinal(s.hpRank)} of ${s.alive} alive on HP, against a median of ${s.medianOpponentHealth} among the others; ${r.goldEnd}g in the bank.`,
        ],
      }];
    }
    return [];
  },

  // S.ELIMINATED_WITH_GOLD: knocked out with at least one interest tier left.
  // Any known placement below 1st was a knockout. Older ledgers stop at the
  // last HP before the fatal fight rather than a value at or below 0, so the
  // last recorded round's gold is read as the gold held going out.
  eliminatedWithGold(match) {
    if (match.finalPlacement === 1 || match.placementSource === 'none') return [];
    const last = match.rounds[match.rounds.length - 1];
    if (!last || last.goldEnd < 10) return [];
    const tail = match.rounds.filter(r => r.type === 'PVP').slice(-3);
    const hpPath = [hpBefore(match, tail[0] ?? last), ...tail.map(r => r.health)].join(' → ');
    return [{
      rounds: [last.label],
      facts: [
        `The game ended at ${last.label} with ${last.goldEnd}g still in the bank, ${Math.floor(last.goldEnd / 2)} rolls' worth.`,
        `Rolled ${rollGold(tail)}g over the last ${tail.length} player rounds while HP went ${hpPath}.`,
      ],
    }];
  },

  // P.ROLL_WHEN_FORCED broken: a lost player round started with two losses or
  // fewer left, 20g+ banked, and under 10g rolled.
  forcedRollSkipped(match, net) {
    const base = net.values.stageBase ?? {};
    const hits = playerRounds(match).filter(r => {
      const stage = stageOf(r.label);
      const hp = hpBefore(match, r);
      const left = lossesLeft(hp, stage, base);
      return stage >= 3 && hp > 0 && left !== undefined && left <= 2
        && r.goldStart >= 20 && r.rollsSpent * 2 < 10 && lost(match, r);
    });
    if (hits.length === 0) return [];
    return [{
      rounds: hits.map(r => r.label),
      facts: hits.map(r => {
        const stage = stageOf(r.label);
        const hp = hpBefore(match, r);
        const left = lossesLeft(hp, stage, base)!;
        const room = left === 0 ? 'the next loss would end it' : `about ${left} loss${left === 1 ? '' : 'es'} left`;
        return `${r.label}: started at ${hp} HP (${room} at ${lossCost(stage, base)} HP a loss) with ${r.goldStart}g; rolled ${r.rollsSpent * 2}g and lost (${hp} → ${r.health}).`;
      }),
    }];
  },

  // P.ONE_SPIKE_PER_STRETCH broken: in stage 3 or 4, three or more player
  // fights lost while 30g+ sat banked and 10g or less was rolled in the stage.
  noSpikeWhileLosing(match, _net, meta) {
    const out: Omit<Firing, 'nodeId'>[] = [];
    for (const stage of [3, 4]) {
      const rounds = match.rounds.filter(r => stageOf(r.label) === stage);
      const fights = rounds.filter(r => r.type === 'PVP');
      const losses = fights.filter(r => lost(match, r));
      if (losses.length < 3) continue;
      const golds = rounds.map(r => r.goldEnd);
      const rolled = rollGold(rounds);
      if (Math.max(...golds) < 30 || rolled > 10) continue;
      const first = rounds[0], last = rounds[rounds.length - 1];
      const xpRounds = rounds.filter(r => r.xpBought).length;
      const pairs = pairsHeld(last, meta).map(id => (meta ? getChampionName(id, meta) : id));
      out.push({
        rounds: [losses[2].label],
        facts: [
          `Stage ${stage}: lost ${losses.length} of ${fights.length} player fights (${hpBefore(match, first)} → ${last.health} HP).`,
          `Rolled ${rolled}g in the stage while holding ${Math.min(...golds)}g to ${Math.max(...golds)}g.`,
          `Bought XP in ${xpRounds} of ${rounds.length} rounds (level ${first.level} → ${last.level}).`,
          ...(pairs.length > 0 ? [`Held ${pairs.length} pair${pairs.length === 1 ? '' : 's'} at ${last.label}: ${pairs.join(', ')}.`] : []),
        ],
      });
    }
    return out;
  },

  // P.LOSS_STREAK_PLAN broken: a loss streak of 4+ still running in stage 3 or later.
  lossStreakPastStage2(match, net) {
    const base = net.values.stageBase ?? {};
    const r = match.rounds.find(x => stageOf(x.label) >= 3 && x.streakType === 'loss' && x.streakCount >= 4);
    const now = r && lossCost(stageOf(r.label), base), early = lossCost(2, base);
    if (!r || now === undefined || early === undefined) return [];
    return [{
      rounds: [r.label],
      facts: [`Loss streak at ${r.streakCount} by ${r.label}, where a loss costs ${now} HP against ${early} in stage 2.`],
    }];
  },

  // ─── Fights (src/coach/fights.ts) ──────────────────────────────────────────

  // S.BEHIND_ON_ITEMS: in 40%+ of the stage 3-4 fights with the opponent's
  // board recorded (at least four), it held two or more finished items more.
  // In 78 recorded games this fired in 45% of bottom-four finishes and 12% of
  // top-four ones; the threshold was set on those games, so it is exploratory.
  behindOnItems(match, _net, meta) {
    const fights = midGameKnown(match, meta);
    const behind = fights.filter(f => f.opp!.items >= f.own.items + 2);
    if (fights.length < 4 || behind.length / fights.length < 0.4) return [];
    const rounds = new Map(match.rounds.map(r => [r.label, r]));
    const spare = (label: string) => {
      const r = rounds.get(label);
      if (!r || !meta) return 0;
      return r.benchItems.filter(id => id && isComponent(id, meta)).length;
    };
    const worst = behind.slice().sort((a, b) => (b.opp!.items - b.own.items) - (a.opp!.items - a.own.items)).slice(0, 3)
      .sort((a, b) => roundNumber(a.round) - roundNumber(b.round));
    return [{
      rounds: behind.map(f => f.round),
      facts: [
        `In ${behind.length} of ${fights.length} stage 3-4 fights the board you met held two or more finished items more than yours.`,
        ...worst.map(f => {
          const loose = f.own.components + spare(f.round);
          return `${f.round}: they had ${f.opp!.items} finished items, you had ${f.own.items}${loose ? `, with ${loose} unbuilt component${loose === 1 ? '' : 's'} on your units or bench` : ''}; you ${f.result === 'loss' ? `lost (${f.hpBefore} → ${f.hpAfter})` : 'won'}.`;
        }),
      ],
    }];
  },

  // S.BEHIND_ON_BOARD: in half or more of the stage 3-4 fights with the
  // opponent's board recorded (at least four), it was worth a fifth more than
  // yours (cost times copies). Fired in 45% of bottom-four and 15% of top-four
  // finishes across 78 recorded games; exploratory, as above.
  behindOnBoard(match, _net, meta) {
    const fights = midGameKnown(match, meta);
    const behind = fights.filter(f => f.opp!.value >= f.own.value * 1.2);
    if (fights.length < 4 || behind.length / fights.length < 0.5) return [];
    const worst = behind.slice().sort((a, b) => b.opp!.value / Math.max(1, b.own.value) - a.opp!.value / Math.max(1, a.own.value)).slice(0, 3)
      .sort((a, b) => roundNumber(a.round) - roundNumber(b.round));
    return [{
      rounds: behind.map(f => f.round),
      facts: [
        `In ${behind.length} of ${fights.length} stage 3-4 fights the board you met was worth a fifth or more than yours.`,
        ...worst.map(f => `${f.round}: their ${describeBoard(f.opp!)} against your ${describeBoard(f.own)}; you ${f.result === 'loss' ? `lost (${f.hpBefore} → ${f.hpAfter})` : 'won'}.`),
      ],
    }];
  },

  // P.AVOID_CONTEST broken: your top damage unit was on the boards of two or
  // more different opponents you fought in stages 3 and 4.
  carryContested(match, _net, meta) {
    if (!meta) return [];
    const fights = fightsOf(match, meta).filter(f => f.stage >= 3 && Object.keys(f.ownShares).length > 0);
    const carry = topUnit(fights);
    if (!carry) return [];
    const seen = new Map<string, string>();
    for (const r of match.rounds) {
      if (r.type !== 'PVP' || !r.opponentBoardFresh || !r.opponentName) continue;
      if (stageOf(r.label) < 3 || stageOf(r.label) > 4) continue;
      const copy = boardUnits(r.opponentBoard).filter(u => u.name === carry).sort((a, b) => Number(b.level) - Number(a.level))[0];
      if (copy && !seen.has(r.opponentName)) seen.set(r.opponentName, `${r.label}, ${Number(copy.level) || 1}★`);
    }
    if (seen.size < 2) return [];
    return [{
      rounds: [...seen.values()].map(v => v.split(',')[0]),
      facts: [`${getChampionName(carry, meta)}, your top damage unit, was on the boards of ${seen.size} opponents you fought: ${[...seen].map(([name, at]) => `${name} (${at})`).join('; ')}.`],
    }];
  },
};

// readFights once per match: several detectors read the same fights.
const fightCache = new WeakMap<MatchSnapshot, Fight[]>();
function fightsOf(match: MatchSnapshot, meta: MetaData): Fight[] {
  let f = fightCache.get(match);
  if (!f) { f = readFights(match, meta); fightCache.set(match, f); }
  return f;
}

// Stage 3 and 4 fights where the opponent's whole board was recorded.
function midGameKnown(match: MatchSnapshot, meta?: MetaData): Fight[] {
  return meta ? fightsOf(match, meta).filter(f => (f.stage === 3 || f.stage === 4) && f.opp) : [];
}

// The unit with the most of your damage across fights.
function topUnit(fights: Fight[]): string | undefined {
  const total = new Map<string, number>();
  for (const f of fights) for (const [u, sh] of Object.entries(f.ownShares)) total.set(u, (total.get(u) ?? 0) + sh);
  return [...total].sort((a, b) => b[1] - a[1])[0]?.[0];
}

// ─── Tracing a game ──────────────────────────────────────────────────────────

// The readings a story can end on, worst first.
const TERMINALS = ['S.ELIMINATED_WITH_GOLD', 'S.LETHAL_STAGE5', 'S.BELOW_FLOOR', 'S.LOW_HP_STAGE4', 'S.STAGE2_BLEED'];

const BASIS_LABEL: Record<StoryBasis, string> = {
  riot: "Riot's numbers",
  recorded: 'Read from your recording',
  sums: "Arithmetic on Riot's numbers",
  benchmark: 'Set 18 ladder statistics',
  heuristic: 'Expert rule of thumb',
  audit: 'Measured in your games',
};

function roundNumber(label: string): number {
  const [s, r] = label.split('-').map(Number);
  return (s || 0) * 10 + (r || 0);
}

// Engine checker hits mapped onto network nodes. Rules the report already
// keeps out of its notes stay out here too: always-on rules (fire in nearly
// every game) and candidate rules not yet confirmed by newer games.
function firingsFromPoints(net: RuleNetwork, points: DecisionPoint[]): Firing[] {
  const nodeFor = new Map<string, string>();
  for (const n of net.nodes) for (const r of n.engineRules ?? []) nodeFor.set(r, n.id);
  const out: Firing[] = [];
  for (const p of points) {
    if (!p.ruleId) continue;
    const nodeId = nodeFor.get(p.ruleId);
    if (!nodeId) continue;
    const evidence = getRuleEvidence(p.ruleId);
    if (evidence.verdict === 'always-on') continue;
    if (getRuleMeta(p.ruleId)?.status === 'candidate' && evidence.status !== 'confirmed') continue;
    out.push({
      nodeId,
      ruleId: p.ruleId,
      rounds: [p.round],
      facts: [p.observed],
      window: p.contributing?.window,
      contributing: p.contributing?.observations,
    });
  }
  return out;
}

function mergeFirings(firings: Firing[]): Map<string, Firing> {
  const byNode = new Map<string, Firing>();
  for (const f of firings) {
    const prev = byNode.get(f.nodeId);
    if (!prev) { byNode.set(f.nodeId, { ...f }); continue; }
    prev.rounds = [...new Set([...prev.rounds, ...f.rounds])].sort((a, b) => roundNumber(a) - roundNumber(b));
    prev.facts = [...prev.facts, ...f.facts.filter(x => !prev.facts.includes(x))];
    prev.ruleId = prev.ruleId ?? f.ruleId;
    prev.window = prev.window ?? f.window;
    prev.contributing = prev.contributing ?? f.contributing;
  }
  return byNode;
}

function evidenceLabel(node: NetworkNode, firing: Firing): string {
  if (firing.ruleId) {
    const e = getRuleEvidence(firing.ruleId);
    if (e.verdict === 'predictive' && e.placementDelta !== undefined) {
      return `In your games: ${e.placementDelta.toFixed(1)} places worse when it fired (${e.status ?? 'exploratory'})`;
    }
    return `In your games: no measured link to placement yet (${e.verdict})`;
  }
  return 'Not yet audited in your games';
}

// Every network node that fired in a match, from the checkers and the
// detectors, with its rounds and facts. traceGame orders these into a story;
// the audit counts them by placement.
export function networkFirings(match: MatchSnapshot, points: DecisionPoint[], meta?: MetaData, net: RuleNetwork = loadRuleNetwork(match.setId)): Map<string, Firing> {
  const detected: Firing[] = [];
  for (const n of net.nodes) {
    if (!n.detector) continue;
    for (const f of DETECTORS[n.detector](match, net, meta)) detected.push({ ...f, nodeId: n.id });
  }
  return mergeFirings([...firingsFromPoints(net, points), ...detected]);
}

// One ordered account of how a bottom-four match was lost: the worst reading
// it reached, and every recorded break or reading that leads to it through
// the network, earliest first. Undefined for top-four finishes, unknown
// placements, and games where no terminal reading fired.
export function traceGame(match: MatchSnapshot, points: DecisionPoint[], meta?: MetaData, net: RuleNetwork = loadRuleNetwork(match.setId)): GameStory | undefined {
  if (match.finalPlacement <= 4 || match.placementSource === 'none') return undefined;
  const nodes = new Map(net.nodes.map(n => [n.id, n]));
  const fired = networkFirings(match, points, meta, net);

  const terminal = TERMINALS.find(id => fired.has(id));
  if (!terminal) return undefined;

  const first = (id: string) => roundNumber(fired.get(id)!.rounds[0]);
  const last = (id: string) => {
    const rs = fired.get(id)!.rounds;
    return roundNumber(rs[rs.length - 1]);
  };
  // leads_to among fired nodes, earlier (or same round) to later.
  const leads = net.edges.filter(e => e.type === 'leads_to' && fired.has(e.from) && fired.has(e.to) && first(e.from) <= last(e.to));

  const included = new Set<string>([terminal]);
  const queue = [terminal];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const e of leads) {
      if (e.to === id && !included.has(e.from)) { included.add(e.from); queue.push(e.from); }
    }
  }

  // A checker's contributing lines for stage N repeat what a detector already
  // said about stage N; keep only the lobby line then ("At 4-1: level 8 ...").
  const stagesCovered = new Set([...included].flatMap(id => fired.get(id)!.facts
    .map(f => /^Stage (\d):/.exec(f)?.[1]).filter((x): x is string => !!x)));
  const factsFor = (f: Firing) => {
    const windowStage = /^stage (\d)/.exec(f.window ?? '')?.[1];
    const extra = f.contributing ?? [];
    return [...f.facts, ...(windowStage && stagesCovered.has(windowStage) ? extra.filter(x => x.startsWith('At ')) : extra)];
  };

  const explainer = (id: string) => {
    const e = net.edges.find(x => x.type === 'explains' && x.to === id);
    return e ? nodes.get(e.from) : undefined;
  };

  const steps: StoryStep[] = [...included]
    .sort((a, b) => first(a) - first(b) || last(a) - last(b))
    .map(id => {
      const node = nodes.get(id)!;
      const firing = fired.get(id)!;
      const principle = node.kind === 'principle' ? node : explainer(id);
      // A reading is trusted as far as its own basis (a fact read from the
      // recording, or a measured checkpoint); a decision as far as its principle.
      const basis = node.kind === 'symptom' ? node.basis : (principle?.basis ?? node.basis);
      return {
        nodeId: id,
        kind: node.kind === 'symptom' ? 'reading' : 'decision',
        name: node.name,
        rounds: firing.rounds,
        facts: factsFor(firing),
        principle: principle?.name,
        advice: principle?.advice,
        unless: principle?.unless,
        basis,
        basisLabel: BASIS_LABEL[basis],
        evidence: evidenceLabel(node, firing),
        ledTo: leads.filter(e => e.from === id && included.has(e.to)).map(e => ({ nodeId: e.to, name: nodes.get(e.to)!.name, why: e.why })),
      };
    });

  return { terminal, networkVersion: net.version, set: net.set, patch: net.patch, steps };
}
