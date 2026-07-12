// Positioning checker
//
// POSITION_001: Unchanged opponent carry position across multiple fights
// POSITION_002: No tank-role unit on board at stage 4+ PvP (carry exposed)

import type { MatchSnapshot, DecisionPoint, MetaData, BoardSnapshot, BoardState, RoundSnapshot, HexPosition } from '../../shared/types';
import { boardChampionIds, isNonChampionToken, identifyCarry } from '../../ledger/merge';
import { getChampionName, getFrontlineExemption } from '../../enrichment/meta-lookup';
import { resolveHexCell, describeHexPosition, HEX_ROWS, HEX_COLS } from '../../shared/hex-grid';

const REPEAT_THRESHOLD = 2;

// Resolves both boards' occupied hexes into named units for the diagram —
// filters out empty slots and PVE ghost-round placeholders (see the PVE note
// in checkRepeatedOpponentCarry below).
function buildBoardSnapshot(board: BoardState, opponentBoard: BoardState, meta: MetaData): BoardSnapshot {
  const toUnits = (b: BoardState) =>
    Object.entries(b).flatMap(([hex, cell]) => {
      if (!cell?.name || cell.name === '0' || cell.name.includes('_PVE_') || isNonChampionToken(cell.name)) return [];
      const pos = resolveHexCell(hex);
      if (!pos) return [];
      return [{ ...pos, name: getChampionName(cell.name, meta), icon: meta.champions?.[cell.name]?.icon }];
    });
  return { own: toUnits(board), opponent: toUnits(opponentBoard) };
}

// Names a concrete own-side unit + destination instead of generic "move your
// frontline" text. Prefers a curated tank-role unit to block the opponent
// carry's column (columns aren't mirrored left/right between sides — see
// HexBoardLegend.tsx's render loop — so the same col index lines up); falls
// back to null (omitted from coaching text) if no tank-role unit is on board,
// since most of the roster is still uncurated role:'flex' and guessing a
// "tank" would risk naming the wrong unit.
function suggestCounterPosition(
  round: RoundSnapshot,
  meta: MetaData,
  oppCol: number
): {
  frontlineName: string | null;
  carryName: string | null;
  blockSpot: string;
  safeSpot: string;
  blockPosition: HexPosition;
  safePosition: HexPosition;
} {
  const ownEntries = Object.entries(round.board).filter(
    ([, c]) => c?.name && c.name !== '0' && !isNonChampionToken(c.name)
  );
  const tankEntry  = ownEntries.find(([, c]) => meta.champions?.[c.name]?.role === 'tank');
  const carryCell  = ownEntries.length > 0 ? identifyCarry(ownEntries.map(([, c]) => c), meta) : null;
  const carryEntry = ownEntries.find(([, c]) => c === carryCell);

  const safeCol = HEX_COLS - 1 - oppCol;
  const blockPosition: HexPosition = { side: 'own', row: 0, col: oppCol };
  const safePosition:  HexPosition = { side: 'own', row: HEX_ROWS - 1, col: safeCol };
  return {
    frontlineName: tankEntry ? getChampionName(tankEntry[1].name, meta) : null,
    carryName:     carryEntry ? getChampionName(carryEntry[1].name, meta) : null,
    blockSpot:     describeHexPosition(blockPosition),
    safeSpot:      describeHexPosition(safePosition),
    blockPosition,
    safePosition,
  };
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

    // Prefer real combat data: the opponent unit that actually dealt the
    // most damage this fight is ground truth for "their carry" — the old
    // most-items proxy could point at an itemised tank instead of the unit
    // actually doing the work. Falls back to the items heuristic for rounds
    // GEP didn't send battle_stats for (see rounds.ts's splitBattleStatsBySide).
    const topDamageUnit = round.battleStats?.opponent.length
      ? [...round.battleStats.opponent].sort((a, b) => b.totalDamage - a.totalDamage)[0]
      : undefined;
    if (topDamageUnit) {
      const match = oppUnits.find(([, cell]) => cell?.name === topDamageUnit.name);
      if (match) { hex = match[0]; carry = match[1]; }
    }

    if (!carry) {
      let bestItems = -1;
      for (const [h, cell] of oppUnits) {
        if (!cell?.name) continue;
        const items = [cell.item_1, cell.item_2, cell.item_3].filter(i => i && i !== '0').length;
        if (items > bestItems) { bestItems = items; hex = h; carry = cell; }
      }
    }
    if (!carry) continue;
    const carryName = getChampionName(carry.name, meta);
    const opponentLabel = round.opponentName ? ` (${round.opponentName})` : '';

    const key = `${carry.name}-${hex}`;
    if (seenCarries[key]) {
      seenCarries[key].count++;
      if (seenCarries[key].count >= REPEAT_THRESHOLD) {
        const pos      = resolveHexCell(hex);
        const spotName = pos ? `the ${describeHexPosition(pos)} of the board` : `hex ${hex}`;
        const suggestion = pos ? suggestCounterPosition(round, meta, pos.col) : null;

        const moveClause = suggestion?.frontlineName
          ? `Move ${suggestion.frontlineName} to your ${suggestion.blockSpot} to intercept it`
          : `Move a frontline unit to your ${suggestion?.blockSpot ?? 'front row in the same column'} to intercept it — you don't have a curated tank-role unit on this board to name specifically`;
        const carrySafetyClause = suggestion?.carryName
          ? ` Keep ${suggestion.carryName} in your ${suggestion.safeSpot}, away from that column.`
          : '';

        points.push({
          ruleId:   'POSITION_001',
          round:    round.label,
          category: 'positioning',
          severity: 'minor',
          observed: `Opponent's ${carryName} was in ${spotName} for ${seenCarries[key].count} fights`,
          recommended: suggestion?.frontlineName
            ? `Move ${suggestion.frontlineName} to your ${suggestion.blockSpot} to block ${carryName}`
            : `Counter-position against ${carryName} — move your frontline to your ${suggestion?.blockSpot ?? 'front row in the same column'}`,
          reasonMetrics: { carry: carryName, hex, fights: seenCarries[key].count, carryDetection: topDamageUnit ? 'damage' : 'items' },
          coaching_text: `You've fought the same opponent${opponentLabel} with their ${carryName} planted in ${spotName} for ${seenCarries[key].count} fights in a row without adjusting your positioning. ${moveClause}.${carrySafetyClause} Scouting the lobby before each round is what makes this adjustment possible — it's a free win-rate improvement that costs nothing.`,
          hexPosition: pos ?? undefined,
          boardSnapshot: buildBoardSnapshot(round.board, round.opponentBoard, meta),
          recommendedPosition: suggestion?.blockPosition,
          moveUnitName: suggestion?.frontlineName ?? undefined,
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

  const points: DecisionPoint[] = [];
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

        points.push({
          ruleId:   'POSITION_002',
          round:    round.label,
          category: 'positioning',
          severity: 'moderate',
          observed: `No tank-role unit on board for ${consecutiveNoTank} consecutive stage-4 PvP rounds (since ${firstRound})`,
          recommended: `Add at least one tank unit to absorb damage and give your carry time to deal damage.${hint}`,
          reasonMetrics: { consecutiveRounds: consecutiveNoTank, firstRound },
          coaching_text: `Your board has had no tank-role unit for ${consecutiveNoTank} stage-4 fights in a row. Without a frontline, enemy carries reach your backline on the first step — your carry deals zero damage before dying. Even a 1-cost tank holding zero items buys 3–5 seconds of combat time, which is often enough for a carry ability to fire.${hint}`,
          boardSnapshot: buildBoardSnapshot(round.board, round.opponentBoard, meta),
        });
        // Reset so a player who never fixes this gets flagged again every 2
        // rounds instead of exactly once for the entire rest of the match.
        consecutiveNoTank = 0;
      }
    } else {
      consecutiveNoTank = 0;
    }
  }

  return points;
}
