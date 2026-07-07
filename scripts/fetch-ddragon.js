#!/usr/bin/env node
// Auto-fetch official TFT static data (champion/item/trait/augment names) from
// Riot's Data Dragon CDN and merge it into the core + season data files.
//
// Usage: node scripts/fetch-ddragon.js
//
// What this does and does not do:
//   - Updates friendly names + cost/tier for champions and items — this data is
//     official and stable, so it's safe to overwrite on every run.
//   - Leaves champion `role` (tank/carry/support/flex) and `traits` alone for
//     champions that already exist in champions.json — Data Dragon does not
//     expose those, they stay hand-curated.
//   - Never touches comps.json, carry-bis.json, or trait-breakpoints.json —
//     tier-list/build knowledge is not part of official game data and is not
//     fetched from anywhere (see scripts/fetch-metatft.js for the separate,
//     feature-flagged, unofficial path for that kind of data).
//   - Data Dragon's tft-champion.json bundles MULTIPLE sets in one payload at
//     once (the current live set plus the upcoming one, e.g. both TFT15_ and
//     TFT17_ ids show up together with no "which one is live" marker). This
//     script groups champions by their TFT<N>_ prefix and only writes to
//     data/sets/set{N}/champions.json for sets that ALREADY have a folder on
//     disk — it never creates a new set folder on its own. Sets present
//     upstream but without a local folder are just logged, not written.

const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_ROOT = path.resolve(__dirname, '..', 'data');
const LOCALE = 'en_US';

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'tft-coach-fetch-ddragon' } }, (res) => {
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

// Community Dragon's raw game-asset mirror serves .tex game paths as .png —
// full path lowercased, .tex -> .png, rest of the path unchanged. Verified
// live against a real asset (TFT17_Teemo's tileIcon) before relying on it.
function texPathToUrl(texPath) {
  return `https://raw.communitydragon.org/latest/game/${texPath.toLowerCase().replace(/\.tex$/, '.png')}`;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

// Data Dragon's tft-champion.json bundles MORE than just the current live set —
// it also includes the upcoming/next set (and tutorial/event ids), all mixed
// together with no top-level "which set is live" marker. Group champions by
// their TFT<N>_ prefix so each set's data stays separate.
function groupChampionsBySet(championData) {
  const bySet = {};
  for (const champ of Object.values(championData)) {
    const m = /^TFT(\d+)_/.exec(champ.id);
    if (!m) continue; // skip TFTTutorial_/TFTEvent_ ids — not a real set
    const setId = 'set' + m[1];
    (bySet[setId] ??= []).push(champ);
  }
  return bySet;
}

async function main() {
  console.log('[fetch-ddragon] fetching version list...');
  const versions = await getJson('https://ddragon.leagueoflegends.com/api/versions.json');
  const version = versions[0];
  console.log('[fetch-ddragon] latest patch:', version);

  const base = `https://ddragon.leagueoflegends.com/cdn/${version}/data/${LOCALE}`;
  const [championsRes, itemsRes, augmentsRes] = await Promise.all([
    getJson(`${base}/tft-champion.json`),
    getJson(`${base}/tft-item.json`),
    getJson(`${base}/tft-augments.json`),
  ]);

  // Community Dragon's `tileIcon` — the clean square shop-tile art used
  // in-game (and by sites like metatft.com) — not Data Dragon's per-champion
  // `image` sprite crop, which is an off-center splash-art zoom, unrecognizable
  // at hex-tile size (found via user report + visual side-by-side check).
  console.log('[fetch-ddragon] fetching Community Dragon tft data (for tile icons)...');
  const cdragonTft = await getJson('https://raw.communitydragon.org/latest/cdragon/tft/en_us.json');
  const tileIconByCharacterName = new Map();
  for (const setEntry of cdragonTft.setData ?? []) {
    for (const champ of setEntry.champions ?? []) {
      if (champ.tileIcon) tileIconByCharacterName.set(champ.characterName, texPathToUrl(champ.tileIcon));
    }
  }
  console.log(`[fetch-ddragon] tile icons available for ${tileIconByCharacterName.size} champions across all Community Dragon sets`);

  // ── Core: items (id -> friendly name), safe to fully sync every run ──────────
  const itemsPath = path.join(DATA_ROOT, 'core', 'items.json');
  const existingItems = readJsonIfExists(itemsPath) ?? {};
  const { _comment: itemsComment, ...existingItemNames } = existingItems;
  const nextItems = { _comment: itemsComment, ...existingItemNames };
  let itemsAdded = 0, itemsChanged = 0;
  for (const item of Object.values(itemsRes.data)) {
    if (!(item.id in existingItemNames)) itemsAdded++;
    else if (existingItemNames[item.id] !== item.name) itemsChanged++;
    nextItems[item.id] = item.name;
  }
  writeJson(itemsPath, nextItems);
  console.log(`[fetch-ddragon] items.json — ${itemsAdded} added, ${itemsChanged} renamed, ${Object.keys(itemsRes.data).length} total from Data Dragon`);

  // ── Core: augment names (id -> friendly name) — supplementary to augments.json's category buckets ──
  const augmentNamesPath = path.join(DATA_ROOT, 'core', 'augment-names.json');
  const nextAugmentNames = { _comment: 'Auto-fetched from Riot Data Dragon (tft-augments.json). Category buckets (economy/combat/items/units) are hand-curated separately in data/sets/set{N}/augments.json since Data Dragon does not categorize augments.' };
  for (const aug of Object.values(augmentsRes.data)) {
    nextAugmentNames[aug.id] = aug.name;
  }
  writeJson(augmentNamesPath, nextAugmentNames);
  console.log(`[fetch-ddragon] augment-names.json — ${Object.keys(augmentsRes.data).length} augments from Data Dragon`);

  // ── Season: champions.json — preserve hand-curated role/traits ──────────────
  // Data Dragon bundles multiple sets in one payload (live + upcoming). Only
  // update a set's champions.json if that set's folder already exists locally —
  // never auto-create a new data/sets/set{N}/ folder for a set nobody asked for.
  const championsBySet = groupChampionsBySet(championsRes.data);
  for (const [setId, champs] of Object.entries(championsBySet)) {
    const setDir = path.join(DATA_ROOT, 'sets', setId);
    if (!fs.existsSync(setDir)) {
      console.log(`[fetch-ddragon] skipping ${setId} — ${champs.length} champions available upstream, but data/sets/${setId}/ doesn't exist locally (not your active set)`);
      continue;
    }

    const championsPath = path.join(setDir, 'champions.json');
    const existingChampions = readJsonIfExists(championsPath) ?? {};
    const nextChampions = { ...existingChampions };
    let champsAdded = 0, champsRenamed = 0;
    const newChampionIds = [];
    for (const champ of champs) {
      const tileIconUrl = tileIconByCharacterName.get(champ.id);
      const icon = tileIconUrl ? { url: tileIconUrl } : undefined;
      const prior = existingChampions[champ.id];
      if (prior) {
        if (prior.name !== champ.name || prior.tier !== champ.tier) champsRenamed++;
        nextChampions[champ.id] = { ...prior, name: champ.name, tier: champ.tier, icon };
      } else {
        champsAdded++;
        newChampionIds.push(champ.id);
        // role/traits are strategic judgment calls Data Dragon doesn't provide —
        // flagged with a placeholder so they're easy to grep for and hand-fill.
        nextChampions[champ.id] = { name: champ.name, tier: champ.tier, role: 'flex', traits: [], icon };
      }
    }
    writeJson(championsPath, nextChampions);
    console.log(`[fetch-ddragon] ${setId}/champions.json — ${champsAdded} added, ${champsRenamed} name/cost updates`);
    if (newChampionIds.length > 0) {
      console.log(`[fetch-ddragon] NEEDS HAND-CURATION — role + traits for new champions: ${newChampionIds.join(', ')}`);
    }
  }

  console.log('[fetch-ddragon] done. comps.json / carry-bis.json / trait-breakpoints.json were not touched — those require strategic judgment, not just official data.');
}

main().catch((e) => {
  console.error('[fetch-ddragon] failed:', e.message);
  process.exit(1);
});
