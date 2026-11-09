// Which recorded ledgers to turn into reports after the fact.
//
// A ledger reaches disk while the match is played; the report is made at the
// end. If that last step never completes — the pipeline crashed (a real Set 18
// match on 2026-11-09 recorded 7,157 entries, then hit an old build's crash),
// the client closed first, or storage was full — the match was recorded but
// never appears in history. On startup the background window lists the ledger
// folder and builds reports for recent ledgers that have none.
//
// Pure selection only; the caller lists the folder and runs the pipeline.

export const RECOVERY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const RECOVERY_MAX_PER_LAUNCH = 3;

// Fallback ids are `fallback-<ms>`, stamped when the match ended.
export function ledgerTimestamp(matchId: string): number | undefined {
  const m = /^fallback-(\d{12,})$/.exec(matchId);
  return m ? Number(m[1]) : undefined;
}

export function pickLedgersToRecover(
  fileNames: string[],
  isSaved: (matchId: string) => boolean,
  alreadyChecked: ReadonlySet<string>,
  now: number,
): string[] {
  return fileNames
    .filter(name => name.endsWith('.jsonl'))
    .map(name => name.slice(0, -'.jsonl'.length))
    .filter(id => !isSaved(id) && !alreadyChecked.has(id))
    // Unknown age (a GEP pseudo id) is read and judged by the caller; a known
    // old one is skipped without reading.
    .filter(id => {
      const ts = ledgerTimestamp(id);
      return ts === undefined || now - ts <= RECOVERY_MAX_AGE_MS;
    })
    .sort((a, b) => (ledgerTimestamp(b) ?? 0) - (ledgerTimestamp(a) ?? 0))
    .slice(0, RECOVERY_MAX_PER_LAUNCH);
}
