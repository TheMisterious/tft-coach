// Riot routes tft-match-v1 by a regional cluster that is not one-per-platform
// in an obvious way (VN2 needs "sea", not "asia"). Same table as the app's
// src/persistence/settings.ts MATCH_CONTINENT — tests/rso-worker.test.ts keeps
// the two from drifting. Also the allowlist: a platform outside it never
// reaches a Riot URL.

export const MATCH_CLUSTER = {
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea', vn2: 'sea', sg2: 'sea', th2: 'sea', tw2: 'sea', ph2: 'sea',
} as const;

export type Platform = keyof typeof MATCH_CLUSTER;

export function isPlatform(value: string | null): value is Platform {
  return !!value && Object.prototype.hasOwnProperty.call(MATCH_CLUSTER, value);
}

// account-v1 serves every account from any cluster.
export const ACCOUNT_CLUSTER = 'americas';
