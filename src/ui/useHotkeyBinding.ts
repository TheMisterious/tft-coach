import { useEffect, useState } from 'react';
import { readHotkeyBinding, HOTKEY_NAME, GAME_ID } from '../shared/hotkey';

declare const overwolf: any;

// Live-reads the user's actual current binding for our one hotkey — never
// hardcode "Ctrl+F" (or whatever the manifest default is) in the UI, since
// the user may have remapped it in Overwolf's own Settings at any time.
export function useHotkeyBinding(): string | null {
  const [binding, setBinding] = useState<string | null>(null);

  useEffect(() => {
    const readBinding = () => readHotkeyBinding(setBinding);
    readBinding();
    overwolf.settings.hotkeys.onChanged.addListener(readBinding);
    return () => overwolf.settings.hotkeys.onChanged.removeListener(readBinding);
  }, []);

  return binding;
}

export { HOTKEY_NAME, GAME_ID };
