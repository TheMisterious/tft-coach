#!/usr/bin/env node
// Auto-fetch official TFT static data (champion/item/trait/augment names) from
// Riot's Data Dragon CDN and merge it into the core + season data files.
//
// Usage: node scripts/fetch-ddragon.js
//
// What this does and does not do:
//   - Updates friendly names + cost/tier for champions and items — this data is
//     official and stable, so it's safe to overwrite on every run.
//   - Updates champion `traits` from Community Dragon's real per-champion
//     `traits` array — CORRECTED 2026-07-28: earlier versions of this script
//     assumed traits "stay hand-curated" because Data Dragon doesn't expose
//     them, but Community Dragon (already fetched here for tile icons) does,
//     and it's real official data, not a judgment call — same tier as
//     name/cost. Found after a live match report showed the wrong "main
//     carry" and an incomplete comp headline; investigation found 57/66 Set
//     17 champions (including the actual carries in that match, Samira and
//     Ornn) still had a hand-curation placeholder `traits: []`. `role`
//     (tank/carry/support/flex) has no equivalent official field and stays
//     hand-curated.
//   - Regenerates trait-breakpoints.json from the same Community Dragon
//     payload's real tier thresholds — excluding per-champion "Unique"
//     traits (Riot's own `apiName` convention: `TFT<set>_<Champion>UniqueTrait`,
//     e.g. Blitzcrank's "Party Animal" — always trivially active with 1 copy
//     of that one champion, not a real multi-unit synergy) and the
//     "Undetermined"/non-`TFT<set>_`-prefixed special mechanics (Set 17's
//     Choose-Trait and Realm-of-Gods blessing tracks, already handled
//     separately via match_info.god_* fields — see src/ledger/rounds.ts).
//   - Generates augment-unit-grants.json (augment id -> local champion id)
//     for augments.json's hand-curated 'units' bucket, by matching each
//     augment's real Data Dragon description text against this set's real
//     champion names — recovers real derived data (checkers/augments.ts's
//     AUGMENT_003 used to only catch the narrow "_Augment_<Name>Carry" id
//     suffix, ~20 of the real ~63 champion-granting augments; this covers
//     the rest without guessing).
//   - Never touches comps.json, carry-bis.json, or augments.json's category
//     buckets themselves — tier-list/build knowledge and augment
//     categorization are not part of official game data and are not
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
    https.get(url, { headers: { 'User-Agent': 'coachv-fetch-ddragon' } }, (res) => {
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

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  // Real per-champion trait membership + real trait breakpoint tiers, keyed
  // by setId — matches only the plain "TFTSet<N>" mutator (the standard
  // ranked set), not _PAIRS/_PVEMODE/event variants which share the same
  // roster/tier data anyway but aren't the canonical source to point at.
  const traitsByChampionApiName = new Map(); // setId -> Map<championApiName, string[]>
  const traitBreakpointsBySet = new Map();   // setId -> Array<{trait, tiers}>
  for (const setEntry of cdragonTft.setData ?? []) {
    const m = /^TFTSet(\d+)$/.exec(setEntry.mutator ?? '');
    if (!m) continue;
    const setId = 'set' + m[1];

    const champTraits = new Map();
    for (const champ of setEntry.champions ?? []) {
      if (champ.apiName) champTraits.set(champ.apiName, champ.traits ?? []);
    }
    traitsByChampionApiName.set(setId, champTraits);

    // A real multi-unit synergy trait needs 2+ different champions actually
    // carrying it — ground truth from the same real per-champion trait data
    // above, not a naming-convention guess. This is the one signal that
    // correctly excludes EVERY single-champion "trait" at once: Riot's
    // explicitly-named "Unique" passives (e.g. TFT17_BlitzcrankUniqueTrait
    // for "Party Animal") AND ones that don't follow that naming convention
    // but are still just one champion's personal mechanic (e.g. "Factory
    // New" / TFT17_GravesTrait — only Graves has it, no "UniqueTrait" suffix
    // to key off).
    const champCountByTraitName = new Map();
    for (const traits of champTraits.values()) {
      for (const t of traits) champCountByTraitName.set(t, (champCountByTraitName.get(t) ?? 0) + 1);
    }

    // "Stargazer" is a real trait but genuinely not representable as a flat
    // ascending tiers list — Community Dragon carries it as 8 separate
    // per-archetype entries (Wolf/Medallion/Huntress/Serpent/Shield/
    // Fountain/Mountain/base) with overlapping, non-linear minUnits ranges,
    // not tiers of one synergy. Flattening them into one union (tried and
    // inspected 2026-07-28) produced a nonsensical 9-entry tiers array.
    // Excluded by name rather than guessed at — same principle as leaving
    // the Evelynn HP-cost field unresolved rather than inventing a value.
    const NON_LINEAR_TRAITS = new Set(['Stargazer']);

    const tiersByTraitName = new Map();
    for (const trait of setEntry.traits ?? []) {
      const apiName = trait.apiName ?? '';
      const isOfficialPrefix = new RegExp(`^TFT${m[1]}_`).test(apiName);
      const isUndetermined = /Undetermined/.test(apiName);
      const isSingleChampion = (champCountByTraitName.get(trait.name) ?? 0) < 2;
      if (!isOfficialPrefix || isUndetermined || isSingleChampion || NON_LINEAR_TRAITS.has(trait.name)) continue;

      const tiers = tiersByTraitName.get(trait.name) ?? new Set();
      for (const eff of trait.effects ?? []) {
        if (typeof eff.minUnits === 'number') tiers.add(eff.minUnits);
      }
      tiersByTraitName.set(trait.name, tiers);
    }
    traitBreakpointsBySet.set(setId, [...tiersByTraitName.entries()]
      .map(([trait, tiers]) => ({ trait, tiers: [...tiers].sort((a, b) => a - b) }))
      .sort((a, b) => a.trait.localeCompare(b.trait)));
  }

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

  // ── Core: item-data.json — real composition + stat-derived tags ─────────────
  // Community Dragon's item payload (fetched above for tile icons) carries a
  // real `composition` array (the 2 component ids that build it) and a real
  // `effects` stat map — unlike Data Dragon's tft-item.json, which is just
  // id+name+icon with no mechanical data at all (confirmed by direct fetch).
  // This replaces the two hand-maintained id lists items.ts used to rely on
  // (COMPONENT_IDS, DAMAGE_ITEM_PREFIXES) with real fetched data.
  const OFFENSE_KEYS = new Set(['AD', 'AP', 'CritChance', 'AS', 'AttackSpeed', 'AttackSpeedPerStack', 'Damage']);
  const TANK_KEYS     = new Set(['Armor', 'MagicResist', 'Health', 'BonusPercentHP', 'PercentMaxHP']);
  const SUSTAIN_KEYS  = new Set(['LifeSteal', 'StatOmnivamp', 'HealthRegenInterval', 'ShieldHealthPercent']);

  function deriveTags(effects) {
    const keys = Object.keys(effects ?? {});
    const tags = [];
    if (keys.some(k => OFFENSE_KEYS.has(k) && effects[k] > 0)) tags.push('offense');
    if (keys.some(k => TANK_KEYS.has(k) && effects[k] > 0)) tags.push('tank');
    if (keys.some(k => SUSTAIN_KEYS.has(k) && effects[k] > 0)) tags.push('sustain');
    return tags;
  }

  // Only unambiguous, well-known-shape stat keys — excludes hashed/internal
  // keys and situational mechanics (burn %, mana regen, ICD, stack caps, ...)
  // that would need real per-item game knowledge to phrase correctly, which
  // this project has already gotten burned by inventing once (fictional
  // traits, 2026-07-04). Coaching text only ever cites keys from this list.
  const KEY_STAT_KEYS = new Set([
    'Health', 'Armor', 'MagicResist', 'LifeSteal', 'StatOmnivamp',
    'BonusPercentHP', 'PercentMaxHP', 'AD', 'AP', 'CritChance', 'AS',
  ]);

  function extractKeyStats(effects) {
    const out = {};
    for (const [k, v] of Object.entries(effects ?? {})) {
      if (KEY_STAT_KEYS.has(k) && typeof v === 'number' && v > 0) out[k] = v;
    }
    return out;
  }

  const nextItemData = {};
  let itemDataCount = 0, componentCount = 0;
  for (const item of cdragonTft.items ?? []) {
    if (!item.apiName || !item.apiName.startsWith('TFT_Item_')) continue;
    if (/Corrupted|Free|Unknown|Debug/.test(item.apiName)) continue;
    if (!item.name) continue; // real junk entries exist (TFT_Item_Blank has name:null, TFT_Item_EmptyBag has name:'')
    if (item.apiName in nextItemData) continue; // dedupe — keep first occurrence
    const isComponent = item.composition.length === 0 && item.tags.includes('component');
    nextItemData[item.apiName] = {
      name: item.name,
      isComponent,
      composition: item.composition,
      tags: deriveTags(item.effects),
      keyStats: extractKeyStats(item.effects),
    };
    itemDataCount++;
    if (isComponent) componentCount++;
  }
  const itemDataPath = path.join(DATA_ROOT, 'core', 'item-data.json');
  writeJson(itemDataPath, nextItemData);
  console.log(`[fetch-ddragon] item-data.json — ${itemDataCount} items (${componentCount} components) from Community Dragon`);

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

    const championTraits = traitsByChampionApiName.get(setId) ?? new Map();

    const championsPath = path.join(setDir, 'champions.json');
    const existingChampions = readJsonIfExists(championsPath) ?? {};
    const nextChampions = { ...existingChampions };
    let champsAdded = 0, champsRenamed = 0, traitsUpdated = 0;
    const newChampionIds = [];
    for (const champ of champs) {
      const tileIconUrl = tileIconByCharacterName.get(champ.id);
      const icon = tileIconUrl ? { url: tileIconUrl } : undefined;
      // undefined (not found in Community Dragon's set data, e.g. a variant
      // id like TFT17_MissFortune_TraitClone) leaves traits as-is rather
      // than overwriting real data with an empty array.
      const realTraits = championTraits.get(champ.id);
      const prior = existingChampions[champ.id];
      if (prior) {
        if (prior.name !== champ.name || prior.tier !== champ.tier) champsRenamed++;
        if (realTraits && JSON.stringify(prior.traits) !== JSON.stringify(realTraits)) traitsUpdated++;
        nextChampions[champ.id] = {
          ...prior, name: champ.name, tier: champ.tier, icon,
          traits: realTraits ?? prior.traits,
        };
      } else {
        champsAdded++;
        newChampionIds.push(champ.id);
        // role is a strategic judgment call Community/Data Dragon doesn't
        // provide — flagged with a placeholder so it's easy to grep for and
        // hand-fill. traits ARE real official data now (see header comment).
        nextChampions[champ.id] = { name: champ.name, tier: champ.tier, role: 'flex', traits: realTraits ?? [], icon };
      }
    }
    writeJson(championsPath, nextChampions);
    console.log(`[fetch-ddragon] ${setId}/champions.json — ${champsAdded} added, ${champsRenamed} name/cost updates, ${traitsUpdated} trait updates`);
    if (newChampionIds.length > 0) {
      console.log(`[fetch-ddragon] NEEDS HAND-CURATION — role for new champions: ${newChampionIds.join(', ')}`);
    }

    const traitBreakpoints = traitBreakpointsBySet.get(setId);
    if (traitBreakpoints && traitBreakpoints.length > 0) {
      const traitBreakpointsPath = path.join(setDir, 'trait-breakpoints.json');
      writeJson(traitBreakpointsPath, traitBreakpoints);
      console.log(`[fetch-ddragon] ${setId}/trait-breakpoints.json — ${traitBreakpoints.length} real synergy traits`);
    }

    // ── Season: augment-unit-grants.json — which local champion an augment grants ──
    // augments.json's 'units' bucket already identifies WHICH augments grant a
    // specific champion (real, hand-classified from Data Dragon description
    // text — see that file's own _comment) but not WHICH one; that mapping
    // was discarded after the original classification pass. Recovered here
    // from the same real description text, matched only against THIS set's
    // real champion names (nextChampions, just updated above) — a recycled
    // cross-set augment naming a champion that can't exist on this set's
    // board is correctly left unmapped, since AUGMENT_003 (the consumer)
    // can only ever check board presence for a champion that could
    // plausibly be on it.
    const localAugments = readJsonIfExists(path.join(setDir, 'augments.json'));
    if (localAugments?.units?.length > 0) {
      const localNamesLongestFirst = Object.entries(nextChampions)
        .map(([id, c]) => ({ id, name: c.name }))
        .sort((a, b) => b.name.length - a.name.length); // longest first avoids a short name matching inside a longer one

      // Real Data Dragon text confirmed several of these grant MULTIPLE
      // champions at once (e.g. "Gain a Pyke and a Meepsie", "Gain a Briar,
      // a Jinx, and an Illaoi") — checked live before trusting a single-
      // pick heuristic. AUGMENT_003's "was THIS champion built" check only
      // makes sense for a single, unambiguous designated champion, so an
      // augment is only kept when the grant window matches EXACTLY ONE
      // local champion id — a multi-grant augment is left unmapped rather
      // than arbitrarily picking one of its several real grants.
      const grants = {};
      for (const augId of localAugments.units) {
        const aug = Object.values(augmentsRes.data).find(a => a.id === augId);
        const desc = aug?.description ?? '';
        const gainIdx = desc.search(/\bGains?\b/);
        if (gainIdx === -1) continue;
        const window = desc.slice(gainIdx, gainIdx + 80);
        const matchedIds = new Set(
          localNamesLongestFirst
            .filter(({ name }) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(window))
            .map(({ id }) => id)
        );
        if (matchedIds.size === 1) grants[augId] = [...matchedIds][0];
      }
      writeJson(path.join(setDir, 'augment-unit-grants.json'), grants);
      console.log(`[fetch-ddragon] ${setId}/augment-unit-grants.json — ${Object.keys(grants).length}/${localAugments.units.length} units-bucket augments resolved to a local champion`);
    }
  }

  console.log('[fetch-ddragon] done. comps.json / carry-bis.json were not touched — those require strategic judgment, not just official data.');
}

main().catch((e) => {
  console.error('[fetch-ddragon] failed:', e.message);
  process.exit(1);
});
