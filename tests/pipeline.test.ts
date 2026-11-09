// src/background/pipeline.ts — the steps main.ts runs after match_end, and
// again to rebuild a saved match. The golden-ledger tests run it end to end
// through tests/replay-harness.ts; these pin the refusals and the result shape
// on hand-written ledgers, so they run on a fresh clone with no goldens.

import { describe, it, expect } from 'vitest';
import { readMatch, coachMatch } from '../src/background/pipeline';
import type { LedgerEntry } from '../src/shared/types';

let ts = 0;
const info = (feature: string, key: string, value: unknown): LedgerEntry =>
  ({ ts: ++ts, kind: 'info', feature, key, value });
const event = (name: string, data: unknown = {}): LedgerEntry =>
  ({ ts: ++ts, kind: 'event', name, data });

const unit = (name: string) => ({ name, level: '1', item_1: '', item_2: '', item_3: '' });

// Two PvP rounds of a Set 18 match with the player's own gold and board.
const MATCH: LedgerEntry[] = [
  info('match_info', 'game_mode', 'TFT'),
  info('roster', 'player_status', {
    Me:    { health: 100, xp: 4, localplayer: true },
    Other: { health: 100, xp: 4, localplayer: false },
  }),
  info('me', 'gold', 10),
  ...['2-1', '2-2'].flatMap(stage => [
    info('match_info', 'round_type', { stage, type: 'PVP' }),
    event('round_start', 'PVP'),
    info('board', 'board_pieces', { cell_1: unit('DA_18_Akali_AD'), cell_2: unit('DA_Gromp18_AP') }),
    event('round_end'),
  ]),
];

describe('readMatch', () => {
  it('refuses an empty ledger', () => {
    expect(readMatch([]).unusable).toBe('empty_ledger');
  });

  it('refuses a ledger with no rounds', () => {
    expect(readMatch(MATCH.slice(0, 3)).unusable).toBe('no_rounds');
  });

  it('refuses rounds that never saw the player\'s own gold or board', () => {
    const spectating = MATCH.filter(e => !(e.kind === 'info' && (e.key === 'gold' || e.key === 'board_pieces')));
    const read = readMatch(spectating);
    expect(read.unusable).toBe('not_playable');
    expect(read.snapshot?.rounds.length).toBeGreaterThan(0);
  });

  it('accepts the player\'s own match', () => {
    const read = readMatch(MATCH);
    expect(read.unusable).toBeUndefined();
    expect(read.snapshot?.rounds.map(r => r.label)).toEqual(['2-1', '2-2']);
  });
});

describe('coachMatch', () => {
  it('produces everything main.ts saves', async () => {
    const read = readMatch(MATCH);
    if (read.unusable) throw new Error(read.unusable);
    const coached = await coachMatch(MATCH, read.snapshot);
    expect(coached.setId).toBe('set18');
    expect(coached.meta.setDataMissing).toBeUndefined();
    // Two rounds are too few to grade overall (coverage.ts), but the report exists.
    expect(Array.isArray(coached.report.notes)).toBe(true);
    expect(coached.brief.setId).toBe('set18');
    expect(coached.featureVector).toBeTruthy();
    expect(coached.matchLabels).toBeTruthy();
  });
});
