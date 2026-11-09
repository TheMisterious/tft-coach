// Guards against the mojibake class of bug found on 2026-08-26: every em dash in
// src/coach/checkers/items.ts had been round-tripped through cp1252 and stored
// as "â€”", plus a stray UTF-8 BOM on line 1. Those strings are user-facing
// coaching_text — the shipped report literally read "Two God rounds have
// occurred by 4-1 â€" your carry should have at least 2 completed items".
//
// Scanned across every source file that can produce report prose, not just the
// one that was broken: the corruption comes from an editor/tool writing the
// file back in the wrong encoding, which can hit any of them.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const ROOTS = ['src', 'data'].map(d => path.resolve(__dirname, '..', d));

// The three lead bytes a UTF-8 sequence turns into when misread as cp1252/latin-1.
// \u201d is the 0x94 of box-drawing characters: "\u2500" comes out as "\u00e2\u201d\u20ac".
const MOJIBAKE = /[\u00e2\u00c3\u00ef][\u20ac\u0192\u201a\u201d\u00a2\u00a9\u00ab\u00bb]/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) { out.push(...sourceFiles(full)); continue; }
    if (/\.(ts|tsx|json)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('source encoding', () => {
  const files = ROOTS.flatMap(sourceFiles);

  it('finds files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no source file carries a UTF-8 BOM', () => {
    const withBom = files.filter(f => readFileSync(f, 'utf-8').charCodeAt(0) === 0xFEFF);
    expect(withBom.map(f => path.relative(process.cwd(), f)), 'strip the BOM — it leaks into bundled strings').toEqual([]);
  });

  it('no source file contains cp1252-mangled UTF-8', () => {
    const bad: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (MOJIBAKE.test(line)) bad.push(`${path.relative(process.cwd(), f)}:${i + 1}`);
      });
    }
    expect(bad, 'file was written back in the wrong encoding — re-save as UTF-8').toEqual([]);
  });
});
