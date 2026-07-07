#!/usr/bin/env node
// Warns when data/sets/set{N}/rules.season.json hasn't been manually
// re-reviewed since the live game patch moved on. Season rules encode
// balance-sensitive thresholds (level timings, HP curves, the Realm of Gods
// mechanic) that can silently go stale after a patch — this script doesn't
// know whether they're actually wrong, it just flags "these were last
// checked against patch X, live is now patch Y, go look."
//
// Usage: node scripts/check-patch-staleness.js [setId]
//   (defaults to set17)

const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_ROOT = path.resolve(__dirname, '..', 'data');
const setId = process.argv[2] || 'set17';

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'tft-coach-check-patch-staleness' } }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`GET ${url} -> ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Bad JSON from ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const rulesPath = path.join(DATA_ROOT, 'sets', setId, 'rules.season.json');
  if (!fs.existsSync(rulesPath)) {
    console.error(`[check-patch] no rules.season.json for ${setId} at ${rulesPath}`);
    process.exit(1);
  }
  const rulesFile = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  const verified = rulesFile.patch_meta?.verified_ddragon_version ?? null;

  console.log('[check-patch] fetching latest Data Dragon version...');
  const versions = await getJson('https://ddragon.leagueoflegends.com/api/versions.json');
  const latest = versions[0];

  if (verified === null) {
    console.warn(`[check-patch] ${setId}/rules.season.json has never been manually verified against a patch.`);
  } else if (verified !== latest) {
    console.warn(`[check-patch] ${setId}/rules.season.json was last verified against ${verified}; live is now ${latest}.`);
  } else {
    console.log(`[check-patch] ${setId}/rules.season.json is up to date with the live patch (${latest}). Nothing to do.`);
    return;
  }

  const highSensitivity = rulesFile.rules.filter(r => r.patch_sensitivity === 'high');
  const mediumSensitivity = rulesFile.rules.filter(r => r.patch_sensitivity === 'medium');
  console.warn(`[check-patch] review these ${highSensitivity.length} high-sensitivity rule(s) first:`);
  for (const r of highSensitivity) console.warn(`  - ${r.unique_id}: ${r.human_readable_name}`);
  console.warn(`[check-patch] then these ${mediumSensitivity.length} medium-sensitivity rule(s) if time allows:`);
  for (const r of mediumSensitivity) console.warn(`  - ${r.unique_id}: ${r.human_readable_name}`);
  console.warn(`[check-patch] once reviewed, set patch_meta.verified_ddragon_version to "${latest}" and patch_meta.verified_at to today's date in ${rulesPath}.`);
}

main().catch((e) => {
  console.error('[check-patch] failed:', e.message);
  process.exit(1);
});
