// Positioning checker
//
// POSITION_001: Unchanged opponent carry position across multiple fights
// POSITION_002: No tank-role unit on board at stage 4+ PvP (carry exposed)

import type { MatchSnapshot, DecisionPoint, MetaData, BoardSnapshot, BoardState } from '../../shared/types';
import { boardChampionIds } from '../../ledger/merge';
import { getChampionName, getFrontlineExemption } from '../../enrichment/meta-lookup';
import { resolveHexCell, describeHexPosition } from '../../shared/hex-grid';

const REPEAT_THRESHOLD = 2;

// Resolves both boards' occupied hexes into named units for the diagram —
// filters out empty slots and PVE ghost-round placeholders (see the PVE note
// in checkRepeatedOpponentCarry below).
function buildBoardSnapshot(board: BoardState, opponentBoard: BoardState, meta: MetaData): BoardSnapshot {
  const toUnits = (b: BoardState) =>
    Object.entries(b).flatMap(([hex, cell]) => {
      if (!cell?.name || cell.name === '0' || cell.name.includes('_PVE_')) return [];
      const pos = resolveHexCell(hex);
      if (!pos) return [];
      return [{ ...pos, name: getChampionName(cell.name, meta), icon: meta.champions?.[cell.name]?.icon }];
    });
  return { own: toUnits(board), opponent: toUnits(opponentBoard) };
}

export function checkPositioning(match: MatchSnapshot, meta: MetaData = {} as MetaData): DecisionPoint[] {
  return [
    ...checkRepeatedOpponentCarry(match, meta),
    ...checkNoFrontline(match, meta),
  ];
}

// POSITION_001 — same opponent carry in same hex across multiple fights
function checkRepeatedOpponentCarry(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  const points: DecisionPoint[] = [];

  type CarryRecord = { champName: string; hex: string; count: number };
  const seenCarries: Record<string, CarryRecord> = {};

  for (const round of match.rounds) {
    if (round.type !== 'PVP') continue;

    // GEP reports type "PVP" even for ghost/stand-in rounds fought against a
    // placeholder NPC lineup (seen in a real match: opponentBoard filled with
    // TFT17_PVE_Minion / TFT17_PVE_Pix at 2-1/2-2). Those aren't a real
    // opponent to counter-position against — skip them so we don't coach
    // "reposition against PVE Minion".
    const oppUnits = Object.entries(round.opponentBoard).filter(([, cell]) => !cell?.name?.includes('_PVE_'));
    if (oppUnits.length === 0) continue;

    let hex = '';
    let carry: typeof oppUnits[0][1] | null = null;
    let bestItems = -1;
    for (const [h, cell] of oppUnits) {
      if (!cell?.name) continue;
      const items = [cell.item_1, cell.item_2, cell.item_3].filter(i => i && i !== '0').length;
      if (items > bestItems) { bestItems = items; hex = h; carry = cell; }
    }
    if (!carry) continue;
    const carryName = getChampionName(carry.name, meta);

    const key = `${carry.name}-${hex}`;
    if (seenCarries[key]) {
      seenCarries[key].count++;
      if (seenCarries[key].count >= REPEAT_THRESHOLD) {
        const pos      = resolveHexCell(hex);
        const spotName = pos ? `the ${describeHexPosition(pos)} of the board` : `hex ${hex}`;

        points.push({
          ruleId:   'POSITION_001',
          round:    round.label,
          category: 'positioning',
          severity: 'minor',
          observed: `Opponent's ${carryName} was in ${spotName} for ${seenCarries[key].count} fights`,
          recommended: `Counter-position against ${carryName} — move your frontline to block that spot`,
          reasonMetrics: { carry: carryName, hex, fights: seenCarries[key].count },
          coaching_text: `You've fought the same opponent with their ${carryName} planted in ${spotName} for ${seenCarries[key].count} fights in a row without adjusting your positioning. Scouting the lobby before each round and moving a frontline unit to intercept the carry — or positioning your own carry in the opposite corner — is a free win-rate improvement that costs nothing.`,
          hexPosition: pos ?? undefined,
          boardSnapshot: buildBoardSnapshot(round.board, round.opponentBoard, meta),
        });
        seenCarries[key].count = 0;
      }
    } else {
      seenCarries[key] = { champName: carryName, hex, count: 1 };
    }
  }

  return points;
}

// POSITION_002 — board has no tank-role unit at stage 4+ PvP rounds
function checkNoFrontline(match: MatchSnapshot, meta: MetaData): DecisionPoint[] {
  if (!meta.champions || Object.keys(meta.champions).length === 0) return [];

  let consecutiveNoTank = 0;
  let firstRound = '';

  for (const round of match.rounds) {
    const [stageStr] = round.label.split('-');
    if (Number(stageStr) < 4) continue;
    if (round.type !== 'PVP') continue;

    const champIds = boardChampionIds(round.board);
    const hasTank  = champIds.some(id => meta.champions[id]?.role === 'tank');
    // A defensive augment (shields, damage reduction) can substitute for an
    // actual tank-role unit — don't flag a "no frontline" mistake that isn't one.
    const exemption = !hasTank ? getFrontlineExemption(round.augmentsPicked, meta) : null;

    if (!hasTank && !exemption) {
      if (consecutiveNoTank === 0) firstRound = round.label;
      consecutiveNoTank++;

      if (consecutiveNoTank === 2) {
        // Find the cheapest tank available that isn't on board.
        const onBoard  = new Set(champIds);
        let cheapTank: string | null = null;
        let cheapCost  = Infinity;
        for (const [id, champ] of Object.entries(meta.champions)) {
          if (champ.role !== 'tank' || onBoard.has(id)) continue;
          if (champ.tier < cheapCost) { cheapCost = champ.tier; cheapTank = champ.name; }
        }
        const hint = cheapTank ? ` Consider adding ${cheapTank} (${cheapCost}-cost) as a temporary frontline.` : '';

        return [{
          ruleId:   'POSITION_002',
          round:    round.label,
          category: 'positioning',
          severity: 'moderate',
          observed: `No tank-role unit on board for ${consecutiveNoTank} consecutive stage-4 PvP rounds (since ${firstRound})`,
          recommended: `Add at least one tank unit to absorb damage and give your carry time to deal damage.${hint}`,
          reasonMetrics: { consecutiveRounds: consecutiveNoTank, firstRound },
          coaching_text: `Your board has had no tank-role unit for ${consecutiveNoTank} stage-4 fights in a row. Without a frontline, enemy carries reach your backline on the first step — your carry deals zero damage before dying. Even a 1-cost tank holding zero items buys 3–5 seconds of combat time, which is often enough for a carry ability to fire.${hint}`,
          boardSnapshot: buildBoardSnapshot(round.board, round.opponentBoard, meta),
        }];
      }
    } else {
      consecutiveNoTank = 0;
    }
  }

  return [];
}
