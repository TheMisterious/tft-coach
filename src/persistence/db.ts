// localStorage-backed persistence for match history.
// Replaces better-sqlite3, which requires CommonJS require() unavailable in
// Overwolf's CEF background window (type: WebApp, no Node integration).
//
// Storage layout:
//   tft:index            → JSON array of { pseudo_match_id, date_played, placement, last_round }
//   tft:match:<id>       → JSON-serialised MatchRecord (brief + report only —
//                          NOT the raw ledger; see MatchRecord's doc comment
//                          in shared/types.ts for why)

import type { MatchRecord, MatchSummary, FeatureVector, MatchLabels, PlayerProfile } from '../shared/types';
// Records from an older schema are skipped rather than fed into the model
// with misaligned columns; see loadAllFeatureRecords below.
import { FEATURE_SCHEMA_VERSION } from '../shared/types';

const INDEX_KEY   = 'tft:index';
const MAX_MATCHES = 200;
const matchKey    = (id: string) => `tft:match:${id}`;
const PROFILE_KEY = 'tft:profile';

function readIndex(): MatchSummary[] {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]') as MatchSummary[];
  } catch {
    return [];
  }
}

function writeIndex(index: MatchSummary[]): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

// Index entries beyond MAX_MATCHES used to just fall off the index while
// their tft:match:<id> blob stayed in localStorage forever — unbounded growth
// toward the ~5-10MB quota with no eviction. Cap the index here AND delete
// the orphaned blobs for whatever falls off.
function trimIndex(index: MatchSummary[]): MatchSummary[] {
  const kept    = index.slice(0, MAX_MATCHES);
  const evicted = index.slice(MAX_MATCHES);
  for (const s of evicted) localStorage.removeItem(matchKey(s.pseudo_match_id));
  return kept;
}

// Drops the oldest `count` matches (blob + index entry) to free quota space.
// Returns the surviving index.
function evictOldest(index: MatchSummary[], count: number): MatchSummary[] {
  const survivors = index.slice(0, Math.max(0, index.length - count));
  const evicted   = index.slice(survivors.length);
  for (const s of evicted) localStorage.removeItem(matchKey(s.pseudo_match_id));
  return survivors;
}

// Both the match blob write and the index write can independently hit quota
// (the index itself is a JSON array that grows with every match). Attempts
// the full save — blob + index — as one unit so a mid-write quota failure
// never leaves the two out of sync.
function attemptSave(m: MatchRecord, index: MatchSummary[], serialized: string): void {
  localStorage.setItem(matchKey(m.pseudoMatchId), serialized);
  const summary: MatchSummary = {
    pseudo_match_id: m.pseudoMatchId,
    date_played:     m.datePlayed,
    placement:       m.placement,
    last_round:      m.lastRound,
  };
  writeIndex(trimIndex([summary, ...index]));
}

// Returns whether the match actually persisted. saveMatch used to be
// fire-and-forget (void) — main.ts logged "match saved to DB" unconditionally
// regardless of the outcome, so a quota failure here was invisible: the
// report still displayed (it's already in memory by this point), but nothing
// showed up in match history and nothing told the user why.
export function saveMatch(m: MatchRecord): boolean {
  try {
    const baseIndex  = readIndex().filter(s => s.pseudo_match_id !== m.pseudoMatchId);
    const serialized = JSON.stringify(m);

    try {
      attemptSave(m, baseIndex, serialized);
      console.log('[db] saved match:', m.pseudoMatchId);
      return true;
    } catch (e) {
      console.warn('[db] saveMatch: quota hit, evicting oldest matches and retrying —', e);
    }

    // Quota exceeded on the first attempt — evict progressively larger
    // batches of the oldest matches (10, then 20, then 40) and retry, since a
    // single fixed batch may not free enough space in one pass.
    for (const batchSize of [10, 20, 40]) {
      const evicted = evictOldest(baseIndex, batchSize);
      try {
        attemptSave(m, evicted, serialized);
        console.log('[db] saved match after evicting', batchSize, 'oldest matches:', m.pseudoMatchId);
        return true;
      } catch {
        continue;
      }
    }

    console.error('[db] saveMatch failed: quota exceeded even after evicting the oldest matches');
    return false;
  } catch (e) {
    console.error('[db] saveMatch failed:', e);
    return false;
  }
}

export function listRecentMatches(limit = 50): MatchSummary[] {
  try {
    return readIndex().slice(0, limit);
  } catch (e) {
    console.error('[db] listRecentMatches failed:', e);
    return [];
  }
}

export function loadMatch(pseudoMatchId: string): MatchRecord | null {
  try {
    const raw = localStorage.getItem(matchKey(pseudoMatchId));
    if (!raw) return null;
    return JSON.parse(raw) as MatchRecord;
  } catch (e) {
    console.error('[db] loadMatch failed:', e);
    return null;
  }
}

export function closeDb(): void {
  // No-op — localStorage needs no explicit teardown.
}

// ─── Player Trends (see src/profile/) ───────────────────────────────────────
// tft:profile is a single derived-aggregate key, the same category as
// tft:index itself: fully recomputable from featureVector/matchLabels already
// sitting on each MatchRecord, so this is a cache, not a second source of
// truth for match history (design/05-scaling-rules.md's constraint).

export interface FeatureVectorRecord {
  matchId: string;
  featureVector: FeatureVector;
  labels: MatchLabels;
  placement: number;
}

// Reads every indexed match's featureVector/matchLabels (when present).
// Records missing either field (not yet processed by the Player Trends
// extraction) or carrying a stale schemaVersion are excluded — the latter
// counted and returned separately so the UI can say "N older matches need
// reprocessing" instead of silently training on a shrinking, unexplained set.
export function loadAllFeatureRecords(): { records: FeatureVectorRecord[]; skippedStaleSchemaCount: number } {
  const records: FeatureVectorRecord[] = [];
  let skippedStaleSchemaCount = 0;

  for (const s of readIndex()) {
    const record = loadMatch(s.pseudo_match_id);
    if (!record?.featureVector || !record?.matchLabels) continue;
    // A placeholder 8th, not a result (src/ledger/placement.ts) — training on
    // it would teach the trend model that this match's behaviour finishes last.
    if (record.placementSource === 'none') continue;
    if (record.featureVector.schemaVersion !== FEATURE_SCHEMA_VERSION) {
      skippedStaleSchemaCount++;
      continue;
    }
    records.push({
      matchId:       s.pseudo_match_id,
      featureVector: record.featureVector,
      labels:        record.matchLabels,
      placement:     record.placement,
    });
  }

  return { records, skippedStaleSchemaCount };
}

export function savePlayerProfile(p: PlayerProfile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  } catch (e) {
    console.error('[db] savePlayerProfile failed:', e);
  }
}

export function loadPlayerProfile(): PlayerProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PlayerProfile;
  } catch (e) {
    console.error('[db] loadPlayerProfile failed:', e);
    return null;
  }
}
