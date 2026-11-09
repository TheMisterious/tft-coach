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
  /**
   * `totalDamage` split by type, straight off GEP's `phy_dmg` / `mag_dmg` /
   * `true_dmg`. Present on both sides whenever the case came from a real
   * `battle_stats` payload; absent when the case was rebuilt from damage
   * curves, which carry no type at all.
   */
  physicalDamage?: number;
  magicDamage?: number;
  trueDamage?: number;
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
  type: RoundType;
  outcome?: 'win' | 'loss' | 'draw';
}

// ─── Per-round snapshot ───────────────────────────────────────────────────────

// 'carousel' is the shared draft at X-4: GEP's round_start type "Carousel",
// seen from Set 18, which brought the carousel back. Set 17 replaced it with
// Realm of the Gods, whose rounds sent no round_start at all, so they never
// became rounds of their own (see godPicks below).
export type RoundType = 'PVP' | 'PVE' | 'carousel' | 'unknown';

export interface RoundSnapshot {
  label: string;                      // "3-2"
  type: RoundType;
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
  // Set 17 only — Realm of the Gods. Set 18 brought the carousel back and GEP
  // sends no god_* fields there, so these stay unset.
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
  // Every player in the lobby as of this round, from GEP's roster.player_status.
  // Undefined only before the first roster update of the match. See
  // LobbyPlayerState for what the fields really mean.
  lobby?: LobbyPlayerState[];
}

// One lobby member's public state, from roster.player_status. GEP keys that
// payload by DISPLAY name, which for opponents is their equipped little-legend
// skin ("Chibi Lee Sin") rather than a Riot ID — only the local player's entry
// carries a real identity, flagged by `localplayer`.
//
// The `xp` field in the raw payload is NOT experience points: verified against
// all six matches in tests/goldens/, it tracks `me.xp.level` exactly, round for
// round. It is stored here as `level` so no caller has to rediscover that.
export interface LobbyPlayerState {
  name: string;
  health: number;
  level: number;
  isLocal: boolean;
}

// Where finalPlacement came from — see src/ledger/placement.ts. 'none' means
// finalPlacement is a placeholder 8, not a result.
export type PlacementSource = 'gep' | 'rank' | 'none';

// What the ledger actually observed, as opposed to the defaults the
// reconstruction starts from (level 1, 0 gold, 100 HP, empty board). A checker
// reading a default it never saw overwritten reports a fabricated fact — a real
// QA report flagged "empty board slots at level 1" at 6-3 off a ledger that
// held only post-elimination spectating. See src/coach/coverage.ts for how
// this gates which categories are graded at all.
export interface CaptureCoverage {
  firstRound?: string;
  lastRound?: string;
  // The first captured round is past 2-1: the recording began mid-match, so
  // every checkpoint before it is missing rather than passed.
  missedStart: boolean;
  goldSeen: boolean;
  healthSeen: boolean;
  // me.xp, or the local player's roster entry when me.xp never fired.
  levelSeen: boolean;
  boardSeen: boolean;
  shopSeen: boolean;
  augmentsSeen: boolean;
  // Rounds that began after the local player was eliminated — GEP keeps
  // streaming the lobby while you spectate. Dropped, never coached.
  spectatorRoundsDropped: number;
}

export interface MatchSnapshot {
  pseudoMatchId: string;
  setId: string;                      // "set17"
  gameMode: 'tft' | 'lol' | 'unknown';
  rounds: RoundSnapshot[];
  finalPlacement: number;             // 1-8
  // Always set by reconstructSnapshots(); optional so hand-built test
  // snapshots need not spell it out (absent reads as a known placement).
  placementSource?: PlacementSource;
  finalBoard: BoardState;
  augments: string[];                 // all picked augments
  // Set 17 only — god picks across its three god rounds (2-4, 3-4, 4-4).
  // Always empty from Set 18 on, where X-4 is an ordinary carousel again.
  godPicks: Array<{ round: string; god: string }>;
  // Always set by reconstructSnapshots(); absent on hand-built test snapshots,
  // which are treated as fully observed.
  capture?: CaptureCoverage;
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
  | 'combat'
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
  // Set by src/coach/decision-trace.ts on checkpoint notes: what the player did
  // in the window before the checkpoint.
  contributing?: ContributingDecisions;
}

// ─── Coaching report ────────────────────────────────────────────────────────

// What scripts/rule-audit.ts measured about a rule against real placements
// (data/core/rule-evidence.json). Only 'predictive' rules have shown a
// measurable link to a worse finish; every other verdict says why the rule
// is unproven — not that it is wrong.
export type RuleVerdict =
  | 'predictive'   // fired -> measurably worse placement (BH q < 0.1)
  | 'inverted'     // fired -> measurably BETTER placement (BH q < 0.1)
  | 'unproven'     // tested, no measurable effect at the audit's sample size
  | 'always-on'    // fires in nearly every match, so it cannot separate good games from bad
  | 'rare'         // fired too rarely to test
  | 'whole-match'  // a whole-match judgment with no round to window on
  | 'never-fired'  // registered, never fired in any audited match
  | 'unaudited';   // not in the evidence file (new rule, or a note with no ruleId)

export interface NoteEvidence {
  verdict: RuleVerdict;
  // 'confirmed' only when the association found on older matches showed up
  // again on newer matches it was not discovered on; everything else is
  // 'exploratory'. Either way it is an association in audited games, not proof
  // that the flagged behaviour caused the result.
  status?: 'confirmed' | 'exploratory';
  placementDelta?: number;  // mean placement fired minus not fired; positive = worse finish
  ci?: [number, number];    // 95% bootstrap interval for placementDelta
  matches?: number;         // audited matches behind the verdict
  matchesFired?: number;    // of those, how many the rule fired in at all
}

// What the player did in the window before a checkpoint note fired — observed
// facts only (src/coach/decision-trace.ts). Shown as "likely contributing
// decisions": the coach cannot see the options that were available, so it
// lists what happened rather than ruling on it.
export interface ContributingDecisions {
  window: string;           // e.g. "stage 3 (3-1 to 3-7)"
  observations: string[];
}

export interface CoachingNote {
  round_label: string;
  category: DecisionCategory;
  severity: Severity;
  tier?: 'core' | 'season';
  // Absent on reports generated before the rule audit existed; the report
  // view treats a report with no evidence on any note as unpartitioned.
  evidence?: NoteEvidence;
  contributing?: ContributingDecisions;
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

// ─── Match plan ──────────────────────────────────────────────────────────────
// A whole-match synthesis layer, distinct from the per-round DecisionPoints
// above. Every checker judges a single round in isolation; MatchPlan instead
// describes what the player was actually building across the whole game
// (comp trajectory, econ arc, leveling curve) so the report can open with an
// overview instead of a flat pile of disconnected notes. See
// src/coach/plan-builder.ts for the derivation — deliberately deterministic
// (no LLM), built entirely from data already captured in RoundSnapshot.

export interface CompPivot {
  round: string;
  from: string[]; // trait names active immediately before the pivot
  to: string[];   // trait names active immediately after the pivot
}

export interface EconPhase {
  startRound: string;
  endRound: string;
  mode: 'banking' | 'spending';
}

export interface LevelMilestone {
  level: number;
  round: string; // first round this level was reached
}

export type EconStyle = 'standard' | 'slow_roll' | 'reroll' | 'fast_tempo';

export interface MatchPlan {
  headline: string;
  finalTraits: string[];  // active trait set in the final stretch of the match
  pivots: CompPivot[];
  econStyle: EconStyle;
  econPhases: EconPhase[];
  levelMilestones: LevelMilestone[];
  // Timing vs. the same level-8-by-4-2 / level-9-by-5-2 benchmarks
  // checkers/leveling.ts's LEVEL_003/LEVEL_005 already use. Undefined when
  // the match ended before the benchmark round existed to compare against.
  level8Timing?: 'ahead' | 'on_curve' | 'behind';
  level9Timing?: 'ahead' | 'on_curve' | 'behind';
  // Current-patch reference info, blended in from AggregateMetaTable (see
  // src/coach/meta-blend.ts) — always informational, never a directive. See
  // MetaContext's own doc comment for why.
  metaContext?: MetaContext;
}

// Current-patch reference context for the match's comp/champion choices,
// sourced from AggregateMetaTable (crowd data across many high-elo players;
// see "Aggregate meta table" below — normally absent now). Deliberately
// NOT a tier-list judgment: `compStanding` is pure reference info ("this trait
// combo has averaged Xth place recently"), never phrased as a mistake.
// `missedChampion` is the ONLY place an implied "you had a better option"
// claim is made, and only when there's real per-round evidence for it —
// RoundSnapshot.shop is genuinely captured "what was offered" data, so a
// champion offered repeatedly and never bought, whose boards place
// meaningfully better in the aggregate table, is a grounded claim. Augment
// offers are NOT capturable by GEP at all (see checkers/augments.ts's header
// comment), so no augment equivalent of `missedChampion` exists anywhere —
// augment meta context stays purely informational (see meta-blend.ts's
// metaAugmentClause).
export interface MetaContext {
  compStanding?: { avgPlacement: number; samples: number };
  missedChampion?: { name: string; avgPlacement: number; offeredCount: number };
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
  // Distinct what_happened lines across every note in this category (not just
  // the one most-severe note `action`/`why` are drawn from), deduplicated and
  // capped — so a category with several different underlying issues (e.g.
  // two separate missed-interest gaps and a rolldown-timing miss, all under
  // "economy") shows its real scope instead of reading as one repeated note.
  // Omitted when there's only the one note `action`/`why` already covers.
  patterns?: string[];
}

export interface CoachingReport {
  overall_placement: number;
  // null when the recording is too incomplete to grade the match (see
  // src/coach/coverage.ts). Reports saved before that check always carry one.
  overall_grade: Grade | null;
  // Per-category grade, computed from ALL decision points the rule engine
  // found in that category for the full match — not just the ones that
  // survived truncation into `notes` below. See src/coach/scoring.ts.
  // A category is absent when this match gave it nothing to judge: no note
  // there is not the same as a clean game there.
  category_grades: Partial<Record<DecisionCategory, Grade>>;
  ungraded_reasons?: Partial<Record<DecisionCategory, 'no-data' | 'unvalidated'>>;
  // Plain-language list of what the recording missed, shown above the grades.
  // Absent when the match was fully captured.
  capture_notes?: string[];
  tldr: string;
  priority_fix?: PriorityFix;
  // Notes from rules with a measured link to placement (see NoteEvidence).
  // On a report generated before the rule audit, every note.
  notes: CoachingNote[];
  // Everything else the rule engine flagged — shown collapsed, never feeds
  // the priority fix or the tldr. Absent on pre-audit reports.
  other_notes?: CoachingNote[];
  // Always-on rules, one summary line each, in place of their notes.
  common_patterns?: string[];
  strengths: string[];
  round_trajectory?: RoundTrajectoryPoint[];
  plan: MatchPlan;
}

// ─── Match brief (compact report input) ─────────────────────────────────────

export interface MatchBrief {
  placement: number;
  setId: string;
  roundTrajectory: RoundTrajectoryPoint[];
  finalComp: Array<{ name: string; stars: number; items: string[] }>;
  augments: string[];
  godPicks: Array<{ round: string; god: string }>;
  plan: MatchPlan;
  // Notes already narrated by the rule engine.
  resolvedNotes: CoachingNote[];
  // Decision points that still need report prose.
  decisionPoints: DecisionPoint[];
  // One line per always-on rule (fires in nearly every audited match): shown
  // instead of its notes. Absent on briefs built before the split.
  commonPatterns?: string[];
  // Every category any rule flagged this match, including always-on and
  // still-hidden candidate rules that leave no note. Absent on older briefs.
  flaggedCategories?: DecisionCategory[];
  // Grades computed from the full, pre-truncation decision-point list (see
  // rule-engine.ts) — deliberately independent of what made it into
  // resolvedNotes/decisionPoints after the MAX_POINTS/MAX_PER_RULE cuts.
  // Same null/absent meaning as CoachingReport's.
  overallGrade: Grade | null;
  categoryGrades: Partial<Record<DecisionCategory, Grade>>;
  // Why a category has no letter: this match did not record enough to judge
  // it ('no-data'), or its letter has not been shown to track results
  // ('unvalidated', see rules-loader.ts categoryGradeValidated).
  ungradedReasons?: Partial<Record<DecisionCategory, 'no-data' | 'unvalidated'>>;
  captureNotes?: string[];
}

// ─── App status ──────────────────────────────────────────────────────────────

export type AppStatus =
  | 'no_game'   // not in a TFT match
  | 'in_match'; // TFT match in progress

// ─── Player Trends (cross-match, set-invariant behavioral profile) ──────────
// A Challenger player transfers skill to a new set in days because econ
// rules, interest breakpoints, streak management, roll-down timing,
// HP-as-a-resource, item slamming, and tempo never change — only the
// vocabulary (units/traits/augments) does. FeatureVector is exactly that
// invariant layer, numeric-only, derivable entirely from RoundSnapshot[] plus
// the already-computed DecisionPoint[]/MatchPlan/MatchContext for one match.
// MatchLabels is the vocabulary layer, kept structurally separate: it's used
// for narrative grouping only ("this pattern shows up in your reroll games")
// and is NEVER fed into ridge regression or k-means as a feature, so a new
// set changeover invalidates only the labels, never the trained model's
// input schema. See src/profile/ for extraction + the model itself.

export interface FeatureVector {
  schemaVersion: 1; // bump on any field add/remove/rename — src/profile/trend-model.ts skips mismatched records rather than misaligning columns

  // Econ curve shape
  econBankingPhaseRatio: number;       // 0-1, fraction of rounds classified 'banking' (see plan-builder.ts's roundMode)
  econPhaseSwitchCount: number;        // banking<->spending transitions across the match
  interestMissedRoundCount: number;    // rounds ending 1-3g short of a 10g interest tier (ECON_001's condition, counted not just fired)
  overcapRoundCount: number;           // rounds sitting >=54g with no roll/XP spend (ECON_002's per-round condition)
  preStage3RollGold: number;           // total gold spent rolling before stage 3 (ECON_003's metric)

  // Roll timing
  rolldownLatencyRounds: number | null;    // rounds between first HP-crisis round and the first roll response after it; null = no crisis this match
  postStabilizationOverrollGold: number;   // ROLL_003's totalWaste when it fired, else 0
  level6RollDuringLossStreakGold: number;  // sum of ROLL_004's goldRolled across all firings, else 0

  // Streak
  maxWinStreak: number;
  maxLossStreak: number;
  streakBreakCount: number;            // count of STREAK_001 firings (win streak of 3+ broken)
  streakConversionRate: number;        // 0-1: (win-streak episodes reaching 3+) / (episodes reaching 2+); 0 when no episode reached 2+

  // Leveling curve vs. the existing level-8-by-4-2 / level-9-by-5-2 benchmarks
  level8DeltaRounds: number | null;    // signed roundToNumber delta, negative = ahead of 4-2; null if level 8 never reached
  level9DeltaRounds: number | null;    // same, vs 5-2; null if level 9 never reached

  // Item-slam timing
  componentHoldRoundRatio: number;         // 0-1: stage>=2 rounds holding 2+ unbuilt components (ITEM_001's condition)
  componentConversionsMissedCount: number; // count of ITEM_005 firings
  carryItemCountAt41: number;              // completed items on the identified carry at round 4-1; 0 if that round doesn't exist

  // Positioning-adjustment
  positioningNoAdjustStreakAvg: number;    // avg consecutive-fight run length of "same opponent carry, same hex" (POSITION_001's ground truth)
  noFrontlineRoundRatio: number;           // 0-1: stage>=4 PVP rounds with nobody in the front two rows

  // Combat damage-share consistency (real battle_stats, not a proxy)
  carryDamageLeadRate: number | null;      // 0-1: qualifying stage>=4 rounds (carry has 2+ completed items) where the carry led own-team damage; null if no qualifying rounds
  avgCarryDamageShareOfTeam: number | null; // avg carryDamage / teamDamage over the same qualifying rounds; null if none

  // HP trajectory shape
  hpCrisisRoundRatio: number;          // 0-1: match.rounds in context.hpCrisisRounds
  hpAtStage3Entry: number | null;      // health at round 3-1; null if absent
  hpAtStage4Entry: number | null;      // health at round 4-1; null if absent
  hpAtStage5Entry: number | null;      // health at round 5-1; null if absent
  hpRecoverySlope: number | null;      // avg HP delta/round from the first crisis round to recovery (health>=40) or match end; null if no crisis

  // Set-invariant situational signals — mechanics/tempo classifications, not vocabulary
  isRerollComp: 0 | 1;
  isFastTempo: 0 | 1;
  isSlowRoll: 0 | 1;

  totalRounds: number;
}

// Set-specific vocabulary — narrative annotation only, never a model input.
export interface MatchLabels {
  setId: string;
  matchedCompId?: string;
  finalTraits: string[];
  augmentsPicked: string[];
  econStyle: EconStyle;
}

export interface FeatureCorrelation {
  feature: keyof FeatureVector;
  r: number;               // Pearson correlation vs. placement (lower placement = better, so a positive r means higher feature value correlates with WORSE placement)
  meaningfulAtN: boolean;   // |r| > 2/sqrt(n) — an honest "not indistinguishable from noise at this n" flag, not a real significance test
}

export interface RegressionResult {
  coefficients: Partial<Record<keyof FeatureVector, number>>; // standardized-units (z-scored inputs), so magnitudes are comparable across features
  rSquared: number;
  sampleSize: number;
  sufficientData: boolean; // n >= 3x feature count; when false the UI must present this as exploratory only
}

export interface PlayStyleCluster {
  clusterId: number;
  matchIds: string[];
  size: number;
  avgPlacement: number;
  centroid: Partial<Record<keyof FeatureVector, number>>; // in original units, for a readable summary
  dominantLabels: string[]; // most common MatchLabels values (finalTraits/econStyle) across member matches — narrative only, never fed back into the model
}

export interface PlayerProfile {
  computedAt: number;
  sampleSize: number;
  // Deliberately never claims more than 'moderate' at this project's realistic
  // scale (single user, n in the tens to low hundreds) — see trend-model.ts.
  confidence: 'insufficient_data' | 'exploratory' | 'moderate';
  correlations: FeatureCorrelation[];
  regression?: RegressionResult;  // absent entirely below the sufficiency bar, not shown-with-caveat
  clusters: PlayStyleCluster[];   // clusters below the minimum size are dropped, not padded
  // Records skipped because their featureVector.schemaVersion didn't match
  // the current schema — surfaced so the UI can say "N older matches need
  // reprocessing" instead of silently training on a shrinking, unexplained set.
  skippedStaleSchemaCount: number;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

// Deliberately does NOT include the raw ledger (LedgerEntry[]) — it used to,
// and a full match's ledger can be 1-3MB+ of JSON. Duplicating that into every
// localStorage-persisted record (on top of the .jsonl file already on disk,
// keyed by pseudoMatchId — see src/ledger/ledger.ts) was enough to exhaust
// localStorage's ~5-10MB quota after only a handful of matches, silently
// failing saveMatch. The ledger file on disk is the single source of truth
// (architectural invariant #1 in design/01-architecture-overview.md); anything
// needing raw ledger data (Riot cross-check reconciliation, the
// __debugReprocessMatch/__debugRecoverMatch dev helpers) reads it fresh via
// readLedger(pseudoMatchId) instead of expecting it here.
export interface MatchRecord {
  pseudoMatchId: string;
  datePlayed: number;
  setId: string;
  placement: number;
  // Absent on records saved before provenance was tracked.
  placementSource?: PlacementSource;
  lastRound: string;
  brief?: MatchBrief;
  coachingReport?: CoachingReport;
  // Set-invariant behavioral stats + set-specific vocabulary for this match —
  // see the "Player Trends" section above. Additive/optional so this stays
  // the single source of truth for match history (no second store): older
  // records simply lack these fields until reprocessed.
  featureVector?: FeatureVector;
  matchLabels?: MatchLabels;
}

// ─── Aggregate meta table ────────────────────────────────────────────────────
// Crowd stats across many high-elo players, read from localStorage
// (src/persistence/meta-cache.ts). Nothing produces it any more: the in-app
// crawler that filled it from Riot's API was removed with Riot sign-in on
// 2026-11-09, so every consumer sees it absent ("no meta context").

export interface AggregateStatBucket {
  samples: number;
  avgPlacement: number;
  top4Rate: number;
}

export interface AggregateMetaTable {
  champions: Record<string, AggregateStatBucket>;    // champion id -> stats across harvested final boards
  traitCombos: Record<string, AggregateStatBucket>;  // sorted-trait-key (see match-context.ts's computeActiveTraitSet) -> stats
  augments: Record<string, AggregateStatBucket>;      // augment id -> stats
  computedAt: number;
  matchSampleCount: number; // unique matches harvested (participants counted separately per bucket)
}

export interface MatchSummary {
  pseudo_match_id: string;
  date_played: number;
  placement: number;
  last_round: string;
}

// ─── Meta data (from data/sets/setN/*.json) ───────────────────────────────────

export interface AugmentEffect {
  /** Evidence phrase for a gold/XP grant, e.g. "gold" or "XP". */
  economy?: string;
  /** Evidence phrase for an item grant, e.g. "Gain a random Tank item". */
  items?: string;
  /** A Realm of the Gods blessing, not a regular augment. */
  godAugment?: true;
}

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
  // GEP's id for an item Riot has since renamed -> the real catalogue id
  // (data/core/item-aliases.json). GEP names some items after their CURRENT
  // display name while Community Dragon keeps the original apiName, so those
  // ids exist in no catalogue at all and can only be joined through the name.
  // Optional: a stale data/ folder without the file still loads, it just
  // resolves fewer ids. See meta-lookup.ts's resolveItemId.
  itemAliases?: Record<string, string>;
  // Augment ids grouped by category (data/sets/set{N}/augments.json).
  augments: Record<string, string[]>;
  // Core, auto-fetched augment id -> friendly display name (data/core/augment-names.json).
  augmentNames: Record<string, string>;
  // Augment picks that override another checker's rule path (data/sets/set{N}/augment-modifiers.json).
  augmentModifiers: AugmentModifiers;
  // Curated comp archetypes for this set (data/sets/set{N}/comps.json).
  comps: CompArchetype[];
  // augment id -> local champion id, for augments.json's 'units' bucket
  // entries where the granted champion could be resolved from real Data
  // Dragon augment description text (data/sets/set{N}/augment-unit-grants.json,
  // auto-fetched — see scripts/fetch-ddragon.js). Optional: absent on any
  // MetaData built without it (older data, or a test literal) should be
  // treated as "no grants known," not a crash.
  augmentUnitGrants?: Record<string, string>;
  // Facts derived from real Data Dragon augment description text
  // (data/sets/set{N}/augment-effects.json, generated by
  // scripts/derive-augment-effects.js). Each flag carries the phrase that
  // justified it so an entry can be audited rather than trusted.
  //
  // These are a FALLBACK, not a replacement: augments.json's hand-curated
  // buckets are checked first and always win. The derivation exists because
  // curation only covers what someone got around to — 10 of 22 augment ids
  // picked across tests/goldens/ had no bucket at all.
  //
  // `godAugment` marks Set 17's Realm of the Gods blessings, which arrive on
  // the same picked_augment feed but are judged by checkers/set17.ts from the
  // match_info god_* fields instead. The augment rules skip them rather than
  // counting them as coverage gaps.
  //
  // Optional: absent on any MetaData built without it (older data, or a test
  // literal) means "nothing derived", not a crash.
  augmentEffects?: Record<string, AugmentEffect>;
  // True when data/sets/<setId>/ does not exist (e.g. set18 before its folder
  // is curated): every set-specific table above is empty, and the rule engine
  // runs only its set-agnostic checkers. See meta-lookup.ts's loadMeta.
  setDataMissing?: boolean;
  // Crowd meta data from localStorage (src/persistence/meta-cache.ts). No
  // longer produced by anything (see "Aggregate meta table" above), so it is
  // absent; every consumer must treat that as "no meta data known yet," not a
  // crash. See MetaContext's doc comment for how this is used.
  metaTierTable?: AggregateMetaTable;
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
  // The whole-match synthesis (see plan-builder.ts) — optional and NOT set by
  // buildMatchContext() itself (match-context.ts can't import plan-builder.ts,
  // which already imports match-context.ts). rule-engine.ts computes it once
  // and attaches it before passing context to checkers, so any checker that
  // already accepts MatchContext can read context.plan without a new
  // parameter. Undefined in NEUTRAL_CONTEXT and in any test that builds a
  // MatchContext literal without it — callers must treat it as optional.
  plan?: MatchPlan;
}
