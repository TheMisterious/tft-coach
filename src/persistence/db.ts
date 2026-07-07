// localStorage-backed persistence for match history.
// Replaces better-sqlite3, which requires CommonJS require() unavailable in
// Overwolf's CEF background window (type: WebApp, no Node integration).
//
// Storage layout:
//   tft:index            → JSON array of { pseudo_match_id, date_played, placement, last_round }
//   tft:match:<id>       → JSON-serialised MatchRecord

import type { MatchRecord, MatchSummary, CoachingReport, MatchBrief, LedgerEntry } from '../shared/types';

const INDEX_KEY = 'tft:index';
const matchKey  = (id: string) => `tft:match:${id}`;

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

export function saveMatch(m: MatchRecord): void {
  try {
    localStorage.setItem(matchKey(m.pseudoMatchId), JSON.stringify(m));

    const index   = readIndex().filter(s => s.pseudo_match_id !== m.pseudoMatchId);
    const summary: MatchSummary = {
      pseudo_match_id: m.pseudoMatchId,
      date_played:     m.datePlayed,
      placement:       m.placement,
      last_round:      m.lastRound,
    };
    // Keep sorted newest-first, cap at 200 entries.
    index.unshift(summary);
    writeIndex(index.slice(0, 200));
    console.log('[db] saved match:', m.pseudoMatchId);
  } catch (e) {
    console.error('[db] saveMatch failed:', e);
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
