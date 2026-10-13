// Which TFT set a GEP champion id belongs to. Shared by meta-lookup.ts's
// detectSet() (picks the data/sets/ folder) and rounds.ts (MatchSnapshot.setId)
// so the two can never disagree about the same ledger.
//
// The id scheme changed between sets, and assuming the old one is what sent
// every Set 18 match down the set17 fallback (the sim sandbox found the same
// thing in its own fetchers first; its 2026-09-03 log entry, "Set 18 is
// published, and two id-prefix filters were silently discarding it"):
//
//   Set <= 17: TFT17_Akali                — `TFT<N>_` prefix
//   Set 18:    DA_18_Akali_AD, DA_18_Sentry — `DA_<N>_` prefix
//              DA_Gromp18_AP, DA_Taric18    — number glued to the name
//
// PvE monsters shared across sets carry `TFT_` with no number and say nothing
// about the set, so they return undefined rather than a guess.

/** What detectSet() and MatchSnapshot.setId report when no id names a set. */
export const UNKNOWN_SET_ID = 'unknown';

export function setIdFromChampionId(id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined;
  const m = /^TFT(\d+)_/.exec(id)
         ?? /^DA_(\d+)_/.exec(id)
         ?? /^DA_[A-Za-z]+(\d+)(?:_|$)/.exec(id);
  return m ? `set${m[1]}` : undefined;
}
