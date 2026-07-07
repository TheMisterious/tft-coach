// Append-only, timestamped event ledger flushed to disk via Overwolf File API.
// One .jsonl file per match, keyed by pseudo_match_id.
//
// WHY APPEND-ONLY: lets you replay any match through updated coaching logic
// without re-playing the game, and survives crashes because every event is
// flushed within 2 seconds.

declare const overwolf: any;

import type { LedgerEntry } from '../shared/types';

let currentMatchId: string | null = null;
let buffer: LedgerEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingFlush: Promise<void> = Promise.resolve();

function getLedgerDir(): string {
  // overwolf.io.paths.documents resolves to the Windows Documents folder.
  const docs = (overwolf?.io?.paths?.documents as string | undefined) ?? '';
  return `${docs}/TFT-Coach/ledgers`;
}

export function appendEvent(entry: LedgerEntry): void {
  buffer.push(entry);

  // Switch ledger files when the match ID changes.
  if (entry.kind === 'info' && entry.feature === 'match_info' && entry.key === 'pseudo_match_id') {
    const newId = entry.value as string;
    if (newId !== currentMatchId) {
      flushSync();              // commit the old ledger before switching
      currentMatchId = newId;
      console.log('[ledger] new match:', newId);
    }
  }

  // Fallback: GEP sometimes provides game_info.matchId but never pseudo_match_id.
  // Only use it when no pseudo_match_id has arrived yet so pseudo_match_id always wins.
  if (entry.kind === 'info' && entry.feature === 'game_info' && entry.key === 'matchId') {
    const newId = String(entry.value);
    if (newId && !currentMatchId) {
      currentMatchId = newId;
      console.log('[ledger] new match (game_info.matchId fallback):', newId);
    }
  }

  // match_end falls through to the normal debounce — the pipeline issues its own
  // flushSync() after yielding to let this appendEvent call complete, so the
  // match_end entry is included in the single end-of-match write rather than
  // triggering a second write that would overwrite the main batch.

  if (flushTimer == null) {
    flushTimer = setTimeout(flushSync, 2000);
  }
}

export function flushSync(): void {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!currentMatchId || buffer.length === 0) return;

  const path = `${getLedgerDir()}/${currentMatchId}.jsonl`;
  const entryCount = buffer.length;
  const chunk = buffer.map(e => JSON.stringify(e)).join('\n') + '\n';
  buffer = [];

  console.log(`[ledger] flushing ${entryCount} entries to: ${path}`);

  // Chain onto pendingFlush so concurrent calls don't race on the same file.
  // WHY read-then-write: Overwolf's writeFileContents 4th param is triggerUacIfRequired,
  // NOT an append flag — every call overwrites the file.  We simulate append by reading
  // the existing content first and writing old + new in one shot.
  // WATCH OUT: not atomic; a crash between read and write loses the last batch.
  // Always parse ledger line-by-line and skip unparseable lines on read.
  pendingFlush = pendingFlush.then(() => new Promise<void>(resolve => {
    overwolf.io.readFileContents(
      path,
      overwolf.io.enums.eEncoding.UTF8,
      (readResult: { success: boolean; content?: string }) => {
        const existing = (readResult.success && readResult.content) ? readResult.content : '';
        overwolf.io.writeFileContents(
          path,
          existing + chunk,
          overwolf.io.enums.eEncoding.UTF8,
          true,   // triggerUacIfRequired (not append — see comment above)
          (result: { success: boolean; error?: string }) => {
            if (!result.success) {
              console.error('[ledger] write failed:', result.error, '| path:', path);
            } else {
              console.log(`[ledger] write OK: ${entryCount} entries -> ${path}`);
            }
            resolve();
          }
        );
      }
    );
  }));
}

// Resolves once all in-flight writeFileContents calls have completed.
// Await this before readLedger to avoid Windows file-lock races.
export function waitForFlush(): Promise<void> {
  return pendingFlush;
}

export function getCurrentMatchId(): string | null {
  return currentMatchId;
}

// Used when GEP never delivers pseudo_match_id before match_end fires.
// Only sets the ID if one hasn't arrived yet — never overwrites a real ID.
export function forceMatchId(id: string): void {
  if (!currentMatchId) {
    currentMatchId = id;
    console.log('[ledger] forced fallback match ID:', id);
  }
}

export function resetLedger(): void {
  flushSync();
  currentMatchId = null;
  buffer = [];
}

// Read a saved ledger file line-by-line, skipping malformed lines.
// Retries up to 3 times on Windows file-lock errors (e.g. when a concurrent
// writeFileContents has been acknowledged but the OS handle isn't fully closed).
export async function readLedger(matchId: string): Promise<LedgerEntry[]> {
  const path = `${getLedgerDir()}/${matchId}.jsonl`;
  console.log('[ledger] reading:', path);

  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 300 * attempt));
      console.log(`[ledger] retrying read (attempt ${attempt + 1}): ${path}`);
    }

    const result = await new Promise<{ success: boolean; content?: string; error?: string }>(
      resolve => overwolf.io.readFileContents(path, overwolf.io.enums.eEncoding.UTF8, resolve)
    );

    if (!result.success || !result.content) {
      const isLock = (result.error ?? '').includes('being used by another process');
      console.error(
        '[ledger] readFileContents failed — success:', result.success,
        'hasContent:', !!result.content,
        'error:', result.error ?? '(none)',
        '| path:', path,
      );
      if (isLock && attempt < MAX_ATTEMPTS - 1) continue;
      return [];
    }

    const entries: LedgerEntry[] = [];
    let malformed = 0;
    for (const line of result.content.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as LedgerEntry);
      } catch {
        malformed++;
        console.warn('[ledger] skipping malformed line:', line.slice(0, 80));
      }
    }
    console.log(`[ledger] read OK: ${entries.length} entries (${malformed} malformed) from ${path}`);
    return entries;
  }
  return [];
}
