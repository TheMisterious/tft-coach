// SCOUT_001: CANDIDATE (defined 2026-11-11, status in data/core/rules.core.json)
// — no other board looked at before any stage 3-4 fight, while a committed
// unit was on two or more opponents' boards or most of those fights were lost.
//
// GEP's match_info.board_spectate names the board on screen. Between
// round_start and battle_start that is the player clicking through the
// lobby (src/ledger/rounds.ts keeps those as RoundSnapshot.scouted); during
// the fight it is the camera, which does not count. Scouting is an input, not
// an outcome: it is what makes a pivot away from a contested line, or a
// counter-position, possible at all. So this only fires when the match gave a
// reason to look: contest (src/coach/lobby-map.ts) or a run of losses.
// A match whose GEP never sent the feed produces no reading.
// Thresholds were fixed before the rule was run against any match; it stays
// out of reports until games recorded after that date confirm it.

import type { MatchSnapshot, DecisionPoint, MetaData, RoundSnapshot } from '../../shared/types';
import { readLobby } from '../lobby-map';

const STAGES = [3, 4];
const MIN_ROUNDS = 4;
const MIN_LOSSES = 3;
const MIN_HOLDERS = 2;

function stageOf(label: string): number {
  return Number(label.split('-')[0]) || 0;
}

function lost(match: MatchSnapshot, r: RoundSnapshot): boolean {
  if (r.outcome) return r.outcome === 'loss';
  const i = match.rounds.indexOf(r);
  return i > 0 && r.health < match.rounds[i - 1].health;
}

export function checkScouting(match: MatchSnapshot, meta: MetaData = {} as MetaData): DecisionPoint[] {
  const rounds = match.rounds.filter(r => r.type === 'PVP' && STAGES.includes(stageOf(r.label)) && r.scouted !== undefined);
  if (rounds.length < MIN_ROUNDS) return [];
  if (rounds.some(r => r.scouted!.length > 0)) return [];

  const losses = rounds.filter(r => lost(match, r)).length;
  const contested = mostContested(match, meta);
  if (losses < MIN_LOSSES && !contested) return [];

  const last = rounds[rounds.length - 1];
  const reason = [
    contested ? `${contested.name} was on the boards of ${contested.by.length} opponents you fought (${contested.by.join(', ')})` : '',
    losses >= MIN_LOSSES ? `you lost ${losses} of those ${rounds.length} fights` : '',
  ].filter(Boolean).join(', and ');

  return [{
    ruleId:   'SCOUT_001',
    round:    last.label,
    category: 'positioning',
    severity: 'moderate',
    observed: `Looked at no other board before any of ${rounds.length} stage 3-4 fights, while ${reason}`,
    recommended: 'From stage 3 the usual line is to look at the other boards before a roll-down and before each fight, which is what tells you who is on your units and where to stand',
    reasonMetrics: { rounds: rounds.length, losses, ...(contested ? { contestedUnit: contested.name, holders: contested.by.length } : {}) },
    coaching_text: `Across ${rounds.length} player fights in stages 3 and 4 the recording shows no other board on your screen before the fight started, and ${reason}. Scouting is what makes the other adjustments possible: counting who else is on your carry before a roll-down, and placing your units against the next opponent's damage. The game sends the board on screen about once a second, so a quick pass through the lobby in the planning phase shows up here; a match where nothing you could see would change the spend is the exception.`,
  }];
}

// The committed unit most opponents fielded in stages 3-4, when two or more did.
function mostContested(match: MatchSnapshot, meta: MetaData): { name: string; by: string[] } | undefined {
  const lobby = readLobby(match, meta);
  if (!lobby) return undefined;
  const byUnit = new Map<string, { name: string; by: Set<string> }>();
  for (const o of lobby.opponents) for (const c of o.contested) {
    if (!STAGES.includes(stageOf(c.round))) continue;
    const e = byUnit.get(c.id) ?? { name: c.name, by: new Set<string>() };
    e.by.add(o.name);
    byUnit.set(c.id, e);
  }
  const top = [...byUnit.values()].sort((a, b) => b.by.size - a.by.size || a.name.localeCompare(b.name))[0];
  return top && top.by.size >= MIN_HOLDERS ? { name: top.name, by: [...top.by].sort() } : undefined;
}
