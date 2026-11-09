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

describe('reconstructSnapshots placement provenance', () => {
  it('marks a placeholder 8th as source none, not as a real placement', () => {
    const snapshot = reconstructSnapshots([info('me', 'health', 12)]);
    expect(snapshot.finalPlacement).toBe(8);
    expect(snapshot.placementSource).toBe('none');
  });

});
