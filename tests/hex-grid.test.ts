import { describe, it, expect } from 'vitest';
import { resolveHexCell } from '../src/shared/hex-grid';

// Row-0 orientation for both sides has flipped twice from screenshot-based
// guessing (see hex-grid.ts's history comment) before finally being settled
// by cross-referencing real match_info.battle_stats (damage blocked, a real
// frontline signal) against row across 19 real ledgers. Locking the
// confirmed direction in here so a future edit can't silently flip it again
// without a test failing.
describe('resolveHexCell row orientation (locked in via real battle_stats data)', () => {
  it('own side: lowest raw cell ids (1-7) are the back row, closest to the player', () => {
    expect(resolveHexCell('cell_1')).toEqual({ side: 'own', row: 3, col: 0 });
  });

  it('own side: highest raw cell ids (22-28) are the front row, closest to the midline', () => {
    expect(resolveHexCell('cell_22')).toEqual({ side: 'own', row: 0, col: 0 });
  });

  it('opponent side: lowest raw cell ids (29-35) are the front row, closest to the midline', () => {
    expect(resolveHexCell('cell_29')).toEqual({ side: 'opponent', row: 0, col: 0 });
  });

  it('opponent side: highest raw cell ids (50-56) are the back row, farthest from the midline', () => {
    expect(resolveHexCell('cell_50')).toEqual({ side: 'opponent', row: 3, col: 0 });
  });
});
