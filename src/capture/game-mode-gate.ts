// TFT and LoL share gameID 21570. Without this gate, your coach runs on LoL matches.
// Every GEP handler in listeners.ts must call `if (!isInTft()) return;` at the top.

let currentMode: 'tft' | 'lol' | null = null;

export function isInTft(): boolean {
  return currentMode === 'tft';
}

export function getGameMode(): 'tft' | 'lol' | 'unknown' {
  return currentMode ?? 'unknown';
}

export function handleGameModeUpdate(mode: string): void {
  const lower = (mode ?? '').toLowerCase();
  const prev = currentMode;

  if (lower.startsWith('tft')) {
    currentMode = 'tft';
  } else if (lower === 'lol') {
    // TFT runs inside the League client — GEP's match_info.game_mode always reports "lol"
    // even during TFT sessions. If TFT was already confirmed (via the pre-seed in
    // onGameLaunched after successful GEP registration, or via TFT signal features),
    // do not let this "lol" string override it.
    if (currentMode !== 'tft') {
      currentMode = 'lol';
    }
  } else {
    // Unknown sub-mode (e.g. tutorial variant, future mode string) — keep whatever
    // was already set so we don't accidentally kill event capture mid-session.
    console.warn(`[capture] unrecognized game_mode: "${mode}" — keeping ${currentMode ?? 'unknown'}`);
    return;
  }

  if (prev !== currentMode) {
    console.log(`[capture] game mode changed: ${prev ?? 'none'} → ${currentMode ?? 'none'}`);
    if (currentMode === 'lol') {
      console.log('[capture] pausing — LoL match detected, TFT coaching suspended');
    }
  }
}

export function resetGameMode(): void {
  currentMode = null;
}
