// Normalises raw onInfoUpdates2 / onNewEvents payloads and feeds the ledger.
// Every sub-key value is independently stringified by GEP — parse each with safeParseGep.

declare const overwolf: any;
declare const window: any;

import { safeParseGep } from './safe-parse';
import { isInTft, handleGameModeUpdate, getGameMode } from './game-mode-gate';
import { appendEvent } from '../ledger/ledger';

type RawInfo = { feature: string; info: Record<string, Record<string, unknown>> };

const TFT_SIGNAL_INFO_FEATURES = new Set(['board', 'bench', 'store', 'augments']);

let attached = false;

// Callbacks fired when significant state changes occur.
let onMatchStartedCb: (() => void) | null = null;
let onMatchEndedCb: (() => void) | null = null;
let onGameModeChangedCb: ((mode: 'tft' | 'lol' | 'unknown') => void) | null = null;

export function setOnMatchStarted(cb: () => void): void { onMatchStartedCb = cb; }
export function setOnMatchEnded(cb: () => void): void { onMatchEndedCb = cb; }
export function setOnGameModeChanged(cb: (mode: 'tft' | 'lol' | 'unknown') => void): void { onGameModeChangedCb = cb; }

// Prevent the info-update match_end path from double-firing the pipeline.
let matchEndFiredFromInfo = false;
export function resetMatchEndFlag(): void { matchEndFiredFromInfo = false; }

// Exposed so the background window can feed getInfo() results into the same pipeline
// that handles onInfoUpdates2, capturing state that was set before listener attachment.
export function injectInfoUpdate(feature: string, key: string, rawValue: unknown): void {
  const ts = Date.now();
  const value = safeParseGep(rawValue, null);
  console.log(`[listeners] injectInfoUpdate: ${feature}.${key} raw=`, rawValue, 'parsed=', value);
  if (value === null) return;

  if (getGameMode() === 'unknown' && TFT_SIGNAL_INFO_FEATURES.has(feature)) {
    handleGameModeUpdate('tft');
    if ((window as any)?.appState) (window as any).appState.gameMode = getGameMode();
    onGameModeChangedCb?.(getGameMode());
  }

  if (feature === 'match_info' && key === 'game_mode') {
    handleGameModeUpdate(value as string);
    if ((window as any)?.appState) (window as any).appState.gameMode = getGameMode();
    onGameModeChangedCb?.(getGameMode());
  }

  if (feature === 'match_info' && key === 'pseudo_match_id') {
    onMatchStartedCb?.();
  }

  // Fallback: game_info.matchId arrives in the initial getInfo payload when pseudo_match_id doesn't.
  if (feature === 'game_info' && key === 'matchId') {
    onMatchStartedCb?.();
  }

  // Match-end detection for initial state from getInfo (same as the live onInfo path).
  // If the match ended before GEP registered, placement / match_outcome arrive here.
  if (!matchEndFiredFromInfo && isInTft()) {
    const isMatchEndSignal =
      (feature === 'me' && key === 'placement') ||
      (feature === 'match_info' && key === 'match_outcome');
    if (isMatchEndSignal) {
      console.log(`[listeners] match_end detected via initial state: ${feature}.${key} =`, value);
      matchEndFiredFromInfo = true;
      onMatchEndedCb?.();
    }
  }

  const allowPreGateMatchId =
    getGameMode() === 'unknown' && (
      (feature === 'match_info' && key === 'pseudo_match_id') ||
      (feature === 'game_info'  && key === 'matchId')
    );
  if (!isInTft() && !allowPreGateMatchId) return;

  appendEvent({ ts, kind: 'info', feature, key, value });
}

export function attachListeners(): void {
  if (attached) {
    // Guard against double-registration — firing the same listener twice doubles events.
    console.warn('[listeners] already attached, skipping');
    return;
  }
  attached = true;

  overwolf.games.events.onInfoUpdates2.addListener(onInfo);
  overwolf.games.events.onNewEvents.addListener(onEvents);
  overwolf.games.events.onError.addListener((err: unknown) =>
    console.error('[gep] error', err)
  );

  console.log('[listeners] attached');
}

export function detachListeners(): void {
  if (!attached) return;
  overwolf.games.events.onInfoUpdates2.removeListener(onInfo);
  overwolf.games.events.onNewEvents.removeListener(onEvents);
  attached = false;
  console.log('[listeners] detached');
}

function onInfo(payload: RawInfo): void {
  const ts = Date.now();
  const { feature, info } = payload;
  const inner = info?.[feature] ?? {};

  // Log every info update so we can see what GEP actually sends.
  console.log('[listeners] onInfo:', feature, Object.keys(inner).join(','));

  if (getGameMode() === 'unknown' && TFT_SIGNAL_INFO_FEATURES.has(feature)) {
    // Some sessions emit TFT-only features before match_info.game_mode.
    handleGameModeUpdate('tft');
    if (window?.appState) {
      window.appState.gameMode = getGameMode();
    }
    onGameModeChangedCb?.(getGameMode());
    console.log(`[listeners] inferred TFT mode from feature: ${feature}`);
    console.log('[listeners] appState after inferred TFT mode:', window?.appState);
  }

  for (const [key, raw] of Object.entries(inner)) {
    const value = safeParseGep(raw, null);
    console.log(`[listeners] info update: ${feature}.${key} =`, value);
    if (value === null) continue;

    // Update the game-mode gate whenever match_info.game_mode arrives.
    if (feature === 'match_info' && key === 'game_mode') {
      handleGameModeUpdate(value as string);
      if (window?.appState) {
        window.appState.gameMode = getGameMode();
      }
      onGameModeChangedCb?.(getGameMode());
      console.log('[listeners] match_info.game_mode ->', value, 'appState:', window?.appState);
    }

    // Signal a new match starting when pseudo_match_id first arrives.
    if (feature === 'match_info' && key === 'pseudo_match_id') {
      onMatchStartedCb?.();
      console.log('[listeners] match_info.pseudo_match_id arrived -> triggered onMatchStarted, appState:', window?.appState);
    }

    // Fallback: game_info.matchId serves as match start signal when pseudo_match_id doesn't arrive.
    if (feature === 'game_info' && key === 'matchId') {
      onMatchStartedCb?.();
    }

    // Fallback match_end detection via info updates.
    // TFT GEP does not always fire the match_end event via onNewEvents.
    // Watch for me.placement (set when match ends and you receive a final rank)
    // and match_info.match_outcome as alternative signals.
    if (!matchEndFiredFromInfo && isInTft()) {
      const isMatchEndSignal =
        (feature === 'me' && key === 'placement') ||
        (feature === 'match_info' && key === 'match_outcome');
      if (isMatchEndSignal) {
        console.log(`[listeners] match_end detected via info update: ${feature}.${key} =`, value);
        matchEndFiredFromInfo = true;
        onMatchEndedCb?.();
      }
    }

    // match_info.pseudo_match_id can arrive before game_mode; keep it so
    // the end-of-match pipeline can resolve the ledger file.
    const allowPreGateMatchId =
      getGameMode() === 'unknown' && feature === 'match_info' && key === 'pseudo_match_id';
    if (!isInTft() && !allowPreGateMatchId) continue;

    appendEvent({ ts, kind: 'info', feature, key, value });
  }
}

function onEvents(payload: { events: Array<{ name: string; data: string }> }): void {
  const ts = Date.now();

  for (const ev of payload.events ?? []) {
    // Log every event regardless of TFT gate so we can see what GEP sends.
    console.log(`[listeners] onEvent: ${ev.name} (inTft=${isInTft()}) data=`, ev.data);
    if (!isInTft()) continue;

    // event.data is sometimes empty, sometimes a plain string, sometimes JSON.
    const parsed = safeParseGep(ev.data, ev.data);
    appendEvent({ ts, kind: 'event', name: ev.name, data: parsed });
  }
}
