// STREAK_001: Win streak of 3+ broken
// STREAK_002: Loss streak 2-4, spent gold to try to break it but still lost
// STREAK_003: Never reached a 5+ streak all game (forfeited +2g/round tier)

import type { MatchSnapshot, DecisionPoint } from '../../shared/types';

// Streak bonus: 2-4 = +1g, 5 = +2g, 6+ = +3g (per lolchess.gg/guide/exp, Set 17).
function streakBonus(length: number): number {
  if (length >= 6) return 3;
  if (length >= 5) return 2;
  if (length >= 2) return 1;
  return 0;
}

export function checkStreak(match: MatchSnapshot): DecisionPoint[] {
  return [
    ...checkWinStreakBreak(match),
    ...checkLossStreakWaste(match),
    ...checkNeverHighStreak(match),
  ];
}

// STREAK_001
function checkWinStreakBreak(match: MatchSnapshot): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  const rounds = match.rounds;

  for (let i = 1; i < rounds.length; i++) {
    const prev = rounds[i - 1];
    const curr = rounds[i];
    if (curr.type !== 'PVP') continue;
    if (prev.streakType !== 'win' || prev.streakCount < 3) continue;
    if (curr.outcome !== 'loss') continue;

    const bonus = streakBonus(prev.streakCount);
    points.push({
      ruleId:   'STREAK_001',
      round:    curr.label,
      category: 'streak',
      severity: prev.streakCount >= 5 ? 'critical' : 'moderate',
      observed: `${prev.streakCount}-win streak broken at ${curr.label}`,
      recommended: 'Keep your board strong enough to maintain win streaks — check item placement and positioning before high-value fights',
      reasonMetrics: { streakLength: prev.streakCount, bonus, hp: curr.health },
      coaching_text: `Your ${prev.streakCount}-game win streak ended at ${curr.label}. At streak length ${prev.streakCount} you were earning +${bonus}g per round; losing it drops that to +0g. Win streaks also apply tempo pressure on opponents — losing one gives the lobby a chance to stabilise against you. Check item placement, trait activations, and positioning from that fight to identify what broke it.`,
    });
  }
  return points;
}

// STREAK_002
function checkLossStreakWaste(match: MatchSnapshot): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  const rounds = match.rounds;

  for (let i = 0; i + 1 < rounds.length; i++) {
    const curr = rounds[i];
    const next = rounds[i + 1];
    if (curr.type !== 'PVP') continue;
    if (curr.streakType !== 'loss') continue;
    if (curr.streakCount < 2 || curr.streakCount > 4) continue;

    // Flag if player spent significant gold this round but still lost the next fight.
    const spend = curr.rollsSpent * 2 + (curr.xpBought ? 4 : 0);
    if (spend <= 8) continue;
    if (next.outcome !== 'loss') continue;

    // Suppress if HP was critical (forced to try to stabilise).
    if (curr.health < 20) continue;

    points.push({
      ruleId:   'STREAK_002',
      round:    curr.label,
      category: 'streak',
      severity: 'moderate',
      observed: `Spent ${spend}g trying to break a ${curr.streakCount}-loss streak at ${curr.label} — still lost`,
      recommended: 'Commit to the loss streak or spend enough to guarantee a win; half-measures waste both gold and streak value',
      reasonMetrics: { spend, streakCount: curr.streakCount, hp: curr.health },
      coaching_text: `You spent ${spend}g at ${curr.label} while on a ${curr.streakCount}-loss streak, but the next fight was still a loss. That gold gave up the streak bonus without producing a win. A 5-game loss streak pays +2g/round — if you can't convert a spend into a guaranteed win, committing to the streak and banking gold is the correct play.`,
    });
  }
  return points;
}

// STREAK_003
function checkNeverHighStreak(match: MatchSnapshot): DecisionPoint[] {
  const pvpRounds = match.rounds.filter(r => r.type === 'PVP');
  if (pvpRounds.length < 5) return []; // too few rounds to build a streak

  const maxStreak = Math.max(0, ...pvpRounds.map(r => r.streakCount));
  if (maxStreak >= 5) return [];

  const bestRound  = pvpRounds.reduce((a, b) => b.streakCount > a.streakCount ? b : a);
  const streakType = bestRound.streakType;

  return [{
    ruleId:   'STREAK_003',
    round:    'match',
    category: 'streak',
    severity: 'minor',
    observed: `Longest streak this game was ${maxStreak} (${streakType}) — never reached the +2g tier (5 streak)`,
    recommended: 'Commit to win or loss streaks to reach 5+ and earn +2g/round; avoid breaking streaks at 2-4',
    reasonMetrics: { maxStreak, streakType },
    coaching_text: `Your longest streak this game was ${maxStreak} ${streakType === 'win' ? 'wins' : 'losses'} in a row — just short of the 5-streak threshold where you start earning +2g per round. Players who maintain 5+ streaks earn 8–12g extra over a typical game compared to those who cap at 4. Try committing more firmly to a streak direction early rather than flip-flopping.`,
  }];
}
