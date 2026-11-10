// Round label detection and snapshot reconstruction from the ledger.
//
// KNOWN BUG: Stage 5-7 sometimes skips match_info events (Overwolf open issue).
// Fallback: the stage from the latest match_info.round_type (labelForRoundStart).

import type { LedgerEntry, RoundSnapshot, RoundType, MatchSnapshot, BoardState, PlayerState, BattleStats, CombatUnitStats, LobbyPlayerState, PlacementSource, ItemOffer } from '../shared/types';
import { safeParseGep } from '../capture/safe-parse';
import { normalizeBoardSnapshot, boardChampionIds } from './merge';
import { findFinalPlacement } from './placement';
import { setIdFromChampionId, UNKNOWN_SET_ID } from '../shared/set-id';

// One bench_items element -> one id string per physical item held. Set 17
// sends bare id strings, repeating an id once per copy held. Set 18 sends one
// object per stack instead — { name: "DA_Component_BFSword", count: 2 },
// confirmed across two real Set 18 ledgers (every element of every snapshot;
// components reach count 3, consumable charges 9) — and calling string
// methods on those objects is what crashed every Set 18 report. Expanded by
// count into Set 17's shape because every consumer counts entries (e.g.
// checkers/items.ts's held-components total).
export function benchItemIds(raw: unknown): string[] {
  if (typeof raw === 'string') return raw ? [raw] : [];
  const { name, count } = (raw ?? {}) as { name?: unknown; count?: unknown };
  if (typeof name !== 'string' || !name) return [];
  const copies = count === undefined ? 1 : Math.floor(Number(count));
  return Number.isFinite(copies) && copies > 0 ? Array(copies).fill(name) : [];
}

// Whether a me.picked_augment slot holds a real augment. slot_1..slot_3 are
// the three augment picks in every set, and that is the marker that survives
// a set change: Set <= 17 ids also say so themselves (TFT_Augment_*,
// TFT9_Augment_*) but Set 18's do not (DA_Kingslayer, DA_BonusGift,
// DA_18_RiftbeastTraitAugment), so the old `_Augment_` test dropped every
// Set 18 augment. slot_4 holds the set-mechanic reward instead
// (TFT17_ChampionItem_Chosen_Kindred, TFT17_GravesTrait_...), and is "" in
// both recorded Set 18 ledgers. An `_Augment_` id is still accepted in any
// slot, so nothing the old filter kept is lost.
function isAugmentPick(slot: string, id: unknown): id is string {
  if (typeof id !== 'string' || !id) return false;
  return /^slot_[1-3]$/.test(slot) || id.includes('_Augment_');
}

// battle_stats groups units by an internal numeric "team" id, not by
// "me"/"opponent" — and the opponent's id changes every round (a new
// opponent) while PVE encounters use their own special ids (e.g. 38 for
// Krugs). The only reliable way to tell which side is "me" is to match
// champion names against the board we're already tracking live — the team
// entry with more overlap against our own board is ours.
function splitBattleStatsBySide(
  raw: unknown,
  ownBoard: BoardState
): BattleStats | undefined {
  const teams = safeParseGep(raw, []) as Array<{ team: number; units?: Array<Record<string, unknown>> }>;
  if (!Array.isArray(teams) || teams.length < 2) return undefined;

  const ownNames = new Set(boardChampionIds(ownBoard));
  const toStats = (units: Array<Record<string, unknown>> | undefined): CombatUnitStats[] =>
    (units ?? []).map(u => ({
      name:         String(u.name ?? ''),
      totalDamage:  Number(u.total_dmg ?? 0),
      totalBlocked: Number(u.total_blocked ?? 0),
      healed:       Number(u.healed ?? 0),
      shielded:     Number(u.shielded ?? 0),
    }));

  const overlap = (units: Array<Record<string, unknown>> | undefined) =>
    (units ?? []).filter(u => ownNames.has(String(u.name ?? ''))).length;

  const [a, b] = teams;
  const aIsOwn = overlap(a.units) >= overlap(b.units);
  return {
    own:      toStats(aIsOwn ? a.units : b.units),
    opponent: toStats(aIsOwn ? b.units : a.units),
  };
}

// Sortable key for a "3-2"-style round label — higher stage/round sorts higher.
function roundSortKey(label: string): number {
  const [stage, round] = label.split('-').map(Number);
  return (stage || 0) * 100 + (round || 0);
}

// GEP sends a round's match_info.round_type in the same tick as its
// round_start, but in either order: across 2,477 recorded round starts it came
// just before in 1,986 and just AFTER in 486. Reading only backwards gave
// those 486 rounds the previous round's label whenever their round_end never
// arrived (the close is then synthesized from the start label) — 78 duplicate
// labels in 81 matches, and checkpoint rounds like 3-2 or 4-1 missing, which
// every fixed-checkpoint rule reads. Look ahead within the tick first.
const SAME_TICK_MS = 100;

// A gold drop and the shop update for the same purchase arrive within this of
// each other.
const PURCHASE_MATCH_MS = 300;

//
// The look-ahead stops at the round's own round_end — except one round_end in
// the same tick when this start had to close a still-open round, because that
// one is the previous round's end arriving late (see the round_end handler).
export function labelForRoundStart(
  entries: LedgerEntry[], startIndex: number, fallback: string, previousStillOpen: boolean,
): string {
  const startTs = entries[startIndex].ts;
  let lateEndAllowed = previousStillOpen;
  for (let i = startIndex + 1; i < entries.length && entries[i].ts - startTs <= SAME_TICK_MS; i++) {
    const e = entries[i];
    if (e.kind === 'event' && e.name === 'round_start') break;
    if (e.kind === 'event' && e.name === 'round_end') {
      if (!lateEndAllowed) break;
      lateEndAllowed = false;
    }
    if (e.kind === 'info' && e.feature === 'match_info' && e.key === 'round_type') {
      const stage = (e.value as { stage?: string })?.stage;
      if (stage) return stage;
    }
  }
  return fallback;
}

// Reconstruct per-round snapshots by replaying all ledger entries in order.
export function reconstructSnapshots(entries: LedgerEntry[]): MatchSnapshot {
  console.log('[rounds] reconstructing from', entries.length, 'ledger entries');
  // Running state — mutated as we walk the ledger.
  let pseudoMatchId = '';
  let setId = UNKNOWN_SET_ID;
  let gameMode: 'tft' | 'lol' | 'unknown' = 'unknown';

  let board:         BoardState = {};
  let bench:         BoardState = {};
  let opponentBoard: BoardState = {};
  // opponentBoard carries over between rounds (the guard below keeps the last
  // non-empty one), so whether GEP sent it during this round is tracked apart.
  let opponentBoardThisRound = false;
  let shop:          string[]   = [];

  let gold    = 0;
  let health  = 100;
  let level   = 1;

  // Which of the defaults above the ledger ever overwrote — see
  // CaptureCoverage in shared/types.ts. sawMeXp also decides whether the
  // roster's level may stand in for me.xp (it only does when me.xp is silent).
  let goldSeen = false, healthSeen = false, levelSeen = false, sawMeXp = false;
  let boardSeen = false, shopSeen = false;
  // The local player is out: HP at or below 0, or GEP's match_end. GEP keeps
  // sending round_start/round_end while you spectate the rest of the lobby,
  // and before this every one became a "round" of yours with an empty board.
  //
  // Only this match's HP counts. When coachv attaches, GEP replays the last
  // values it holds, which can be the previous game's end (me.health 0, rank
  // 7): a 6th place on 2026-11-09 had every one of its 28 rounds dropped as
  // spectating because of them. HP never comes back from 0 within a match, so
  // match_start, or a positive HP before this match's first round, clears the
  // flag. A recording that starts after the player went out keeps HP at or
  // below 0 and stays out.
  let localOut = false;
  let spectatorRoundsDropped = 0;

  let prevGold  = 0;
  let prevShop: string[] = [];
  let rollsThisRound     = 0;
  // Times this round when gold fell by exactly 4 with no shop purchase beside
  // it — XP bought. A 4-gold unit bought from the shop drops gold by the same
  // amount: 689 of 2,948 such drops in the recorded corpus landed within 300ms
  // of a shop slot turning "Sold", and every one used to count as buying XP.
  let xpBuyTimes: number[] = [];
  let soldInShop = 0;
  let lastShopPurchaseTs = -Infinity;
  let lastRoundOutcome: 'win' | 'loss' | undefined;
  let lastBattleStats: BattleStats | undefined;
  // Fallback own-side damage, accumulated from match_info.local_player_damage.
  // See the local_player_damage handler below for why this exists at all.
  let bestLocalDamage: CombatUnitStats[] | undefined;
  let bestLocalDamageTotal = 0;
  // Whether this match's GEP ever sent the authoritative bench.item_bench
  // feature. When it never does, bench_pieces item slots are used instead —
  // see the bench_pieces handler below.
  let sawItemBench = false;
  // Latest lobby standings from roster.player_status. Persisted across rounds
  // rather than reset per-round: GEP only pushes this when a value changes, so
  // a quiet round would otherwise report an empty lobby.
  let lastLobby: LobbyPlayerState[] | undefined;
  let benchItemsFromPieces: string[] = [];
  let lastOpponentName: string | undefined;

  // Every shop of the round (opening shop plus one per roll) and what was
  // bought from it. prevRawSlots keeps the "Sold" markers the filtered `shop`
  // drops, so a purchase can be named from the slot that just turned "Sold".
  // It carries across rounds on purpose: a buy in the first second of a round
  // closes against the last shop GEP sent, whichever round that was in.
  let shopsSeen: string[][] = [];
  let boughtThisRound: string[] = [];
  let prevRawSlots: Array<string | undefined> = [];
  // Boards looked at between round_start and battle_start. GEP sends
  // board_spectate for the camera too (the fight opponent during the fight,
  // the player's own board after it), so only the planning phase counts, and
  // the player's own name never does.
  let planningPhase = false;
  let scoutedThisRound = new Set<string>();
  let sawSpectate = false;
  let summonerName: string | undefined;
  // Item choices (match_info.item_select) and the pick (picked_item). The
  // pick can land a millisecond after the next round_start, so the last
  // unanswered offer is kept by reference and filled in wherever it arrives.
  let itemOffersThisRound: ItemOffer[] = [];
  let lastUnpickedOffer: ItemOffer | undefined;
  let lastLobbyOutcomes: Record<string, 'win' | 'loss'> | undefined;

  let streakCount = 0;
  let streakType: 'win' | 'loss' | 'none' = 'none';
  let localPlayerName: string | undefined;

  // Last full snapshot of match_stats.board_players (stage -> per-player
  // {board, bench} arrays, item_1/2/3 included) — a separate GEP source from
  // board_pieces, used as a finalBoard fallback below (see block after the
  // main loop).
  let lastMatchStatsBoardPlayersRaw: unknown;

  let augments: string[]     = [];
  const augmentSlots: Record<string, string> = {};
  let benchItems: string[]   = [];
  let roundStartTs:  number  = 0;
  let roundType: RoundType = 'unknown';
  // Set 17 only — Realm of the Gods, which replaced the carousel for that one
  // set. Set 18 brought the carousel back: X-4 arrives as round_type
  // { type: "Carousel" } with a normal round_start, and no god_* field is
  // ever sent, so none of the state below is touched. Set 17 behaviour,
  // confirmed via a real ledger (tests/goldens/2026-07-03-rank-5.jsonl):
  //  - match_info.god_names fires ONCE for the whole match — the two candidate
  //    gods never change — with match_info.god_picked_favor telling us which
  //    SIDE ("favor_left"/"favor_right") is currently picked, resolved against
  //    the most recent god_names array.
  //  - GEP only pushes an info update when the VALUE CHANGES. Picking the SAME
  //    god again at a later Realm-of-Gods round (the alignment strategy) does
  //    NOT re-fire god_picked_favor, so neither of these can be reset per-round
  //    — they must persist as "the currently resolved pick" across rounds.
  //  - There is no "realm_of_gods" feature and round_start events never report
  //    type "realm_of_the_gods" (only "PVP"/"PVE") — the real marker is
  //    match_info.round_type.native_name === "CarouselMarket" at stage X-4.
  //  - round_start/round_end EVENTS skip CarouselMarket rounds entirely (no
  //    start/end pair fires for them at all — confirmed missing from the real
  //    ledger's event stream), so god picks can't be recorded at round_end like
  //    everything else. The match_info.round_type INFO stream is complete and
  //    strictly ordered, so picks are recorded off of ITS transitions instead:
  //    entering a CarouselMarket stage arms `pendingGodRoundStage`; the next
  //    round_type transition (i.e. we've left it) flushes the pick that
  //    resolved sometime during that round.
  let currentGodNames: string[] | undefined;
  let currentGodChosen: string | undefined;
  let currentGodHpCost: number | undefined;
  let pendingGodRoundStage: string | undefined;
  const godPicks: Array<{ round: string; god: string }> = [];

  const rounds:        RoundSnapshot[] = [];
  let   goldAtRoundStart = 0;
  let   currentRoundLabel = '1-1';
  let   roundStartLabel   = '1-1';

  let roundStartCount    = 0;
  let roundEndCount      = 0;
  let synthesizedCount   = 0;
  // The latest round_start closed a round whose round_end had not come yet —
  // see the round_end handler for the late end this anticipates.
  let closedPreviousAtStart = false;

  // GEP frequently skips round_end for ordinary rounds — not just the known
  // CarouselMarket/god-round quirk. Confirmed across two real matches: ~25-30%
  // of round_start events never get a matching round_end before the next
  // round_start fires. Without this, that round's data (HP/gold/board as of
  // its end, plus rollsThisRound/xpBuyTimes accumulated during it) is
  // silently discarded the moment the next round_start resets those counters
  // — a real, permanent loss of what the player did that round, not just a
  // missing label. The running state (health/gold/board/etc.) at the moment
  // we detect the next round_start already reflects "as of the end of the
  // round that never closed," so we can synthesize an accurate close using
  // the label/type captured when that round itself started.
  // Own-side-only BattleStats synthesized from local_player_damage, used when
  // this match's GEP never sent a real battle_stats payload. Returns undefined
  // rather than an empty shell when no damage was recorded, so consumers'
  // existing `!round.battleStats?.own?.length` guards behave exactly as before.
  function localDamageAsBattleStats(): BattleStats | undefined {
    if (!bestLocalDamage?.length) return undefined;
    return { own: bestLocalDamage, opponent: [] };
  }

  function pushRoundSnapshot(label: string, type: typeof roundType) {
    const interest = Math.min(5, Math.floor(gold / 10));
    // GEP sends no round_outcome for some fights (a 6th place's 3-1 among
    // them, which left its 3-loss streak reading as 2). A won fight never
    // costs HP, so a PvP round that closes with no outcome reads as lost when
    // HP fell and won when it held, and the streak follows it.
    if (type === 'PVP' && lastRoundOutcome === undefined && healthSeen) {
      const before = rounds.length > 0 ? rounds[rounds.length - 1].health : 100;
      const inferred: 'win' | 'loss' = health < before ? 'loss' : 'win';
      lastRoundOutcome = inferred;
      if (streakType === inferred) streakCount++;
      else { streakType = inferred; streakCount = 1; }
    }
    rounds.push({
      label,
      type,
      // This round's own win/loss, from the round_outcome event that fired
      // during it (see round_outcome handling below). Was previously always
      // hardcoded undefined — the comment claiming it got "filled in" was
      // aspirational, nothing ever wrote back to a pushed round's `outcome`.
      // That silently disabled STREAK_001/STREAK_002, which both gate on
      // `round.outcome`. Reset after every push so a round with no combat
      // (e.g. an augment-pick round) doesn't inherit the previous round's
      // outcome.
      outcome:        lastRoundOutcome,
      goldStart:      goldAtRoundStart,
      goldEnd:        gold,
      health,
      level,
      rollsSpent:     rollsThisRound,
      xpBought:       xpBuyTimes.length > 0,
      board:          { ...board },
      bench:          { ...bench },
      benchItems:     [...benchItems],
      shop:           [...shop],
      augmentsPicked:     [...augments],
      opponentBoard:      { ...opponentBoard },
      opponentBoardFresh: opponentBoardThisRound,
      interestEarned:     interest,
      streakCount,
      streakType,
      godChosen:          currentGodChosen,
      godOfferingHpCost:  currentGodHpCost,
      battleStats:        lastBattleStats ?? localDamageAsBattleStats(),
      opponentName:       lastOpponentName,
      lobby:              lastLobby ? [...lastLobby] : undefined,
      shopsSeen:          shopsSeen.map(s => [...s]),
      bought:             [...boughtThisRound],
      ...(sawSpectate ? { scouted: [...scoutedThisRound] } : {}),
      ...(itemOffersThisRound.length > 0 ? { itemOffers: [...itemOffersThisRound] } : {}),
      ...(lastLobbyOutcomes ? { lobbyOutcomes: { ...lastLobbyOutcomes } } : {}),
    });
    lastRoundOutcome = undefined;
    lastBattleStats  = undefined;
    lastOpponentName = undefined;
    opponentBoardThisRound = false;
    bestLocalDamage      = undefined;
    bestLocalDamageTotal = 0;
    // Reset here rather than at round_start: the next round's opening shop
    // can arrive before its round_start event and belongs to that round.
    shopsSeen = [];
    boughtThisRound = [];
    scoutedThisRound = new Set();
    itemOffersThisRound = [];
    lastLobbyOutcomes = undefined;
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];

    if (e.kind === 'info') {
      const { feature, key, value } = e;

      if (feature === 'match_info') {
        if (key === 'pseudo_match_id') pseudoMatchId = value as string;
        // Every recorded ledger sends "TFT" in capitals; the old exact
        // 'tft' match labelled every real match 'lol'.
        if (key === 'game_mode')       gameMode = String(value).toLowerCase() === 'tft' ? 'tft' : 'lol';

        if (key === 'round_type') {
          const rt = value as { stage?: string; type?: string; native_name?: string };
          if (rt.stage) currentRoundLabel = rt.stage;

          if (rt.native_name === 'CarouselMarket') {
            pendingGodRoundStage = rt.stage;
          } else if (pendingGodRoundStage && currentGodChosen) {
            godPicks.push({ round: pendingGodRoundStage, god: currentGodChosen });
            pendingGodRoundStage = undefined;
          }
        }

        if (key === 'round_outcome') {
          // Confirmed via a real ledger: round_outcome is { playerName: { outcome, tag_line } }
          // keyed by EVERY player in the lobby, not just "me" — and the real
          // outcome strings are "victory"/"defeat", not "win"/"loss" as
          // previously assumed. Two bugs, both silent: (1) checking for
          // 'win'/'loss' never matched 'victory'/'defeat', so streak was reset
          // to 0 on every single round_outcome event, every match; (2) reading
          // Object.values(value)[0] grabbed whichever player happens to be
          // first in the object — not necessarily the local player — so even
          // after fixing the string mismatch, the streak would often track a
          // random opponent's win/loss instead of the local player's. Fixed by
          // looking up the entry by localPlayerName (resolved from
          // roster.player_status's `localplayer: true` flag, which fires
          // early and often — see below).
          // Real TFT rule: only PvP fights extend or break a streak — PvE
          // (creep) rounds are neutral and shouldn't touch it. But GEP fires
          // round_outcome for creep rounds too (you always "win" against
          // krugs/wolves/minions), and this handler used to apply that
          // unconditionally — a real match showed the effect directly: a PvP
          // loss streak (loss:1 at 2-2/2-3) got overwritten to win:1 by the
          // very next round_outcome, which landed on 2-4's PVE creep round,
          // and a PVP win:2 streak (2-6) got knocked back down to win:1 by
          // 2-7's PVE round instead of continuing to 3. Gated on roundType so
          // creep-round outcomes no longer touch the real PvP streak.
          if (roundType === 'PVP') {
            const players = value as Record<string, { outcome?: string } | string>;
            const readOutcome = (raw: { outcome?: string } | string | undefined): 'win' | 'loss' | undefined => {
              const normalized = (typeof raw === 'string' ? raw : (raw?.outcome ?? '')).toLowerCase();
              return normalized === 'victory' ? 'win'
                   : normalized === 'defeat'  ? 'loss'
                   : normalized === 'win' || normalized === 'loss' ? normalized
                   : undefined;
            };
            // The same payload names every player's result: who won and who
            // lost across the lobby this round (src/coach/lobby-map.ts).
            const all: Record<string, 'win' | 'loss'> = {};
            for (const [name, raw] of Object.entries(players ?? {})) {
              const o = readOutcome(raw);
              if (name && o) all[name] = o;
            }
            if (Object.keys(all).length > 0) lastLobbyOutcomes = all;

            const mine = localPlayerName ? players[localPlayerName] : undefined;
            const outcome = readOutcome(mine);

            lastRoundOutcome = outcome;

            if (outcome) {
              if (streakType === outcome) {
                streakCount++;
              } else {
                streakType = outcome;
                streakCount = 1;
              }
            } else {
              streakType = 'none';
              streakCount = 0;
            }
          }
        }

        // Real per-unit damage/blocked/healed/shielded for the fight that just
        // ended — fires right after battle_end, well within the same round
        // window (confirmed via real ledger timestamps, unlike augment picks'
        // multi-round lag). Captured continuously like gold/health and
        // attached to whichever round closes next.
        if (key === 'battle_stats') {
          lastBattleStats = splitBattleStatsBySide(value, board);
        }

        // Real per-unit damage for the local player's own board. This is the
        // feed Set 17's GEP actually sends — battle_stats above does NOT fire
        // for the local player in any of tests/goldens/ (0 occurrences across
        // all six real matches, vs. 17,423 local_player_damage entries), which
        // left RoundSnapshot.battleStats permanently undefined and COMBAT_001
        // unable to fire at all.
        //
        // Shape is { unit_0: { name, damage, level }, ... }, and the values are
        // CUMULATIVE WITHIN ONE FIGHT: verified against real ledgers, every
        // unit resets to 0 when a fight starts and climbs until it ends. So the
        // meaningful figure for a round is the highest-total snapshot seen
        // since the last round closed — taking the merely-latest one would
        // read back 0s from the next fight's reset.
        //
        // Own side only: unlike battle_stats there is no opponent half here, so
        // `opponent` stays empty. positioning.ts reads battleStats.opponent and
        // already handles it being absent — this is strictly more data than
        // before, never less.
        if (key === 'local_player_damage') {
          const raw = safeParseGep(value, {}) as Record<string, { name?: string; damage?: number }>;
          const units: CombatUnitStats[] = Object.values(raw)
            .filter(u => u?.name)
            .map(u => ({
              name:         String(u.name),
              totalDamage:  Number(u.damage ?? 0),
              totalBlocked: 0,
              healed:       0,
              shielded:     0,
            }));
          const total = units.reduce((sum, u) => sum + u.totalDamage, 0);
          if (units.length > 0 && total > bestLocalDamageTotal) {
            bestLocalDamage      = units;
            bestLocalDamageTotal = total;
          }
        }

        // The real display name of this round's opponent — who board/
        // opponentBoard actually belong to right now.
        if (key === 'opponent') {
          const opp = safeParseGep(value, {}) as { name?: string };
          if (opp.name) lastOpponentName = opp.name;
        }

        // The board on screen, by its owner's display name (the same names
        // the roster uses). Sent about once a second while the camera is on
        // a board, the player's own included; see planningPhase.
        if (key === 'board_spectate') {
          sawSpectate = true;
          const name = typeof value === 'string' ? value : '';
          const own = name !== '' && (name === localPlayerName || name === summonerName);
          if (planningPhase && name && !own) scoutedThisRound.add(name);
        }

        // Four items to choose one from (an anvil, a carousel-style pick).
        // The pick arrives as the picked_item event.
        if (key === 'item_select') {
          const slots = safeParseGep(value, {}) as Record<string, { name?: unknown } | undefined>;
          const offered = Object.values(slots)
            .map(s => s?.name)
            .filter((n): n is string => typeof n === 'string' && n !== '');
          if (offered.length > 0) {
            const offer: ItemOffer = { offered };
            itemOffersThisRound.push(offer);
            lastUnpickedOffer = offer;
          }
        }

        // Set 17 only — Realm of Gods. Confirmed via a real recorded match (see
        // src/ledger/diagnostics.ts __debugRawSamples): GEP does NOT expose a
        // "realm_of_gods" feature or a "god_chosen" key. It sends the two
        // offered gods as match_info.god_names (e.g. ["TFT17_God_Thresh",
        // "TFT17_God_Yasuo"]) and the player's pick as match_info.god_picked_favor,
        // which is a SIDE ("favor_left"/"favor_right"), not a god id — resolve it
        // by indexing into the most recent god_names array.
        if (key === 'god_names') {
          currentGodNames = safeParseGep(value, []) as string[];
        }
        if (key === 'god_picked_favor') {
          const side = value as string;
          const idx  = side === 'favor_left' ? 0 : side === 'favor_right' ? 1 : -1;
          const pick = idx >= 0 ? currentGodNames?.[idx] : undefined;
          if (pick) currentGodChosen = pick.replace(/^TFT\d+_God_/, '');
        }
        // TODO: Evelynn's HP-cost offering field is still unconfirmed, but the
        // real payload shape is now known (confirmed via a real Evelynn-offering
        // match, 2026-07-04): match_info.god_favors is an array with ONE entry
        // shaped { favor_left: {name, name_lang, title, title_lang}, favor_right:
        // {...} } — e.g. favor_right: { name: "Evelynn", title:
        // "TFT17_CarouselMarket_BloodPact", title_lang: "Blood Pact" }. There is
        // NO raw numeric HP-cost field anywhere in it — only an internal `title`
        // id (e.g. BloodPact, Sacrifice, or even non-namespaced ids like
        // "AssistGiveGold") plus its display name in `title_lang`. So the HP
        // cost can never be read directly off the payload; it would have to come
        // from a hardcoded title-id -> HP-cost lookup table built from real Set
        // 17 game knowledge (never invent these values), or empirically from the
        // HP delta on a round where the player actually PICKS the Evelynn side —
        // the one real match seen so far picked Yasuo (favor_left) every time,
        // so no such delta has been observed yet. currentGodHpCost stays unset
        // (SET17_002 won't fire) until either source is available.
      }

      // roster.player_status fires ~50x/match, keyed by player name, with an
      // explicit localplayer flag — the only reliable way to know which key
      // in round_outcome's per-player object is "me" (see round_outcome above).
      if (feature === 'roster' && key === 'player_status') {
        const players = value as Record<string, { localplayer?: boolean }>;
        const me = Object.entries(players).find(([, p]) => p?.localplayer === true);
        if (me) localPlayerName = me[0];
      }

      if (feature === 'me') {
        // The local player's own display name, for telling their board from
        // a scouted one before the roster has named them.
        if (key === 'summoner_name' && typeof value === 'string' && value) summonerName = value;
        if (key === 'gold')   { prevGold = gold; gold  = Number(value); goldSeen = true; }
        if (key === 'health') {
          health = Number(value);
          healthSeen = true;
          if (health <= 0) localOut = true;
          else if (roundStartCount === 0) localOut = false;
        }
        // Confirmed via a real ledger: there is no separate "me.level" key —
        // it never fires. Player level lives inside me.xp ({level, current_xp,
        // xp_max}); current_xp/xp_max are broken (always 0, see below) but
        // .level is real and updates correctly. The old "level" branch below
        // was dead code — level silently stayed 1 all game, every game,
        // meaning every LEVEL_* checker had been firing false positives.
        if (key === 'xp') {
          const xp = safeParseGep(value, {}) as { level?: number };
          if (xp.level) {
            level = Number(xp.level);
            levelSeen = sawMeXp = true;
          }
        }
        // Detect XP purchase: gold dropped by 4 with no shop purchase beside
        // it (see xpBuyTimes). me.xp.current_xp is 0 in every Set 17 ledger,
        // so the gold delta is the only signal there.
        if (key === 'gold' && prevGold - gold === 4 && e.ts - lastShopPurchaseTs > PURCHASE_MATCH_MS) {
          xpBuyTimes.push(e.ts);
        }
      }

      if (feature === 'board' && key === 'board_pieces') {
        const update = safeParseGep(value, {}) as Record<string, any>;
        const next   = normalizeBoardSnapshot(update);
        // GEP occasionally sends a transient empty board_pieces update with no
        // purchase/sell event around it (observed in a real match: board went
        // 7 units -> {} -> 7 units again within ~30s, and the empty update
        // landed right at a round_end boundary, capturing a false "0 units"
        // snapshot for that round). A real board never legitimately drops to
        // 0 units once units have been placed — only accept an empty update if
        // the board was already empty, so a glitch can't wipe real state.
        if (Object.keys(next).length > 0 || Object.keys(board).length === 0) {
          board = next;
        }
        if (Object.keys(next).length > 0) boardSeen = true;
        // Detect set from the champion id scheme (see shared/set-id.ts).
        for (const cell of Object.values(update)) {
          const detected = setIdFromChampionId(cell?.name);
          if (detected) setId = detected;
        }
      }

      if (feature === 'board' && key === 'opponent_board_pieces') {
        const update = safeParseGep(value, {}) as Record<string, any>;
        const next   = normalizeBoardSnapshot(update);
        // Same transient-empty-snapshot guard as board_pieces above.
        if (Object.keys(next).length > 0 || Object.keys(opponentBoard).length === 0) {
          opponentBoard = next;
          if (Object.keys(next).length > 0) opponentBoardThisRound = true;
        }
      }

      if (feature === 'bench' && key === 'bench_pieces') {
        bench = normalizeBoardSnapshot(safeParseGep(value, {}) as Record<string, any>);
        // Components already equipped onto bench units. Strictly narrower than
        // item_bench (it cannot see components sitting loose in the item tray),
        // but item_bench fires 0 times across every match in tests/goldens/,
        // which left benchItems permanently empty and ITEM_001/ITEM_004/ITEM_005
        // unable to fire. Recorded separately and only used when item_bench
        // never arrives, so a match that does have the real feature is
        // unaffected.
        benchItemsFromPieces = Object.values(bench)
          .flatMap(cell => [cell?.item_1, cell?.item_2, cell?.item_3])
          .filter((id): id is string => !!id && id !== '0' && !id.includes('_Consumable_'));
        if (!sawItemBench) benchItems = [...benchItemsFromPieces];
      }

      // item_bench is a SEPARATE feature from bench_pieces — an array keyed by
      // player, one entry per lobby member, e.g. [{summoner: "Chibi Jinx",
      // bench_items: [...]}, ...]. Confirmed via real ledger data: other
      // players' entries use their equipped little-legend skin name (GEP
      // anonymizes opponents), but the LOCAL player's own entry is the real
      // Riot ID ("name#tag") — so it's found by prefix-matching localPlayerName
      // (itself resolved from roster.player_status), not by exact key lookup.
      // Filters out consumable tokens (ItemRemover/ItemReroller charges,
      // TFT_Consumable_*) which aren't real components or completed items.
      // Set 18 changed the element shape (see benchItemIds above).
      if (feature === 'bench' && key === 'item_bench') {
        sawItemBench = true;
        const players = safeParseGep(value, []) as Array<{ summoner?: string; bench_items?: unknown }>;
        const mine = localPlayerName
          ? players.find(p => p.summoner?.startsWith(localPlayerName!))
          : undefined;
        const held = Array.isArray(mine?.bench_items) ? mine.bench_items : [];
        benchItems = held.flatMap(benchItemIds).filter(id => !id.includes('_Consumable_'));
      }

      // Public state of all eight players. The only lobby-wide feed this GEP
      // version actually sends (match_stats.board_players, the richer one this
      // file also looks for below, fires 0 times across every match in
      // tests/goldens/). Keyed by display name; opponents show their
      // little-legend skin rather than a Riot ID, so `localplayer` is the only
      // reliable way to find ourselves.
      //
      // `xp` is the player's LEVEL, not experience — verified round-for-round
      // against me.xp.level across all six goldens. Stored as `level`.
      if (feature === 'roster' && key === 'player_status') {
        const roster = safeParseGep(value, {}) as Record<string, { health?: number; xp?: number; localplayer?: boolean; rank?: number }>;
        const players: LobbyPlayerState[] = Object.entries(roster)
          .filter(([name]) => !!name)
          .map(([name, p]) => ({
            name,
            health:  Number(p?.health ?? 0),
            level:   Number(p?.xp ?? 0),
            isLocal: p?.localplayer === true,
            rank:    Number(p?.rank ?? 0) || 0,
          }));
        if (players.length > 0) lastLobby = players;

        // The same verified level, for a match whose me.xp never fires — the
        // case behind a report that called a stage-6 player "level 1". And the
        // local HP, which says whether those rounds are still the player's.
        const me = players.find(p => p.isLocal);
        if (me) {
          if (!sawMeXp && me.level > 0) {
            level = me.level;
            levelSeen = true;
          }
          if (me.health <= 0) localOut = true;
          else if (roundStartCount === 0) localOut = false;
        }
      }

      if (feature === 'match_stats' && key === 'board_players') {
        lastMatchStatsBoardPlayersRaw = value;
      }

      if (feature === 'store' && key === 'shop_pieces') {
        // Confirmed via a real ledger: shop_pieces is an object keyed by slot
        // ("slot_1": {name}, "slot_2": {name}, ...), never a flat array. The
        // old safeParseGep(value, []) call silently discarded every update —
        // an object always fails safeParseGep's array-shape guard and falls
        // back to [] — so `shop` (and therefore roll detection below, which
        // depends on prevShop) had been broken since day one: rollsSpent was
        // stuck at 0 on every round of every match.
        const raw = safeParseGep(value, {}) as Record<string, { name?: string } | undefined>;
        const rawSlots = Object.values(raw);
        const newShop = rawSlots
          .map(slot => slot?.name)
          .filter((name): name is string => !!name && name !== 'Sold');

        // A purchased slot's name becomes the literal string "Sold" and the
        // other slots are untouched. A paid reroll replaces ALL 5 slots with
        // fresh champions — no "Sold" markers at all. Skip the very first
        // shop of a round (prevShop.length === 0, the free round-start
        // refresh) and rounds with no real shop at all (PVE/carousel rounds
        // send an empty {}).
        const hasSlots   = rawSlots.length > 0;
        if (hasSlots) shopSeen = true;
        const isPurchase = rawSlots.some(slot => slot?.name === 'Sold');
        // A newly sold slot is a unit bought: un-count a 4-gold drop it explains
        // (the gold update can land on either side of the shop update).
        const sold = rawSlots.filter(slot => slot?.name === 'Sold').length;
        if (sold > soldInShop) {
          lastShopPurchaseTs = e.ts;
          xpBuyTimes = xpBuyTimes.filter(t => Math.abs(e.ts - t) > PURCHASE_MATCH_MS);
        }
        soldInShop = sold;
        if (hasSlots && prevShop.length > 0 && !isPurchase) {
          rollsThisRound++;
        }
        // The unit bought is whatever the newly "Sold" slot held a moment
        // ago. A slot already "Sold" in the previous update names nothing.
        const names = rawSlots.map(slot => slot?.name);
        if (isPurchase) {
          names.forEach((name, i) => {
            const before = prevRawSlots[i];
            if (name === 'Sold' && before && before !== 'Sold') boughtThisRound.push(before);
          });
        } else if (hasSlots && newShop.length > 0) {
          const last = shopsSeen[shopsSeen.length - 1];
          if (!last || last.length !== newShop.length || last.some((n, i) => n !== newShop[i])) shopsSeen.push(newShop);
        }
        if (hasSlots) prevRawSlots = names;
        prevShop = shop;
        shop = newShop;
      }

      // Confirmed via a real recorded match: GEP sends augment picks as
      // me.picked_augment (a cumulative snapshot object keyed by slot, e.g.
      // { slot_1: {name: "TFT_Augment_..."} , slot_4: {name: "TFT17_ChampionItem_Chosen_Kindred"} }),
      // NOT augments.me as an array. slot_4+ can hold a Set-specific "Chosen"
      // reward rather than a real augment — see isAugmentPick above for how
      // the two are told apart.
      //
      // Confirmed across 22 real ledgers: this event fires only ONCE (rarely
      // twice) for the entire match, and lands AFTER the final round_end —
      // i.e. GEP delivers augment picks in the post-game settlement window,
      // never live during play. Recording only the flat `augments` list here
      // (used for match.augments) is fine for that, but round.augmentsPicked
      // would end up empty for the ENTIRE match if built the same way — see
      // the slot-based backfill after the main loop below, which is what
      // actually populates it correctly.
      if (feature === 'me' && key === 'picked_augment') {
        const slots  = safeParseGep(value, {}) as Record<string, { name?: unknown } | undefined>;
        const picked = Object.entries(slots)
          .filter(([slot, cell]) => isAugmentPick(slot, cell?.name))
          .map(([, cell]) => cell!.name as string);
        augments = [...new Set([...augments, ...picked])];

        for (const [slot, cell] of Object.entries(slots)) {
          if (isAugmentPick(slot, cell?.name)) augmentSlots[slot] = cell!.name as string;
        }
      }
    }

    if (e.kind === 'event') {
      if (e.name === 'match_start') localOut = false;
      if (e.name === 'match_end') localOut = true;
      // Planning ends when the fight starts; scouting after that is the camera.
      if (e.name === 'battle_start') planningPhase = false;
      if (e.name === 'picked_item') {
        const picked = typeof e.data === 'string' ? e.data : '';
        if (picked) {
          if (lastUnpickedOffer) { lastUnpickedOffer.picked = picked; lastUnpickedOffer = undefined; }
          else itemOffersThisRound.push({ offered: [], picked });
        }
      }

      if (e.name === 'round_start' && localOut) {
        // Close the round the player was eliminated in (its round_end often
        // never comes), then record nothing more: from here on it is the rest
        // of the lobby's game.
        if (roundStartTs > 0) {
          pushRoundSnapshot(roundStartLabel, roundType);
          synthesizedCount++;
          roundStartTs = 0;
        }
        spectatorRoundsDropped++;
        continue;
      }

      if (e.name === 'round_start') {
        const data = e.data as { game_stage?: string; type?: string } | string;
        const typeStr = typeof data === 'object' ? (data?.type ?? '') : (data ?? '');
        const newRoundType: RoundType = typeStr === 'PVP' ? 'PVP'
                  : typeStr === 'PVE' ? 'PVE'
                  : typeStr === 'Carousel' ? 'carousel'
                  : 'unknown';

        // Previous round never got a round_end — synthesize its close before
        // resetting state for the new round (see pushRoundSnapshot comment).
        closedPreviousAtStart = roundStartTs > 0;
        if (roundStartTs > 0) {
          pushRoundSnapshot(roundStartLabel, roundType);
          synthesizedCount++;
        }

        roundType          = newRoundType;
        roundStartTs       = e.ts;
        roundStartLabel    = labelForRoundStart(entries, i, currentRoundLabel, closedPreviousAtStart);
        goldAtRoundStart   = gold;
        rollsThisRound     = 0;
        xpBuyTimes         = [];
        prevShop           = [];
        planningPhase      = true;
        currentGodHpCost   = undefined;
        roundStartCount++;
        console.log(`[rounds] round_start #${roundStartCount}: label=${currentRoundLabel} type=${typeStr || '(empty)'}`);
      }

      // A round_end in the same tick as a round_start that had to close the
      // previous round itself is that previous round's end, delivered late
      // (seen as round_start, round_end, round_type all in one millisecond).
      // Closing again would end the new round at once under the old label.
      const lateEndOfPreviousRound = e.name === 'round_end' && closedPreviousAtStart
        && roundStartTs > 0 && e.ts - roundStartTs <= SAME_TICK_MS;
      if (e.name === 'round_end') closedPreviousAtStart = false;
      // Labelled from its own start (labelForRoundStart), not the newest
      // round_type: the NEXT round's round_type can land just before this
      // round's round_end in the same tick, which named 5-1 as "5-2".
      if (e.name === 'round_end' && roundStartTs > 0 && !lateEndOfPreviousRound) {
        pushRoundSnapshot(roundStartLabel, roundType);
        roundStartTs = 0;
        roundEndCount++;
      }
    }
  }

  // Ledger ended while a round was still open (its round_end never fired —
  // e.g. the match itself ended mid-round). Synthesize a final close so the
  // last round the player experienced isn't silently dropped.
  if (roundStartTs > 0) {
    pushRoundSnapshot(roundStartLabel, roundType);
    synthesizedCount++;
  }

  // Flush a still-pending god pick if the ledger ends while the last
  // Realm-of-Gods round was current (no further round_type ever arrived to
  // trigger the transition-based flush above — e.g. match_end cuts the ledger
  // short right after the final CarouselMarket round).
  if (pendingGodRoundStage && currentGodChosen) {
    godPicks.push({ round: pendingGodRoundStage, god: currentGodChosen });
  }

  // Back-fill round.augmentsPicked using TFT's fixed slot->round mapping
  // (slot_1 is always picked at 2-1, slot_2 at 3-2, slot_3 at 4-2) instead of
  // trusting when the picked_augment event happened to arrive in the event
  // stream — see the picked_augment handler above for why that's unreliable.
  // Every round from the pick round onward gets the augment added, exactly
  // as if it had been captured live.
  const AUGMENT_SLOT_ROUNDS: Array<[string, string]> = [
    ['slot_1', '2-1'],
    ['slot_2', '3-2'],
    ['slot_3', '4-2'],
  ];
  for (const [slot, pickRoundLabel] of AUGMENT_SLOT_ROUNDS) {
    const augId = augmentSlots[slot];
    if (!augId) continue;
    const pickKey = roundSortKey(pickRoundLabel);
    for (const round of rounds) {
      if (roundSortKey(round.label) >= pickKey && !round.augmentsPicked.includes(augId)) {
        round.augmentsPicked.push(augId);
      }
    }
  }

  console.log(`[rounds] events counted: round_start=${roundStartCount} round_end=${roundEndCount} synthesized=${synthesizedCount} spectator=${spectatorRoundsDropped} → ${rounds.length} snapshots built`);
  console.log(`[rounds] setId=${setId} gameMode=${gameMode} pseudoMatchId=${pseudoMatchId || '(none)'}`);
  if (rounds.length > 0) {
    console.log(`[rounds] label range: ${rounds[0].label} → ${rounds[rounds.length - 1].label}`);
  } else {
    console.warn('[rounds] no round snapshots built — round_start/round_end events may be missing from ledger');
  }

  const { placement: finalPlacement, source: placementSource } = extractFinalPlacement(entries);
  console.log(`[rounds] finalPlacement=${finalPlacement} (${placementSource}) augments=${augments.length} godPicks=${godPicks.length}`);

  // finalBoard fallback: board_pieces is a live diff stream, and its last
  // update before the ledger ends can predate the player's final item slams
  // if the match/game ended abruptly — confirmed real (MetaTFT's post-game
  // recap showed 4 fully-itemised champions on a match where board_pieces
  // alone produced a finalBoard with 0 completed items, causing AUGMENT_003/
  // 004 to fire a false "augment's payoff went unused" note). match_stats.
  // board_players is a separate, per-stage GEP snapshot (stage -> per-player
  // {board, bench} arrays, item_1/2/3 included) that isn't subject to the
  // same "last live diff before cutoff" risk — used here only when it shows
  // strictly more equipped items than the board_pieces-derived board, so it
  // can only improve accuracy, never regress a case that was already correct.
  let finalBoard = board;
  if (lastMatchStatsBoardPlayersRaw !== undefined && localPlayerName) {
    type StageEntry = {
      stage?: { stage_main?: number; stage_sub?: number };
      board?: Array<{ summoner?: string; board?: Array<Record<string, any>> }>;
    };
    const stages = safeParseGep(lastMatchStatsBoardPlayersRaw, []) as StageEntry[];
    const lastStage = stages.reduce<StageEntry | undefined>((best, s) => {
      if (!best) return s;
      const bestKey = (best.stage?.stage_main ?? 0) * 100 + (best.stage?.stage_sub ?? 0);
      const key     = (s.stage?.stage_main ?? 0) * 100 + (s.stage?.stage_sub ?? 0);
      return key > bestKey ? s : best;
    }, undefined);

    const mine = lastStage?.board?.find(p => p.summoner?.startsWith(localPlayerName!));
    if (mine?.board) {
      const fallbackBoard: BoardState = {};
      for (const unit of mine.board) {
        if (!unit?.cell || !unit?.name) continue;
        fallbackBoard[unit.cell as string] = {
          name:   unit.name,
          level:  Number(unit.level ?? 1),
          item_1: unit.item_1 || '0',
          item_2: unit.item_2 || '0',
          item_3: unit.item_3 || '0',
        };
      }
      const itemCount = (b: BoardState) =>
        Object.values(b).reduce((n, c) => n + [c.item_1, c.item_2, c.item_3].filter(i => i && i !== '0').length, 0);
      if (itemCount(fallbackBoard) > itemCount(finalBoard)) {
        console.warn(`[rounds] finalBoard from live board_pieces had fewer equipped items (${itemCount(finalBoard)}) than match_stats.board_players's last snapshot (${itemCount(fallbackBoard)}) — using the fallback as finalBoard`);
        finalBoard = fallbackBoard;
      }
    }
  }

  return {
    pseudoMatchId,
    setId,
    gameMode,
    rounds,
    finalPlacement,
    placementSource,
    finalBoard,
    augments,
    godPicks,
    capture: {
      firstRound:   rounds[0]?.label,
      lastRound:    rounds.at(-1)?.label,
      missedStart:  rounds.length > 0 && roundSortKey(rounds[0].label) > roundSortKey('2-1'),
      goldSeen,
      healthSeen,
      levelSeen,
      boardSeen,
      shopSeen,
      augmentsSeen: augments.length > 0,
      scoutingSeen: sawSpectate,
      spectatorRoundsDropped,
    },
  };
}

function extractFinalPlacement(entries: LedgerEntry[]): { placement: number; source: PlacementSource } {
  // Source order, and why each is trusted: src/ledger/placement.ts.
  const found = findFinalPlacement(entries);
  if (found?.source === 'rank') {
    console.warn(`[rounds] me.placement missing from ledger — using last live me.rank (${found.placement}) as best-effort final placement`);
  }
  if (found) return found;

  // A placeholder for display, not a result: anything that learns from
  // placements must skip source 'none'.
  console.warn('[rounds] no placement signal in ledger (me.placement, Riot, or me.rank) — placeholder 8th, source none');
  return { placement: 8, source: 'none' };
}
