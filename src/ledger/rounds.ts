// Round label detection and snapshot reconstruction from the ledger.
//
// KNOWN BUG: Stage 5-7 sometimes skips match_info events (Overwolf open issue).
// Fallback: count round_start events since the last Realm of the Gods round to derive the label.

import type { LedgerEntry, RoundSnapshot, MatchSnapshot, BoardState, PlayerState } from '../shared/types';
import { safeParseGep } from '../capture/safe-parse';
import { normalizeBoardSnapshot } from './merge';

// Walk backwards from position `upTo` to find the most recent round_type.stage.
export function detectRoundLabel(entries: LedgerEntry[], upTo: number): string | null {
  for (let i = upTo; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'info' && e.feature === 'match_info' && e.key === 'round_type') {
      const rt = e.value as { stage?: string };
      if (rt.stage) return rt.stage;
    }
  }
  return null;
}

// Reconstruct per-round snapshots by replaying all ledger entries in order.
export function reconstructSnapshots(entries: LedgerEntry[]): MatchSnapshot {
  console.log('[rounds] reconstructing from', entries.length, 'ledger entries');
  // Running state — mutated as we walk the ledger.
  let pseudoMatchId = '';
  let setId = 'set17';
  let gameMode: 'tft' | 'lol' | 'unknown' = 'unknown';

  let board:         BoardState = {};
  let bench:         BoardState = {};
  let opponentBoard: BoardState = {};
  let shop:          string[]   = [];

  let gold    = 0;
  let health  = 100;
  let level   = 1;
  let liveRank: number | undefined;

  let prevGold  = 0;
  let prevShop: string[] = [];
  let rollsThisRound     = 0;
  let xpBoughtThisRound  = false;
  let lastRoundOutcome: 'win' | 'loss' | undefined;

  let streakCount = 0;
  let streakType: 'win' | 'loss' | 'none' = 'none';
  let localPlayerName: string | undefined;

  let augments: string[]     = [];
  let roundStartTs:  number  = 0;
  let roundType: 'PVP' | 'PVE' | 'realm_of_the_gods' | 'unknown' = 'unknown';
  // Realm of Gods state. Confirmed via a real ledger (tests/goldens/2026-07-03-rank-5.jsonl):
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

  // GEP frequently skips round_end for ordinary rounds — not just the known
  // CarouselMarket/god-round quirk. Confirmed across two real matches: ~25-30%
  // of round_start events never get a matching round_end before the next
  // round_start fires. Without this, that round's data (HP/gold/board as of
  // its end, plus rollsThisRound/xpBoughtThisRound accumulated during it) is
  // silently discarded the moment the next round_start resets those counters
  // — a real, permanent loss of what the player did that round, not just a
  // missing label. The running state (health/gold/board/etc.) at the moment
  // we detect the next round_start already reflects "as of the end of the
  // round that never closed," so we can synthesize an accurate close using
  // the label/type captured when that round itself started.
  function pushRoundSnapshot(label: string, type: typeof roundType) {
    const interest = Math.min(5, Math.floor(gold / 10));
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
      xpBought:       xpBoughtThisRound,
      board:          { ...board },
      bench:          { ...bench },
      shop:           [...shop],
      augmentsPicked:     [...augments],
      opponentBoard:      { ...opponentBoard },
      interestEarned:     interest,
      streakCount,
      streakType,
      liveRank,
      godChosen:          currentGodChosen,
      godOfferingHpCost:  currentGodHpCost,
    });
    lastRoundOutcome = undefined;
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];

    if (e.kind === 'info') {
      const { feature, key, value } = e;

      if (feature === 'match_info') {
        if (key === 'pseudo_match_id') pseudoMatchId = value as string;
        if (key === 'game_mode')       gameMode = (value as string) === 'tft' ? 'tft' : 'lol';

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
            const mine = localPlayerName ? players[localPlayerName] : undefined;
            const rawOutcome = typeof mine === 'string' ? mine : (mine?.outcome ?? '');
            const normalized = rawOutcome.toLowerCase();
            const outcome = normalized === 'victory' ? 'win'
                          : normalized === 'defeat'  ? 'loss'
                          : normalized === 'win' || normalized === 'loss' ? normalized
                          : undefined;

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

        // Set 17 — Realm of Gods. Confirmed via a real recorded match (see
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
        if (key === 'gold')   { prevGold = gold; gold  = Number(value); }
        if (key === 'health') { health = Number(value); }
        // Confirmed via a real ledger: there is no separate "me.level" key —
        // it never fires. Player level lives inside me.xp ({level, current_xp,
        // xp_max}); current_xp/xp_max are broken (always 0, see below) but
        // .level is real and updates correctly. The old "level" branch below
        // was dead code — level silently stayed 1 all game, every game,
        // meaning every LEVEL_* checker had been firing false positives.
        if (key === 'xp') {
          const xp = safeParseGep(value, {}) as { level?: number };
          if (xp.level) level = Number(xp.level);
        }
        // Live standing among remaining players — distinct from me.placement,
        // which only arrives once at match end (see extractFinalPlacement).
        if (key === 'rank')   { liveRank = Number(value); }

        // Detect XP purchase: gold dropped by 4 with no shop/bench change.
        // me/xp.current_xp is broken (always 0) — gold delta is the only signal.
        if (key === 'gold' && prevGold - gold === 4) {
          xpBoughtThisRound = true;
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
        // Detect set from TFT{N}_ prefix.
        for (const cell of Object.values(update)) {
          const m = (cell?.name as string | undefined)?.match(/^TFT(\d+)_/);
          if (m) setId = `set${m[1]}`;
        }
      }

      if (feature === 'board' && key === 'opponent_board_pieces') {
        const update = safeParseGep(value, {}) as Record<string, any>;
        const next   = normalizeBoardSnapshot(update);
        // Same transient-empty-snapshot guard as board_pieces above.
        if (Object.keys(next).length > 0 || Object.keys(opponentBoard).length === 0) {
          opponentBoard = next;
        }
      }

      if (feature === 'bench' && key === 'bench_pieces') {
        bench = normalizeBoardSnapshot(safeParseGep(value, {}) as Record<string, any>);
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
        const isPurchase = rawSlots.some(slot => slot?.name === 'Sold');
        if (hasSlots && prevShop.length > 0 && !isPurchase) {
          rollsThisRound++;
        }
        prevShop = shop;
        shop = newShop;
      }

      // Confirmed via a real recorded match: GEP sends augment picks as
      // me.picked_augment (a cumulative snapshot object keyed by slot, e.g.
      // { slot_1: {name: "TFT_Augment_..."} , slot_4: {name: "TFT17_ChampionItem_Chosen_Kindred"} }),
      // NOT augments.me as an array. slot_4+ can hold a Set-specific "Chosen"
      // reward rather than a real augment — filter to ids containing "_Augment_".
      if (feature === 'me' && key === 'picked_augment') {
        const slots  = safeParseGep(value, {}) as Record<string, { name?: string } | undefined>;
        const picked = Object.values(slots)
          .map(s => s?.name)
          .filter((id): id is string => !!id && id.includes('_Augment_'));
        augments = [...new Set([...augments, ...picked])];
      }
    }

    if (e.kind === 'event') {
      if (e.name === 'round_start') {
        const data = e.data as { game_stage?: string; type?: string } | string;
        const typeStr = typeof data === 'object' ? (data?.type ?? '') : (data ?? '');
        const newRoundType = typeStr === 'PVP' ? 'PVP'
                  : typeStr === 'PVE' ? 'PVE'
                  : typeStr === 'realm_of_the_gods' ? 'realm_of_the_gods'
                  : 'unknown';

        // Previous round never got a round_end — synthesize its close before
        // resetting state for the new round (see pushRoundSnapshot comment).
        if (roundStartTs > 0) {
          pushRoundSnapshot(roundStartLabel, roundType);
          synthesizedCount++;
        }

        roundType          = newRoundType;
        roundStartTs       = e.ts;
        roundStartLabel    = currentRoundLabel;
        goldAtRoundStart   = gold;
        rollsThisRound     = 0;
        xpBoughtThisRound  = false;
        prevShop           = [];
        currentGodHpCost   = undefined;
        roundStartCount++;
        console.log(`[rounds] round_start #${roundStartCount}: label=${currentRoundLabel} type=${typeStr || '(empty)'}`);
      }

      if (e.name === 'round_end' && roundStartTs > 0) {
        const label = detectRoundLabel(entries, i) ?? currentRoundLabel;
        pushRoundSnapshot(label, roundType);
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

  console.log(`[rounds] events counted: round_start=${roundStartCount} round_end=${roundEndCount} synthesized=${synthesizedCount} → ${rounds.length} snapshots built`);
  console.log(`[rounds] setId=${setId} gameMode=${gameMode} pseudoMatchId=${pseudoMatchId || '(none)'}`);
  if (rounds.length > 0) {
    console.log(`[rounds] label range: ${rounds[0].label} → ${rounds[rounds.length - 1].label}`);
  } else {
    console.warn('[rounds] no round snapshots built — round_start/round_end events may be missing from ledger');
  }

  const finalPlacement = extractFinalPlacement(entries);
  console.log(`[rounds] finalPlacement=${finalPlacement} augments=${augments.length} godPicks=${godPicks.length}`);

  return {
    pseudoMatchId,
    setId,
    gameMode,
    rounds,
    finalPlacement,
    finalBoard: board,
    augments,
    godPicks,
  };
}

function extractFinalPlacement(entries: LedgerEntry[]): number {
  // Walk backwards; me.placement is the signal GEP sends at match end (see
  // capture/listeners.ts — it's treated as the match-end signal in two places).
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'info' && e.feature === 'me' && e.key === 'placement') {
      const parsed = Number(e.value);
      if (parsed >= 1 && parsed <= 8) return parsed;
    }
  }

  // GEP is known to sometimes never fire the match_end / me.placement signal
  // (see file header + capture/listeners.ts). Rather than silently guessing
  // 8th place, fall back to the last live me.rank value recorded in the
  // ledger — rank tracks standing among remaining players and only changes
  // when someone is eliminated, so the last value seen before the ledger
  // ends is normally the player's actual final placement, not a blind guess.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'info' && e.feature === 'me' && e.key === 'rank') {
      const parsed = Number(e.value);
      if (parsed >= 1 && parsed <= 8) {
        console.warn(`[rounds] me.placement missing from ledger — using last live me.rank (${parsed}) as best-effort final placement`);
        return parsed;
      }
    }
  }

  console.warn('[rounds] no me.placement or me.rank found in ledger — defaulting to 8th as a last resort; this match had no usable placement signal at all');
  return 8;
}
