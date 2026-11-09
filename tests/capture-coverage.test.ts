// Regression coverage for the Overwolf QA report on a deliberately poor test
// game (2026-11): it flagged "empty board slots at level 1" at 6-3, showed no
// augments, and graded economy and leveling S.
//
// The recorded ledgers show where that report came from. After the player is
// eliminated GEP keeps streaming the lobby they are spectating — round_start,
// round_end, board_spectate — and that tail could become a "match" of its own:
// no me.xp (level stayed at the default 1), no board, no augments, so nothing
// fired and every category defaulted to S. ~14 such fragments sit in the
// recording folders. The fixes covered here:
//  - reconstruction drops rounds that start after the player is out;
//  - the roster's level stands in when me.xp is silent;
//  - a capture that never saw the player's gold or board is not a match;
//  - unobserved categories get no notes and no grade, never a default S;
//  - placement caps the overall grade;
//  - ECON_002 is no longer hidden during an HP crisis.

import { describe, it, expect, beforeAll } from 'vitest';
import { reconstructSnapshots } from '../src/ledger/rounds';
import { loadMeta } from '../src/enrichment/meta-lookup';
import { extractDecisionPoints } from '../src/coach/rule-engine';
import { buildBrief } from '../src/coach/brief-builder';
import { generateCoachingReport } from '../src/coach/report-generator';
import { overallGrade } from '../src/coach/scoring';
import { isUsableCapture, gradableCategories, canGradeOverall, captureNotes } from '../src/coach/coverage';
import { categoryGradeValidated } from '../src/coach/rules-loader';
import type { LedgerEntry, MatchSnapshot, MetaData, RoundSnapshot, CaptureCoverage } from '../src/shared/types';

let ts = 0;
const info = (feature: string, key: string, value: unknown): LedgerEntry =>
  ({ ts: ++ts, kind: 'info', feature, key, value });
const event = (name: string, data: unknown = ''): LedgerEntry =>
  ({ ts: ++ts, kind: 'event', name, data });

const unit = (name: string) => ({ name, level: '1', item_1: '', item_2: '', item_3: '' });

function roster(health: number, xp: number) {
  return info('roster', 'player_status', {
    Me:              { health, xp, localplayer: true },
    'Little Legend': { health: 40, xp: 8, localplayer: false },
  });
}

function playedRound(stage: string, gold: number, health: number, withXp = true): LedgerEntry[] {
  return [
    info('match_info', 'round_type', { stage, type: 'PVP', name: 'Combat' }),
    event('round_start', 'PVP'),
    info('me', 'gold', gold),
    info('me', 'health', health),
    ...(withXp ? [info('me', 'xp', { level: 6, current_xp: 0, xp_max: 0 })] : []),
    info('board', 'board_pieces', { cell_1: unit('TFT17_Aatrox'), cell_2: unit('TFT17_Akali') }),
    event('round_end'),
  ];
}

// What GEP sends once you are out and watching: the lobby's rounds, your HP
// at or below 0, and nothing of your own economy.
function spectatorTail(): LedgerEntry[] {
  return [
    roster(-8, 9),
    info('match_info', 'board_spectate', 'Little Legend'),
    event('round_end'),
    info('match_info', 'round_type', { stage: '6-4', type: 'PVP', name: 'Combat' }),
    event('round_start', 'PVP'),
    info('board', 'board_pieces', {}),
    event('round_end'),
    info('match_info', 'round_type', { stage: '6-5', type: 'PVP', name: 'Combat' }),
    event('round_start', 'PVP'),
  ];
}

describe('post-elimination spectating', () => {
  it('drops rounds that start after the player is eliminated', () => {
    const ledger = [
      roster(100, 3),
      ...playedRound('2-1', 10, 80),
      ...playedRound('2-2', 12, 50),
      info('me', 'health', -8),
      event('match_end'),
      ...spectatorTail(),
    ];
    const snap = reconstructSnapshots(ledger);
    expect(snap.rounds.map(r => r.label)).toEqual(['2-1', '2-2']);
    expect(snap.capture?.spectatorRoundsDropped).toBe(2);
  });

  it('a ledger that begins after elimination is not a match (the QA report)', () => {
    const snap = reconstructSnapshots(spectatorTail());
    expect(snap.rounds).toHaveLength(0);
    expect(isUsableCapture(snap)).toBe(false);
  });

  it('a fragment whose HP arrives after its first round_start is still rejected', () => {
    // Real shape (fallback-1783780899156): round_start lands before any
    // health or roster update, so the round opens — but the player's gold
    // and board never arrive, because GEP stops sending them once you're out.
    const ledger = [
      info('match_info', 'round_type', { stage: '6-4', type: 'PVP', name: 'Combat' }),
      event('round_start', 'PVP'),
      roster(0, 9),
      event('round_end'),
    ];
    const snap = reconstructSnapshots(ledger);
    expect(isUsableCapture(snap)).toBe(false);
  });
});

describe('level when me.xp never fires', () => {
  it('falls back to the local roster level instead of the default 1', () => {
    const ledger = [roster(100, 7), ...playedRound('3-2', 30, 70, false)];
    const snap = reconstructSnapshots(ledger);
    expect(snap.rounds[0].level).toBe(7);
    expect(snap.capture?.levelSeen).toBe(true);
  });

  it('prefers me.xp when both are present', () => {
    const ledger = [roster(100, 9), ...playedRound('3-2', 30, 70, true)];
    expect(reconstructSnapshots(ledger).rounds[0].level).toBe(6);
  });
});

// ─── Grading ────────────────────────────────────────────────────────────────

function round(label: string, over: Partial<RoundSnapshot> = {}): RoundSnapshot {
  return {
    label, type: 'PVP', goldStart: 0, goldEnd: 10, health: 80, level: 5,
    rollsSpent: 0, xpBought: false, board: {}, bench: {}, benchItems: [], shop: [],
    augmentsPicked: [], opponentBoard: {}, interestEarned: 1, streakCount: 0, streakType: 'none',
    ...over,
  };
}

const FULL: CaptureCoverage = {
  missedStart: false, goldSeen: true, healthSeen: true, levelSeen: true,
  boardSeen: true, shopSeen: true, augmentsSeen: true, spectatorRoundsDropped: 0,
};

function match(rounds: RoundSnapshot[], over: Partial<MatchSnapshot> = {}): MatchSnapshot {
  return {
    pseudoMatchId: 'm', setId: 'set17', gameMode: 'tft', rounds,
    finalPlacement: 8, placementSource: 'gep', finalBoard: {}, augments: [], godPicks: [],
    capture: { ...FULL, firstRound: rounds[0]?.label, lastRound: rounds.at(-1)?.label },
    ...over,
  };
}

const STAGES = ['1-1', '1-2', '1-3', '1-4', '2-1', '2-2', '2-3', '2-5', '2-6', '3-1', '3-2', '3-3', '3-5', '3-6', '4-1', '4-2', '4-3'];

let meta: MetaData;
beforeAll(async () => { meta = await loadMeta('set17'); });

describe('categories with nothing observed', () => {
  it('a level-1 empty board at 6-3 with no level signal produces no board note and no grade', () => {
    const rounds = STAGES.map(l => round(l, { level: 1 })).concat(round('6-3', { level: 1 }));
    const m = match(rounds, { capture: { ...FULL, levelSeen: false, boardSeen: false } });
    const points = extractDecisionPoints(m, meta);
    expect(points.filter(p => p.ruleId === 'BOARD_003')).toHaveLength(0);
    expect(points.filter(p => p.category === 'leveling')).toHaveLength(0);

    const brief = buildBrief(m, points, meta);
    expect(brief.categoryGrades.board).toBeUndefined();
    expect(brief.categoryGrades.leveling).toBeUndefined();
    expect(brief.overallGrade).toBeNull();
  });

  it('missing augment picks leave augments ungraded and say so', () => {
    const m = match(STAGES.map(l => round(l)), { capture: { ...FULL, augmentsSeen: false } });
    expect(gradableCategories(m).has('augments')).toBe(false);
    expect(captureNotes(m).join(' ')).toMatch(/augment picks/);
  });

  it('a recording that started mid-match has no overall grade and names where it began', () => {
    const rounds = ['3-2', '3-3', '4-1'].map(l => round(l));
    const m = match(rounds, { capture: { ...FULL, missedStart: true, firstRound: '3-2' } });
    expect(canGradeOverall(m)).toBe(false);
    expect(captureNotes(m)[0]).toMatch(/started at 3-2/);
  });

  it('leveling is not graded for a match that ended before any leveling checkpoint', () => {
    const m = match(['1-1', '2-1', '2-5'].map(l => round(l)));
    expect(gradableCategories(m).has('leveling')).toBe(false);
  });
});

describe('overall grade', () => {
  it('placement caps the grade: no S below 2nd, nothing above C at 7th-8th', () => {
    expect(overallGrade(1, [], 30)).toBe('S');
    expect(overallGrade(3, [], 30)).toBe('A');
    expect(overallGrade(5, [], 30)).toBe('B');
    expect(overallGrade(8, [], 30)).toBe('C');
  });
});

describe('a deliberately poor game', () => {
  // Hoards gold above the cap while dying, never rolls or levels past the
  // passive curve, finishes 8th.
  function poorGame(): MatchSnapshot {
    const rounds = STAGES.map((l, i) => round(l, {
      goldEnd: i < 4 ? 4 + i : 54 + i,
      health:  Math.max(5, 100 - i * 6),
      level:   Math.min(6, 1 + Math.floor(i / 3)),
    }));
    return match(rounds, { finalPlacement: 8 });
  }

  it('is not graded S on economy or overall', async () => {
    const m = poorGame();
    const points = extractDecisionPoints(m, meta);
    expect(points.some(p => p.ruleId === 'ECON_002')).toBe(true);

    const brief = buildBrief(m, points, meta);
    expect(brief.categoryGrades.econ).not.toBe('S');
    expect(brief.categoryGrades.leveling).not.toBe('S');
    expect(brief.overallGrade).not.toBe('S');

    const report = await generateCoachingReport(brief);
    expect(report.strengths.join(' ')).not.toMatch(/Economy management was clean/);
  });

  it('keeps ECON_002 when HP is in crisis — its advice is to spend, the same as the crisis advice', () => {
    const rounds = ['3-1', '3-2', '3-3', '3-5'].map(l => round(l, { goldEnd: 60, health: 20 }));
    const points = extractDecisionPoints(match(rounds), meta);
    expect(points.some(p => p.ruleId === 'ECON_002')).toBe(true);
  });
});

describe('category letters need validation', () => {
  it('letters only categories whose grade the audit found to track results, and says why the rest are blank', () => {
    const m = match(STAGES.map(l => round(l)), { finalPlacement: 4 });
    const brief = buildBrief(m, extractDecisionPoints(m, meta), meta);
    for (const category of gradableCategories(m)) {
      if (categoryGradeValidated(category)) {
        expect(brief.categoryGrades[category], category).toBeDefined();
      } else {
        expect(brief.categoryGrades[category], category).toBeUndefined();
        expect(brief.ungradedReasons?.[category]).toBe('unvalidated');
      }
    }
  });
});
