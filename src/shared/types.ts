// Central type definitions — the only file imported across all layers.
// Data flows: capture → ledger → enrichment → coach → UI
// No layer imports a later layer; this file is the only cross-layer dependency.

// ─── Ledger ──────────────────────────────────────────────────────────────────

export type LedgerEntry =
  | { ts: number; kind: 'info'; feature: string; key: string; value: unknown }
  | { ts: number; kind: 'event'; name: string; data: unknown };

// ─── GEP shapes (parsed from stringified JSON) ───────────────────────────────

export interface Cell {
  name: string;   // e.g. "TFT17_Ahri"
  level: number;  // star level (1, 2, 3)
  item_1: string; // item ID or "0" for empty
  item_2: string;
  item_3: string;
}

export type BoardState = Record<string, Cell>; // cellId → Cell

// Per-unit combat telemetry from a single fight, straight off GEP's
// match_info.battle_stats (real damage/blocked/healed/shielded — not
// inferred from item/HP deltas like the rest of this app's data).
export interface CombatUnitStats {
  name: string;
  totalDamage: number;
  totalBlocked: number;
  healed: number;
  shielded: number;
}

export interface BattleStats {
  own: CombatUnitStats[];
  opponent: CombatUnitStats[];
}

export interface PlayerState {
  summoner_name?: string;
  health: number;
  gold: number;
  level: number;
  rank?: number;
}

export interface RoundInfo {
  stage: string;         // e.g. "3-2"
  type: 'PVP' | 'PVE' | 'realm_of_the_gods' | 'unknown';
  outcome?: 'win' | 'loss' | 'draw';
}

// ─── Per-round snapshot ───────────────────────────────────────────────────────

export interface RoundSnapshot {
  label: string;                      // "3-2"
  type: 'PVP' | 'PVE' | 'realm_of_the_gods' | 'unknown';
  outcome?: 'win' | 'loss' | 'draw';
  goldStart: number;
  goldEnd: number;
  health: number;
  level: number;
  rollsSpent: number;
  xpBought: boolean;
  board: BoardState;
  bench: BoardState;
  // Loose items/components sitting in the item tray, NOT equipped on any
  // champion — from GEP's bench.item_bench (a separate feature from
  // bench.bench_pieces, which only covers benched CHAMPIONS' equipped items).
  // This is where most real component-hoarding actually happens.
  benchItems: string[];
  shop: string[];                     // champion IDs
  augmentsPicked: string[];           // augment IDs picked so far this match
  opponentBoard: BoardState;
  interestEarned: number;
  streakCount: number;
  streakType: 'win' | 'loss' | 'none';
  // Set 17 — Realm of Gods (populated only for realm_of_the_gods rounds)
  godChosen?: string;                 // e.g. "Ahri" | "Evelynn" | "Kayle" | "Thresh" | "Pengu"
  godOfferingHpCost?: number;        // HP cost of the chosen Evelynn offering, if any
  // Real per-unit damage/blocked/healed/shielded from this round's fight
  // (match_info.battle_stats) — undefined when GEP didn't send it for this
  // round (e.g. a round with no combat) or the side split couldn't be
  // resolved. See src/ledger/rounds.ts for how own/opponent are told apart.
  battleStats?: BattleStats;
  // The real display name of this round's opponent (match_info.opponent),
  // when GEP reported one — undefined for PVE/no-opponent rounds.
  opponentName?: string;
}

export interface MatchSnapshot {
  pseudoMatchId: string;
  setId: string;                      // "set17"
  gameMode: 'tft' | 'lol' | 'unknown';
  rounds: RoundSnapshot[];
  finalPlacement: number;             // 1-8
  finalBoard: BoardState;
  augments: string[];                 // all picked augments
  // Set 17 — collected god picks across all three god rounds (2-4, 3-4, 4-4)
  godPicks: Array<{ round: string; god: string }>;
}

// ─── Rule engine ─────────────────────────────────────────────────────────────

export type DecisionCategory =
  | 'econ'
  | 'streak'
  | 'leveling'
  | 'items'
  | 'rolling'
  | 'traits'
  | 'augments'
  | 'positioning'
  | 'hp'
  | 'board'
  | 'comp'
  | 'set_mechanic';

export type Severity = 'minor' | 'moderate' | 'critical';

// Best-effort (row, col) on a 4x7 hex board, resolved from a GEP cell_N id —
// see shared/hex-grid.ts for the mapping and its caveats.
export interface HexPosition {
  side: 'own' | 'opponent';
  row: number; // 0-3
  col: number; // 0-6
}

// A resolved board occupant, for rendering the full board layout (not just a
// single highlighted hex) on the positioning diagram.
export interface BoardUnit extends HexPosition {
  name: string; // friendly champion name
  icon?: ChampionIcon;
}

export interface BoardSnapshot {
  own: BoardUnit[];
  opponent: BoardUnit[];
}

export interface DecisionPoint {
  ruleId?: string;                    // links back to rules.core.json / rules.season.json unique_id
  // 'core' = set-agnostic mechanic, 'season' = tied to this set's balance/comps.
  // Populated by the rule engine from the rule registry when ruleId is set.
  tier?: 'core' | 'season';
  round: string;
  category: DecisionCategory;
  severity: Severity;
  observed: string;
  recommended: string;
  reasonMetrics: Record<string, number | string>;
  // When present, the rule engine has written the full coaching prose.
  // brief-builder converts these directly to CoachingNotes.
  coaching_text?: string;
  // Set by positioning checks that reference a specific board hex — the
  // opponent threat being reacted to (e.g. their carry's hex).
  hexPosition?: HexPosition;
  // Set by positioning checks — the full board layout at the referenced round,
  // so the diagram can show champion names, not just an empty highlighted hex.
  boardSnapshot?: BoardSnapshot;
  // Own-side hex the checker recommends moving a unit TO. Paired with
  // moveUnitName (the unit's current name, looked up in boardSnapshot.own to
  // find its current cell) so the diagram can draw "move from here to here"
  // instead of only marking the opponent's threat.
  recommendedPosition?: HexPosition;
  moveUnitName?: string;
}

// ─── Coaching report ────────────────────────────────────────────────────────

export interface CoachingNote {
  round_label: string;
  category: DecisionCategory;
  severity: Severity;
  tier?: 'core' | 'season';
  what_happened: string;
  what_should_have_happened: string;
  why: string;
  references?: {
    units?: string[];
    items?: string[];
    augments?: string[];
    hexPosition?: HexPosition;
    boardSnapshot?: BoardSnapshot;
    recommendedPosition?: HexPosition;
    moveUnitName?: string;
  };
}

export interface RoundTrajectoryPoint {
  round: string;
  hp: number;
  gold: number;
  level: number;
  rollGold: number;   // gold spent rolling this round (rollsSpent * 2)
}

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D';

// The single highest-leverage fix for the match — the worst-graded category
// (see src/coach/scoring.ts's categoryGrades), reduced to one concrete action
// so a scattered note list doesn't leave the user without a clear takeaway.
// Undefined when there are no notes at all (a clean game with nothing to fix).
export interface PriorityFix {
  category: DecisionCategory;
  occurrences: number;
  action: string; // what_should_have_happened from the category's most severe note
  why: string;    // that note's why text
}

export interface CoachingReport {
  overall_placement: number;
  overall_grade: Grade;
  // Per-category grade, computed from ALL decision points the rule engine
  // found in that category for the full match — not just the ones that
  // survived truncation into `notes` below. See src/coach/scoring.ts.
  category_grades: Record<DecisionCategory, Grade>;
  tldr: string;
  priority_fix?: PriorityFix;
  notes: CoachingNote[];
  strengths: string[];
  round_trajectory?: RoundTrajectoryPoint[];
}

// ─── Match brief (compact report input) ─────────────────────────────────────

export interface MatchBrief {
  placement: number;
  setId: string;
  roundTrajectory: RoundTrajectoryPoint[];
  finalComp: Array<{ name: string; stars: number; items: string[] }>;
  augments: string[];
  godPicks: Array<{ round: string; god: string }>;
  // Notes already narrated by the rule engine.
  resolvedNotes: CoachingNote[];
  // Decision points that still need report prose.
  decisionPoints: DecisionPoint[];
  // Grades computed from the full, pre-truncation decision-point list (see
  // rule-engine.ts) — deliberately independent of what made it into
  // resolvedNotes/decisionPoints after the MAX_POINTS/MAX_PER_RULE cuts.
  overallGrade: Grade;
  categoryGrades: Record<DecisionCategory, Grade>;
}

// ─── App status ──────────────────────────────────────────────────────────────

export type AppStatus =
  | 'no_game'   // not in a TFT match
  | 'in_match'; // TFT match in progress

// ─── Persistence ─────────────────────────────────────────────────────────────

export interface MatchRecord {
  pseudoMatchId: string;
  datePlayed: number;
  setId: string;
  placement: number;
  lastRound: string;
  ledger: LedgerEntry[];
  brief?: MatchBrief;
  coachingReport?: CoachingReport;
  // Best-effort ground-truth check against Riot's match-v1, when a Riot
  // account is linked in settings. Diagnostic only — never overwrites
  // `placement`, which stays sourced from GEP. See src/enrichment/riot-api.ts.
  riotCrossCheck?: RiotCrossCheck;
}

// ─── Riot API (bring-your-own-key, see src/enrichment/riot-api.ts) ───────────

export interface RiotAccount {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface RiotLeagueEntry {
  queueType: string;
  tier: string;
  rank: string;        // division, e.g. "II" (absent for apex tiers)
  leaguePoints: number;
  wins: number;
  losses: number;
}

export interface RiotCrossCheck {
  riotPlacement: number;
  matched: boolean;
  checkedAt: number;
}

export interface MatchSummary {
  pseudo_match_id: string;
  date_played: number;
  placement: number;
  last_round: string;
}

// ─── Meta data (from data/sets/setN/*.json) ───────────────────────────────────

export interface CarryBisEntry {
  role: string;
  items_bis: string[];
  items_alt: string[];
  components_priority: string[];
  notes: string;
}

export interface TraitBreakpoint {
  trait: string;
  tiers: number[];  // e.g. [2, 4, 6]
}

export interface EconBenchmark {
  round: string;
  minGold: number;
  notes: string;
}

// A standalone square champion tile icon (Community Dragon's `tileIcon` —
// the same clean shop-tile art real-game TFT and sites like metatft.com use),
// not Data Dragon's per-champion sprite crop, which is an off-center splash-art
// crop too zoomed-in to recognize at hex-tile size.
export interface ChampionIcon {
  url: string;
}

// Real composition + stat-derived tags for a single item (data/core/item-data.json,
// auto-fetched from Community Dragon — see scripts/fetch-ddragon.js). Replaces the
// hand-maintained component/damage-item id lists items.ts used to carry.
export interface ItemData {
  name: string;
  isComponent: boolean;
  composition: string[]; // the 2 component ids that build this item; [] for components
  tags: Array<'offense' | 'tank' | 'sustain'>;
  // Filtered subset of real Community Dragon stat effects — only unambiguous,
  // well-known-shape keys (Health, Armor, MagicResist, LifeSteal, StatOmnivamp,
  // BonusPercentHP, PercentMaxHP, AD, AP, CritChance, AS). Values >=1 are flat
  // (e.g. Health: 500), values <1 are fractional percentages (e.g. AD: 0.15 =
  // +15% bonus AD) — a consistent Riot data convention cross-checked against
  // known real item values (B.F. Sword AD:10 flat, Bloodthirster AD:0.15=15%).
  keyStats: Record<string, number>;
}

export interface ChampionMeta {
  name: string;
  tier: number;
  role: 'carry' | 'tank' | 'support' | 'flex';
  traits: string[];
  icon?: ChampionIcon;
}

// A curated comp archetype (data/sets/set{N}/comps.json) — used to detect when
// a player is intentionally executing a known strategy (e.g. reroll) so
// checkers can adjust their verdict instead of judging every game against a
// single "standard curve" assumption.
export interface CompArchetype {
  id: string;
  name: string;
  type: 'reroll' | 'fast8' | 'fast9' | string;
  optimal_level: number;
  primary_carry_ids: string[];
  key_traits: string[];
  notes: string;
}

// An augment picked this match can change what "correct play" means for a
// checker that otherwise reasons from static meta data. Each bucket below is
// a distinct kind of override; see data/sets/set{N}/augment-modifiers.json.
export interface AugmentItemOverride {
  items: string[];  // item ids this augment makes BiS-equivalent, regardless of carry-bis.json
  reason: string;    // short clause explaining why, used directly in coaching text
}

export interface AugmentTraitBonus {
  trait: string;
  bonus: number;     // additional effective trait count granted while this augment is active
  reason: string;
}

export interface AugmentFrontlineExemption {
  reason: string;    // why this augment substitutes for having a tank-role unit on board
}

export interface AugmentModifiers {
  itemBisOverrides: Record<string, AugmentItemOverride>;
  traitCountBonuses: Record<string, AugmentTraitBonus>;
  frontlineExemptions: Record<string, AugmentFrontlineExemption>;
}

export interface MetaData {
  carryBis: Record<string, CarryBisEntry>;
  traitBreakpoints: TraitBreakpoint[];
  econBenchmarks: EconBenchmark[];
  champions: Record<string, ChampionMeta>;
  // Core, set-agnostic item id -> friendly display name (data/core/items.json).
  items: Record<string, string>;
  // Core, set-agnostic item id -> real composition/stat data (data/core/item-data.json).
  itemData: Record<string, ItemData>;
  // Augment ids grouped by category (data/sets/set{N}/augments.json).
  augments: Record<string, string[]>;
  // Core, auto-fetched augment id -> friendly display name (data/core/augment-names.json).
  augmentNames: Record<string, string>;
  // Augment picks that override another checker's rule path (data/sets/set{N}/augment-modifiers.json).
  augmentModifiers: AugmentModifiers;
  // Curated comp archetypes for this set (data/sets/set{N}/comps.json).
  comps: CompArchetype[];
}

// ─── Match context ───────────────────────────────────────────────────────────
// Situational signals computed once per match, shared across checkers, so a
// checker can reason about "what kind of game is this" rather than judging
// every round against one fixed standard-curve assumption in isolation.

export interface MatchContext {
  // True when the player's board matches a known reroll archetype from
  // comps.json (see src/coach/match-context.ts for the detection heuristic).
  isRerollComp: boolean;
  matchedComp?: { id: string; name: string };
  // Round labels where the player was in a stage-3+ HP crisis (health < 40).
  // Used to suppress econ-discipline notes that would contradict "spend gold
  // to survive" advice on the same round.
  hpCrisisRounds: Set<string>;
  // Plurality-vote active comp — unit names on board in >50% of PvP rounds.
  activeComp: Set<string>;
  // True when leveling hit the same fast-tempo checkpoints LEVEL_003/LEVEL_005
  // already use (level 8 by 4-2, or level 9 by 5-2) — a level-timing signal,
  // not a named comp archetype. Deliberately NOT tied to specific carries or
  // traits: most of the Set 17 roster is still uncurated role:'flex' data
  // (see champions.json), and this project has twice already shipped invented
  // Set 17 comp/trait data that turned out to be wrong. Level timing is a
  // verifiable game mechanic; "this is a Fast 9 comp" is not, without real
  // per-archetype curation this project doesn't have yet.
  isFastTempo: boolean;
}
