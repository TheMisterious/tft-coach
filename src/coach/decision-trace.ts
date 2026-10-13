// "Likely contributing decisions" for checkpoint notes.
//
// The rules that hold up in the audit (scripts/rule-audit.ts) are almost all
// checkpoint readings — HP entering a stage, level against the lobby, gold left
// idle. They say where the game stood, not which decision put it there. This
// attaches what the player actually did in the window before each checkpoint,
// so a report can say "here is what happened in stage 3" instead of only "you
// entered stage 4 low".
//
// OBSERVATIONS, NOT VERDICTS. The ledger shows what the player did, not the
// options they had: GEP records the shop at the end of each round (not every
// roll), XP purchases as a yes/no per round, and nothing about opponents beyond
// HP and level. So nothing here says a different choice would have been better.
// Each line is a fact the player can check against their own memory of the game.

import type { DecisionPoint, MatchSnapshot, RoundSnapshot, MetaData, BoardState, ContributingDecisions } from '../shared/types';
import { standingFor, ordinal } from './lobby-context';
import { getChampionName } from '../enrichment/meta-lookup';

// Checkpoint rules whose window is "the stage before this checkpoint". Each
// fires at a stage-entry round ("4-1"), so the decisions behind it are the
// previous stage's rounds.
const STAGE_CHECKPOINT_RULES = new Set(['HP_001', 'HP_002', 'HP_003', 'LOBBY_001', 'LOBBY_002']);

export function attachContributingDecisions(points: DecisionPoint[], match: MatchSnapshot, meta?: MetaData): DecisionPoint[] {
  return points.map(p => {
    if (!p.ruleId) return p;
    const trace = traceFor(p, match, meta);
    return trace ? { ...p, contributing: trace } : p;
  });
}

function traceFor(p: DecisionPoint, match: MatchSnapshot, meta?: MetaData): ContributingDecisions | undefined {
  const at = match.rounds.findIndex(r => r.label === p.round);
  if (at < 0) return undefined;
  const checkpoint = match.rounds[at];

  let window: RoundSnapshot[];
  let name: string;
  if (STAGE_CHECKPOINT_RULES.has(p.ruleId!)) {
    const stage = stageOf(p.round) - 1;
    if (stage < 1) return undefined;
    window = match.rounds.slice(0, at).filter(r => stageOf(r.label) === stage);
    name = `stage ${stage}`;
  } else if (p.ruleId === 'ECON_002') {
    const start = String(p.reasonMetrics.streakStartRound ?? '');
    const from = match.rounds.findIndex(r => r.label === start);
    if (from < 0) return undefined;
    window = match.rounds.slice(from, at + 1);
    name = 'the rounds the gold sat idle';
  } else {
    return undefined;
  }
  if (window.length === 0) return undefined;

  const first = window[0], last = window[window.length - 1];
  const observations = [
    hpLine(first, checkpoint, window),
    goldLine(window),
    spendLine(first, last, window),
    upgradeLine(window, last, meta),
    lobbyLine(checkpoint),
  ].filter((s): s is string => !!s);

  return observations.length ? { window: `${name} (${first.label} to ${last.label})`, observations } : undefined;
}

function hpLine(first: RoundSnapshot, checkpoint: RoundSnapshot, window: RoundSnapshot[]): string | undefined {
  const fights = window.filter(r => r.type === 'PVP' && r.outcome);
  if (fights.length === 0) return undefined;
  const losses = fights.filter(r => r.outcome === 'loss').length;
  return `HP ${first.health} → ${checkpoint.health}: lost ${losses} of ${fights.length} player fights.`;
}

function goldLine(window: RoundSnapshot[]): string | undefined {
  const golds = window.map(r => r.goldEnd);
  if (golds.length === 0) return undefined;
  const idleRich = window.filter(r => r.goldEnd >= 50 && r.rollsSpent === 0 && !r.xpBought).length;
  const lo = Math.min(...golds), hi = Math.max(...golds);
  const range = lo === hi ? `${lo}g` : `${lo}g to ${hi}g`;
  return `Gold at round end: ${range}` + (idleRich ? `; ${idleRich} round${idleRich === 1 ? '' : 's'} at 50g+ with nothing spent.` : '.');
}

function spendLine(first: RoundSnapshot, last: RoundSnapshot, window: RoundSnapshot[]): string {
  const rolls = window.reduce((a, r) => a + r.rollsSpent, 0);
  const xpRounds = window.filter(r => r.xpBought).length;
  const levels = first.level === last.level ? `stayed level ${last.level}` : `level ${first.level} → ${last.level}`;
  const rolled = rolls === 0 ? 'No shop rolls' : `Rolled ${rolls} time${rolls === 1 ? '' : 's'} (${rolls * 2}g)`;
  return `${rolled}; bought XP in ${xpRounds} of ${window.length} rounds; ${levels}.`;
}

// Upgrade options the player could see: copies of units they already held
// showing in the end-of-round shop, and pairs one copy from a 2-star. Only the
// LAST shop of each round is recorded, so this undercounts — it never invents.
function upgradeLine(window: RoundSnapshot[], last: RoundSnapshot, meta?: MetaData): string | undefined {
  const parts: string[] = [];

  const seen = new Map<string, number>();
  for (const r of window) {
    const held = new Set([...unitsIn(r.board, meta), ...unitsIn(r.bench, meta)].map(u => u.name));
    for (const id of r.shop) if (held.has(id)) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const offered = [...seen.values()].reduce((a, b) => a + b, 0);
  if (offered > 0) {
    const top = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([id, n]) => `${nameOf(id, meta)} ×${n}`).join(', ');
    parts.push(`end-of-round shops showed ${offered} cop${offered === 1 ? 'y' : 'ies'} of units you held (${top})`);
  }

  const oneStar = new Map<string, number>();
  for (const u of [...unitsIn(last.board, meta), ...unitsIn(last.bench, meta)]) {
    if (u.level === 1) oneStar.set(u.name, (oneStar.get(u.name) ?? 0) + 1);
  }
  const pairs = [...oneStar.entries()].filter(([, n]) => n === 2).map(([id]) => nameOf(id, meta));
  if (pairs.length) parts.push(`${pairs.length} pair${pairs.length === 1 ? '' : 's'} one copy from a 2-star at ${last.label} (${pairs.slice(0, 3).join(', ')})`);

  if (!parts.length) return undefined;
  const sentence = parts.join('; ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
}

function lobbyLine(checkpoint: RoundSnapshot): string | undefined {
  const s = standingFor(checkpoint);
  if (!s) return undefined;
  return `At ${checkpoint.label}: level ${s.level} against a lobby median of ${s.medianOpponentLevel}; HP ${s.health}, ${ordinal(s.hpRank)} of ${s.alive}.`;
}

// Board and bench also hold non-champions (TFT_ArmoryKeyComponent and other
// set tokens). With the set's champion table loaded, only its champions count;
// without one, nothing is filtered rather than guessed at.
function unitsIn(board: BoardState | undefined, meta?: MetaData): Array<{ name: string; level: number }> {
  const known = meta?.champions && Object.keys(meta.champions).length ? meta.champions : undefined;
  return Object.values(board ?? {})
    .filter(c => c?.name && c.name !== '0' && (!known || c.name in known))
    .map(c => ({ name: c.name, level: Number(c.level) || 1 }));
}

function nameOf(id: string, meta?: MetaData): string {
  return meta ? getChampionName(id, meta) : id;
}

function stageOf(label: string): number {
  return Number(label.split('-')[0]) || 0;
}
