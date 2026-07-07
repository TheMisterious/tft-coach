// Replay harness — feeds a saved .jsonl ledger through the coaching pipeline
// without playing a real TFT match.
//
// Usage:
//   npx ts-node tests/replay-harness.ts tests/goldens/2026-04-28-rank-3.jsonl
//
// Also used by Vitest regression tests (see coach.regression.test.ts).

import { readFileSync } from 'fs';
import path from 'path';
import type { LedgerEntry, MatchBrief } from '../src/shared/types';
import { reconstructSnapshots } from '../src/ledger/rounds';
import { detectSet, loadMeta } from '../src/enrichment/meta-lookup';
import { extractDecisionPoints } from '../src/coach/rule-engine';
import { buildBrief } from '../src/coach/brief-builder';

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

export async function replayLedger(filePath: string) {
  const ledger   = loadLedgerFromFile(filePath);
  const snapshot = reconstructSnapshots(ledger);
  const setId    = detectSet(ledger);

  // In tests, loadMeta fetches from the local data/ folder via Node's file: protocol.
  // Make sure the working directory is the project root when running tests.
  const meta   = await loadMeta(setId);
  const points = extractDecisionPoints(snapshot, meta);
  const brief  = buildBrief(snapshot, points, meta);

  return { ledger, snapshot, points, brief };
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
