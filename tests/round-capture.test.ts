// What a round keeps beyond its end state (src/ledger/rounds.ts): every shop
// the player was shown, what they bought, which boards they scouted before
// the fight, the item choices they were given, and how the whole lobby's
// fights went. Each shape below is the one seen in recorded ledgers
// (2026-11-11): a roll-down at 3-2 sends one shop_pieces per roll, a purchase
// turns one slot "Sold", board_spectate names the board on screen about once
// a second, and a picked_item can land a millisecond after the next
// round_start.

import { describe, it, expect } from 'vitest';
import { reconstructSnapshots } from '../src/ledger/rounds';
import type { LedgerEntry } from '../src/shared/types';

let ts = 1000;
const info = (feature: string, key: string, value: unknown, at?: number): LedgerEntry =>
  ({ ts: at ?? (ts += 100), kind: 'info', feature, key, value });
const event = (name: string, data: unknown = '', at?: number): LedgerEntry =>
  ({ ts: at ?? (ts += 100), kind: 'event', name, data });
const shop = (...names: string[]): LedgerEntry =>
  info('store', 'shop_pieces', Object.fromEntries(names.map((name, i) => [`slot_${i + 1}`, { name }])));

const ROSTER = {
  Me:        { health: 60, xp: 7, localplayer: true,  rank: 0 },
  'Chibi X': { health: 80, xp: 7, localplayer: false, rank: 0 },
  'Chibi Y': { health: 0,  xp: 6, localplayer: false, rank: 8 },
};

function ledger(withSpectate = true): LedgerEntry[] {
  ts = 1000;
  const spectate = (name: string) => withSpectate ? [info('match_info', 'board_spectate', name)] : [];
  return [
    info('match_info', 'game_mode', 'TFT'),
    info('me', 'summoner_name', 'Me'),
    info('roster', 'player_status', ROSTER),
    info('me', 'gold', 50),
    // The round before, so 3-2's opening shop replaces a real one: roll
    // counting treats the first shop after a round_start as the free refresh.
    info('match_info', 'round_type', { stage: '3-1', type: 'PVP' }),
    event('round_start', 'PVP'),
    shop('P1', 'P2', 'P3', 'P4', 'P5'),
    event('battle_start', 'PVP'),
    event('round_end'),
    info('match_info', 'round_type', { stage: '3-2', type: 'PVP' }),
    event('round_start', 'PVP'),
    shop('A1', 'A2', 'A3', 'A4', 'A5'),                 // opening shop
    shop('B1', 'B2', 'B3', 'B4', 'B5'),                 // roll
    info('me', 'gold', 48),
    shop('B1', 'Sold', 'B3', 'B4', 'B5'),               // bought B2
    shop('B1', 'Sold', 'B3', 'Sold', 'B5'),             // bought B4
    shop('C1', 'C2', 'C3', 'C4', 'C5'),                 // roll
    info('me', 'gold', 46),
    ...spectate('Me'),
    ...spectate('Chibi X'),
    ...spectate('Chibi Y'),
    ...spectate('Chibi X'),
    info('match_info', 'item_select', {
      item_1: { name: 'TFT_Item_BFSword' }, item_2: { name: 'TFT_Item_ChainVest' },
      item_3: { name: 'TFT_Item_RecurveBow' }, item_4: { name: 'TFT_Item_GiantsBelt' },
    }),
    event('battle_start', 'PVP'),
    ...spectate('Chibi Z'),                               // the camera, not scouting
    info('match_info', 'round_outcome', {
      Me: { outcome: 'defeat' }, 'Chibi X': { outcome: 'victory' }, 'Chibi Y': { outcome: 'defeat' },
    }),
    event('battle_end'),
    event('round_end'),
    shop('D1', 'D2', 'D3', 'D4', 'D5'),                 // next round's opening shop, before its round_start
    info('match_info', 'round_type', { stage: '3-3', type: 'PVP' }),
    event('round_start', 'PVP'),
    event('picked_item', 'TFT_Item_BFSword'),            // the 3-2 offer's pick, a beat late
    event('battle_start', 'PVP'),
    event('round_end'),
  ];
}

describe('round capture', () => {
  const rounds = reconstructSnapshots(ledger()).rounds;
  const [r31, r32, r33] = rounds;

  it('labels the three rounds', () => {
    expect(rounds.map(r => r.label)).toEqual(['3-1', '3-2', '3-3']);
    expect(r31.shopsSeen).toEqual([['P1', 'P2', 'P3', 'P4', 'P5']]);
  });

  it('keeps every shop shown, with purchases marking nothing new', () => {
    expect(r32.shopsSeen).toEqual([
      ['A1', 'A2', 'A3', 'A4', 'A5'],
      ['B1', 'B2', 'B3', 'B4', 'B5'],
      ['C1', 'C2', 'C3', 'C4', 'C5'],
    ]);
    expect(r32.rollsSpent).toBe(2);
    expect(r32.shop).toEqual(['C1', 'C2', 'C3', 'C4', 'C5']);
  });

  it('names the units bought from the slots that turned Sold', () => {
    expect(r32.bought).toEqual(['B2', 'B4']);
    expect(r33.bought).toEqual([]);
  });

  it('counts boards looked at before the fight, the player\'s own and the camera left out', () => {
    expect(r32.scouted).toEqual(['Chibi X', 'Chibi Y']);
    expect(r33.scouted).toEqual([]);
  });

  it('keeps the item offer and attaches a pick that lands after the next round_start', () => {
    expect(r32.itemOffers).toEqual([{
      offered: ['TFT_Item_BFSword', 'TFT_Item_ChainVest', 'TFT_Item_RecurveBow', 'TFT_Item_GiantsBelt'],
      picked: 'TFT_Item_BFSword',
    }]);
    expect(r33.itemOffers).toBeUndefined();
  });

  it('keeps every player\'s result and their live rank', () => {
    expect(r32.lobbyOutcomes).toEqual({ Me: 'loss', 'Chibi X': 'win', 'Chibi Y': 'loss' });
    expect(r32.outcome).toBe('loss');
    expect(r32.lobby?.find(p => p.name === 'Chibi Y')?.rank).toBe(8);
    expect(r32.lobby?.find(p => p.isLocal)?.rank).toBe(0);
  });

  it('gives an opening shop sent before round_start to the round it opens', () => {
    expect(r33.shopsSeen).toEqual([['D1', 'D2', 'D3', 'D4', 'D5']]);
  });

  it('records that the scouting feed was seen', () => {
    expect(reconstructSnapshots(ledger()).capture?.scoutingSeen).toBe(true);
  });

  it('does not read the all-Sold shop the game sends on elimination as purchases', () => {
    ts = 1000;
    const snap = reconstructSnapshots([
      info('match_info', 'game_mode', 'TFT'),
      info('me', 'gold', 37),
      info('match_info', 'round_type', { stage: '4-6', type: 'PVP' }),
      event('round_start', 'PVP'),
      shop('Taric', 'Camille', 'Caitlyn', 'Kennen', 'Vi'),
      shop('Taric', 'Camille', 'Caitlyn', 'Sold', 'Vi'),
      shop('Sold', 'Camille', 'Caitlyn', 'Sold', 'Vi'),
      event('battle_start', 'PVP'),
      event('battle_end'),
      shop('Sold', 'Sold', 'Sold', 'Sold', 'Sold'),
      info('me', 'health', -2),
      event('match_end'),
      event('round_end'),
    ]);
    expect(snap.rounds[0].bought).toEqual(['Kennen', 'Taric']);
  });

  it('leaves scouting undefined when the match never sent board_spectate', () => {
    const snap = reconstructSnapshots(ledger(false));
    expect(snap.capture?.scoutingSeen).toBe(false);
    expect(snap.rounds[1].scouted).toBeUndefined();
    expect(snap.rounds[1].shopsSeen?.length).toBe(3);
  });
});
