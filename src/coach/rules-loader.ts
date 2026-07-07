// Loads the rule registry at build time (bundled by webpack via JSON import).
// Rules are split into two tiers:
//   - data/core/rules.core.json           — set-agnostic mechanics, reused across sets.
//   - data/sets/set17/rules.season.json   — Set 17 balance-sensitive thresholds/mechanics.
// Provides: rule metadata lookup, tier lookup, and coaching message templates.

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
  coaching_message_templates?: {
    low_rank: string;
    mid_rank: string;
    high_rank: string;
  };
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

// Returns the coaching message for a given rule and player rank.
// Defaults to mid_rank when rank is unknown.
export function getCoachingTemplate(
  uniqueId: string,
  rank: 'low_rank' | 'mid_rank' | 'high_rank' = 'mid_rank'
): string | undefined {
  return ruleIndex[uniqueId]?.coaching_message_templates?.[rank];
}
