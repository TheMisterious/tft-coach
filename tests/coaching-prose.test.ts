// Guards the wording standard the coaching methodology rework set
// (2026-10-13): a rule's text describes what happened and the usual answer
// "unless…", never a verdict. Only HP_002 and HP_003 are confirmed on held-out
// games, and even those are associations with placement, not proof that a
// different choice would have won. Before this test, most checkers still said
// "skipping the XP buy here was a pure tempo loss" or "the correct play was to
// roll down immediately" about rules that showed no measured effect at all.
//
// Scans the literal text of every string and template in the checkers (not
// the ${…} expressions, and not comments), plus the benchmark notes that
// ECON_004 prints verbatim.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import ts from 'typescript';

const CHECKERS_DIR = path.resolve(__dirname, '../src/coach/checkers');
const SETS_DIR = path.resolve(__dirname, '../data/sets');

// Each phrase states a verdict or an absolute. Rewrite as "the usual line is
// X unless Y", "consider X", or the fact itself.
const VERDICTS: Array<[RegExp, string]> = [
  [/\bshould (have|be)\b/i, 'should have / should be'],
  [/\bmust\b/i, 'must'],
  [/\bcorrect play\b/i, 'the correct play'],
  [/\balways\b(?!-on)/i, 'always'],
  [/\bcosts? you\b/i, 'costs you'],
  [/\bwast(e|ed|es|ing)\b/i, 'waste'],
  [/\bpure (tempo loss|inefficiency)\b/i, 'pure tempo loss'],
  [/\bimmediately\b/i, 'immediately'],
  [/\bdramatically\b/i, 'dramatically'],
  [/\bguarantee/i, 'guarantee'],
  [/\bworst\b/i, 'worst'],
  [/\babsolute\b/i, 'absolute'],
  [/\btoo dangerous\b/i, 'too dangerous'],
];

interface Literal { where: string; text: string }

function checkerLiterals(): Literal[] {
  const out: Literal[] = [];
  for (const file of readdirSync(CHECKERS_DIR).filter(f => f.endsWith('.ts'))) {
    const src = readFileSync(path.join(CHECKERS_DIR, file), 'utf-8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        out.push({ where: `${file}:${line}`, text: node.text });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

function benchmarkNotes(): Literal[] {
  const out: Literal[] = [];
  for (const set of readdirSync(SETS_DIR)) {
    let rows: Array<{ round?: string; notes?: string }>;
    try { rows = JSON.parse(readFileSync(path.join(SETS_DIR, set, 'econ-benchmarks.json'), 'utf-8')); }
    catch { continue; }
    for (const r of rows) if (r.notes) out.push({ where: `${set}/econ-benchmarks.json ${r.round}`, text: r.notes });
  }
  return out;
}

describe('coaching prose', () => {
  const literals = [...checkerLiterals(), ...benchmarkNotes()];

  it('finds the coaching strings', () => {
    expect(literals.length).toBeGreaterThan(100);
  });

  it('states no verdicts', () => {
    const hits = literals.flatMap(l => VERDICTS
      .filter(([re]) => re.test(l.text))
      .map(([, phrase]) => `${l.where} "${phrase}": ${l.text.trim().slice(0, 80)}`));
    expect(hits, 'rewrite as an observation plus the usual answer and its exception').toEqual([]);
  });

  it('mentions gods only in the Set 17 checker', () => {
    // Set 18 brought the carousel back. A God round outside checkers/set17.ts
    // (which only runs on Set 17 matches) reaches every set's reports.
    const hits = literals
      .filter(l => /\bgods?\b/i.test(l.text) && !l.where.startsWith('set17.ts:'))
      .map(l => `${l.where}: ${l.text.trim().slice(0, 80)}`);
    expect(hits).toEqual([]);
  });
});
