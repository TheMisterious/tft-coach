// Background window — the headless controller for the entire app.
// This window runs always while the app is live. It owns:
//   1. GEP registration and event listening
//   2. The ledger (append-only event log)
//   3. Triggering the coaching pipeline after match_end
//   4. Communication to desktop/in_game windows
//
// IMPORTANT: Call setRequiredFeatures ONLY from here — never from UI windows.

declare const overwolf: any;

import { registerTftFeatures,
         fetchAndDispatchInitialState } from '../capture/gep';
import { attachListeners,
         detachListeners,
         setOnMatchStarted,
         setOnMatchEnded,
         resetMatchEndFlag,
         setOnGameModeChanged,
         injectInfoUpdate }        from '../capture/listeners';
import { getGameMode,
         resetGameMode,
         handleGameModeUpdate }   from '../capture/game-mode-gate';
import { getCurrentMatchId,
         readLedger,
         resetLedger,
         appendEvent,
         flushSync,
         waitForFlush,
         forceMatchId }           from '../ledger/ledger';
import { reconstructSnapshots }   from '../ledger/rounds';
import { detectSet, loadMeta }    from '../enrichment/meta-lookup';
import { extractDecisionPoints }  from '../coach/rule-engine';
import { buildBrief }             from '../coach/brief-builder';
import { generateCoachingReport } from '../coach/report-generator';
import { saveMatch, loadMatch, listRecentMatches } from '../persistence/db';
import { summarizeLedgerCoverage, formatLedgerCoverage, sampleRawValues, formatRawSamples } from '../ledger/diagnostics';
import { ensureWindowOnScreen } from './window-position';
import { readHotkeyBinding } from '../shared/hotkey';
import { loadSettings, hasLinkedAccount } from '../persistence/settings';
import { getLeagueEntriesByPuuid, getMatchIdsByPuuid, getMatchById, formatRiotRank } from '../enrichment/riot-api';

// ─── State ────────────────────────────────────────────────────────────────────

(window as any).appState = {
  latestReport:  null as import('../shared/types').CoachingReport | null,
  matchHistory:  [] as import('../shared/types').MatchSummary[],
  isProcessing:  false,
  gameMode:      getGameMode(),
  gameRunning:   false,
  matchActive:   false,
  appStatus:     'no_game' as import('../shared/types').AppStatus,
};

function computeStatus(): import('../shared/types').AppStatus {
  const s = (window as any).appState;
  return s.matchActive ? 'in_match' : 'no_game';
}

// Push current status to the desktop window.
// start_window is "desktop" so getMainWindow() returns the desktop's global directly.
// We call receiveStatusUpdate() that the desktop exposes on its window object.
// sendMessage is kept as a fallback in case the function isn't ready yet.
function pushStatusToDesktop(): void {
  const s = (window as any).appState;
  try {
    const mw = (overwolf.windows.getMainWindow() as any);
    if (typeof mw?.receiveStatusUpdate === 'function') {
      mw.receiveStatusUpdate(s.appStatus);
      return;
    }
  } catch (_) {}
  overwolf.windows.obtainDeclaredWindow('desktop', (result: any) => {
    if (!result.success) return;
    overwolf.windows.sendMessage(
      result.window.id, 'status_update',
      { appStatus: s.appStatus },
      () => {}
    );
  });
}

// Fallback: info-update based match_end (fires when me.placement or match_info.match_outcome arrives).
// The primary path is the onNewEvents 'match_end' event below; this fires when that doesn't.
setOnMatchEnded(() => {
  console.log('[bg] match_end detected via info-update fallback');
  runCoachingPipeline();
});

// Wire callbacks so listeners can push state changes without circular imports.
setOnMatchStarted(() => {
  const s = (window as any).appState;
  s.matchActive = true;
  s.appStatus   = computeStatus();
  console.log('[bg] onMatchStarted ->', s.appStatus);
  pushStatusToDesktop();
});

setOnGameModeChanged((mode) => {
  const s = (window as any).appState;
  if (mode === 'tft') {
    s.matchActive = true;
  }
  s.appStatus = computeStatus();
  console.log('[bg] onGameModeChanged ->', mode, s.appStatus);
  pushStatusToDesktop();
});

// ─── Game lifecycle ───────────────────────────────────────────────────────────

async function onGameLaunched(): Promise<void> {
  const state = (window as any).appState;
  state.gameRunning = true;
  state.matchActive = true;
  state.appStatus   = computeStatus();
  pushStatusToDesktop();
  // Pre-seed TFT mode immediately. The manifest targets only game 21570 (TFT),
  // so any game reaching this handler is TFT. Without this, events are silently
  // dropped while we wait for match_info.game_mode to arrive from GEP.
  handleGameModeUpdate('tft');
  state.gameMode = getGameMode();
  console.log('[bg] game launched — registering GEP features');
  const ok = await registerTftFeatures();
  if (ok) {
    attachListeners();
    // Pull in any game state that was set before our listeners attached.
    fetchAndDispatchInitialState(injectInfoUpdate);
  } else {
    // GEP registration timed out — likely LoL is running, not TFT yet.
    // Reset gameRunning so the next onGameInfoUpdated event can retry.
    state.gameRunning = false;
    state.matchActive = false;
    state.appStatus   = computeStatus();
    resetGameMode();
    console.warn('[bg] GEP registration failed — will retry on next game event');
    pushStatusToDesktop();
  }
}

function onGameClosed(): void {
  console.log('[bg] game closed — detaching listeners');
  detachListeners();
  resetGameMode();
  const state = (window as any).appState;
  state.gameRunning = false;
  state.gameMode    = 'unknown';

  // Safety net: if match_end never fired (race, alt-F4, GEP late registration)
  // but we captured ledger data, run the pipeline now so the report isn't lost.
  const matchId = getCurrentMatchId();
  if (matchId && !state.isProcessing) {
    console.log('[bg] game closed with pending match — triggering pipeline for:', matchId);
    state.matchActive = false;
    state.appStatus   = computeStatus();
    pushStatusToDesktop();
    runCoachingPipeline();
    return;
  }

  state.matchActive = false;
  state.appStatus   = computeStatus();
  console.log('[bg] game closed ->', state.appStatus);
  pushStatusToDesktop();
}

// TFT's Overwolf class ID. The manifest targets this game exclusively, but
// onGameInfoUpdated fires for ANY running game (e.g. LoL client = 5426).
// Without this guard, detecting LoL first sets gameRunning=true and the
// subsequent TFT launch is silently ignored.
const TFT_CLASS_ID = 21570;
const LOL_CLASS_ID  = 5426; // TFT runs inside the League client — Overwolf reports classId 5426 for both

function isTftGame(gameInfo: any): boolean {
  const cid = gameInfo?.classId;
  // TFT always appears as classId 5426 (League executable) in onGameInfoUpdated.
  // classId 21570 is kept for standalone TFT builds and older Overwolf versions.
  // setRequiredFeatures will fail if only LoL is running, so false positives are safe.
  return !cid || cid === TFT_CLASS_ID || cid === LOL_CLASS_ID;
}

overwolf.games.onGameInfoUpdated.addListener(async (info: any) => {
  const gameInfo = info?.gameInfo;
  // Log every event so the Overwolf DevTools console reveals the real classId.
  console.log(`[bg] onGameInfoUpdated: classId=${gameInfo?.classId} title="${gameInfo?.title}" isRunning=${gameInfo?.isRunning} runningChanged=${info?.runningChanged} gameChanged=${info?.gameChanged}`);
  if (!gameInfo) return;

  if (!isTftGame(gameInfo)) {
    console.log(`[bg] skipping non-TFT game: classId=${gameInfo?.classId}`);
    return;
  }

  const s = (window as any).appState;
  const nowRunning = !!(gameInfo.isRunning);

  if (nowRunning && !s.gameRunning) {
    await onGameLaunched();
  } else if (!nowRunning && s.gameRunning) {
    onGameClosed();
  }
});

// Poll for a game that was already running when the background page loaded.
// A single getRunningGameInfo call can race — the Overwolf process may not have
// registered TFT in its game table yet at the exact moment we ask. Retry until we
// see TFT (or give up after ~30 s so we don't poll forever mid-session).
let _startupPoll = 0;
function pollRunningGame(): void {
  overwolf.games.getRunningGameInfo((info: any) => {
    const gameInfo = info?.gameInfo ?? info;
    console.log(`[bg] poll #${_startupPoll + 1}: classId=${gameInfo?.classId} title="${gameInfo?.title}" isRunning=${gameInfo?.isRunning}`);
    const s = (window as any).appState;
    if (gameInfo?.isRunning && isTftGame(gameInfo) && !s.gameRunning) {
      console.log('[bg] TFT detected via startup poll #' + (_startupPoll + 1));
      onGameLaunched();
    } else if (!s.gameRunning && _startupPoll < 10) {
      _startupPoll++;
      setTimeout(pollRunningGame, 1000);
    }
  });
}
pollRunningGame();

// ─── Match end pipeline ───────────────────────────────────────────────────────

// The listeners.ts module calls appendEvent() for every GEP update.
// When match_end fires, appendEvent flushes the ledger, then this handler runs.
overwolf.games.events.onNewEvents.addListener(async (payload: any) => {
  for (const ev of payload?.events ?? []) {
    if (ev.name === 'match_end') {
      await runCoachingPipeline();
    }
  }
});

async function runCoachingPipeline(): Promise<void> {
  const state = (window as any).appState;
  if (state.isProcessing) return;
  state.isProcessing = true;
  state.matchActive  = false;
  state.appStatus    = computeStatus();
  pushStatusToDesktop();

  // Yield one microtask tick so the synchronous listeners.ts onEvents handler
  // (which fires in the same Overwolf event dispatch as this listener) can finish
  // calling appendEvent(match_end) before we flush.  Without this yield, the pipeline
  // flushes 2953 entries, then listeners.ts flushes 1 more (the match_end event) —
  // that second write overwrites the first because Overwolf writeFileContents always
  // overwrites (its 4th param is triggerUacIfRequired, not append).  After the yield,
  // match_end is already in the buffer, so we get ONE write with all entries.
  await Promise.resolve();

  // The info-update fallback in listeners.ts latches on whichever match-end signal
  // (me.placement or match_info.match_outcome) arrives first. When match_outcome wins
  // the race, the pipeline used to run before me.placement had ever been pushed to us,
  // so extractFinalPlacement() found nothing and silently fell back to 8th place.
  // Pull GEP's live state directly here — getInfo() returns the authoritative current
  // value regardless of which push event fired, closing that race.
  await fetchAndDispatchInitialState(injectInfoUpdate);

  let matchId = getCurrentMatchId();
  if (!matchId) {
    // GEP delivered match_end before pseudo_match_id (known race condition).
    // Generate a fallback ID, stamp it on the ledger, and flush the buffer to
    // disk so buffered events aren't lost.
    matchId = `fallback-${Date.now()}`;
    forceMatchId(matchId);
    flushSync();
    console.warn('[bg] no pseudo_match_id from GEP — using fallback:', matchId);
  }

  // Wait for all in-flight writeFileContents to complete before reading.
  await waitForFlush();
  await waitForFlush();

  try {
    console.log('[bg] pipeline step 0: start — matchId:', matchId);

    // 1. Load ledger from disk.
    const ledger   = await readLedger(matchId);
    console.log('[bg] pipeline step 1: ledger loaded — entries:', ledger.length);
    if (ledger.length === 0) {
      console.warn('[bg] empty ledger for match:', matchId, '— aborting pipeline');
      return;
    }

    // 2. Reconstruct per-round snapshots.
    const snapshot = reconstructSnapshots(ledger);
    console.log('[bg] pipeline step 2: snapshots reconstructed — rounds:', snapshot.rounds.length, 'placement:', snapshot.finalPlacement);

    // 3. Load meta data for this set.
    const setId    = detectSet(ledger);
    console.log('[bg] pipeline step 3a: set detected —', setId);
    const meta     = await loadMeta(setId);
    console.log('[bg] pipeline step 3b: meta loaded — champions:', Object.keys(meta.champions ?? {}).length);

    // 4. Run rule engine.
    const points   = extractDecisionPoints(snapshot, meta);
    console.log('[bg] pipeline step 4: rule engine done — decision points:', points.length);

    // 5. Build the compact report brief.
    const brief    = buildBrief(snapshot, points, meta);
    console.log('[bg] pipeline step 5: brief built — resolvedNotes:', brief.resolvedNotes?.length, 'pendingPoints:', brief.decisionPoints?.length);

    // 6. Generate the report summary.
    showInGameToast('Generating coaching report…');
    const report   = await generateCoachingReport(brief);
    console.log('[bg] pipeline step 6: report generated — grade:', report.overall_grade, 'notes:', report.notes?.length);

    // 7. Persist to localStorage (src/persistence/db.ts).
    const lastRound  = snapshot.rounds.at(-1)?.label ?? 'unknown';
    const datePlayed = Date.now();
    saveMatch({
      pseudoMatchId:  matchId,
      datePlayed,
      setId,
      placement:      snapshot.finalPlacement,
      lastRound,
      ledger,
      brief,
      coachingReport: report,
    });
    console.log('[bg] pipeline step 7: match saved to DB');

    // 8. Push to UI.
    state.latestReport = report;
    readHotkeyBinding((binding) => {
      showInGameToast(`Coaching report ready — press ${binding ?? '(hotkey not set)'} to view`);
    });
    console.log('[bg] pipeline step 8: opening desktop window');
    openDesktopWindow(report);

    // 9-10. Optional Riot API enrichment — fire-and-forget, never blocks or
    // risks the already-delivered local report on a network/key failure.
    runRiotEnrichment(matchId, snapshot.finalPlacement, datePlayed);

    console.log('[bg] pipeline complete — placement:', snapshot.finalPlacement);
  } catch (e) {
    console.error('[bg] pipeline error:', e);
    showInGameToast('Error generating report — check console');
  } finally {
    state.isProcessing = false;
    state.appStatus    = computeStatus();
    pushStatusToDesktop();
    resetLedger();
    resetMatchEndFlag();
  }
}

// ─── Window helpers ───────────────────────────────────────────────────────────

function openDesktopWindow(report: any): void {
  overwolf.windows.obtainDeclaredWindow('desktop', (result: any) => {
    console.log('[bg] obtainDeclaredWindow(desktop):', JSON.stringify({ success: result.success, id: result.window?.id, state: result.window?.stateEx }));
    if (!result.success) {
      console.error('[bg] failed to obtain desktop window:', result.error);
      return;
    }
    ensureWindowOnScreen(result.window, () => {
      overwolf.windows.restore(result.window.id, (restoreResult: any) => {
        console.log('[bg] restore(desktop):', JSON.stringify(restoreResult));
        try {
          const mw = (overwolf.windows.getMainWindow() as any);
          if (typeof mw?.receiveReport === 'function') {
            console.log('[bg] delivering report via receiveReport()');
            mw.receiveReport(report);
            return;
          }
          console.warn('[bg] receiveReport not found on main window — falling back to sendMessage');
        } catch (e) {
          console.error('[bg] getMainWindow() threw:', e);
        }
        console.log('[bg] delivering report via sendMessage');
        overwolf.windows.sendMessage(result.window.id, 'new_report', report, (msgResult: any) => {
          console.log('[bg] sendMessage(new_report):', JSON.stringify(msgResult));
        });
      });
    });
  });
}

function showInGameToast(message: string): void {
  overwolf.windows.obtainDeclaredWindow('in_game', (result: any) => {
    if (!result.success) return;
    overwolf.windows.sendMessage(result.window.id, 'toast', message, () => {});
  });
}

// ─── Optional Riot API enrichment ──────────────────────────────────────────
// Bring-your-own-key (see src/persistence/settings.ts). Both steps are
// best-effort: a bad/missing key, rate limit, or network failure here must
// never affect the core local pipeline above, which already fully succeeded
// by the time this runs.

async function runRiotEnrichment(matchId: string, finalPlacement: number, datePlayed: number): Promise<void> {
  const settings = loadSettings();
  if (!hasLinkedAccount(settings)) return;
  const { riotApiKey, puuid, continent, platform } = settings;

  // Step 9: rank refresh, pushed to the desktop window's StatusBar.
  try {
    const entries = await getLeagueEntriesByPuuid(puuid!, riotApiKey, platform);
    const label = formatRiotRank(entries);
    const mw = (overwolf.windows.getMainWindow() as any);
    if (typeof mw?.receiveRiotRank === 'function') mw.receiveRiotRank(label);
    console.log('[bg] riot step 9: rank refreshed —', label);
  } catch (e) {
    console.warn('[bg] riot step 9: rank refresh failed —', e);
  }

  // Step 10: placement cross-check against tft-match-v1 (final result only,
  // no round-by-round data — see enrichment/riot-api.ts). Diagnostic only,
  // never overwrites the GEP-derived finalPlacement.
  try {
    const matchIds = await getMatchIdsByPuuid(puuid!, riotApiKey, continent, 1);
    const riotMatchId = matchIds[0];
    if (!riotMatchId) return;
    const match = await getMatchById(riotMatchId, riotApiKey, continent);

    // Skip if this is clearly a different (later) match than the one we just
    // processed — e.g. the user already queued into a new game before this
    // async call resolved.
    const driftMs = Math.abs(match.info.game_datetime - datePlayed);
    if (driftMs > 5 * 60 * 1000) {
      console.log('[bg] riot step 10: skipped — most recent Riot match is', Math.round(driftMs / 1000), 's away from local match end');
      return;
    }

    const participant = match.info.participants.find(p => p.puuid === puuid);
    if (!participant) return;

    const record = loadMatch(matchId);
    if (!record) return;
    saveMatch({
      ...record,
      riotCrossCheck: {
        riotPlacement: participant.placement,
        matched: participant.placement === finalPlacement,
        checkedAt: Date.now(),
      },
    });
    console.log('[bg] riot step 10: placement cross-check —', 'local:', finalPlacement, 'riot:', participant.placement);
  } catch (e) {
    console.warn('[bg] riot step 10: placement cross-check failed —', e);
  }
}

// ─── Hotkey listener ──────────────────────────────────────────────────────────

overwolf.hotkeys?.onHotkeyDown?.addListener((result: any) => {
  if (result.name === 'tft_coach_toggle') {
    overwolf.windows.obtainDeclaredWindow('desktop', (res: any) => {
      if (!res.success) return;
      if (res.window.stateEx === 'normal' || res.window.stateEx === 'maximized') {
        overwolf.windows.minimize(res.window.id);
      } else {
        ensureWindowOnScreen(res.window, () => overwolf.windows.restore(res.window.id));
      }
    });
  }
});

// Open the desktop window and push the initial status once it's ready.
overwolf.windows.obtainDeclaredWindow('desktop', (result: any) => {
  if (!result.success) return;
  ensureWindowOnScreen(result.window, () => {
    overwolf.windows.restore(result.window.id, () => {
      // Small delay to let the desktop React tree mount before the first message arrives.
      setTimeout(pushStatusToDesktop, 500);
    });
  });
});

console.log('[bg] background controller started');

// ─── Dev debug helpers ────────────────────────────────────────────────────────
// Call from background DevTools console to simulate a game session without a
// real game running.
//
//   window.__debugSimulateGameLaunch()   — registers GEP + attaches listeners
//   window.__debugInfo(feature, key, value) — inject an info-update directly
//   window.__debugEvent(name, data)         — inject an event directly
//
// __debugInfo/__debugEvent bypass the GEP provider layer entirely, so they work
// even when setRequiredFeatures fails (no real game running).

(window as any).__debugSimulateGameLaunch = async () => {
  const s = (window as any).appState;
  handleGameModeUpdate('tft');
  s.gameRunning = true;
  s.gameMode    = getGameMode();
  s.matchActive = true;
  s.appStatus   = computeStatus();
  // Attempt feature registration — may succeed if gep-sim's provider is active.
  console.log('[debug] attempting setRequiredFeatures…');
  const ok = await registerTftFeatures(3);
  console.log(`[debug] setRequiredFeatures: ${ok ? 'OK' : 'failed — use __debugInfo/__debugEvent instead'}`);
  attachListeners();
  console.log('[debug] ready — fire gep-sim events, or use __debugInfo/__debugEvent');
};

// Direct injection — bypasses gep-sim and setRequiredFeatures entirely.
(window as any).__debugInfo = (feature: string, key: string, value: unknown) => {
  injectInfoUpdate(feature, key, value);
  console.log(`[debug] injected info: ${feature}.${key} =`, value);
};

(window as any).__debugEvent = (name: string, data: string = '') => {
  if (name === 'match_end') {
    console.log('[debug] injected match_end — running pipeline');
    runCoachingPipeline();
  } else {
    appendEvent({ ts: Date.now(), kind: 'event', name, data });
    console.log(`[debug] injected event: ${name}`);
  }
};

// Reports which GEP feature.key pairs actually showed up in a saved match's
// raw ledger — answers "did GEP send streak/rank/augments this game" from
// real captured data instead of guessing. Defaults to the most recent match.
//
//   window.__debugLedgerCoverage()            — most recent saved match
//   window.__debugLedgerCoverage('<matchId>') — a specific match
(window as any).__debugLedgerCoverage = (matchId?: string) => {
  const id = matchId ?? listRecentMatches(1)[0]?.pseudo_match_id;
  if (!id) {
    console.warn('[debug] no saved matches found — play a match first');
    return undefined;
  }
  const record = loadMatch(id);
  if (!record) {
    console.warn('[debug] no saved match found for id:', id);
    return undefined;
  }
  const coverage = summarizeLedgerCoverage(record.ledger);
  console.log(`[debug] ledger coverage for ${id} (placement ${record.placement}, ${record.ledger.length} ledger entries):\n${formatLedgerCoverage(coverage)}`);
  return coverage;
};

// Pulls actual raw payload values for specific feature.key pairs from a saved
// match — use this before writing parsing logic for a newly-discovered key,
// since __debugLedgerCoverage only tells you a key exists, not its shape.
//
//   window.__debugRawSamples()                                — every key, 5 samples each, most recent match
//   window.__debugRawSamples(['roster.player_status'])         — just this key, most recent match
//   window.__debugRawSamples(['me.picked_augment'], '<matchId>') — a specific match
(window as any).__debugRawSamples = (keyFilter?: string[], matchId?: string) => {
  const id = matchId ?? listRecentMatches(1)[0]?.pseudo_match_id;
  if (!id) {
    console.warn('[debug] no saved matches found — play a match first');
    return undefined;
  }
  const record = loadMatch(id);
  if (!record) {
    console.warn('[debug] no saved match found for id:', id);
    return undefined;
  }
  const samples = sampleRawValues(record.ledger, 5, keyFilter);
  console.log(`[debug] raw value samples for ${id}:\n${formatRawSamples(samples)}`);
  return samples;
};

// Re-runs the coaching pipeline (steps 2-8 of runCoachingPipeline) against an
// already-saved match's raw ledger, using whatever parsing logic is live right
// now — lets a fix to reconstructSnapshots/checkers be verified against a real
// past match without needing to replay a new game. generateCoachingReport is
// fully local/deterministic (see report-generator.ts — no LLM call exists
// yet), so this has no external side effects; it does overwrite the saved
// record with the recomputed result.
//
//   window.__debugReprocessMatch()            — most recent saved match
//   window.__debugReprocessMatch('<matchId>') — a specific match
(window as any).__debugReprocessMatch = async (matchId?: string) => {
  const id = matchId ?? listRecentMatches(1)[0]?.pseudo_match_id;
  if (!id) {
    console.warn('[debug] no saved matches found — play a match first');
    return undefined;
  }
  const record = loadMatch(id);
  if (!record) {
    console.warn('[debug] no saved match found for id:', id);
    return undefined;
  }

  const snapshot   = reconstructSnapshots(record.ledger);
  const setId      = detectSet(record.ledger);
  const meta       = await loadMeta(setId);
  const points     = extractDecisionPoints(snapshot, meta);
  const brief      = buildBrief(snapshot, points, meta);
  const report     = await generateCoachingReport(brief);
  const lastRound  = snapshot.rounds.at(-1)?.label ?? 'unknown';

  console.log(`[debug] reprocessed ${id} — old placement:${record.placement} new placement:${snapshot.finalPlacement}, augments:${JSON.stringify(snapshot.augments)}, godPicks:${JSON.stringify(snapshot.godPicks)}`);

  saveMatch({
    pseudoMatchId:  id,
    datePlayed:     record.datePlayed,
    setId,
    placement:      snapshot.finalPlacement,
    lastRound,
    ledger:         record.ledger,
    brief,
    coachingReport: report,
  });
  (window as any).appState.latestReport = report;
  openDesktopWindow(report);
  return report;
};
