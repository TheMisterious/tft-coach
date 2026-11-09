// Final placement, and where it came from.
//
// GEP's me.placement is the real end-of-match signal, but it is known to never
// arrive — most often when the client is closed straight after elimination,
// before GEP sends the final roster. Of 81 recorded matches audited on
// 2026-10-13, 4 ended that way with no placement signal of any kind. Each source is therefore recorded with
// its provenance, best first:
//
//   gep   me.placement, sent by GEP at match end.
//   rank  the last live me.rank of 1-8. Rank only changes on an elimination,
//         so this is normally right, but it is a fallback, not a report.
//   none  nothing at all. The caller decides what to show; this match must not
//         be read as a real placement by anything that learns from placements.

import type { LedgerEntry, PlacementSource } from '../shared/types';

export function findFinalPlacement(entries: LedgerEntry[]): { placement: number; source: Exclude<PlacementSource, 'none'> } | null {
  return lastValid(entries, 'me', 'placement', 'gep')
    ?? lastValid(entries, 'me', 'rank', 'rank');
}

function lastValid<S extends Exclude<PlacementSource, 'none'>>(
  entries: LedgerEntry[], feature: string, key: string, source: S
): { placement: number; source: S } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind !== 'info' || e.feature !== feature || e.key !== key) continue;
    const parsed = Number(e.value);
    if (parsed >= 1 && parsed <= 8) return { placement: parsed, source };
  }
  return null;
}
