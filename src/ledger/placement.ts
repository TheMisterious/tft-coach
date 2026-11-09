// Final placement, and where it came from.
//
// GEP's me.placement is the real end-of-match signal, but it is known to never
// arrive — most often when the client is closed straight after elimination,
// before GEP sends the final roster. Of 81 recorded matches audited on
// 2026-10-13, 4 ended that way with no placement signal of any kind. Each source is therefore recorded with
// its provenance, best first:
//
//   gep   me.placement, sent by GEP at match end.
//   rank  the last live me.rank of 1-8. Rank only changes on an elimination,
//         so this is normally right, but it is a fallback, not a report. When
//         other players died in the same round, it is re-ordered by HP (see
//         applySameRoundTiebreak).
//   none  nothing at all. The caller decides what to show; this match must not
//         be read as a real placement by anything that learns from placements.

import type { LedgerEntry, PlacementSource } from '../shared/types';
import { safeParseGep } from '../capture/safe-parse';

export function findFinalPlacement(allEntries: LedgerEntry[]): { placement: number; source: Exclude<PlacementSource, 'none'> } | null {
  // GEP replays the previous game's last values when coachv attaches (a rank
  // of 7 before a match that ended 6th), so only what follows this match's
  // match_start can be its placement.
  const entries = sinceMatchStart(allEntries);
  const gep = lastValid(entries, 'me', 'placement', 'gep');
  if (gep) return gep;
  const rank = lastValid(entries, 'me', 'rank', 'rank');
  if (!rank) return null;
  return { placement: applySameRoundTiebreak(entries, rank.placement), source: 'rank' };
}

function sinceMatchStart(entries: LedgerEntry[]): LedgerEntry[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'event' && e.name === 'match_start') return entries.slice(i);
  }
  return entries;
}

interface RosterPlayer { health?: number; rank?: number; localplayer?: boolean }

// GEP's live rank orders players knocked out in the same round by who died
// first. TFT has not worked that way since patch 10.14: the least negative HP
// places higher, then whoever started that round with more HP. A recorded
// 8th (2026-11-09, both players died in 4-6, at -1 and -2 HP) came through
// as a 7th.
//
// Re-ordered only when every player in that round's group has a real final
// HP: all at or below 0, and not all exactly 0. Older ledgers keep the last HP
// from before the fatal round, or 0 for everyone, and re-ordering those would
// invent a placement rather than fix one. Across 90 recorded matches this
// changes exactly the one above.
export function applySameRoundTiebreak(entries: LedgerEntry[], rank: number): number {
  let round = 0;
  let roster: Record<string, RosterPlayer> = {};
  const startHp: Array<Record<string, number | undefined>> = [{}];
  const rankedInRound = new Map<string, number>();

  for (const e of entries) {
    if (e.kind === 'event') {
      if (e.name === 'round_start') {
        round++;
        startHp[round] = Object.fromEntries(Object.entries(roster).map(([name, p]) => [name, p?.health]));
      }
      continue;
    }
    if (e.feature !== 'roster' || e.key !== 'player_status') continue;
    const players = safeParseGep<Record<string, RosterPlayer> | null>(e.value, null);
    if (!players || typeof players !== 'object') continue;
    roster = players;
    for (const [name, p] of Object.entries(players)) {
      if ((p?.rank ?? 0) > 0 && !rankedInRound.has(name)) rankedInRound.set(name, round);
    }
  }

  const me = Object.keys(roster).find(name => roster[name]?.localplayer === true);
  if (!me || roster[me].rank !== rank || !rankedInRound.has(me)) return rank;
  const myRound = rankedInRound.get(me)!;
  const group = [...rankedInRound].filter(([, r]) => r === myRound).map(([name]) => name);
  if (group.length < 2) return rank;

  const hp = (name: string) => Number(roster[name]?.health);
  if (group.some(name => !Number.isFinite(hp(name)) || hp(name) > 0)) return rank;
  if (group.every(name => hp(name) === 0)) return rank;

  const start = startHp[myRound] ?? {};
  const order = [...group].sort((a, b) => {
    if (hp(a) !== hp(b)) return hp(b) - hp(a);
    const sa = start[a], sb = start[b];
    if (sa !== undefined && sb !== undefined && sa !== sb) return sb - sa;
    return (roster[a].rank ?? 0) - (roster[b].rank ?? 0);
  });
  const ranks = group.map(name => roster[name].rank ?? 0).sort((a, b) => a - b);
  return ranks[order.indexOf(me)];
}

function lastValid<S extends Exclude<PlacementSource, 'none'>>(
  entries: LedgerEntry[], feature: string, key: string, source: S
): { placement: number; source: S } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind !== 'info' || e.feature !== feature || e.key !== key) continue;
    const parsed = Number(e.value);
    if (parsed >= 1 && parsed <= 8) return { placement: parsed, source };
  }
  return null;
}
