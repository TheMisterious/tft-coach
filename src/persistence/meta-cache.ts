// localStorage-backed cache for the cross-player "meta crawl" (see
// src/enrichment/meta-crawler.ts). Two keys, mirroring the tft:profile
// pattern from src/persistence/db.ts:
//   tft:meta-crawl-state → resumable crawl progress (MetaCrawlState)
//   tft:meta-table       → the finalized AggregateMetaTable, rebuilt each
//                          time a crawl cycle completes
//
// Both are derived, recomputable, runtime-only caches — not a data/ file
// (this is sourced live under the user's own Riot key, not shipped/committed)
// and not a new source of truth for anything (same category as tft:profile).

import type { AggregateMetaTable, MetaCrawlState } from '../shared/types';

const CRAWL_STATE_KEY = 'tft:meta-crawl-state';
const META_TABLE_KEY  = 'tft:meta-table';

export const EMPTY_CRAWL_STATE: MetaCrawlState = {
  seedPuuids: [],
  cursor: 0,
  seedFetchedAt: 0,
  seenMatchIds: [],
  accumulator: [],
};

export function loadMetaCrawlState(): MetaCrawlState {
  try {
    const raw = localStorage.getItem(CRAWL_STATE_KEY);
    if (!raw) return { ...EMPTY_CRAWL_STATE };
    return { ...EMPTY_CRAWL_STATE, ...(JSON.parse(raw) as Partial<MetaCrawlState>) };
  } catch (e) {
    console.error('[meta-cache] loadMetaCrawlState failed:', e);
    return { ...EMPTY_CRAWL_STATE };
  }
}

export function saveMetaCrawlState(state: MetaCrawlState): void {
  try {
    localStorage.setItem(CRAWL_STATE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('[meta-cache] saveMetaCrawlState failed:', e);
  }
}

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

export function saveAggregateMetaTable(table: AggregateMetaTable): void {
  try {
    localStorage.setItem(META_TABLE_KEY, JSON.stringify(table));
  } catch (e) {
    console.error('[meta-cache] saveAggregateMetaTable failed:', e);
  }
}
