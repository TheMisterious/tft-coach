// Rule audit — does each coaching rule actually predict a worse placement?
//
// Every rule in src/coach/checkers/ was written from TFT knowledge and then
// checked only for "does it fire on the right rounds". Nothing has ever checked
// the claim each one implicitly makes: that the mistake it flags COSTS
// PLACEMENT. This replays every recorded match through the real pipeline and
// measures that, per rule, against the one ground truth every match carries —
// where the player finished.
//
// Usage:
//   npx ts-node --transpile-only scripts/rule-audit.ts            extract + analyse
//   npx ts-node --transpile-only scripts/rule-audit.ts --cached    analyse only
//   ... --write   also regenerate data/core/rule-evidence.json, which decides
//                 which notes lead the in-app report (src/coach/rules-loader.ts)
//
// Ledger directories default to the two recording folders on this machine;
// override with TFT_LEDGER_DIRS (semicolon-separated). Output lands in
// results/rule-audit/ (git-ignored): matches.json (per-match firings, no
// player names) and report.md.
//
// THE ONE TRAP THIS IS BUILT AROUND: survivorship. A rule that can fire on any
// round fires more often in a long match, and long matches are good placements
// — so a naive "fired vs not fired" comparison makes almost every rule look
// like it IMPROVES placement. Three views are reported, and only the third is
// safe to act on:
//   naive      fired anywhere vs never fired. Biased; shown so the bias is visible.
//   rate       firings per round played, Spearman vs placement. Still biased
//              when a rule's opportunity depends on the stage reached.
//   windowed   firings at or before a fixed round, among matches that REACHED
//              that round. Every match in the comparison had the same chance
//              to trigger the rule, so a difference is not a length effect.

import '../tests/setup/fetch-polyfill';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { DecisionPoint, LedgerEntry, PlacementSource } from '../src/shared/types';
import { reconstructSnapshots } from '../src/ledger/rounds';
import { findFinalPlacement } from '../src/ledger/placement';
import { detectSet, loadMeta } from '../src/enrichment/meta-lookup';
import { extractDecisionPoints } from '../src/coach/rule-engine';
import { buildMatchContext } from '../src/coach/match-context';
import { buildMatchPlan } from '../src/coach/plan-builder';
import { extractFeatureVector } from '../src/profile/feature-vector';
import { getAllRules } from '../src/coach/rules-loader';

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'results', 'rule-audit');
const DEFAULT_DIRS = [
  'F:/1. project/tft_coach/ledgers',
  'C:/Users/Admin/Documents/TFT-Coach/ledgers',
  path.join(ROOT, 'tests', 'goldens'),
];

// ─── Extraction ──────────────────────────────────────────────────────────────

interface Firing {
  ruleId: string;
  round: string;
  severity: string;
  category: string;
}

interface MatchRecord {
  file: string;
  setId: string;
  gameMode: string;
  placement: number;
  placementSource: PlacementSource;
  rounds: string[];          // labels in play order
  lastRound: string | null;
  firings: Firing[];
  features: Record<string, number | null> | null;
  error?: string;
}

function ledgerDirs(): string[] {
  const env = process.env.TFT_LEDGER_DIRS;
  return env ? env.split(';').filter(Boolean) : DEFAULT_DIRS;
}

function listLedgers(): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const dir of ledgerDirs()) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const full = path.join(dir, name);
      // The goldens are byte-identical copies of six recordings; count each
      // match once.
      const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      if (seen.has(digest)) continue;
      seen.add(digest);
      files.push(full);
    }
  }
  return files;
}

function readLedger(file: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* malformed line */ }
  }
  return entries;
}

async function muted<T>(fn: () => Promise<T> | T): Promise<T> {
  const { log, warn, info } = console;
  console.log = console.warn = console.info = () => {};
  try { return await fn(); } finally { Object.assign(console, { log, warn, info }); }
}

async function extractMatch(file: string): Promise<MatchRecord> {
  const entries = readLedger(file);
  const base: MatchRecord = {
    file: path.basename(file), setId: '?', gameMode: '?', placement: 0,
    // Source 'none' is a placeholder 8th, not a result; such matches are
    // excluded from analysis (src/ledger/placement.ts).
    placementSource: findFinalPlacement(entries)?.source ?? 'none', rounds: [], lastRound: null,
    firings: [], features: null,
  };
  try {
    return await muted(async () => {
      const snapshot = reconstructSnapshots(entries);
      const meta = await loadMeta(detectSet(entries));
      const points: DecisionPoint[] = extractDecisionPoints(snapshot, meta);
      const context = { ...buildMatchContext(snapshot, meta), plan: buildMatchPlan(snapshot, meta) };
      let features: MatchRecord['features'] = null;
      try {
        const { schemaVersion, ...fv } = extractFeatureVector(snapshot, points, context, meta);
        void schemaVersion;
        features = fv as Record<string, number | null>;
      } catch { /* feature extraction is secondary */ }
      const rounds = snapshot.rounds.map(r => r.label);
      return {
        ...base,
        setId: snapshot.setId,
        gameMode: snapshot.gameMode,
        placement: snapshot.finalPlacement,
        rounds,
        lastRound: rounds.at(-1) ?? null,
        firings: points.map(p => ({
          ruleId: p.ruleId ?? `(${p.category})`,
          round: p.round,
          severity: p.severity,
          category: p.category,
        })),
        features,
      };
    });
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}

// ─── Statistics ──────────────────────────────────────────────────────────────

// Checkers also emit two non-round labels: "N-x" for a whole-stage judgment
// (ECON_003's "2-x"), placed at that stage's last round, and "match" for a
// whole-match judgment (STREAK_003), which has no round and cannot be windowed.
function roundNum(label: string): number {
  const m = /^(\d+)-(\d+|x)$/.exec(label);
  if (!m) return NaN;
  return Number(m[1]) * 100 + (m[2] === 'x' ? 7 : Number(m[2]));
}

// Rounds a complete recording holds up to and including `label`: stage 1 has
// 4, every later stage 7 (6-3 -> 4 + 4*7 + 3 = 35, matching real ledgers).
function expectedRounds(label: string): number {
  const m = /^(\d+)-(\d+)$/.exec(label);
  if (!m) return NaN;
  const stage = Number(m[1]), sub = Number(m[2]);
  return stage === 1 ? sub : 4 + (stage - 2) * 7 + sub;
}

// A recording that started late or dropped rounds cannot show a rule firing on
// rounds it never captured, which would read as "rule did not fire". Missing
// only stage 1's PvE rounds is fine (nothing there is a decision the rules
// judge); starting at 2-7 or 3-4 — the app attaching mid-game — is not.
const MIN_COVERAGE = 0.9;
const LATEST_START = '2-1';
function coverage(m: MatchRecord): number {
  const first = m.rounds[0];
  if (!first || !m.lastRound || roundNum(first) > roundNum(LATEST_START)) return 0;
  return m.rounds.length / (expectedRounds(m.lastRound) - expectedRounds(first) + 1);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function ranks(xs: number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(xs: number[], ys: number[]): number {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy);
}

const spearman = (xs: number[], ys: number[]) => pearson(ranks(xs), ranks(ys));

// Seeded so the report is reproducible run to run.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PERMUTATIONS = 5000;

/** Two-sided permutation p-value for a difference in mean placement. */
function permutationP(fired: number[], notFired: number[], seed = 1): number {
  const all = [...fired, ...notFired];
  const observed = Math.abs(mean(fired) - mean(notFired));
  const rand = rng(seed);
  let extreme = 0;
  for (let p = 0; p < PERMUTATIONS; p++) {
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    const a = all.slice(0, fired.length), b = all.slice(fired.length);
    if (Math.abs(mean(a) - mean(b)) >= observed - 1e-12) extreme++;
  }
  return (extreme + 1) / (PERMUTATIONS + 1);
}

/** Benjamini-Hochberg q-values, same order as input. */
function bh(ps: number[]): number[] {
  const idx = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const q = new Array<number>(ps.length);
  let min = 1;
  for (let k = idx.length - 1; k >= 0; k--) {
    min = Math.min(min, (idx[k][0] * idx.length) / (k + 1));
    q[idx[k][1]] = min;
  }
  return q;
}

// ─── Analysis ────────────────────────────────────────────────────────────────

// Candidate cut rounds for the windowed view. Each rule gets the EARLIEST cut
// that covers WINDOW_COVERAGE of its own firings — chosen from where the rule
// fires, never from which cut gives the best p-value. A later cut keeps more of
// a late rule's firings but drops the matches that died before it, so it only
// moves later when the earlier one leaves a group too small to compare.
const WINDOWS = ['3-2', '4-1', '4-5', '5-1', '5-5'];
const WINDOW_COVERAGE = 0.75;
const MIN_GROUP = 5;   // fewer than this on either side and no comparison is made

interface RuleRow {
  ruleId: string;
  category: string;
  severity: string;
  firings: number;
  matchesFired: number;
  naiveDelta: number | null;     // mean placement fired - not fired (positive = rule predicts WORSE)
  rateRho: number | null;        // Spearman(firings per round, placement)
  window: string | null;
  windowN: [number, number] | null;
  windowDelta: number | null;
  windowTop4: [number, number] | null;  // top-4 rate fired / not fired
  windowP: number | null;
  windowQ?: number | null;
  // Smallest |Δ| this comparison could detect (80% power, two-sided 0.05).
  // "No measurable effect" means the effect is below this, not that it is zero.
  windowMde: number | null;
  untestable?: 'fires in nearly every match' | 'too rare' | 'whole-match judgment';
}

function analyseRules(matches: MatchRecord[]): RuleRow[] {
  const ids = new Map<string, { category: string; severity: Map<string, number> }>();
  for (const m of matches) for (const f of m.firings) {
    const e = ids.get(f.ruleId) ?? { category: f.category, severity: new Map() };
    e.severity.set(f.severity, (e.severity.get(f.severity) ?? 0) + 1);
    ids.set(f.ruleId, e);
  }

  const rows: RuleRow[] = [];
  let seed = 1;
  for (const [ruleId, info] of ids) {
    const per = matches.map(m => m.firings.filter(f => f.ruleId === ruleId));
    const firedIdx = per.map(p => p.length > 0);
    const placeFired = matches.filter((_, i) => firedIdx[i]).map(m => m.placement);
    const placeNot = matches.filter((_, i) => !firedIdx[i]).map(m => m.placement);
    const naiveDelta = placeFired.length && placeNot.length ? mean(placeFired) - mean(placeNot) : null;
    const rates = per.map((p, i) => p.length / Math.max(1, matches[i].rounds.length));
    const rateRho = new Set(rates).size > 1 ? spearman(rates, matches.map(m => m.placement)) : null;

    let best: Pick<RuleRow, 'window' | 'windowN' | 'windowDelta' | 'windowTop4' | 'windowP' | 'windowMde' | 'untestable'> =
      { window: null, windowN: null, windowDelta: null, windowTop4: null, windowP: null, windowMde: null };
    const allRounds = per.flat().map(f => roundNum(f.round)).filter(Number.isFinite);
    const firstCut = WINDOWS.findIndex(w =>
      allRounds.filter(r => r <= roundNum(w)).length >= WINDOW_COVERAGE * allRounds.length);
    let lastFailure: RuleRow['untestable'] = 'too rare';
    for (const w of WINDOWS.slice(firstCut === -1 ? WINDOWS.length - 1 : firstCut)) {
      const cut = roundNum(w);
      const eligible = matches
        .map((m, i) => ({ m, p: per[i] }))
        .filter(({ m }) => m.rounds.some(r => roundNum(r) >= cut));
      const fired = eligible.filter(({ p }) => p.some(f => roundNum(f.round) <= cut)).map(({ m }) => m.placement);
      const not = eligible.filter(({ p }) => !p.some(f => roundNum(f.round) <= cut)).map(({ m }) => m.placement);
      if (fired.length < MIN_GROUP || not.length < MIN_GROUP) {
        lastFailure = not.length < MIN_GROUP && fired.length >= MIN_GROUP ? 'fires in nearly every match' : 'too rare';
        continue;
      }
      const all = [...fired, ...not];
      const sd = Math.sqrt(all.reduce((a, x) => a + (x - mean(all)) ** 2, 0) / (all.length - 1));
      const top4 = (xs: number[]) => xs.filter(x => x <= 4).length / xs.length;
      best = {
        window: w,
        windowN: [fired.length, not.length],
        windowDelta: mean(fired) - mean(not),
        windowTop4: [top4(fired), top4(not)],
        windowP: permutationP(fired, not, seed++),
        windowMde: 2.8 * sd * Math.sqrt(1 / fired.length + 1 / not.length),
      };
      break;
    }
    if (best.window === null) best.untestable = allRounds.length === 0 ? 'whole-match judgment' : lastFailure;

    const sev = [...info.severity.entries()].sort((a, b) => b[1] - a[1])[0][0];
    rows.push({
      ruleId, category: info.category, severity: sev,
      firings: per.reduce((a, p) => a + p.length, 0),
      matchesFired: placeFired.length,
      naiveDelta, rateRho, ...best,
    });
  }

  const tested = rows.filter(r => r.windowP !== null);
  const qs = bh(tested.map(r => r.windowP!));
  tested.forEach((r, i) => { r.windowQ = qs[i]; });
  return rows;
}

interface FeatureRow { feature: string; n: number; rho: number; p: number; q?: number }

function analyseFeatures(matches: MatchRecord[]): FeatureRow[] {
  const withFv = matches.filter(m => m.features);
  if (withFv.length === 0) return [];
  const keys = Object.keys(withFv[0].features!);
  const rows: FeatureRow[] = [];
  let seed = 1000;
  for (const k of keys) {
    if (k === 'totalRounds') continue;  // placement by construction
    const pairs = withFv
      .map(m => [m.features![k], m.placement] as const)
      .filter((p): p is readonly [number, number] => typeof p[0] === 'number' && Number.isFinite(p[0]));
    if (pairs.length < 15 || new Set(pairs.map(p => p[0])).size < 3) continue;
    const xs = pairs.map(p => p[0]), ys = pairs.map(p => p[1]);
    const rho = spearman(xs, ys);
    // Permutation p for Spearman.
    const rand = rng(seed++);
    const ry = ranks(ys), rx = ranks(xs);
    let extreme = 0;
    for (let i = 0; i < PERMUTATIONS; i++) {
      const sh = [...ry];
      for (let a = sh.length - 1; a > 0; a--) {
        const b = Math.floor(rand() * (a + 1));
        [sh[a], sh[b]] = [sh[b], sh[a]];
      }
      if (Math.abs(pearson(rx, sh)) >= Math.abs(rho) - 1e-12) extreme++;
    }
    rows.push({ feature: k, n: pairs.length, rho, p: (extreme + 1) / (PERMUTATIONS + 1) });
  }
  const qs = bh(rows.map(r => r.p));
  rows.forEach((r, i) => { r.q = qs[i]; });
  return rows.sort((a, b) => a.p - b.p);
}

// ─── Report ──────────────────────────────────────────────────────────────────

const f2 = (x: number | null | undefined, d = 2) =>
  x === null || x === undefined || Number.isNaN(x) ? '—' : (x > 0 ? '+' : '') + x.toFixed(d);
const pct = (x: number) => `${Math.round(x * 100)}%`;

function verdict(r: RuleRow): string {
  if (r.windowP === null) return `untestable — ${r.untestable}`;
  if ((r.windowQ ?? 1) < 0.1) return r.windowDelta! > 0 ? 'KEEP — predicts worse placement' : 'INVERTED — predicts better placement';
  if (r.windowP < 0.05) return r.windowDelta! > 0 ? 'lean keep (not significant after correction)' : 'lean inverted (not significant after correction)';
  return 'no measurable effect';
}

function report(matches: MatchRecord[], excluded: MatchRecord[], rules: RuleRow[], features: FeatureRow[]): string {
  const registry = new Map(getAllRules().map(r => [r.unique_id, r]));
  const neverFired = [...registry.keys()].filter(id => !rules.some(r => r.ruleId === id)).sort();
  const placements = matches.map(m => m.placement);
  const dist = [1, 2, 3, 4, 5, 6, 7, 8].map(p => `${p}:${placements.filter(x => x === p).length}`).join(' ');
  const reached = (w: string) => matches.filter(m => m.rounds.some(r => roundNum(r) >= roundNum(w))).length;

  const L: string[] = [];
  L.push(`# Rule audit — ${new Date().toISOString().slice(0, 10)}`, '');
  L.push(`${matches.length} matches analysed (${excluded.length} excluded). Mean placement ${mean(placements).toFixed(2)}, distribution ${dist}.`);
  L.push(`Reached 3-2: ${reached('3-2')}. Reached 4-1: ${reached('4-1')}.`, '');
  L.push('Exclusions:');
  const why = new Map<string, number>();
  for (const m of excluded) {
    const k = m.error ? `pipeline error (${m.error})`
      : m.rounds.length < 5 ? 'fewer than 5 rounds (post-game spectate fragments, not matches)'
      : m.placementSource === 'none' ? 'no placement signal (client closed before GEP sent one)'
      : coverage(m) < MIN_COVERAGE ? `partial recording (started after ${LATEST_START}, or under ${pct(MIN_COVERAGE)} of rounds captured)`
      : 'other';
    why.set(k, (why.get(k) ?? 0) + 1);
  }
  for (const [k, v] of why) L.push(`- ${k}: ${v}`);
  L.push('');
  L.push('**How to read this.** Δ is mean placement when the rule fired minus when it did not; **positive = the rule predicts a WORSE finish**, which is what a correct mistake-detector should do. The windowed columns only count firings at or before the window round, among matches that reached it, so match length cannot fake an effect. p is a two-sided permutation test; q is Benjamini-Hochberg across every tested rule. With this many rules and this few matches, treat anything with q above 0.1 as unproven, not as disproven.', '');

  const totalNotes = rules.reduce((a, r) => a + r.firings, 0);
  L.push(`${totalNotes} notes across ${matches.length} matches — ${(totalNotes / matches.length).toFixed(1)} per match before the report's per-rule cap.`, '');

  const sorted = [...rules].sort((a, b) => (a.windowP ?? 2) - (b.windowP ?? 2) || b.firings - a.firings);
  L.push('| rule | name | sev | notes (matches) | share of notes | naive Δ | window | n fired/not | windowed Δ | detectable Δ | top-4 fired/not | p | q | verdict |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of sorted) {
    const name = registry.get(r.ruleId)?.human_readable_name ?? '';
    L.push(`| ${r.ruleId} | ${name} | ${r.severity} | ${r.firings} (${r.matchesFired}) | ${pct(r.firings / totalNotes)} | ${f2(r.naiveDelta)} | ${r.window ?? '—'} | ${r.windowN ? r.windowN.join('/') : '—'} | ${f2(r.windowDelta)} | ${r.windowMde === null ? '—' : '±' + r.windowMde.toFixed(2)} | ${r.windowTop4 ? `${pct(r.windowTop4[0])}/${pct(r.windowTop4[1])}` : '—'} | ${r.windowP?.toFixed(3) ?? '—'} | ${r.windowQ?.toFixed(3) ?? '—'} | ${verdict(r)} |`);
  }
  L.push('');
  L.push(`**Registered but never fired on any match (${neverFired.length}):** ${neverFired.join(', ') || 'none'}`, '');

  if (features.length) {
    L.push('## Behaviour features vs placement', '');
    L.push('Spearman ρ between each per-match feature (src/profile/feature-vector.ts) and placement. **Positive ρ = more of this, worse finish.** Several are partly length-driven (counts over the whole match), noted where obvious.', '');
    L.push('| feature | n | ρ | p | q |', '|---|---|---|---|---|');
    for (const r of features) L.push(`| ${r.feature} | ${r.n} | ${f2(r.rho)} | ${r.p.toFixed(3)} | ${r.q!.toFixed(3)} |`);
    L.push('');
  }
  return L.join('\n');
}

// ─── Evidence file (read by the app) ─────────────────────────────────────────

const EVIDENCE_PATH = path.join(ROOT, 'data', 'core', 'rule-evidence.json');

function toVerdict(r: RuleRow): string {
  if (r.windowP === null) {
    return r.untestable === 'fires in nearly every match' ? 'always-on'
      : r.untestable === 'whole-match judgment' ? 'whole-match' : 'rare';
  }
  if ((r.windowQ ?? 1) < 0.1) return r.windowDelta! > 0 ? 'predictive' : 'inverted';
  return 'unproven';
}

function writeEvidence(matches: MatchRecord[], rules: RuleRow[]): void {
  const round2 = (x: number | null) => x === null ? null : Math.round(x * 100) / 100;
  const out: Record<string, unknown> = {};
  for (const r of [...rules].sort((a, b) => a.ruleId.localeCompare(b.ruleId))) {
    if (r.ruleId.startsWith('(')) continue;  // a point with no ruleId
    out[r.ruleId] = {
      verdict: toVerdict(r),
      placementDelta: round2(r.windowDelta),
      matches: r.windowN ? r.windowN[0] + r.windowN[1] : matches.length,
      matchesFired: r.matchesFired,
      window: r.window,
      p: r.windowP === null ? null : Math.round(r.windowP * 1000) / 1000,
      q: r.windowQ === null || r.windowQ === undefined ? null : Math.round(r.windowQ * 1000) / 1000,
    };
  }
  for (const id of getAllRules().map(r => r.unique_id).sort()) {
    if (!(id in out)) out[id] = { verdict: 'never-fired', placementDelta: null, matches: matches.length, matchesFired: 0 };
  }
  const file = {
    _meta: {
      generated: new Date().toISOString().slice(0, 10),
      by: 'scripts/rule-audit.ts --write — do not hand-edit',
      matches: matches.length,
      sets: [...new Set(matches.map(m => m.setId))].sort(),
      method: 'Per rule: mean placement in matches where it fired at or before a cut round vs matches that reached that round without it firing; two-sided permutation test, Benjamini-Hochberg across rules. predictive = q < 0.1 with a worse finish when fired. All matches are one player\'s own recordings.',
    },
    rules: out,
  };
  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(file, null, 2) + '\n');
  console.log(`[audit] wrote ${EVIDENCE_PATH}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cachePath = path.join(OUT_DIR, 'matches.json');
  let records: MatchRecord[];

  if (process.argv.includes('--cached') && fs.existsSync(cachePath)) {
    records = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } else {
    const files = listLedgers();
    console.log(`[audit] replaying ${files.length} ledgers`);
    records = [];
    for (const [i, f] of files.entries()) {
      const r = await extractMatch(f);
      records.push(r);
      console.log(`[audit] ${i + 1}/${files.length} ${r.file} set=${r.setId} place=${r.placement}(${r.placementSource}) rounds=${r.rounds.length} last=${r.lastRound} points=${r.firings.length}${r.error ? ' ERROR ' + r.error : ''}`);
    }
    fs.writeFileSync(cachePath, JSON.stringify(records, null, 1));
  }

  // No game-mode filter: every ledger's raw match_info.game_mode is "TFT", and
  // snapshot.gameMode reads "lol" for all of them because rounds.ts compares
  // against lowercase 'tft'. Nothing downstream reads that field.
  const ok = (m: MatchRecord) => !m.error && m.placementSource !== 'none' && m.rounds.length >= 5
    && coverage(m) >= MIN_COVERAGE;
  const matches = records.filter(ok);
  const excluded = records.filter(m => !ok(m));
  const rules = analyseRules(matches);
  const features = analyseFeatures(matches);
  const md = report(matches, excluded, rules, features);
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), md);
  console.log(md);
  if (process.argv.includes('--write')) writeEvidence(matches, rules);
}

main().catch(e => { console.error(e); process.exit(1); });
