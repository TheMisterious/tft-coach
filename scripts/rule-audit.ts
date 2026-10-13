// Rule audit — is each coaching rule associated with a worse placement, and
// how sure can we be?
//
// Every rule in src/coach/checkers/ was written from TFT knowledge and checked
// only for "does it fire on the right rounds". This replays every recorded
// match through the real pipeline and measures, per rule, the one ground truth
// every match carries — where the player finished.
//
// Usage:
//   npx ts-node --transpile-only scripts/rule-audit.ts            extract + analyse
//   npx ts-node --transpile-only scripts/rule-audit.ts --cached    analyse only
//   ... --write   also regenerate data/core/rule-evidence.json, which decides
//                 which notes lead the in-app report (src/coach/rules-loader.ts)
//
// Ledger directories default to the recording folders on this machine;
// override with TFT_LEDGER_DIRS (semicolon-separated). Output lands in
// results/rule-audit/ (git-ignored): matches.json (per-match firings and
// per-round state, no player names) and report.md.
//
// WHAT THE NUMBERS CAN AND CANNOT SAY. Everything here is an association in one
// player's games, so every finding is EXPLORATORY unless it survives a
// held-out check (below). "Fired -> finished worse" says the rule marks a game
// that was going badly; it does not say the flagged behaviour caused it.
//
// Four guards, each against a specific way this goes wrong:
//
//   windowing     A rule that can fire on any round fires more in long matches,
//                 and long matches are good ones — a naive fired-vs-not
//                 comparison makes most rules look GOOD. Only firings at or
//                 before a cut round count, among matches that reached it, so
//                 every match had the same chance to trigger the rule. The cut
//                 is chosen from where the rule fires, never from outcomes.
//   uncertainty   Every difference carries a 95% percentile-bootstrap interval
//                 and the smallest effect its sample could detect.
//   multiplicity  Testing ~35 rules makes some look predictive by chance.
//                 Benjamini-Hochberg q-values across all tested rules.
//   held-out      Matches are split by DATE: rules are discovered on the older
//                 60% and must then show the same direction, at one-sided
//                 p < 0.05 after correction, on the newer 40% they never saw.
//                 Only that earns "confirmed".

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
import { standingFor } from '../src/coach/lobby-context';
import { extractFeatureVector } from '../src/profile/feature-vector';
import { getAllRules } from '../src/coach/rules-loader';
import {
  mean, sd, ranks, pearson, spearman, rng, PERMUTATIONS, permutationP,
  bootstrapDiffCI, bh, minimumDetectableEffect,
} from './audit-stats';

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

// The player's state at the END of a round — what the context breakdown
// stratifies on. hpRank/alive come from the lobby roster and are absent before
// the first roster update.
interface RoundState {
  label: string;
  hp: number;
  level: number;
  gold: number;
  hpRank?: number;
  levelRank?: number;
  alive?: number;
}

interface MatchRecord {
  file: string;
  startedAt: number;         // first ledger timestamp — the held-out split orders by it
  setId: string;
  gameMode: string;
  placement: number;
  placementSource: PlacementSource;
  rounds: string[];          // labels in play order
  lastRound: string | null;
  states: RoundState[];
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
  const { log, warn, info, error } = console;
  console.log = console.warn = console.info = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, { log, warn, info, error }); }
}

async function extractMatch(file: string): Promise<MatchRecord> {
  const entries = readLedger(file);
  const base: MatchRecord = {
    file: path.basename(file), startedAt: entries[0]?.ts ?? 0, setId: '?', gameMode: '?', placement: 0,
    // Source 'none' is a placeholder 8th, not a result; such matches are
    // excluded from analysis (src/ledger/placement.ts).
    placementSource: findFinalPlacement(entries)?.source ?? 'none', rounds: [], lastRound: null,
    states: [], firings: [], features: null,
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
        states: snapshot.rounds.map(r => {
          const standing = standingFor(r);
          return {
            label: r.label, hp: r.health, level: r.level, gold: r.goldEnd,
            ...(standing ? { hpRank: standing.hpRank, levelRank: standing.levelRank, alive: standing.alive } : {}),
          };
        }),
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

// ─── Match selection ─────────────────────────────────────────────────────────

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

function exclusionReason(m: MatchRecord): string | null {
  if (m.error) return `pipeline error (${m.error})`;
  if (m.rounds.length < 5) return 'fewer than 5 rounds (post-game spectate fragments, not matches)';
  if (m.placementSource === 'none') return 'no placement signal (client closed before GEP sent one)';
  if (coverage(m) < MIN_COVERAGE) return `partial recording (started after ${LATEST_START}, or under ${Math.round(MIN_COVERAGE * 100)}% of rounds captured)`;
  return null;
}

// ─── One comparison ──────────────────────────────────────────────────────────

// Candidate cut rounds. Each rule gets the EARLIEST cut covering
// WINDOW_COVERAGE of its own firings — chosen from where the rule fires, never
// from which cut gives the best p-value. A later cut keeps more of a late
// rule's firings but drops the matches that died before it, so it only moves
// later when the earlier one leaves a group too small to compare.
const WINDOWS = ['3-2', '4-1', '4-5', '5-1', '5-5'];
const WINDOW_COVERAGE = 0.75;
const MIN_GROUP = 5;   // fewer than this on either side and no comparison is made

const reached = (m: MatchRecord, cut: number) => m.rounds.some(r => roundNum(r) >= cut);
const firedBy = (m: MatchRecord, ruleId: string, cut: number) =>
  m.firings.some(f => f.ruleId === ruleId && roundNum(f.round) <= cut);

interface Comparison {
  fired: number[];
  not: number[];
  delta: number;            // mean placement fired - not; positive = worse finish when fired
  ci: [number, number];
  p: number;                // two-sided permutation
  mde: number;
  top4: [number, number];
}

function compare(matches: MatchRecord[], ruleId: string, window: string, seed: number,
                 filter: (m: MatchRecord) => boolean = () => true): Comparison | null {
  const cut = roundNum(window);
  const eligible = matches.filter(m => reached(m, cut) && filter(m));
  const fired = eligible.filter(m => firedBy(m, ruleId, cut)).map(m => m.placement);
  const not = eligible.filter(m => !firedBy(m, ruleId, cut)).map(m => m.placement);
  if (fired.length < MIN_GROUP || not.length < MIN_GROUP) return null;
  const top4 = (xs: number[]) => xs.filter(x => x <= 4).length / xs.length;
  return {
    fired, not,
    delta: mean(fired) - mean(not),
    ci: bootstrapDiffCI(fired, not, seed),
    p: permutationP(fired, not, seed),
    mde: minimumDetectableEffect(sd([...fired, ...not]), fired.length, not.length),
    top4: [top4(fired), top4(not)],
  };
}

// The rule's own window, from where it fires across ALL usable matches (the
// choice reads firing rounds only, never placements, so it does not leak the
// held-out outcomes into discovery).
function chooseWindow(matches: MatchRecord[], ruleId: string): { window: string | null; untestable?: Untestable } {
  const allRounds = matches.flatMap(m => m.firings.filter(f => f.ruleId === ruleId)).map(f => roundNum(f.round)).filter(Number.isFinite);
  if (allRounds.length === 0) return { window: null, untestable: 'whole-match judgment' };
  const first = WINDOWS.findIndex(w => allRounds.filter(r => r <= roundNum(w)).length >= WINDOW_COVERAGE * allRounds.length);
  let failure: Untestable = 'too rare';
  for (const w of WINDOWS.slice(first === -1 ? WINDOWS.length - 1 : first)) {
    const cut = roundNum(w);
    const eligible = matches.filter(m => reached(m, cut));
    const nFired = eligible.filter(m => firedBy(m, ruleId, cut)).length;
    const nNot = eligible.length - nFired;
    if (nFired >= MIN_GROUP && nNot >= MIN_GROUP) return { window: w };
    failure = nNot < MIN_GROUP && nFired >= MIN_GROUP ? 'fires in nearly every match' : 'too rare';
  }
  return { window: null, untestable: failure };
}

// ─── Context strata ──────────────────────────────────────────────────────────

// Effect modification: does the rule's association hold in every game state, or
// only in some? Strata are read at the rule's CUT round — the same moment for
// matches where it fired and where it did not — so they never peek at the
// firing itself. A rule defined BY one of these states (HP_002 is "under 60 HP
// at 4-1") leaves one stratum empty; that reads "too few", which is correct.
const STRATA: Array<{ name: string; groups: Array<{ label: string; test: (s: RoundState) => boolean }> }> = [
  { name: 'HP at the cut round', groups: [
    { label: 'HP 50+', test: s => s.hp >= 50 },
    { label: 'HP under 50', test: s => s.hp < 50 },
  ] },
  { name: 'HP rank in the lobby', groups: [
    { label: 'top half', test: s => s.hpRank !== undefined && s.alive !== undefined && s.hpRank <= s.alive / 2 },
    { label: 'bottom half', test: s => s.hpRank !== undefined && s.alive !== undefined && s.hpRank > s.alive / 2 },
  ] },
];

function stateAt(m: MatchRecord, window: string): RoundState | undefined {
  const cut = roundNum(window);
  let last: RoundState | undefined;
  for (const s of m.states) if (roundNum(s.label) <= cut) last = s;
  return last;
}

interface StratumRow { stratum: string; group: string; nFired: number; nNot: number; delta: number | null; ci: [number, number] | null }

function stratify(matches: MatchRecord[], ruleId: string, window: string, seed: number): StratumRow[] {
  const rows: StratumRow[] = [];
  for (const s of STRATA) for (const g of s.groups) {
    const filter = (m: MatchRecord) => { const st = stateAt(m, window); return !!st && g.test(st); };
    const c = compare(matches, ruleId, window, seed++, filter);
    const cut = roundNum(window);
    const eligible = matches.filter(m => reached(m, cut) && filter(m));
    const nFired = eligible.filter(m => firedBy(m, ruleId, cut)).length;
    rows.push({ stratum: s.name, group: g.label, nFired, nNot: eligible.length - nFired, delta: c?.delta ?? null, ci: c?.ci ?? null });
  }
  return rows;
}

// ─── Per-rule analysis ───────────────────────────────────────────────────────

type Untestable = 'fires in nearly every match' | 'too rare' | 'whole-match judgment';
type Status = 'confirmed' | 'exploratory';

interface RuleRow {
  ruleId: string;
  category: string;
  severity: string;
  firings: number;
  matchesFired: number;
  window: string | null;
  untestable?: Untestable;
  full: Comparison | null;
  q?: number;
  discovery: { n: number; delta: number | null; q: number | null } | null;
  holdout: { n: number; delta: number | null; p: number | null; q: number | null } | null;
  status: Status;
  strata: StratumRow[];
}

// Pre-registered before any held-out number is looked at.
const HOLDOUT_FRACTION = 0.4;
const DISCOVERY_Q = 0.1;
const CONFIRM_Q = 0.05;
const FULL_Q = 0.1;

function analyseRules(matches: MatchRecord[]): { rows: RuleRow[]; discoveryN: number; holdoutN: number; splitAt: number } {
  const byDate = [...matches].sort((a, b) => a.startedAt - b.startedAt);
  const cutIdx = Math.round(byDate.length * (1 - HOLDOUT_FRACTION));
  const discovery = byDate.slice(0, cutIdx);
  const holdout = byDate.slice(cutIdx);

  const meta = new Map<string, { category: string; severity: Map<string, number> }>();
  for (const m of matches) for (const f of m.firings) {
    const e = meta.get(f.ruleId) ?? { category: f.category, severity: new Map() };
    e.severity.set(f.severity, (e.severity.get(f.severity) ?? 0) + 1);
    meta.set(f.ruleId, e);
  }

  let seed = 1;
  const rows: RuleRow[] = [];
  const discP = new Map<string, number>();   // discovery two-sided p, by rule
  for (const [ruleId, info] of meta) {
    const { window, untestable } = chooseWindow(matches, ruleId);
    const firings = matches.reduce((a, m) => a + m.firings.filter(f => f.ruleId === ruleId).length, 0);
    const matchesFired = matches.filter(m => m.firings.some(f => f.ruleId === ruleId)).length;
    const full = window ? compare(matches, ruleId, window, seed++) : null;
    const disc = window ? compare(discovery, ruleId, window, seed++) : null;
    rows.push({
      ruleId, category: info.category,
      severity: [...info.severity.entries()].sort((a, b) => b[1] - a[1])[0][0],
      firings, matchesFired, window, untestable, full,
      discovery: window ? { n: disc ? disc.fired.length + disc.not.length : 0, delta: disc?.delta ?? null, q: null } : null,
      holdout: null,
      status: 'exploratory',
      strata: window && full ? stratify(matches, ruleId, window, seed += 10) : [],
    });
    if (disc) discP.set(ruleId, disc.p);
  }

  // Multiplicity: full-data q across every rule that could be compared.
  const tested = rows.filter(r => r.full);
  bh(tested.map(r => r.full!.p)).forEach((q, i) => { tested[i].q = q; });

  // Discovery: q across rules testable in the older games; candidates are the
  // ones associated with a WORSE finish there.
  const discTested = rows.filter(r => discP.has(r.ruleId));
  bh(discTested.map(r => discP.get(r.ruleId)!)).forEach((q, i) => { discTested[i].discovery!.q = q; });
  const candidates = discTested.filter(r => (r.discovery!.q ?? 1) < DISCOVERY_Q && (r.discovery!.delta ?? 0) > 0);

  // Confirmation: only the candidates are tested on the newer games, one-sided
  // in the direction discovery found, corrected across the candidates.
  const holdoutPs: number[] = [];
  for (const r of candidates) {
    const cut = roundNum(r.window!);
    const eligible = holdout.filter(m => reached(m, cut));
    const fired = eligible.filter(m => firedBy(m, r.ruleId, cut)).map(m => m.placement);
    const not = eligible.filter(m => !firedBy(m, r.ruleId, cut)).map(m => m.placement);
    const ok = fired.length >= 2 && not.length >= 2;
    const p = ok ? permutationP(fired, not, seed++, 'greater') : 1;
    r.holdout = { n: eligible.length, delta: ok ? mean(fired) - mean(not) : null, p: ok ? p : null, q: null };
    holdoutPs.push(p);
  }
  bh(holdoutPs).forEach((q, i) => {
    candidates[i].holdout!.q = q;
    if (q < CONFIRM_Q && (candidates[i].holdout!.delta ?? 0) > 0) candidates[i].status = 'confirmed';
  });

  return { rows, discoveryN: discovery.length, holdoutN: holdout.length, splitAt: holdout[0]?.startedAt ?? 0 };
}

// The app-facing classification of the FULL-data result. Status (confirmed or
// exploratory) is separate and says how far to trust it.
function toVerdict(r: RuleRow): string {
  if (!r.full) {
    return r.untestable === 'fires in nearly every match' ? 'always-on'
      : r.untestable === 'whole-match judgment' ? 'whole-match' : 'rare';
  }
  if ((r.q ?? 1) < FULL_Q) return r.full.delta > 0 ? 'predictive' : 'inverted';
  return 'unproven';
}

// ─── Behaviour features ──────────────────────────────────────────────────────

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
    const rand = rng(seed++);
    const rx = ranks(xs), ry = ranks(ys);
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
  bh(rows.map(r => r.p)).forEach((q, i) => { rows[i].q = q; });
  return rows.sort((a, b) => a.p - b.p);
}

// ─── Report ──────────────────────────────────────────────────────────────────

const f2 = (x: number | null | undefined, d = 2) =>
  x === null || x === undefined || Number.isNaN(x) ? '—' : (x > 0 ? '+' : '') + x.toFixed(d);
const ci2 = (c: [number, number] | null | undefined) => c ? `[${f2(c[0], 1)}, ${f2(c[1], 1)}]` : '—';
const pct = (x: number) => `${Math.round(x * 100)}%`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function verdictText(r: RuleRow): string {
  const v = toVerdict(r);
  if (v === 'predictive' || v === 'inverted') return `${v} (${r.status})`;
  return v;
}

function report(matches: MatchRecord[], excluded: MatchRecord[], a: ReturnType<typeof analyseRules>, features: FeatureRow[]): string {
  const registry = new Map(getAllRules().map(r => [r.unique_id, r]));
  const rules = a.rows;
  const neverFired = [...registry.keys()].filter(id => !rules.some(r => r.ruleId === id)).sort();
  const placements = matches.map(m => m.placement);
  const dist = [1, 2, 3, 4, 5, 6, 7, 8].map(p => `${p}:${placements.filter(x => x === p).length}`).join(' ');
  const totalNotes = rules.reduce((s, r) => s + r.firings, 0);

  const L: string[] = [];
  L.push(`# Rule audit — ${new Date().toISOString().slice(0, 10)}`, '');
  L.push(`${matches.length} matches analysed (${excluded.length} excluded), sets ${[...new Set(matches.map(m => m.setId))].sort().join(', ')}. Mean placement ${mean(placements).toFixed(2)}, distribution ${dist}. ${totalNotes} notes, ${(totalNotes / matches.length).toFixed(1)} per match before the report's per-rule cap.`, '');
  L.push('Exclusions:');
  const why = new Map<string, number>();
  for (const m of excluded) { const k = exclusionReason(m) ?? 'other'; why.set(k, (why.get(k) ?? 0) + 1); }
  for (const [k, v] of why) L.push(`- ${k}: ${v}`);
  L.push('');

  L.push('## Method', '');
  L.push('**Every finding here is exploratory unless marked confirmed.** All matches are one player\'s; a rule that tracks this player\'s results may not track anyone else\'s, and an association is not a cause: a rule that fires in games that end badly marks those games, it does not show that the flagged behaviour lost them.', '');
  L.push(`- **Windowed comparison.** For each rule, mean placement of matches where it fired at or before a cut round, minus matches that reached that round without it firing. **Positive Δ = finished worse when it fired.** The cut is the earliest of ${WINDOWS.join(', ')} that covers ${pct(WINDOW_COVERAGE)} of the rule's firings, chosen from firing rounds only. Groups under ${MIN_GROUP} matches are not compared.`);
  L.push(`- **Uncertainty.** 95% percentile-bootstrap interval for Δ (${4000} resamples per group). "Detectable" is the smallest |Δ| the comparison had 80% power to detect at two-sided α = 0.05, by the normal approximation 2.8 · sd · √(1/n₁ + 1/n₂); an approximation, not an exact power calculation.`);
  L.push(`- **Multiplicity.** Two-sided permutation p (${PERMUTATIONS} shuffles), Benjamini-Hochberg q across all ${rules.filter(r => r.full).length} rules that could be compared. Full-data "predictive" needs q < ${FULL_Q}.`);
  L.push(`- **Held-out confirmation.** Matches sorted by date: the older ${a.discoveryN} discover, the newer ${a.holdoutN} (from ${day(a.splitAt)}) confirm. A rule is a candidate if discovery q < ${DISCOVERY_Q} with a worse finish; it is **confirmed** only if the newer matches show a worse finish again at one-sided permutation q < ${CONFIRM_Q} (corrected across candidates). The ${pct(HOLDOUT_FRACTION)} split and every threshold were fixed before the held-out numbers were read.`);
  L.push('- **Context.** Each tested rule\'s Δ split by the player\'s state at its cut round (same moment for fired and not-fired matches): HP above or below 50, and HP rank in the top or bottom half of the lobby. Cells under 5 matches read "too few".', '');

  L.push('## Rules', '');
  const sorted = [...rules].sort((x, y) => (x.full?.p ?? 2) - (y.full?.p ?? 2) || y.firings - x.firings);
  L.push('| rule | name | notes (matches) | share | window | n fired/not | Δ [95% CI] | detectable | top-4 fired/not | p | q | discovery Δ (q) | held-out Δ (p) | verdict |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of sorted) {
    const name = registry.get(r.ruleId)?.human_readable_name ?? '';
    const c = r.full;
    const disc = r.discovery?.delta !== null && r.discovery?.delta !== undefined ? `${f2(r.discovery.delta)} (${r.discovery.q?.toFixed(3) ?? '—'})` : '—';
    const hold = r.holdout ? `${f2(r.holdout.delta)} (${r.holdout.p?.toFixed(3) ?? '—'})` : '—';
    L.push(`| ${r.ruleId} | ${name} | ${r.firings} (${r.matchesFired}) | ${pct(r.firings / totalNotes)} | ${r.window ?? '—'} | ${c ? `${c.fired.length}/${c.not.length}` : '—'} | ${c ? `${f2(c.delta)} ${ci2(c.ci)}` : '—'} | ${c ? '±' + c.mde.toFixed(2) : '—'} | ${c ? `${pct(c.top4[0])}/${pct(c.top4[1])}` : '—'} | ${c?.p.toFixed(3) ?? '—'} | ${r.q?.toFixed(3) ?? '—'} | ${disc} | ${hold} | ${verdictText(r)}${r.untestable ? ` — ${r.untestable}` : ''} |`);
  }
  L.push('');
  L.push(`**Registered but never fired on any match (${neverFired.length}):** ${neverFired.join(', ') || 'none'}`, '');

  const ctx = sorted.filter(r => r.full && ((r.q ?? 1) < 0.2));
  if (ctx.length) {
    L.push('## Context: does the association hold in every game state?', '');
    L.push('Δ within each state at the rule\'s cut round, with its 95% interval. A rule whose Δ only appears in one state is conditional, and an automated judgement should say so.', '');
    L.push('| rule | state | group | n fired/not | Δ [95% CI] |', '|---|---|---|---|---|');
    for (const r of ctx) for (const s of r.strata) {
      L.push(`| ${r.ruleId} | ${s.stratum} | ${s.group} | ${s.nFired}/${s.nNot} | ${s.delta === null ? 'too few' : `${f2(s.delta)} ${ci2(s.ci)}`} |`);
    }
    L.push('');
  }

  if (features.length) {
    L.push('## Behaviour features vs placement', '');
    L.push('Spearman ρ between each per-match feature (src/profile/feature-vector.ts) and placement. **Positive ρ = more of this, worse finish.** Whole-match counts are inflated by match length: a long game is a good game and has more rounds to count in. Exploratory throughout.', '');
    L.push('| feature | n | ρ | p | q |', '|---|---|---|---|---|');
    for (const r of features) L.push(`| ${r.feature} | ${r.n} | ${f2(r.rho)} | ${r.p.toFixed(3)} | ${r.q!.toFixed(3)} |`);
    L.push('');
  }
  return L.join('\n');
}

// ─── Evidence file (read by the app) ─────────────────────────────────────────

const EVIDENCE_PATH = path.join(ROOT, 'data', 'core', 'rule-evidence.json');

function writeEvidence(matches: MatchRecord[], a: ReturnType<typeof analyseRules>): void {
  const r2 = (x: number | null | undefined) => x === null || x === undefined ? null : Math.round(x * 100) / 100;
  const r3 = (x: number | null | undefined) => x === null || x === undefined ? null : Math.round(x * 1000) / 1000;
  const out: Record<string, unknown> = {};
  for (const r of [...a.rows].sort((x, y) => x.ruleId.localeCompare(y.ruleId))) {
    if (r.ruleId.startsWith('(')) continue;  // a point with no ruleId
    const c = r.full;
    out[r.ruleId] = {
      verdict: toVerdict(r),
      status: r.status,
      placementDelta: r2(c?.delta),
      ci: c ? [r2(c.ci[0]), r2(c.ci[1])] : null,
      matches: c ? c.fired.length + c.not.length : matches.length,
      matchesFired: r.matchesFired,
      window: r.window,
      p: r3(c?.p),
      q: r3(r.q),
      discovery: r.discovery ? { n: r.discovery.n, delta: r2(r.discovery.delta), q: r3(r.discovery.q) } : null,
      holdout: r.holdout ? { n: r.holdout.n, delta: r2(r.holdout.delta), p: r3(r.holdout.p), q: r3(r.holdout.q) } : null,
      context: r.strata.map(s => ({ state: s.stratum, group: s.group, nFired: s.nFired, nNot: s.nNot, delta: r2(s.delta), ci: s.ci ? [r2(s.ci[0]), r2(s.ci[1])] : null })),
    };
  }
  for (const id of getAllRules().map(r => r.unique_id).sort()) {
    if (!(id in out)) out[id] = { verdict: 'never-fired', status: 'exploratory', placementDelta: null, matches: matches.length, matchesFired: 0 };
  }
  const file = {
    _meta: {
      generated: new Date().toISOString().slice(0, 10),
      by: 'scripts/rule-audit.ts --write — do not hand-edit',
      matches: matches.length,
      sets: [...new Set(matches.map(m => m.setId))].sort(),
      split: { discovery: a.discoveryN, holdout: a.holdoutN, holdoutFrom: day(a.splitAt) },
      method: 'Exploratory association in one player\'s games, not causation. Per rule: mean placement where it fired at or before a cut round vs matches that reached that round without it firing, 95% bootstrap CI, two-sided permutation test, Benjamini-Hochberg across rules. verdict is the full-data result (predictive = q < 0.1 with a worse finish). status is confirmed only when a rule discovered on the older 60% of matches (by date) shows a worse finish again on the newer 40% (one-sided, corrected); otherwise exploratory. See results/rule-audit/report.md.',
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

  const matches = records.filter(m => exclusionReason(m) === null);
  const excluded = records.filter(m => exclusionReason(m) !== null);
  const analysis = analyseRules(matches);
  const features = analyseFeatures(matches);
  const md = report(matches, excluded, analysis, features);
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), md);
  console.log(md);
  if (process.argv.includes('--write')) writeEvidence(matches, analysis);
}

main().catch(e => { console.error(e); process.exit(1); });
