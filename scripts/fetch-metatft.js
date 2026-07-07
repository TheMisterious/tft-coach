#!/usr/bin/env node
// Feature-flagged, unofficial comp tier-list fetch (MetaTFT data via the Parse.bot proxy).
//
// WHY THIS IS ISOLATED AND OFF BY DEFAULT:
//   MetaTFT does not publish an official public API. Parse.bot
//   (https://parse.bot/marketplace/5194af2c-7ceb-40ce-8b3f-b6f70748fa6e/metatft-com-api)
//   is an unofficial third-party proxy that scrapes/wraps MetaTFT's private endpoints.
//   That means: (a) it can break or get blocked without notice, (b) it's not sanctioned
//   by MetaTFT, and (c) it returns win_rate/pick_rate — the same category of stat this
//   project already refuses to display for augments, per Overwolf/Riot ToS policy
//   (see the project's compliance rules). This script is kept fully separate from the
//   rest of the app on purpose:
//     - It never runs unless BOTH env vars below are explicitly set.
//     - Its output goes to data/sets/set17/meta-tiers.generated.json, a file NO other
//       code in this repo reads. Nothing in the coach/rule-engine/UI is wired to it.
//     - Ripping this out is one step: delete this file (and the generated JSON, if
//       you ran it). Nothing else references it.
//   Wiring this data into an actual checker or into visible coaching text is a
//   separate, deliberate decision to make later — this script only fetches and
//   stores it for manual review.
//
// Usage:
//   ENABLE_METATFT_FETCH=true PARSE_API_KEY=your_key node scripts/fetch-metatft.js

const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://api.parse.bot/scraper/fafd290f-21e4-421b-bd4d-0e7a011e8e05';
const OUTPUT_PATH = path.resolve(__dirname, '..', 'data', 'sets', 'set17', 'meta-tiers.generated.json');

function getJson(url, apiKey) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'X-API-Key': apiKey } }, (res) => {
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
  if (process.env.ENABLE_METATFT_FETCH !== 'true') {
    console.log('[fetch-metatft] disabled — set ENABLE_METATFT_FETCH=true to run this (see script header for why it defaults off).');
    return;
  }
  const apiKey = process.env.PARSE_API_KEY;
  if (!apiKey) {
    console.error('[fetch-metatft] ENABLE_METATFT_FETCH=true but PARSE_API_KEY is not set. Get a key from https://parse.bot and set it as an env var.');
    process.exit(1);
  }

  const url = `${BASE_URL}/get_comps?days=3&rank=CHALLENGER,GRANDMASTER,MASTER&patch=current&queue=1100`;
  console.log('[fetch-metatft] fetching comp tier list (unofficial MetaTFT proxy)...');
  const comps = await getJson(url, apiKey);

  const payload = {
    _comment: 'UNOFFICIAL data via an unsanctioned MetaTFT proxy (Parse.bot). Not read by any checker or UI code — see scripts/fetch-metatft.js header before wiring this in. win_rate/pick_rate are present here for manual review only; do not surface them directly per this project\'s compliance rules.',
    fetchedAt: new Date().toISOString(),
    comps,
  };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[fetch-metatft] wrote ${Array.isArray(comps) ? comps.length : '?'} comps to ${OUTPUT_PATH}`);
}

main().catch((e) => {
  console.error('[fetch-metatft] failed:', e.message);
  process.exit(1);
});
