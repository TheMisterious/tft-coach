// Champion forms (data/sets/set18/champion-aliases.json, applied by
// withChampionForms in src/enrichment/meta-lookup.ts): GEP reports the form a
// unit is in ("DA_18_Akali_AP", "DA_NidaleeCougar18_AD"), which no
// champions.json lists. Each form must read as its champion everywhere a
// board is costed, named or traited.

import { describe, it, expect } from 'vitest';
import { loadMeta, getChampionName, unitPrevalence, withChampionForms } from '../src/enrichment/meta-lookup';
import type { ChampionMeta } from '../src/shared/types';

describe('champion forms resolve to their champion', () => {
  it('names, costs and traits every Set 18 form like its base unit', async () => {
    const meta = await loadMeta('set18');
    const pairs: Array<[string, string, string]> = [
      ['DA_18_Akali_AP', 'DA_18_Akali_AD', 'Akali'],
      ['DA_18_MasterYi_AP', 'DA_18_MasterYi_AD', 'Master Yi'],
      ['DA_KogMaw18_AP', 'DA_KogMaw18_AD', "Kog'Maw"],
      ['DA_NidaleeCougar18_AD', 'DA_Nidalee18_AP', 'Nidalee'],
      ['DA_18_EliseSpider', 'DA_18_Elise', 'Elise'],
      ['DA_18_GnarBig', 'DA_18_GnarSmall', 'Gnar'],
    ];
    for (const [form, base, name] of pairs) {
      expect(getChampionName(form, meta)).toBe(name);
      expect(meta.champions[form].tier).toBe(meta.champions[base].tier);
      expect(meta.champions[form].traits).toEqual(meta.champions[base].traits);
    }
  });

  it('reads a form\'s prevalence from its champion\'s record', async () => {
    const meta = await loadMeta('set18');
    const base = unitPrevalence('DA_18_Akali_AD', meta);
    expect(base).toBeDefined();
    expect(unitPrevalence('DA_18_Akali_AP', meta)).toEqual(base);
  });

  it('keeps a form that champions.json already lists, and skips aliases to unknown ids', () => {
    const own = { name: 'Own form', tier: 4, traits: [] } as unknown as ChampionMeta;
    const champions: Record<string, ChampionMeta> = {
      BASE: { name: 'Base', tier: 2, traits: [] } as unknown as ChampionMeta,
      FORM_LISTED: own,
    };
    const resolved = withChampionForms(champions, { _comment: 'x', FORM: 'BASE', FORM_LISTED: 'BASE', ORPHAN: 'MISSING' });
    expect(champions.FORM.name).toBe('Base');
    expect(champions.FORM_LISTED).toBe(own);
    expect(champions.ORPHAN).toBeUndefined();
    expect(resolved).toEqual({ FORM: 'BASE', FORM_LISTED: 'BASE' });
  });
});
