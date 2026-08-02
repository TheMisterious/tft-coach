import type { BoardState, Cell, MetaData } from '../shared/types';

// Normalizes a board/bench/opponent-board GEP payload into a BoardState.
//
// CORRECTED (2026-07-03, verified against a real ledger — tests/goldens/2026-07-03-rank-5.jsonl):
// board_pieces/bench_pieces/opponent_board_pieces are FULL current-state
// snapshots re-sent whenever the board changes, NOT incremental diffs as
// previously assumed. Evidence: a real cell (Veigar, cell_4) appeared once
// then permanently vanished from every later board_pieces update with no
// explicit null/removal — under the old union-merge behavior that meant it
// silently stayed on the board forever. Consecutive late-game updates also
// resend the SAME ~10 cells each time with only one field changed (an item
// added to one cell), which is exactly the signature of "full snapshot
// resent on change," not a partial diff. The old merge-based code produced a
// fictitious 19 "units" by round 5-1 in that match when the true final board
// only had 10 — this function replaces the board outright on every update
// instead of unioning it with whatever came before.
export function normalizeBoardSnapshot(
  update: Record<string, Partial<Cell> | null>
): BoardState {
  const next: BoardState = {};
  for (const [cellId, cell] of Object.entries(update)) {
    if (!cell || !cell.name) continue;
    next[cellId] = {
      name:   cell.name,
      level:  Number(cell.level ?? 1), // GEP sends level as a numeric string (e.g. "1")
      item_1: cell.item_1 || '0',
      item_2: cell.item_2 || '0',
      item_3: cell.item_3 || '0',
    };
  }
  return next;
}

// Spell-effect/pet tokens (e.g. Shen's clone "TFT17_ShenProp", a generic
// "TFT17_Summon") get tracked in board_pieces/opponent_board_pieces just like
// real units but aren't champions — exclude them from every board reader.
export function isNonChampionToken(name: string): boolean {
  return /_Summon$|_Prop$|_Clone$/.test(name);
}

// Extract champion IDs present on a board (excluding empty/undefined cells).
export function boardChampionIds(board: BoardState): string[] {
  return Object.values(board)
    .filter(c => c?.name && c.name !== '0' && !isNonChampionToken(c.name))
    .map(c => c.name);
}

// Returns all item IDs equipped on a board (excluding "0" empty slots).
export function boardItemIds(board: BoardState): string[] {
  return Object.values(board).flatMap(c =>
    [c.item_1, c.item_2, c.item_3].filter(i => i && i !== '0')
  );
}

function itemCount(c: Cell): number {
  return [c.item_1, c.item_2, c.item_3].filter(i => i && i !== '0').length;
}

// Identifies "the carry" among a set of board units for itemization/roll
// checks. Prefers a unit whose curated role is 'carry' — falls back to a
// cost-first heuristic only when no unit on board has curated role data
// saying otherwise (a real gap: most of the Set 17 roster is still
// placeholder role:'flex' — see champions.json).
//
// FIXED (2026-07-12, found reviewing a real match): the fallback used to
// compare star level first, then item count only as an equal-level tiebreak.
// Confirmed live this misidentifies the carry whenever a cheap unit happens
// to star up early from ordinary buys — e.g. a real 4-1 board where a
// 2-starred 1-cost Twisted Fate (holding only a trait emblem, no combat
// item, and not even on the final board) beat a 1-starred, itemless 4-cost
// Xayah (the actual eventual carry — final board had her 2-starred with a
// full Kraken Slayer/Rapid Fire Cannon build) purely because level was
// compared before cost. Star level on a cheap unit is incidental to normal
// buying/rolling; cost is a structural, design-level signal — units are
// gated behind higher cost specifically because they're meant to be carries.
// Reordered to weight cost first, then item count, then level as tiebreakers.
//
// FIXED (2026-07-28, real match report showed "Main carry Jhin" for a board
// that was actually "Samira, two-tank reroll"): both champions were still
// uncurated role:'flex' (see champions.json's ~57-entry curation gap,
// documented elsewhere), so the cost-first fallback picked the 5-cost Jhin
// over the 3-cost Samira purely because 5 > 3 — even though Jhin had only
// briefly touched the board that round and Samira was the unit actually
// being rerolled and played round after round. Added an optional
// `activeComp` signal (src/coach/match-context.ts's computeActiveComp() —
// unit names on board in >50% of the match's PvP rounds, already used for
// bench-clutter/reroll detection): when no unit has curated 'carry' role
// data, a unit the player has committed to across the whole match outranks
// raw cost, since a high-cost unit tried out for one round isn't "the carry"
// just because it's expensive.
//
// FIXED (2026-07-28, same day, second real report: "Main carry Caitlyn" for
// an Akali reroll board): the `activeComp` fix above only kicked in when NO
// unit had curated role data — but Caitlyn is one of the original 9
// hand-curated champions and IS tagged role:'carry' (a real, general fact
// about her kit — she genuinely is a carry in some comps), so the tagged-
// carry branch short-circuited before `activeComp` was ever consulted,
// picking her outright over Akali (role:'flex', but the unit actually being
// rerolled and played all game). A static role tag describes what a
// champion CAN be, not what this specific match's player built — it must
// not unconditionally outrank real evidence of what was actually played.
// Reworked into an explicit priority order: tagged-AND-committed beats
// committed-only beats tagged-only beats the full pool, so a stale/generic
// role tag can only win when there's no real match evidence to check it
// against (activeComp not passed, or nothing on board clears its 50%
// PvP-round threshold).
//
// FIXED (2026-08-02, real match report: "Main carry Aurelion Sol" for a
// Zoe/Viktor Mecha reroll board): the pool-selection priority above was
// correct — Viktor (role:'carry', tier 3) qualified as tagged-AND-committed —
// but two champions can both be hand-curated role:'carry' (Viktor AND
// Aurelion Sol both are; see champions.json) and both be on board >50% of
// PvP rounds (Aurelion Sol shares Viktor's Mecha/Conduit traits, so he rode
// along as a frontline/trait-bot all game without ever getting items). Once
// both land in the same pool, the final reduce's cost-first tiebreak picked
// Aurelion Sol (tier 4) over Viktor (tier 3) purely on price tag — exactly
// the failure this function's own doc history already fixed once for the
// pool-selection step, just recurring one step later at the tiebreak step.
// Added `carryDamage` (match-context.ts's computeCarryDamage() — cumulative
// real battle_stats damage per champion across the whole match, the same
// ground-truth signal feature-vector.ts's opponentCarryKey already trusts
// for the OPPONENT's board) as the tiebreak's first check, ahead of cost: a
// champion that's actually dealing the damage outranks a champion that's
// merely expensive. Falls through to the old cost/items/level order when no
// damage data was passed or both candidates tie (e.g. before any PvP combat
// has happened yet), so callers that don't pass it keep prior behavior.
//
// FIXED (2026-08-02, same day, two more real reports from one match — a
// pivot to Nami support-carry at 4-1 flagged Riven as "main carry" with 1
// item, and later rounds flagged Tahm Kench as an "itemized carry outdamaged
// by Nami" instead of recognizing Nami herself as the carry): tried first
// making `carryDamage` override pool selection outright (decide the carry
// before tagged/committed was even consulted), but that broke COMBAT_001
// structurally — that checker's entire premise is "compare the *intended*
// carry against who's actually leading damage," and once "intended carry"
// is itself picked by damage, it becomes circular and can never fire (a
// real regression, caught by tests/combat.test.ts). The actual root cause
// was one level down: Nami joined the comp at the 4-1 pivot and was on board
// nearly every round *since* — but `activeComp` (match-context.ts's
// computeActiveComp) measured her presence against the whole match's PvP
// round count, a denominator that includes rounds before she was even
// recruited. No newly-pivoted-in carry can ever clear a >50%-of-the-*whole*-
// match bar without having played since round one. Fixed at the source
// instead: computeActiveComp now measures each unit's presence ratio against
// the PvP rounds *since that unit's first appearance*, not the full match.
// Nami's real window ratio in this match was 100% (10/10 rounds since she
// joined) — she now clears "committed" correctly, and `carryDamage` goes
// back to being purely an intra-pool tiebreak (ahead of cost), same as the
// Aurelion Sol fix above — which is what correctly promotes her over
// Tahm Kench/Riven once she's rightfully in the pool, without ever
// bypassing pool selection itself.
export function identifyCarry(
  units: Cell[],
  meta: MetaData,
  activeComp?: Set<string>,
  carryDamage?: Map<string, number>
): Cell {
  const tagged    = units.filter(u => meta.champions?.[u.name]?.role === 'carry');
  const committed = activeComp && activeComp.size > 0 ? units.filter(u => activeComp.has(u.name)) : [];
  const taggedAndCommitted = committed.filter(u => tagged.includes(u));

  const pool =
    taggedAndCommitted.length > 0 ? taggedAndCommitted :
    committed.length > 0 ? committed :
    tagged.length > 0 ? tagged :
    units;

  return pool.reduce((best, u) => {
    const uDamage = carryDamage?.get(u.name) ?? 0;
    const bDamage = carryDamage?.get(best.name) ?? 0;
    if (uDamage !== bDamage) return uDamage > bDamage ? u : best;

    const uCost  = meta.champions?.[u.name]?.tier ?? 0;
    const bCost  = meta.champions?.[best.name]?.tier ?? 0;
    if (uCost !== bCost) return uCost > bCost ? u : best;

    const uItems = itemCount(u);
    const bItems = itemCount(best);
    if (uItems !== bItems) return uItems > bItems ? u : best;

    return u.level > best.level ? u : best;
  });
}
