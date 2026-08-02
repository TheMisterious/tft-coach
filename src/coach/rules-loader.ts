// Loads the rule registry at build time (bundled by webpack via JSON import).
// Rules are split into two tiers:
//   - data/core/rules.core.json           — set-agnostic mechanics, reused across sets.
//   - data/sets/set17/rules.season.json   — Set 17 balance-sensitive thresholds/mechanics.
// Provides: rule metadata lookup, tier lookup, and MVP-curation priority order.
//
// REMOVED (2026-08-02): each rule entry used to also carry a
// coaching_message_templates block (low_rank/mid_rank/high_rank prose with
// {{placeholder}} interpolation) and a getCoachingTemplate() lookup — dead
// code, `getCoachingTemplate` was never called anywhere. Two real reasons it
// stayed unwired rather than being worth reviving: (1) there is no genuine
// "player rank" signal anywhere in this pipeline — GEP exposes match
// placement, not a competitive skill tier, and inventing one (e.g. from this
// player's own recent average placement) would be answering a question this
// codebase has repeatedly refused to guess at elsewhere (see the augment
// win-rate ban, the Evelynn HP-cost field left non-functional rather than
// guessed, etc.); (2) even setting that aside, every checker's real
// coaching_text (see src/coach/checkers/*.ts) had already grown far more
// specific than these generic templates — HP/gold-tiered phrasing, reroll/
// pivot-aware caveats, exact recipe/odds numbers computed from real match
// data — so reviving the templates would have been a strict downgrade in
// coaching quality, not a missing feature. Removed the field from both JSON
// files and this loader rather than leave an unreachable dead path.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const coreRules = require('../../data/core/rules.core.json') as RulesFile;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const seasonRules = require('../../data/sets/set17/rules.season.json') as RulesFile;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mvpData = require('../../data/rules.mvp.json') as { mvp_top_20: Array<{ priority_rank: number; rule_id: string }> };

export type RuleTier = 'core' | 'season';

export interface RuleMeta {
  unique_id: string;
  human_readable_name: string;
  category: string;
  subcategory?: string;
  short_summary: string;
  severity: string;
  confidence: string;
  patch_sensitivity: string;
  tier: RuleTier;
}

interface RulesFile {
  rules: Array<Omit<RuleMeta, 'tier'>>;
}

// Indexed by unique_id for O(1) lookup. Season entries win on id collision (shouldn't happen).
const ruleIndex: Record<string, RuleMeta> = {};
for (const rule of coreRules.rules) {
  ruleIndex[rule.unique_id] = { ...rule, tier: 'core' };
}
for (const rule of seasonRules.rules) {
  ruleIndex[rule.unique_id] = { ...rule, tier: 'season' };
}

export function getRuleMeta(uniqueId: string): RuleMeta | undefined {
  return ruleIndex[uniqueId];
}

export function getRuleTier(uniqueId: string): RuleTier | undefined {
  return ruleIndex[uniqueId]?.tier;
}

export function getAllRules(): RuleMeta[] {
  return Object.values(ruleIndex);
}

export function getCoreRules(): RuleMeta[] {
  return getAllRules().filter(r => r.tier === 'core');
}

export function getSeasonRules(): RuleMeta[] {
  return getAllRules().filter(r => r.tier === 'season');
}

export function getMvpRules(): string[] {
  return mvpData.mvp_top_20
    .sort((a, b) => a.priority_rank - b.priority_rank)
    .map(r => r.rule_id);
}
