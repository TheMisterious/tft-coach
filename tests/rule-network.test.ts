// The rule network (data/core/rule-network.json, each set's
// rule-network.season.json, src/coach/rule-network.ts): the files are sound on
// their own and merged, the core holds in any set, the loss arithmetic matches
// the research, and a traced game reads in order from its first break to its
// worst reading.

import { describe, it, expect } from 'vitest';
import {
  loadRuleNetwork, validateNetwork, validateSeason, seasonNetworkFor, seasonNetworkSets,
  traceGame, lossesLeft, stageFloor, type RuleNetwork,
} from '../src/coach/rule-network';
import { getCoreRules, getSeasonRules } from '../src/coach/rules-loader';
import type { DecisionPoint, LobbyPlayerState, MatchSnapshot, RoundSnapshot } from '../src/shared/types';

// Seven opponents, all healthier than the player unless told otherwise.
function lobby(myHp: number, others = [70, 65, 60, 55, 50, 45, 40]): LobbyPlayerState[] {
  return [
    { name: 'me', health: myHp, level: 7, isLocal: true },
    ...others.map((health, i) => ({ name: `p${i}`, health, level: 7, isLocal: false })),
  ];
}

function round(label: string, over: Partial<RoundSnapshot> = {}): RoundSnapshot {
  const health = over.health ?? 60;
  return {
    label, type: 'PVP', goldStart: 30, goldEnd: 30, health, level: 7,
    rollsSpent: 0, xpBought: false, board: {}, bench: {}, benchItems: [], shop: [],
    augmentsPicked: [], opponentBoard: {}, interestEarned: 0, streakCount: 0, streakType: 'none',
    lobby: lobby(health),
    ...over,
  };
}

function match(rounds: RoundSnapshot[], finalPlacement = 8): MatchSnapshot {
  return { pseudoMatchId: 't', setId: 'set18', gameMode: 'tft', rounds, finalPlacement, placementSource: 'rank', finalBoard: {}, augments: [], godPicks: [] };
}

// Wording a set may change, kept out of the core so it holds in the next set.
const SET_SPECIFIC = /\bSet \d+\b|\bWisps?\b|\bCoven\b/;

describe('network files', () => {
  const core = loadRuleNetwork();
  const sets = seasonNetworkSets();

  it('has a season layer for each set with rules', () => {
    expect(sets).toEqual(expect.arrayContaining(['set17', 'set18']));
  });

  it('validates on its own and merged with each set', () => {
    expect(validateNetwork(core)).toEqual([]);
    for (const set of sets) {
      expect(validateSeason(seasonNetworkFor(set)!), set).toEqual([]);
      expect(validateNetwork(loadRuleNetwork(set)), set).toEqual([]);
    }
  });

  it('keeps set-specific wording out of the core', () => {
    const texts = [
      ...core.nodes.flatMap(n => [n.name, n.statement, n.advice ?? '', n.unless ?? ''].map(t => [n.id, t])),
      ...core.edges.map(e => [`${e.from} -> ${e.to}`, e.why]),
    ];
    expect(texts.filter(([, t]) => SET_SPECIFIC.test(t)).map(([id]) => id)).toEqual([]);
  });

  it('maps each engine rule to at most one node', () => {
    const seen = new Map<string, string>();
    for (const n of core.nodes) {
      for (const r of n.engineRules ?? []) {
        expect(seen.get(r), `${r} is on both ${seen.get(r)} and ${n.id}`).toBeUndefined();
        seen.set(r, n.id);
      }
    }
  });

  // Set mechanics with no network node: Set 17's god rounds, and the
  // coverage-gap note for missing augment data.
  const UNMAPPED = (id: string) => id.startsWith('SET17_') || id === 'AUGMENT_002';

  it("places every core rule and every set's rules in the network", () => {
    for (const set of sets) {
      const mapped = new Set(loadRuleNetwork(set).nodes.flatMap(n => n.engineRules ?? []));
      const ids = [...getCoreRules(), ...getSeasonRules(set)].map(r => r.unique_id).filter(id => !UNMAPPED(id));
      expect(ids.filter(id => !mapped.has(id)), set).toEqual([]);
    }
  });

  it('rejects an override that changes what a rule is', () => {
    const bad = { ...seasonNetworkFor('set18')!, overrides: [{ id: 'P.BANK_TO_TENS', kind: 'symptom' } as never, { id: 'P.NOPE', name: 'x' }] };
    const errors = validateSeason(bad);
    expect(errors).toContain('set18: P.BANK_TO_TENS overrides kind, which a set may not change');
    expect(errors).toContain('set18: override for unknown node P.NOPE');
  });

  it('catches a dangling edge and a leads_to cycle', () => {
    const net = loadRuleNetwork('set18');
    const broken: RuleNetwork = {
      ...net,
      edges: [
        ...net.edges,
        { from: 'S.ELIMINATED_WITH_GOLD', to: 'S.STAGE2_BLEED', type: 'leads_to', why: 'loop' },
        { from: 'P.NOPE', to: 'M.INCOME', type: 'rests_on', why: 'dangling' },
      ],
    };
    const errors = validateNetwork(broken);
    expect(errors).toContain('edge from unknown node P.NOPE');
    expect(errors).toContain('leads_to edges form a cycle');
  });
});

describe('loss arithmetic', () => {
  const base = loadRuleNetwork('set18').values.stageBase!;

  it('counts the losses left at a stage price of base damage plus 3 units', () => {
    expect(lossesLeft(19, 4, base)).toBe(1);   // 10 a loss
    expect(lossesLeft(8, 4, base)).toBe(0);    // the next loss ends it
    expect(lossesLeft(60, 3, base)).toBe(6);   // 9 a loss
    expect(lossesLeft(0, 4, base)).toBe(0);
  });

  it('sets each floor at two losses of the stage', () => {
    expect(stageFloor(3, base)).toBe(18);
    expect(stageFloor(4, base)).toBe(20);
    expect(stageFloor(5, base)).toBe(26);
    expect(stageFloor(6, base)).toBe(30);
  });

  it('prices nothing when the set has no numbers', () => {
    expect(lossesLeft(19, 4, {})).toBeUndefined();
    expect(stageFloor(5, {})).toBeUndefined();
  });
});

describe('traceGame', () => {
  // Shaped on the 2026-11-09 8th: a stage 3 spent levelling with gold banked,
  // then two lost fights near the end with 30g+ and nothing rolled.
  const rounds = [
    round('3-1', { health: 68, goldEnd: 50 }),
    round('3-2', { health: 58, goldEnd: 52, xpBought: true }),
    round('3-3', { health: 50, goldEnd: 55, xpBought: true, rollsSpent: 1 }),
    round('3-5', { health: 41, goldEnd: 60 }),
    round('4-1', { health: 31, goldStart: 47, goldEnd: 30, rollsSpent: 4 }),
    round('4-2', { health: 19, goldStart: 30, goldEnd: 28, rollsSpent: 3 }),
    round('4-5', { health: 8, goldStart: 33, goldEnd: 30 }),
    round('4-6', { health: -2, goldStart: 38, goldEnd: 31 }),
  ];
  const hp002: DecisionPoint = {
    ruleId: 'HP_002', round: '4-1', category: 'hp', severity: 'critical',
    observed: 'Entered stage 4 at 31 HP (safe zone is 60+)', recommended: '', reasonMetrics: {},
  };

  it('ends on the worst reading and runs earliest first', () => {
    const story = traceGame(match(rounds), [hp002])!;
    expect(story.terminal).toBe('S.ELIMINATED_WITH_GOLD');
    expect(story.steps.map(s => s.nodeId)).toEqual([
      'P.ONE_SPIKE_PER_STRETCH', 'S.LOW_HP_STAGE4', 'S.BELOW_FLOOR', 'P.ROLL_WHEN_FORCED', 'S.ELIMINATED_WITH_GOLD',
    ]);
  });

  it('states facts from the recording and links each step to the next', () => {
    const story = traceGame(match(rounds), [hp002])!;
    const byId = new Map(story.steps.map(s => [s.nodeId, s]));
    expect(byId.get('S.ELIMINATED_WITH_GOLD')!.facts[0]).toBe('The game ended at 4-6 with 31g still in the bank, 15 rolls\' worth.');
    expect(byId.get('P.ROLL_WHEN_FORCED')!.rounds).toEqual(['4-5', '4-6']);
    expect(byId.get('P.ROLL_WHEN_FORCED')!.facts[1]).toContain('the next loss would end it');
    expect(byId.get('S.BELOW_FLOOR')!.ledTo.map(l => l.nodeId)).toEqual(['P.ROLL_WHEN_FORCED']);
    expect(byId.get('S.LOW_HP_STAGE4')!.evidence).toMatch(/^In your games: 2\.0 places worse/);
    expect(byId.get('P.ROLL_WHEN_FORCED')!.evidence).toBe('Not yet audited in your games');
  });

  it('reads the floor only when no one else is about to go out first', () => {
    const others = [5, 4, 3, 60, 55, 50, 45];
    const crowded = rounds.map(r => ({ ...r, lobby: lobby(r.health, others) }));
    const ids = traceGame(match(crowded), [hp002])!.steps.map(s => s.nodeId);
    expect(ids).not.toContain('S.BELOW_FLOOR');
  });

  it('tells no story for a top-four finish', () => {
    expect(traceGame(match(rounds, 4), [hp002])).toBeUndefined();
  });

  it('stays silent on damage-priced readings for a set with no numbers yet', () => {
    const unknownSet = { ...match(rounds), setId: 'set99' };
    const ids = traceGame(unknownSet, [hp002])!.steps.map(st => st.nodeId);
    expect(ids).not.toContain('S.BELOW_FLOOR');
    expect(ids).not.toContain('P.ROLL_WHEN_FORCED');
    expect(ids).toContain('S.ELIMINATED_WITH_GOLD');
  });

  it('uses the Set 18 layer for a Set 18 match', () => {
    const story = traceGame(match(rounds), [hp002])!;
    expect(story.set).toBe('set18');
    expect(story.patch).toBe('18.6');
  });

  it('tells no story when no checkpoint reading fired', () => {
    const healthy = [round('3-1', { health: 90 }), round('4-1', { health: 80, outcome: 'win' })];
    expect(traceGame(match(healthy, 3), [])).toBeUndefined();
  });

  it('leaves always-on and unconfirmed candidate rules out', () => {
    const story = traceGame(match(rounds), [
      hp002,
      { ruleId: 'BOARD_004', round: '4-6', category: 'board', severity: 'moderate', observed: 'weaker board', recommended: '', reasonMetrics: {} },
      { ruleId: 'ECON_001', round: '3-3', category: 'econ', severity: 'minor', observed: '1g short', recommended: '', reasonMetrics: {} },
    ])!;
    const ids = story.steps.map(s => s.nodeId);
    expect(ids).not.toContain('P.BOARD_VS_LOBBY');
    expect(ids).not.toContain('P.BANK_TO_TENS');
  });
});
