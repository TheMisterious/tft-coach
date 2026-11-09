// "In TFT match" must come from gameplay. A real session (2026-11-09) showed
// the status stuck on "In TFT match" in the lobby and after the match ended,
// because a game_mode update and the League client launching both counted as
// a match. Only a round starting does now (src/background/main.ts
// markMatchInProgress); this checks the listener side of that.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as listeners from '../src/capture/listeners';
import * as gate from '../src/capture/game-mode-gate';

type Listener = (payload: any) => void;

describe('round start signal', () => {
  let onInfo: Listener | undefined;
  let onEvents: Listener | undefined;

  beforeEach(() => {
    onInfo = onEvents = undefined;
    vi.stubGlobal('overwolf', {
      games: { events: {
        onInfoUpdates2: { addListener: (cb: Listener) => { onInfo = cb; }, removeListener: () => {} },
        onNewEvents:    { addListener: (cb: Listener) => { onEvents = cb; }, removeListener: () => {} },
        onError:        { addListener: () => {} },
      } },
      io: { paths: { documents: '' }, enums: { eEncoding: { UTF8: 'UTF8' } }, readFileContents: () => {}, writeFileContents: () => {} },
    });
    vi.stubGlobal('window', {});
  });

  it('fires on round_start, and not on a game_mode update', () => {
    const roundStarted = vi.fn();
    const modeChanged = vi.fn();
    listeners.setOnRoundStarted(roundStarted);
    listeners.setOnGameModeChanged(modeChanged);
    listeners.attachListeners();

    onInfo!({ feature: 'match_info', info: { match_info: { game_mode: 'TFT' } } });
    expect(modeChanged).toHaveBeenCalled();
    expect(roundStarted).not.toHaveBeenCalled();

    gate.handleGameModeUpdate('tft');
    onEvents!({ events: [{ name: 'round_start', data: 'PVP' }] });
    expect(roundStarted).toHaveBeenCalledTimes(1);

    onEvents!({ events: [{ name: 'battle_start', data: '' }] });
    expect(roundStarted).toHaveBeenCalledTimes(1);
    listeners.detachListeners();
  });
});
