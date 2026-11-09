// Final placement and its provenance (src/ledger/placement.ts). The order is
// the whole point: GEP's own end-of-match placement, then the live-rank
// fallback, then nothing — and "nothing" must stay distinguishable from a
// real 8th.

import { describe, it, expect } from 'vitest';
import { findFinalPlacement } from '../src/ledger/placement';
import { reconstructSnapshots } from '../src/ledger/rounds';
import type { LedgerEntry } from '../src/shared/types';

const info = (feature: string, key: string, value: unknown, ts = 1): LedgerEntry =>
  ({ ts, kind: 'info', feature, key, value });

describe('findFinalPlacement', () => {
  it('prefers GEP me.placement over everything else', () => {
    expect(findFinalPlacement([
      info('me', 'rank', 5), info('me', 'placement', 3),
    ])).toEqual({ placement: 3, source: 'gep' });
  });

  it('falls back to the last valid live rank, ignoring rank 0 (still alive)', () => {
    expect(findFinalPlacement([
      info('me', 'rank', 6), info('me', 'rank', 0),
    ])).toEqual({ placement: 6, source: 'rank' });
  });

  it('returns null when the ledger has no placement signal at all', () => {
    expect(findFinalPlacement([info('me', 'rank', 0), info('me', 'health', 12)])).toBeNull();
  });
});

// Two players knocked out in the same round. GEP ranks them by who died first;
// TFT ranks them by HP (least negative higher), then by HP at round start.
describe('same-round eliminations', () => {
  const roundStart = (ts: number): LedgerEntry => ({ ts, kind: 'event', name: 'round_start', data: 'PVP' });
  const roster = (players: Record<string, { health: number; rank: number; localplayer?: boolean }>, ts: number) =>
    info('roster', 'player_status', players, ts);

  // The 2026-11-09 match: both died in 4-6, the opponent first at -1 HP, then
  // the player at -2. GEP said 7th; the game said 8th.
  const ledger = (meFinal: number, foeFinal: number, meStart = 8, foeStart = 10): LedgerEntry[] => [
    roster({ me: { health: meStart, rank: 0, localplayer: true }, foe: { health: foeStart, rank: 0 }, alive: { health: 50, rank: 0 } }, 1),
    roundStart(2),
    roster({ me: { health: meStart, rank: 0, localplayer: true }, foe: { health: foeFinal, rank: 8 }, alive: { health: 50, rank: 0 } }, 3),
    roster({ me: { health: meFinal, rank: 7, localplayer: true }, foe: { health: foeFinal, rank: 8 }, alive: { health: 50, rank: 0 } }, 4),
    info('me', 'rank', 7, 4),
  ];

  it('ranks the more negative HP lower, whatever order GEP saw the deaths in', () => {
    expect(findFinalPlacement(ledger(-2, -1))).toEqual({ placement: 8, source: 'rank' });
    expect(findFinalPlacement(ledger(-1, -2))).toEqual({ placement: 7, source: 'rank' });
  });

  it('breaks an exact HP tie by HP at the start of the round', () => {
    expect(findFinalPlacement(ledger(-3, -3, 12, 5))).toEqual({ placement: 7, source: 'rank' });
    expect(findFinalPlacement(ledger(-3, -3, 5, 12))).toEqual({ placement: 8, source: 'rank' });
  });

  it("keeps GEP's rank when final HP is stale or clamped, as in older ledgers", () => {
    // A positive HP is the last value from before the fatal round.
    expect(findFinalPlacement(ledger(3, -1))).toEqual({ placement: 7, source: 'rank' });
    // Everyone at 0 says nothing about who lost more.
    expect(findFinalPlacement(ledger(0, 0, 4, 20))).toEqual({ placement: 7, source: 'rank' });
  });

  it('leaves a lone elimination alone', () => {
    const solo: LedgerEntry[] = [
      roster({ me: { health: 5, rank: 0, localplayer: true }, foe: { health: -4, rank: 8 } }, 1),
      roundStart(2),
      roster({ me: { health: -6, rank: 7, localplayer: true }, foe: { health: -4, rank: 8 } }, 3),
      info('me', 'rank', 7, 3),
    ];
    expect(findFinalPlacement(solo)).toEqual({ placement: 7, source: 'rank' });
  });

  it('never overrides GEP me.placement', () => {
    expect(findFinalPlacement([...ledger(-2, -1), info('me', 'placement', 7, 5)]))
      .toEqual({ placement: 7, source: 'gep' });
  });
});

describe('reconstructSnapshots placement provenance', () => {
  it('marks a placeholder 8th as source none, not as a real placement', () => {
    const snapshot = reconstructSnapshots([info('me', 'health', 12)]);
    expect(snapshot.finalPlacement).toBe(8);
    expect(snapshot.placementSource).toBe('none');
  });

});
