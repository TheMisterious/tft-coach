// Round labels under GEP's real event orderings. Across 81 recorded matches
// the old reconstruction produced 78 duplicate labels and dropped checkpoint
// rounds (3-1, 3-2, 4-1, 5-1) that the fixed-checkpoint rules read, because a
// round's round_type, the previous round's round_end, and the next round's
// round_type all arrive in the same millisecond in varying order. Each case
// below is the order seen in a real ledger.

import { describe, it, expect } from 'vitest';
import { reconstructSnapshots } from '../src/ledger/rounds';
import type { LedgerEntry } from '../src/shared/types';

const info = (ts: number, stage: string): LedgerEntry =>
  ({ ts, kind: 'info', feature: 'match_info', key: 'round_type', value: { stage, type: 'PVP' } });
const ev = (ts: number, name: string): LedgerEntry => ({ ts, kind: 'event', name, data: 'PVP' });
const gold = (ts: number, g: number): LedgerEntry => ({ ts, kind: 'info', feature: 'me', key: 'gold', value: g });

const labels = (entries: LedgerEntry[]) => reconstructSnapshots(entries).rounds.map(r => r.label);

describe('round labels', () => {
  it('round_type after its round_start, round_end never sent', () => {
    // 486 of 2,477 starts: label lands just after the start.
    expect(labels([
      ev(1000, 'round_start'), info(1000, '2-6'), gold(5000, 10),
      ev(60000, 'round_start'), info(60000, '2-7'), gold(65000, 12),
      ev(120000, 'round_start'), info(120001, '3-1'),
    ])).toEqual(['2-6', '2-7', '3-1']);
  });

  it('the previous round\'s round_end arriving after the next round_start', () => {
    // fallback-1784368809002: round_start, round_end, round_type 3-1 in one ms.
    expect(labels([
      info(1000, '2-7'), ev(1000, 'round_start'), gold(5000, 10),
      ev(60000, 'round_start'), ev(60000, 'round_end'), info(60000, '3-1'), gold(65000, 20),
      ev(120000, 'round_end'), info(120000, '3-2'), ev(120000, 'round_start'),
    ])).toEqual(['2-7', '3-1', '3-2']);
  });

  it('the next round\'s round_type arriving before this round\'s round_end', () => {
    // fallback-1785680397805: round_type 5-2, round_end, round_start in one ms.
    expect(labels([
      info(1000, '5-1'), ev(1000, 'round_start'), gold(5000, 30),
      info(60000, '5-2'), ev(60000, 'round_end'), ev(60001, 'round_start'),
      ev(120000, 'round_end'),
    ])).toEqual(['5-1', '5-2']);
  });
});

describe('XP purchase detection', () => {
  const shop = (ts: number, slots: string[]): LedgerEntry =>
    ({ ts, kind: 'info', feature: 'store', key: 'shop_pieces', value: Object.fromEntries(slots.map((name, i) => [`slot_${i + 1}`, { name }])) });
  const roundWith = (...body: LedgerEntry[]) => reconstructSnapshots([
    info(10, '3-1'), ev(10, 'round_start'), gold(11, 30), ...body, ev(60000, 'round_end'),
  ]).rounds[0];

  it('a 4-gold drop with no shop purchase is XP', () => {
    expect(roundWith(gold(1000, 26)).xpBought).toBe(true);
  });

  it('a 4-gold unit bought from the shop is not XP, whichever update lands first', () => {
    const shopBefore = shop(500, ['A', 'B', 'C', 'D', 'E']);
    expect(roundWith(shopBefore, gold(1000, 26), shop(1001, ['A', 'Sold', 'C', 'D', 'E'])).xpBought).toBe(false);
    expect(roundWith(shopBefore, shop(1000, ['A', 'Sold', 'C', 'D', 'E']), gold(1002, 26)).xpBought).toBe(false);
  });
});
