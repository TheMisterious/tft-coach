#!/usr/bin/env node
// Derives data/sets/set{N}/augment-effects.json from Riot Data Dragon's real
// augment description text.
//
// Usage: node scripts/derive-augment-effects.js
//
// WHY THIS EXISTS
//
// augments.json's category buckets (economy/combat/items/units) are
// hand-curated, and they are always right where they exist — but they only
// cover what someone got around to curating. Across the six real matches in
// tests/goldens/, 10 of 22 picked augment ids had no bucket at all, so
// AUGMENT_001 ("economy augment during an HP crisis") and AUGMENT_004
// ("item-shaping augment picked, nothing built") silently never evaluated
// them. Half of that gap turned out not to be a gap at all — see GOD AUGMENTS
// below — but the rest is real, and it grows every time Riot adds an augment.
//
// WHAT THIS DOES AND DOES NOT CLAIM
//
// It does NOT try to reproduce the hand-curated *category*. That was measured
// and rejected: a keyword classifier picking one bucket per augment scores 75%
// against the existing curation, because real augments are genuinely
// multi-category ("Gain a Battle Academia Emblem and a Rakan" is items AND
// units) and text cannot tell which one a human would call primary. A rule
// consuming a 1-in-4 wrong category is worse than a rule that abstains.
//
// Instead it derives INDEPENDENT, factual flags — does the description grant
// gold/XP, does it grant an item — each recorded with the phrase that
// justified it, so every entry is auditable rather than trusted. Measured
// against the hand-curated buckets as ground truth:
//
//   economy flag: 46/46 of the economy bucket (100% recall), 6/87 of combat
//   items flag:   143/146 of the items bucket (98% recall),  2/87 of combat
//
// and both combat-bucket firings are real ("Gain a random Tank item").
//
// The items flag requires a GRANTING construction ("gain/get/choose ... item"),
// not a bare mention. Without that, "Makeshift Armor — allies WITHOUT items
// equipped gain 30 Armor" reads as an item augment and inverts AUGMENT_004's
// premise, which is that the player was handed items and failed to build them.
//
// GOD AUGMENTS
//
// Set 17's Realm of the Gods blessings arrive through the same picked_augment
// feed but are not augments in the sense these rules mean — they are the god
// alignment reward, already judged by checkers/set17.ts from the match_info
// god_* fields. They are marked `godAugment: true` here so the augment rules
// skip them outright rather than counting them as uncategorised coverage gaps.
//
// Hand curation always wins: checkers/augments.ts checks augments.json first
// and only falls back to these flags. This file never edits augments.json.

const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_ROOT = path.resolve(__dirname, '..', 'data');
const LOCALE = 'en_US';

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'coachv-derive-augment-effects' } }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`GET ${url} -> ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function readJsonIfExists(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, value) {
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
}

// Data Dragon descriptions carry inline markup and non-breaking spaces.
function plainText(augment) {
  return (augment.description || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Riot's item table carries placeholder rows that are not items ("5-cost
// champion", "3 gold", "2-star 2-cost champion"). Matching those would make any
// augment mentioning a champion cost read as an item augment.
const NOT_AN_ITEM_NAME = /\d|\bcost\b|\bchampion\b|\bstar\b|\bgold\b|\btier\b/i;

function realItemNames() {
  const itemData = readJsonIfExists(path.join(DATA_ROOT, 'core', 'item-data.json')) || {};
  return [...new Set(Object.entries(itemData)
    .filter(([k, v]) => k !== '_comment' && v && typeof v === 'object' && typeof v.isComponent === 'boolean')
    .map(([, v]) => v.name)
    .filter(n => typeof n === 'string' && n.length >= 5 && !NOT_AN_ITEM_NAME.test(n)))]
    // Longest first so "Thief's Gloves" wins over a shorter substring match.
    .sort((a, b) => b.length - a.length);
}

const GRANT_VERB = '\\b(gain|gains|gaining|receive|receives|get|gets|choose|grant|grants)\\b[^.]{0,45}';
const ITEM_WORD = '(items?|components?|anvils?|emblems?|artifacts?|removers?)';

// "the next completed item you make", "whenever you craft a completed item" —
// item augments whose payoff is phrased as a crafting trigger rather than a
// grant. Kept separate from GRANT_VERB because the item noun precedes the verb.
const CRAFT_PHRASE = /\b(completed item|item component|craft a[n]? [a-z ]*item)\b/i;

const ECONOMY_RE = /\b(gold|XP|experience|interest|rerolls?)\b/i;

// A god blessing, not an augment. Riot's own id convention: the god's name
// followed by "GodAugment", optionally with a blessing suffix
// (TFT17_Augment_VarusGodAugment_BoonOfStars).
const GOD_AUGMENT_RE = /_Augment_[A-Za-z]+GodAugment/i;

function economyEvidence(text) {
  const m = text.match(ECONOMY_RE);
  return m ? m[0] : null;
}

function itemEvidence(text, itemNames) {
  let m = text.match(new RegExp(GRANT_VERB + '\\b' + ITEM_WORD + '\\b', 'i'));
  if (m) return m[0].slice(0, 80);

  m = text.match(CRAFT_PHRASE);
  if (m) return m[0];

  for (const name of itemNames) {
    m = text.match(new RegExp(GRANT_VERB + '\\b' + escapeRe(name), 'i'));
    if (m) return m[0].slice(0, 80);
  }
  return null;
}

async function main() {
  const versions = await getJson('https://ddragon.leagueoflegends.com/api/versions.json');
  const version = versions[0];
  console.log(`[derive-augment-effects] Data Dragon version ${version}`);

  const augmentsRes = await getJson(
    `https://ddragon.leagueoflegends.com/cdn/${version}/data/${LOCALE}/tft-augments.json`
  );
  const augments = Object.values(augmentsRes.data);
  console.log(`[derive-augment-effects] ${augments.length} augments from Data Dragon`);

  const itemNames = realItemNames();
  console.log(`[derive-augment-effects] matching against ${itemNames.length} real item names`);

  // Only write into set folders that already exist — same rule
  // scripts/fetch-ddragon.js follows; this script never creates a set.
  const setsRoot = path.join(DATA_ROOT, 'sets');
  const setDirs = fs.readdirSync(setsRoot).filter(d =>
    fs.statSync(path.join(setsRoot, d)).isDirectory()
  );

  for (const setId of setDirs) {
    const setDir = path.join(setsRoot, setId);
    const effects = {
      _comment:
        'Auto-derived from Riot Data Dragon augment description text by scripts/derive-augment-effects.js. ' +
        'Each flag records the phrase that justified it. These are FACTS ABOUT THE TEXT (does it grant gold/XP, ' +
        'does it grant an item), not a category judgment — augments.json\'s hand-curated buckets remain ' +
        'authoritative and are checked first by src/coach/checkers/augments.ts. Do not hand-edit: regenerate.',
      _generated: { dataDragonVersion: version, augmentsScanned: augments.length },
    };

    let economyCount = 0;
    let itemCount = 0;
    let godCount = 0;

    for (const augment of augments) {
      const text = plainText(augment);
      const isGod = GOD_AUGMENT_RE.test(augment.id);
      const economy = isGod ? null : economyEvidence(text);
      const items = isGod ? null : itemEvidence(text, itemNames);

      if (!isGod && !economy && !items) continue;

      const entry = {};
      if (isGod) { entry.godAugment = true; godCount++; }
      if (economy) { entry.economy = economy; economyCount++; }
      if (items) { entry.items = items; itemCount++; }
      effects[augment.id] = entry;
    }

    writeJson(path.join(setDir, 'augment-effects.json'), effects);
    console.log(
      `[derive-augment-effects] ${setId}/augment-effects.json — ` +
      `${economyCount} economy, ${itemCount} item-granting, ${godCount} god blessings`
    );
  }
}

main().catch((e) => {
  console.error('[derive-augment-effects] failed:', e.message);
  process.exit(1);
});
