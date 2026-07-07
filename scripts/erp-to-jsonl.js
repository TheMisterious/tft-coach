#!/usr/bin/env node
// Converts an ow-events-recorder timeline.json file into the .jsonl ledger format
// that the replay harness and coaching pipeline expect.
//
// Steps:
//   1. Record a TFT match with ow-events-recorder.
//   2. Export the session as a .erp file.
//   3. Rename .erp → .zip and extract.
//   4. Run: node scripts/erp-to-jsonl.js path/to/timeline.json
//   5. Output: tests/goldens/YYYY-MM-DD-rank-N.jsonl (named by date or manually)

const fs   = require('fs');
const path = require('path');

const inputFile = process.argv[2];
if (!inputFile) {
  console.error('Usage: node scripts/erp-to-jsonl.js <timeline.json>');
  process.exit(1);
}

const raw      = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
const timeline = Array.isArray(raw) ? raw : raw.timeline ?? [];

// ow-events-recorder timeline format: [[timestamp, event], ...]
// event has type, feature (for InfoUpdate), name (for GameEvent), data/info

const entries = [];

for (const [ts, ev] of timeline) {
  try {
    if (ev.type === 'InfoUpdate') {
      // ev.info: { feature, info: { [feature]: { [key]: value } } }
      const feature = ev.info?.feature;
      const inner   = ev.info?.info?.[feature] ?? {};
      for (const [key, value] of Object.entries(inner)) {
        entries.push({ ts, kind: 'info', feature, key, value });
      }
    } else if (ev.type === 'GameEvent') {
      // ev.events: [{ name, data }]
      for (const gameEv of ev.events ?? []) {
        entries.push({ ts, kind: 'event', name: gameEv.name, data: gameEv.data });
      }
    }
  } catch (e) {
    console.warn('[erp-to-jsonl] skipping malformed entry:', JSON.stringify(ev).slice(0, 100));
  }
}

const date     = new Date().toISOString().slice(0, 10);
const outFile  = path.join(
  path.dirname(inputFile),
  `../../tests/goldens/${date}-rank-unknown.jsonl`
);

const jsonl = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, jsonl, 'utf-8');

console.log(`[erp-to-jsonl] wrote ${entries.length} entries to:`, path.resolve(outFile));
console.log('[erp-to-jsonl] rename the file to include your final placement (e.g. 2026-04-28-rank-3.jsonl)');
