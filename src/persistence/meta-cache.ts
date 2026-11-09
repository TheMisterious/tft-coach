// localStorage-backed cache for the aggregate meta table (tft:meta-table),
// mirroring the tft:profile pattern from src/persistence/db.ts. A derived,
// runtime-only cache — not a data/ file and not a source of truth.
//
// Nothing writes it any more: the crawler that filled it from Riot's API left
// with Riot sign-in on 2026-11-09. Reading it stays, so a table from an older
// install is still used and an absent one reads as "no meta context".

import type { AggregateMetaTable } from '../shared/types';

const META_TABLE_KEY = 'tft:meta-table';

export function loadAggregateMetaTable(): AggregateMetaTable | undefined {
  try {
    const raw = localStorage.getItem(META_TABLE_KEY);
    if (!raw) return undefined;
    return JSON.parse(raw) as AggregateMetaTable;
  } catch (e) {
    console.error('[meta-cache] loadAggregateMetaTable failed:', e);
    return undefined;
  }
}
