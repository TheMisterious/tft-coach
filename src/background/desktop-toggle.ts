// The toggle hotkey: brings the desktop window (the coaching report) into view
// and into focus, or puts it away.
//
// It used to be registered on overwolf.hotkeys.onHotkeyDown, which is not an
// Overwolf API — optional chaining turned that into a silent no-op, and the
// only thing the hotkey ever did was the manifest's built-in "toggle", which
// shows or hides the window but never focuses it. A desktop window restored
// behind a fullscreen game stays out of sight, so to the user (and Overwolf QA)
// the hotkey did nothing. The manifest hotkey is now "custom" and handled here.

declare const overwolf: any;

import { HOTKEY_NAME } from '../shared/hotkey';
import { ensureWindowOnScreen } from './window-position';

export function registerToggleHotkey(): void {
  const pressed = overwolf.settings?.hotkeys?.onPressed;
  if (!pressed) {
    console.error('[hotkey] overwolf.settings.hotkeys.onPressed unavailable — the toggle hotkey will not work');
    return;
  }
  pressed.addListener((event: { name?: string }) => {
    if (event?.name === HOTKEY_NAME) toggleDesktopWindow();
  });
}

// Hidden or minimized: restore it and take focus. Showing while the game has
// focus (behind a fullscreen game, or on another monitor): take focus.
// Showing and already focused: minimize, so the key still toggles.
export function toggleDesktopWindow(): void {
  overwolf.windows.obtainDeclaredWindow('desktop', (res: any) => {
    if (!res?.success) return;
    const win = res.window;
    const showing = win.stateEx === 'normal' || win.stateEx === 'maximized';
    if (!showing) {
      ensureWindowOnScreen(win, () => overwolf.windows.restore(win.id, () => focusWindow(win.id)));
      return;
    }
    gameHasFocus(inGame => {
      if (inGame) focusWindow(win.id);
      else overwolf.windows.minimize(win.id);
    });
  });
}

// Show and focus, never hide — for returning the player from somewhere else
// (the browser, after Riot sign-in), where a toggle could minimize instead.
export function showDesktopWindow(): void {
  overwolf.windows.obtainDeclaredWindow('desktop', (res: any) => {
    if (!res?.success) return;
    const win = res.window;
    ensureWindowOnScreen(win, () => overwolf.windows.restore(win.id, () => focusWindow(win.id)));
  });
}

// grabFocus=true is what brings a desktop window in front of a fullscreen
// game (Overwolf minimizes the game to do it); without it the window is raised
// behind the game. Only ever called from an explicit hotkey press — the
// report-ready path restores the window without taking focus on purpose.
function focusWindow(windowId: string): void {
  overwolf.windows.bringToFront(windowId, true, (result: any) => {
    if (result && result.success === false) console.warn('[hotkey] bringToFront(desktop) failed:', result.error);
  });
}

function gameHasFocus(callback: (focused: boolean) => void): void {
  overwolf.games.getRunningGameInfo((info: any) => {
    const game = info?.gameInfo ?? info;
    callback(!!game?.isRunning && !!(game.gameIsInFocus ?? game.isInFocus));
  });
}
