import { describe, it, expect } from 'vitest';
import { pickLedgersToRecover, ledgerTimestamp, RECOVERY_MAX_AGE_MS, RECOVERY_MAX_PER_LAUNCH } from '../src/background/recovery';

const NOW = 1794200000000;
const ago = (ms: number) => `fallback-${NOW - ms}`;

describe('pickLedgersToRecover', () => {
  it('picks recent ledgers that have no saved report, newest first', () => {
    const recent = ago(60_000);
    const older = ago(3_600_000);
    const saved = ago(120_000);
    const picked = pickLedgersToRecover(
      [`${older}.jsonl`, `${saved}.jsonl`, `${recent}.jsonl`, 'notes.txt'],
      id => id === saved, new Set(), NOW,
    );
    expect(picked).toEqual([recent, older]);
  });

  it('skips ledgers already checked and ones past the age limit', () => {
    const checked = ago(1000);
    const stale = ago(RECOVERY_MAX_AGE_MS + 1);
    expect(pickLedgersToRecover([`${checked}.jsonl`, `${stale}.jsonl`], () => false, new Set([checked]), NOW)).toEqual([]);
  });

  it('caps the work done per launch', () => {
    const names = Array.from({ length: 10 }, (_, i) => `${ago(i * 1000 + 1)}.jsonl`);
    expect(pickLedgersToRecover(names, () => false, new Set(), NOW)).toHaveLength(RECOVERY_MAX_PER_LAUNCH);
  });

  it('keeps ids with no timestamp for the caller to judge, after dated ones', () => {
    expect(pickLedgersToRecover(['abc-pseudo.jsonl', `${ago(5)}.jsonl`], () => false, new Set(), NOW))
      .toEqual([ago(5), 'abc-pseudo']);
    expect(ledgerTimestamp('fallback-1794166486409')).toBe(1794166486409);
  });
});
