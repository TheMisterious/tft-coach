// Replay harness — feeds a saved .jsonl ledger through the coaching pipeline
// without playing a real TFT match.
//
// Usage:
//   npx ts-node tests/replay-harness.ts tests/goldens/2026-04-28-rank-3.jsonl
//
// Also used by Vitest regression tests (see coach.regression.test.ts).

import { readFileSync } from 'fs';
import path from 'path';
import type { LedgerEntry } from '../src/shared/types';
import { readMatch, coachMatch } from '../src/background/pipeline';

export function loadLedgerFromFile(filePath: string): LedgerEntry[] {
  const raw = readFileSync(filePath, 'utf-8');
  const entries: LedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      console.warn('[harness] skipping malformed line:', line.slice(0, 80));
    }
  }
  return entries;
}

// The same pipeline the app runs after match_end (src/background/pipeline.ts),
// minus the match history the app passes from storage. A ledger the app would
// refuse to coach throws, naming why, instead of producing a report it never
// would.
export async function replayLedger(filePath: string) {
  const ledger = loadLedgerFromFile(filePath);
  const read   = readMatch(ledger);
  if (read.unusable) throw new Error(`${path.basename(filePath)} is not a match the app would coach: ${read.unusable}`);

  // In tests, loadMeta fetches from the local data/ folder via Node's file: protocol.
  // Make sure the working directory is the project root when running tests.
  const coached = await coachMatch(ledger, read.snapshot);
  return { ledger, snapshot: read.snapshot, ...coached };
}

// ─── CLI runner ───────────────────────────────────────────────────────────────

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: npx ts-node tests/replay-harness.ts <path-to.jsonl>');
    process.exit(1);
  }

  console.log('[harness] replaying:', filePath);
  const { snapshot, points, brief } = await replayLedger(path.resolve(filePath));

  console.log('\n── Match Snapshot ─────────────────────────────────────');
  console.log('  Placement:', snapshot.finalPlacement);
  console.log('  Set:',       snapshot.setId);
  console.log('  Rounds:',    snapshot.rounds.length);
  console.log('  Augments:',  snapshot.augments);

  console.log('\n── Decision Points ────────────────────────────────────');
  for (const p of points) {
    console.log(`  [${p.severity.toUpperCase().padEnd(8)}] ${p.round} ${p.category}: ${p.observed}`);
  }

  console.log('\n── Brief (JSON sent to report generator) ─────────────');
  console.log(JSON.stringify(brief, null, 2));
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
