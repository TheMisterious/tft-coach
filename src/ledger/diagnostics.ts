// Ledger coverage diagnostics — answers "did GEP actually send X this match"
// from real captured data instead of guessing from Overwolf's docs.
//
// Every checker and extraction function (extractFinalPlacement, streak
// tracking in reconstructSnapshots, etc.) assumes certain feature.key signals
// arrive from GEP beyond the well-established gold/shop/board/health ones.
// TFT's Overwolf GEP support is known to be less complete than LoL's and has
// open gaps (see file header comments in ledger/rounds.ts), so this gives a
// concrete per-match report of what showed up rather than continued
// speculation. Exposed via window.__debugLedgerCoverage() in background/main.ts.

import type { LedgerEntry } from '../shared/types';

export interface LedgerCoverage {
  totalEntries: number;
  infoCounts: Record<string, number>;  // "feature.key" -> occurrence count
  eventCounts: Record<string, number>; // event name -> occurrence count
  expectedSignals: Array<{ signal: string; present: boolean; count: number; usedBy: string }>;
}

// Signals the pipeline relies on beyond gold/shop/board/health. If one of
// these shows present:false for a real match, the corresponding feature is
// either not supported by TFT's GEP integration, or gated behind a condition
// (e.g. only fires on certain round types) that this match didn't trigger.
const EXPECTED_SIGNALS: Array<{ signal: string; usedBy: string }> = [
  { signal: 'me.rank',                    usedBy: 'live rank trajectory; final-placement fallback' },
  { signal: 'me.placement',               usedBy: 'final placement (extractFinalPlacement) — confirmed absent in real matches so far; me.rank fallback carries this' },
  { signal: 'roster.player_status',       usedBy: 'resolves localPlayerName (via the localplayer:true flag) for match_info.round_outcome lookup — streak tracking' },
  { signal: 'match_info.round_outcome',   usedBy: 'streak tracking (win/loss streak, STREAK_*)' },
  { signal: 'match_info.round_type',      usedBy: 'round labels ("3-2")' },
  { signal: 'match_info.match_outcome',   usedBy: 'match-end detection fallback' },
  { signal: 'me.picked_augment',          usedBy: 'augment checkers (AUGMENT_*) — confirmed shape: {slot_N: {name}}' },
  { signal: 'match_info.god_names',       usedBy: 'Set 17 god alignment checkers (SET17_*) — the two gods offered this round' },
  { signal: 'match_info.god_picked_favor',usedBy: 'Set 17 god alignment checkers (SET17_*) — which side ("favor_left"/"favor_right") was picked' },
  { signal: 'match_info.god_favors',      usedBy: 'SET17_002 Evelynn HP-risk checker — shape confirmed (array of {favor_left,favor_right}, each {name,name_lang,title,title_lang}), but no raw HP-cost number in the payload; needs a real match where Evelynn is actually picked to derive cost from the HP delta' },
];

export function summarizeLedgerCoverage(ledger: LedgerEntry[]): LedgerCoverage {
  const infoCounts: Record<string, number> = {};
  const eventCounts: Record<string, number> = {};

  for (const e of ledger) {
    if (e.kind === 'info') {
      const k = `${e.feature}.${e.key}`;
      infoCounts[k] = (infoCounts[k] ?? 0) + 1;
    } else {
      eventCounts[e.name] = (eventCounts[e.name] ?? 0) + 1;
    }
  }

  const expectedSignals = EXPECTED_SIGNALS.map(({ signal, usedBy }) => ({
    signal,
    usedBy,
    present: (infoCounts[signal] ?? 0) > 0,
    count: infoCounts[signal] ?? 0,
  }));

  return { totalEntries: ledger.length, infoCounts, eventCounts, expectedSignals };
}

export function formatLedgerCoverage(coverage: LedgerCoverage): string {
  const lines: string[] = [];
  lines.push(`Ledger: ${coverage.totalEntries} entries`);
  lines.push('');
  lines.push('Expected signal coverage:');
  for (const s of coverage.expectedSignals) {
    lines.push(`  ${s.present ? '[OK]  ' : '[MISS]'} ${s.signal} — ${s.count} occurrence(s) — used by: ${s.usedBy}`);
  }
  lines.push('');
  lines.push('All info feature.key pairs seen (sorted by count):');
  for (const [k, count] of Object.entries(coverage.infoCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${k}: ${count}`);
  }
  lines.push('');
  lines.push('All events seen (sorted by count):');
  for (const [k, count] of Object.entries(coverage.eventCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${k}: ${count}`);
  }
  return lines.join('\n');
}

// Pulls up to maxPerKey raw values for each (or a filtered set of) feature.key
// pairs. Coverage counts alone can't tell us the *shape* of a payload — e.g.
// confirming a key exists doesn't tell us whether it's a single string, an
// array, or an object keyed by summoner name. Use this before writing any
// parsing logic against a newly-discovered key.
export function sampleRawValues(
  ledger: LedgerEntry[],
  maxPerKey = 5,
  keyFilter?: string[]
): Record<string, unknown[]> {
  const samples: Record<string, unknown[]> = {};
  const allowed = keyFilter ? new Set(keyFilter) : null;

  for (const e of ledger) {
    if (e.kind !== 'info') continue;
    const k = `${e.feature}.${e.key}`;
    if (allowed && !allowed.has(k)) continue;
    if (!samples[k]) samples[k] = [];
    if (samples[k].length < maxPerKey) samples[k].push(e.value);
  }
  return samples;
}

export function formatRawSamples(samples: Record<string, unknown[]>): string {
  const lines: string[] = [];
  for (const [k, vals] of Object.entries(samples)) {
    lines.push(`${k}:`);
    for (const v of vals) lines.push(`  ${JSON.stringify(v)}`);
  }
  return lines.join('\n');
}
