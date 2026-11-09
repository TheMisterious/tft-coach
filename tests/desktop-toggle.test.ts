// The toggle hotkey must bring the report window into focus (Overwolf QA,
// 2026-11: "the hotkey does not bring the app into focus"). Driven against a
// fake `overwolf` that records the window calls made.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { registerToggleHotkey, toggleDesktopWindow } from '../src/background/desktop-toggle';
import { HOTKEY_NAME } from '../src/shared/hotkey';

type Call = [string, ...unknown[]];

function fakeOverwolf(stateEx: string, gameInFocus: boolean) {
  const calls: Call[] = [];
  let pressed: ((e: { name: string }) => void) | undefined;
  const win = { id: 'desktop-id', stateEx, left: 0, top: 0, width: 1280, height: 800 };
  (globalThis as any).overwolf = {
    settings: { hotkeys: { onPressed: { addListener: (cb: typeof pressed) => { pressed = cb; } } } },
    utils: { getMonitorsList: (cb: (r: unknown) => void) => cb({ success: true, displays: [] }) },
    games: { getRunningGameInfo: (cb: (r: unknown) => void) => cb({ isRunning: true, gameIsInFocus: gameInFocus }) },
    windows: {
      obtainDeclaredWindow: (_name: string, cb: (r: unknown) => void) => cb({ success: true, window: win }),
      restore:      (id: string, cb?: () => void) => { calls.push(['restore', id]); cb?.(); },
      minimize:     (id: string) => calls.push(['minimize', id]),
      bringToFront: (id: string, grabFocus: boolean, cb?: (r: unknown) => void) => { calls.push(['bringToFront', id, grabFocus]); cb?.({ success: true }); },
    },
  };
  return { calls, press: (name = HOTKEY_NAME) => pressed?.({ name }) };
}

describe('toggle hotkey', () => {
  beforeEach(() => { delete (globalThis as any).overwolf; });

  it('a minimized report window is restored and takes focus', () => {
    const ow = fakeOverwolf('minimized', true);
    toggleDesktopWindow();
    expect(ow.calls).toEqual([['restore', 'desktop-id'], ['bringToFront', 'desktop-id', true]]);
  });

  it('a window left behind the game is brought in front with focus, not minimized', () => {
    const ow = fakeOverwolf('normal', true);
    toggleDesktopWindow();
    expect(ow.calls).toEqual([['bringToFront', 'desktop-id', true]]);
  });

  it('a window that already has focus is minimized', () => {
    const ow = fakeOverwolf('normal', false);
    toggleDesktopWindow();
    expect(ow.calls).toEqual([['minimize', 'desktop-id']]);
  });

  it('registers on overwolf.settings.hotkeys.onPressed and ignores other hotkeys', () => {
    const ow = fakeOverwolf('hidden', true);
    registerToggleHotkey();
    ow.press('some_other_app_hotkey');
    expect(ow.calls).toEqual([]);
    ow.press();
    expect(ow.calls.at(-1)).toEqual(['bringToFront', 'desktop-id', true]);
  });

  it('the manifest hotkey is custom, so Overwolf does not run its own show/hide alongside ours', () => {
    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'public', 'manifest.json'), 'utf-8'));
    expect(manifest.data.hotkeys[HOTKEY_NAME]['action-type']).toBe('custom');
  });
});
