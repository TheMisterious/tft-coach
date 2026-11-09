// Fill a set's data/sets/set{N}/ files from Riot's match records: champion
// roles, carry best-in-slot items and reroll comps. See riot-meta/derive.ts for
// what is derived and why.
//
// Usage (PowerShell):
//   $env:RIOT_API_KEY = "<your key>"; npm run fetch:riot-meta -- --platform=vn2
// Options:
//   --platform=vn2      server whose Challenger/GM/Master ladder seeds the pull
//   --set=18            TFT set number (matches from other sets are dropped)
//   --matches=400       distinct matches to read
//   --players=150       ladder players to take match ids from
//   --pace=prod|dev     request spacing: a production key allows far more per
//                       second than a 24h development key (default prod)
//   --dry-run           derive and print, write nothing
//   --cached            re-derive from the last fetch's local copy (no key,
//                       no network) — results/riot-meta-cache/, git-ignored
//
// The key is read from RIOT_API_KEY only, sent only to api.riotgames.com, and
// never written anywhere. Nothing from players other than their final boards
// is kept, and no PUUID or Riot ID reaches the written files.

import fs from 'fs';
import path from 'path';
import { deriveSetMeta, type RiotMatchFull, type ChampionEntry, type ItemEntry } from './riot-meta/derive';

const ROOT = path.resolve(__dirname, '..');
const arg = (name: string, fallback: string) =>
  process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;

const PLATFORM = arg('platform', 'vn2');
const SET = Number(arg('set', '18'));
const TARGET_MATCHES = Number(arg('matches', '400'));
const MAX_PLAYERS = Number(arg('players', '150'));
const PACE_MS = arg('pace', 'prod') === 'dev' ? 1300 : 60;
const DRY_RUN = process.argv.includes('--dry-run');
const CACHED = process.argv.includes('--cached');
const CACHE_PATH = path.join(ROOT, 'results', 'riot-meta-cache', `set${SET}-${PLATFORM}.json`);

// Only what derive.ts reads. No PUUIDs, Riot IDs or anything else about the
// players is kept, so the local copy identifies no one.
function stripForCache(m: RiotMatchFull): RiotMatchFull {
  return {
    metadata: { match_id: m.metadata.match_id },
    info: {
      tft_set_number: m.info.tft_set_number,
      game_version: m.info.game_version,
      game_datetime: m.info.game_datetime,
      participants: m.info.participants.map(p => ({
        placement: p.placement,
        level: p.level,
        units: (p.units ?? []).map(u => ({ character_id: u.character_id, itemNames: u.itemNames, tier: u.tier })),
        traits: (p.traits ?? []).map(t => ({ name: t.name, tier_current: t.tier_current, num_units: t.num_units })),
      })),
    },
  };
}

const MATCH_CLUSTER: Record<string, string> = {
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea', vn2: 'sea', sg2: 'sea', th2: 'sea', tw2: 'sea', ph2: 'sea',
};

const KEY = process.env.RIOT_API_KEY ?? '';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let lastCall = 0;
async function riot<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastCall + PACE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(url, { headers: { 'X-Riot-Token': KEY } });
    if (res.status === 429) {
      const retry = Number(res.headers.get('Retry-After') ?? '10');
      console.warn(`[riot-meta] rate limited, waiting ${retry}s`);
      await sleep(retry * 1000);
      continue;
    }
    if (res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Riot API refused the key (${res.status}). Check RIOT_API_KEY is current and has TFT access.`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Riot API ${res.status} for ${url.replace(/by-puuid\/[^/]+/, 'by-puuid/…')}`);
    return res.json() as Promise<T>;
  }
  return null;
}

async function ladderPuuids(): Promise<string[]> {
  const seen = new Map<string, number>();
  for (const tier of ['challenger', 'grandmaster', 'master']) {
    const league = await riot<{ entries?: Array<{ puuid?: string; summonerId?: string; leaguePoints: number }> }>(
      `https://${PLATFORM}.api.riotgames.com/tft/league/v1/${tier}`);
    const entries = (league?.entries ?? []).sort((a, b) => b.leaguePoints - a.leaguePoints);
    for (const e of entries) {
      if (seen.size >= MAX_PLAYERS) break;
      // Older league payloads carry only a summonerId.
      const puuid = e.puuid ?? (e.summonerId
        ? (await riot<{ puuid?: string }>(`https://${PLATFORM}.api.riotgames.com/tft/summoner/v1/summoners/${e.summonerId}`))?.puuid
        : undefined);
      if (puuid && !seen.has(puuid)) seen.set(puuid, e.leaguePoints);
    }
    console.log(`[riot-meta] ${tier}: ${entries.length} players`);
    if (seen.size >= MAX_PLAYERS) break;
  }
  return [...seen].sort((a, b) => b[1] - a[1]).map(([puuid]) => puuid);
}

async function main() {
  if (!KEY && !CACHED) {
    console.error('Set RIOT_API_KEY first, e.g. in PowerShell:  $env:RIOT_API_KEY = "<your key>"');
    process.exit(1);
  }
  const cluster = MATCH_CLUSTER[PLATFORM];
  if (!cluster) throw new Error(`unknown platform ${PLATFORM}`);
  const setDir = path.join(ROOT, 'data', 'sets', `set${SET}`);
  const championsPath = path.join(setDir, 'champions.json');
  const champions = JSON.parse(fs.readFileSync(championsPath, 'utf-8')) as Record<string, ChampionEntry>;
  const itemData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'core', 'item-data.json'), 'utf-8')) as Record<string, ItemEntry>;

  let traitNames: Record<string, string> = {};
  try {
    const cdragon = await (await fetch('https://raw.communitydragon.org/latest/cdragon/tft/en_us.json')).json() as
      { setData?: Array<{ mutator?: string; traits?: Array<{ apiName: string; name: string }> }> };
    const set = cdragon.setData?.find(s => s.mutator === `TFTSet${SET}`);
    traitNames = Object.fromEntries((set?.traits ?? []).map(t => [t.apiName, t.name]));
  } catch { console.warn('[riot-meta] Community Dragon unavailable — key_traits keep Riot ids'); }

  const matches = CACHED ? readCache() : await fetchMatches(cluster);
  if (matches.length === 0) throw new Error('no matches from this set — nothing to derive');
  if (!CACHED) {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(matches.map(stripForCache)));
    console.log(`[riot-meta] kept an ID-free copy for --cached re-runs: ${CACHE_PATH}`);
  }

  const patches = [...new Set(matches.map(m => /(\d+\.\d+)/.exec(m.info.game_version ?? '')?.[1]).filter(Boolean))].sort();
  if (patches.length === 0) console.warn('[riot-meta] no game_version on these matches; info fields are:', Object.keys(matches[0].info).join(', '));
  const source = `${matches.length} ${PLATFORM} Challenger-Master matches, patch ${patches.join('/') || 'unknown'}, ${new Date().toISOString().slice(0, 10)}`;
  const out = deriveSetMeta({ matches, champions, itemData, traitNames, source });
  report(out, champions);
  if (DRY_RUN) { console.log('[riot-meta] dry run — nothing written'); return; }
  write(out, champions, championsPath, setDir, source);
}

function readCache(): RiotMatchFull[] {
  if (!fs.existsSync(CACHE_PATH)) throw new Error(`no cached fetch at ${CACHE_PATH} — run once without --cached`);
  const matches = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as RiotMatchFull[];
  console.log(`[riot-meta] ${matches.length} matches from ${CACHE_PATH}`);
  return matches;
}

async function fetchMatches(cluster: string): Promise<RiotMatchFull[]> {
  const puuids = await ladderPuuids();
  console.log(`[riot-meta] reading match ids for ${puuids.length} ladder players on ${PLATFORM} (${cluster})`);
  const matchIds = new Set<string>();
  for (const puuid of puuids) {
    if (matchIds.size >= TARGET_MATCHES * 1.5) break;
    const ids = await riot<string[]>(`https://${cluster}.api.riotgames.com/tft/match/v1/matches/by-puuid/${puuid}/ids?count=20`);
    for (const id of ids ?? []) matchIds.add(id);
  }

  const matches: RiotMatchFull[] = [];
  let otherSet = 0;
  for (const id of matchIds) {
    if (matches.length >= TARGET_MATCHES) break;
    const m = await riot<RiotMatchFull>(`https://${cluster}.api.riotgames.com/tft/match/v1/matches/${id}`);
    if (!m) continue;
    if (m.info.tft_set_number !== SET) { otherSet++; continue; }
    matches.push(m);
    if (matches.length % 50 === 0) console.log(`[riot-meta] ${matches.length}/${TARGET_MATCHES} matches`);
  }
  console.log(`[riot-meta] ${matches.length} set ${SET} matches (${otherSet} from other sets dropped)`);
  return matches;
}

function report(out: ReturnType<typeof deriveSetMeta>, champions: Record<string, ChampionEntry>): void {
  const roleCounts = Object.values(out.roles).reduce<Record<string, number>>((n, r) => ({ ...n, [r]: (n[r] ?? 0) + 1 }), {});
  console.log(`[riot-meta] roles:`, roleCounts, `carry BiS: ${Object.keys(out.carryBis).length}`, `reroll comps: ${out.comps.length}`);
  for (const [id, role] of Object.entries(out.roles)) if (role !== 'flex') console.log(`  ${role.padEnd(5)} ${champions[id].name}`);
  for (const c of out.comps) console.log(`  comp  ${c.name} — ${c.notes}`);
  const unmapped = Object.entries(out.stats.unmappedChampions).sort((a, b) => b[1] - a[1]);
  if (unmapped.length) console.warn('[riot-meta] champion ids not in champions.json (summons are expected):', unmapped.slice(0, 15));
  const unknown = Object.entries(out.stats.unknownItems).sort((a, b) => b[1] - a[1]);
  if (unknown.length) console.warn('[riot-meta] item ids not in item-data.json:', unknown.slice(0, 15));
}

function write(
  out: ReturnType<typeof deriveSetMeta>, champions: Record<string, ChampionEntry>,
  championsPath: string, setDir: string, source: string,
): void {
  // Roles: only champions with enough appearances change; the rest keep theirs.
  for (const [id, role] of Object.entries(out.roles)) champions[id] = { ...champions[id], role };
  fs.writeFileSync(championsPath, JSON.stringify(champions, null, 2) + '\n');
  fs.writeFileSync(path.join(setDir, 'carry-bis.json'), JSON.stringify(out.carryBis, null, 2) + '\n');
  fs.writeFileSync(path.join(setDir, 'comps.json'), JSON.stringify(out.comps, null, 2) + '\n');
  fs.writeFileSync(path.join(setDir, 'riot-meta.source.json'), JSON.stringify({
    _comment: 'Written by scripts/fetch-riot-meta.ts — provenance of the derived roles, carry-bis.json and comps.json. Do not hand-edit.',
    source, generated: new Date().toISOString(), platform: PLATFORM, set: SET,
    matches: out.stats.matches, boards: out.stats.boards, topFourBoards: out.stats.topFourBoards, patches: out.stats.patches,
    roleEvidence: out.stats.roleEvidence,
  }, null, 2) + '\n');
  console.log(`[riot-meta] wrote champions.json roles, carry-bis.json, comps.json and riot-meta.source.json in ${setDir}`);
}

main().catch(e => { console.error('[riot-meta]', e.message ?? e); process.exit(1); });
