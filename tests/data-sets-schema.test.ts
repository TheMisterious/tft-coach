// Schema validation for data/sets/*/ — the app's design intentionally makes
// adding a new set a matter of dropping a new folder here with no code
// changes (see loadMeta in src/enrichment/meta-lookup.ts). That also means a
// malformed or missing field in a new set's JSON fails silently at runtime
// instead of at build/test time — fetchJson falls back to {}/[] on a missing
// file, and nothing previously verified the *shape* of a file that does
// exist. This test enumerates every folder under data/sets/ (currently just
// set17) so any set added later is checked automatically, without editing
// this file.

import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync, readFileSync } from 'fs';
import path from 'path';

const SETS_DIR = path.resolve(__dirname, '../data/sets');
const setDirs = readdirSync(SETS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

// meta-tiers.generated.json is fetched/regenerated locally and gitignored
// (see .gitignore) — not part of the required, committed schema.
const REQUIRED_FILES = [
  'champions.json',
  'carry-bis.json',
  'trait-breakpoints.json',
  'econ-benchmarks.json',
  'augments.json',
  'augment-modifiers.json',
  'comps.json',
  'rules.season.json',
];

function loadJson(setDir: string, file: string): any {
  return JSON.parse(readFileSync(path.join(SETS_DIR, setDir, file), 'utf-8'));
}

function stripComment(obj: Record<string, unknown>): Record<string, unknown> {
  const { _comment, ...rest } = obj;
  return rest;
}

describe.each(setDirs)('data/sets/%s schema', (setDir) => {
  it('has every required file', () => {
    for (const file of REQUIRED_FILES) {
      expect(existsSync(path.join(SETS_DIR, setDir, file)), `missing ${file}`).toBe(true);
    }
  });

  it('champions.json entries have name, tier, role, traits', () => {
    const champions = loadJson(setDir, 'champions.json');
    for (const [id, c] of Object.entries<any>(champions)) {
      expect(typeof c.name, `${id}.name`).toBe('string');
      expect(typeof c.tier, `${id}.tier`).toBe('number');
      expect(typeof c.role, `${id}.role`).toBe('string');
      expect(Array.isArray(c.traits), `${id}.traits`).toBe(true);
    }
  });

  it('carry-bis.json entries have role, items_bis, items_alt, components_priority, notes', () => {
    const carryBis = loadJson(setDir, 'carry-bis.json');
    for (const [id, entry] of Object.entries<any>(carryBis)) {
      expect(typeof entry.role, `${id}.role`).toBe('string');
      expect(Array.isArray(entry.items_bis), `${id}.items_bis`).toBe(true);
      expect(Array.isArray(entry.items_alt), `${id}.items_alt`).toBe(true);
      expect(Array.isArray(entry.components_priority), `${id}.components_priority`).toBe(true);
      expect(typeof entry.notes, `${id}.notes`).toBe('string');
    }
  });

  it('trait-breakpoints.json is an array of {trait, tiers}', () => {
    const breakpoints = loadJson(setDir, 'trait-breakpoints.json');
    expect(Array.isArray(breakpoints)).toBe(true);
    for (const b of breakpoints) {
      expect(typeof b.trait).toBe('string');
      expect(Array.isArray(b.tiers)).toBe(true);
      expect(b.tiers.every((t: unknown) => typeof t === 'number')).toBe(true);
    }
  });

  it('econ-benchmarks.json is an array of {round, minGold, notes}', () => {
    const benchmarks = loadJson(setDir, 'econ-benchmarks.json');
    expect(Array.isArray(benchmarks)).toBe(true);
    for (const b of benchmarks) {
      expect(typeof b.round).toBe('string');
      expect(typeof b.minGold).toBe('number');
      expect(typeof b.notes).toBe('string');
    }
  });

  it('augments.json buckets are arrays of augment id strings', () => {
    const augments = stripComment(loadJson(setDir, 'augments.json'));
    for (const [bucket, ids] of Object.entries<any>(augments)) {
      expect(Array.isArray(ids), `${bucket}`).toBe(true);
      expect(ids.every((id: unknown) => typeof id === 'string'), `${bucket} entries`).toBe(true);
    }
  });

  it('augment-modifiers.json only has known buckets with the expected shape', () => {
    const modifiers = stripComment(loadJson(setDir, 'augment-modifiers.json'));
    const knownBuckets = ['itemBisOverrides', 'traitCountBonuses', 'frontlineExemptions'];
    expect(Object.keys(modifiers).every(k => knownBuckets.includes(k))).toBe(true);

    for (const [aug, entry] of Object.entries<any>(modifiers.itemBisOverrides ?? {})) {
      expect(Array.isArray(entry.items), `itemBisOverrides.${aug}.items`).toBe(true);
      expect(typeof entry.reason, `itemBisOverrides.${aug}.reason`).toBe('string');
    }
    for (const [aug, entry] of Object.entries<any>(modifiers.traitCountBonuses ?? {})) {
      expect(typeof entry.trait, `traitCountBonuses.${aug}.trait`).toBe('string');
      expect(typeof entry.bonus, `traitCountBonuses.${aug}.bonus`).toBe('number');
      expect(typeof entry.reason, `traitCountBonuses.${aug}.reason`).toBe('string');
    }
    for (const [aug, entry] of Object.entries<any>(modifiers.frontlineExemptions ?? {})) {
      expect(typeof entry.reason, `frontlineExemptions.${aug}.reason`).toBe('string');
    }
  });

  it('comps.json is an array of well-formed comp archetypes', () => {
    const comps = loadJson(setDir, 'comps.json');
    expect(Array.isArray(comps)).toBe(true);
    for (const c of comps) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.name).toBe('string');
      expect(typeof c.type).toBe('string');
      expect(typeof c.optimal_level).toBe('number');
      expect(Array.isArray(c.primary_carry_ids)).toBe(true);
      expect(Array.isArray(c.key_traits)).toBe(true);
      expect(typeof c.notes).toBe('string');
    }
  });

  it("comps.json primary_carry_ids reference champions that exist in champions.json", () => {
    const comps = loadJson(setDir, 'comps.json');
    const champions = loadJson(setDir, 'champions.json');
    for (const c of comps) {
      for (const carryId of c.primary_carry_ids) {
        expect(champions[carryId], `${c.id} references unknown champion ${carryId}`).toBeTruthy();
      }
    }
  });

  it('rules.season.json has a rules array with unique_id and category on every entry', () => {
    const rulesFile = loadJson(setDir, 'rules.season.json');
    expect(Array.isArray(rulesFile.rules)).toBe(true);
    const seen = new Set<string>();
    for (const rule of rulesFile.rules) {
      expect(typeof rule.unique_id).toBe('string');
      expect(typeof rule.category).toBe('string');
      expect(seen.has(rule.unique_id), `duplicate unique_id ${rule.unique_id}`).toBe(false);
      seen.add(rule.unique_id);
    }
  });
});
