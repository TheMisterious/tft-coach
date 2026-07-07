// Rule catalog coverage — cross-references every ruleId a checker can emit
// against the merged rule registry (data/core/rules.core.json +
// data/sets/set{N}/rules.season.json), in both directions.
//
// Static text scan rather than executing the pipeline: driving every checker
// down every branch would need a golden match for each rule, which doesn't
// exist yet (see tests/goldens/). A regex over the source is cheap and catches
// exactly the two failure modes that matter here:
//   - a checker references a ruleId with a typo / no registry entry, so the
//     rule engine's getRuleTier() silently returns undefined and the tier
//     badge never renders.
//   - a checker's DecisionPoint literal is simply missing a ruleId field, so
//     a documented registry rule is never actually reachable from gameplay.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { getAllRules } from '../src/coach/rules-loader';

const CHECKERS_DIR = path.resolve(__dirname, '../src/coach/checkers');

function referencedRuleIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of readdirSync(CHECKERS_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(path.join(CHECKERS_DIR, file), 'utf-8');
    for (const m of src.matchAll(/ruleId:\s*'([A-Z0-9_]+)'/g)) {
      ids.add(m[1]);
    }
  }
  return ids;
}

describe('rule catalog coverage', () => {
  const registryIds = new Set(getAllRules().map(r => r.unique_id));
  const checkerIds = referencedRuleIds();

  it('every ruleId a checker emits exists in the rule registry', () => {
    const orphans = [...checkerIds].filter(id => !registryIds.has(id));
    expect(
      orphans,
      `checker(s) reference unknown ruleId(s): ${orphans.join(', ')} — typo, or missing entry in rules.core.json / rules.season.json`
    ).toEqual([]);
  });

  it('every registry rule is emitted by at least one checker', () => {
    const unused = [...registryIds].filter(id => !checkerIds.has(id));
    expect(
      unused,
      `registry rule(s) never referenced by any checker: ${unused.join(', ')} — dead catalog entry, or a checker forgot to attach ruleId to its DecisionPoint`
    ).toEqual([]);
  });
});
