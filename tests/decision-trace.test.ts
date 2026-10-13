// "Likely contributing decisions" (src/coach/decision-trace.ts): checkpoint
// notes get the facts from the window before them, and only facts.

import { describe, it, expect } from 'vitest';
import { attachContributingDecisions } from '../src/coach/decision-trace';
import type { DecisionPoint, MatchSnapshot, MetaData, RoundSnapshot, BoardState } from '../src/shared/types';

function round(label: string, over: Partial<RoundSnapshot> = {}): RoundSnapshot {
  return {
    label, type: 'PVP', outcome: 'loss', goldStart: 0, goldEnd: 30, health: 60, level: 6,
    rollsSpent: 0, xpBought: false, board: {}, bench: {}, benchItems: [], shop: [],
    augmentsPicked: [], opponentBoard: {}, interestEarned: 0, streakCount: 0, streakType: 'none',
    ...over,
  };
}

function board(...names: string[]): BoardState {
  return Object.fromEntries(names.map((n, i) => [`cell_${i}`, { name: n, level: 1, item_1: '', item_2: '', item_3: '' }]));
}

function match(rounds: RoundSnapshot[]): MatchSnapshot {
  return { pseudoMatchId: 't', setId: 'set17', gameMode: 'tft', rounds, finalPlacement: 7, finalBoard: {}, augments: [], godPicks: [] };
}

function point(ruleId: string, round: string, reasonMetrics: Record<string, number | string> = {}): DecisionPoint {
  return { ruleId, round, category: 'hp', severity: 'moderate', observed: '', recommended: '', reasonMetrics };
}

const STAGE3 = [
  round('3-1', { health: 70, goldEnd: 52, level: 6, outcome: 'loss' }),
  round('3-2', { health: 62, goldEnd: 58, outcome: 'loss', board: board('TFT17_Jinx', 'TFT17_Jinx'), shop: ['TFT17_Jinx', 'TFT17_Leona'] }),
  round('3-3', { health: 55, goldEnd: 40, rollsSpent: 4, xpBought: true, level: 7, outcome: 'win' }),
  round('3-4', { type: 'unknown', outcome: undefined, health: 55, goldEnd: 44, level: 7 }),
];

describe('attachContributingDecisions', () => {
  it('gives a stage-entry checkpoint the previous stage as its window', () => {
    const m = match([...STAGE3, round('4-1', { health: 48, level: 7 })]);
    const [p] = attachContributingDecisions([point('HP_002', '4-1')], m);
    expect(p.contributing?.window).toBe('stage 3 (3-1 to 3-4)');
    const text = p.contributing!.observations.join('\n');
    expect(text).toContain('HP 70 → 48: lost 2 of 3 player fights.');
    expect(text).toContain('Gold at round end: 40g to 58g; 2 rounds at 50g+ with nothing spent.');
    expect(text).toContain('Rolled 4 times (8g); bought XP in 1 of 4 rounds; level 6 → 7.');
  });

  it('reports upgrade copies seen in end-of-round shops and pairs one copy short', () => {
    const m = match([...STAGE3.slice(0, 2), round('4-1')]);
    const [p] = attachContributingDecisions([point('HP_002', '4-1')], m);
    const text = p.contributing!.observations.join('\n');
    expect(text).toContain('1 copy of units you held (TFT17_Jinx ×1)');
    expect(text).toContain('1 pair one copy from a 2-star at 3-2 (TFT17_Jinx)');
  });

  it('counts only real champions once the set table is loaded', () => {
    const r = round('3-1', { board: board('TFT_ArmoryKeyComponent', 'TFT_ArmoryKeyComponent', 'TFT17_Jinx') });
    const meta = { champions: { TFT17_Jinx: { name: 'Jinx', tier: 1, role: 'carry', traits: [] } } } as unknown as MetaData;
    const [p] = attachContributingDecisions([point('HP_002', '4-1')], match([r, round('4-1')]), meta);
    expect(p.contributing!.observations.join('\n')).not.toContain('Armory');
  });

  it('uses the idle rounds as the window for ECON_002', () => {
    const m = match([...STAGE3, round('4-1')]);
    const [p] = attachContributingDecisions([point('ECON_002', '3-3', { streakStartRound: '3-1' })], m);
    expect(p.contributing?.window).toBe('the rounds the gold sat idle (3-1 to 3-3)');
  });

  it('leaves untraced rules, and checkpoints with no earlier stage, alone', () => {
    const m = match([round('2-1'), ...STAGE3]);
    const [a, b] = attachContributingDecisions([point('TRAIT_001', '3-2'), point('LOBBY_002', '2-1')], m);
    expect(a.contributing).toBeUndefined();
    expect(b.contributing).toBeUndefined();
  });

  it('never phrases an observation as a verdict', () => {
    const m = match([...STAGE3, round('4-1')]);
    const [p] = attachContributingDecisions([point('HP_002', '4-1')], m);
    for (const o of p.contributing!.observations) expect(o).not.toMatch(/\bshould\b|\bmistake\b|\bcorrect\b/i);
  });
});
