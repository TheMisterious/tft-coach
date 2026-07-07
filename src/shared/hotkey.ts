declare const overwolf: any;

export const HOTKEY_NAME = 'tft_coach_toggle';
export const GAME_ID = 21570;

// Plain (non-hook) read of the user's actual current binding for our one
// hotkey — never hardcode "Ctrl+F"/"Ctrl+Shift+T" anywhere, since the user
// may have remapped it in Overwolf's own Settings at any time. Usable from
// both React windows and the plain-script background window.
export function readHotkeyBinding(callback: (binding: string | null) => void): void {
  overwolf.settings.hotkeys.get((result: any) => {
    if (!result?.success) {
      callback(null);
      return;
    }
    const fromGame   = result.games?.[GAME_ID]?.find((h: any) => h.name === HOTKEY_NAME);
    const fromGlobal = result.globals?.find((h: any) => h.name === HOTKEY_NAME);
    const hotkey = fromGame ?? fromGlobal;
    callback(hotkey && !hotkey.IsUnassigned ? hotkey.binding : null);
  });
}
