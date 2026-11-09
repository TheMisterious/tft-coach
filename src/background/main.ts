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
         setOnRoundStarted,
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
         forceMatchId,
         appendToSavedLedger,
         getLedgerDir }           from '../ledger/ledger';
import { reconstructSnapshots }   from '../ledger/rounds';
import { RIOT_LEDGER_FEATURE }    from '../ledger/placement';
import { detectSet, loadMeta }    from '../enrichment/meta-lookup';
import { extractDecisionPoints }  from '../coach/rule-engine';
import type { MatchHistoryEntry } from '../coach/history-context';
import { buildBrief }             from '../coach/brief-builder';
import { generateCoachingReport } from '../coach/report-generator';
import { buildMatchContext }      from '../coach/match-context';
import { isUsableCapture }        from '../coach/coverage';
import { pickLedgersToRecover }   from './recovery';
import { buildMatchPlan }         from '../coach/plan-builder';
import { extractFeatureVector }   from '../profile/feature-vector';
import { extractMatchLabels }     from '../profile/labels';
import { buildPlayerProfile }     from '../profile/trend-model';
import { saveMatch, loadMatch, listRecentMatches, loadAllFeatureRecords, savePlayerProfile } from '../persistence/db';
import { summarizeLedgerCoverage, formatLedgerCoverage, sampleRawValues, formatRawSamples } from '../ledger/diagnostics';
import { ensureWindowOnScreen } from './window-position';
import { readHotkeyBinding } from '../shared/hotkey';
import { registerToggleHotkey, showDesktopWindow } from './desktop-toggle';
import { loadSettings, hasLinkedAccount } from '../persistence/settings';
import { formatRiotRank, riotUnitsToBoardState, countBoardItems, type RiotMatch } from '../enrichment/riot-api';
import { getRank, getLatestMatch, BackendError } from '../enrichment/coachv-backend';
import { completeRiotSignIn, signInFailureMessage } from '../enrichment/riot-sign-in';

// ─── State ────────────────────────────────────────────────────────────────────

(window as any).appState = {
  latestReport:  null as import('../shared/types').CoachingReport | null,
  matchHistory:  [] as import('../shared/types').MatchSummary[],
  isProcessing:  false,
  gameMode:      getGameMode(),
  gameRunning:   false,
  matchActive:   false,
  appStatus:     'no_game' as import('../shared/types').AppStatus,
  // True once a real report has been generated for the current game session
  // (onGameLaunched..onGameClosed bracket). Blocks a second pipeline run —
  // see runCoachingPipeline's entry guard for why this is needed.
  pipelineRanThisSession: false,
  // The current game session's match is over (the pipeline has been triggered
  // for it, whatever came of that). Rounds after this are spectating.
  matchEnded: false,
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
//
// "In TFT match" means a match is being played, and only gameplay says so: a
// round starting, or a match id arriving. It used to be set by anything
// TFT-flavoured — the League client launching (it is running in the lobby), a
// game_mode update, and the getInfo() re-read the pipeline itself does at match
// end — so the status read "In TFT match" in the lobby and stayed there after
// every match until the client closed. Once this session's report has gone
// out, the rounds that follow are the lobby being spectated, not a match.
function markMatchInProgress(reason: string): void {
  const s = (window as any).appState;
  if (s.matchActive || s.isProcessing || s.matchEnded) return;
  s.matchActive = true;
  s.appStatus   = computeStatus();
  console.log('[bg] match in progress (', reason, ') ->', s.appStatus);
  pushStatusToDesktop();
}

setOnMatchStarted(() => markMatchInProgress('match id'));
setOnRoundStarted(() => markMatchInProgress('round_start'));

setOnGameModeChanged((mode) => {
  console.log('[bg] onGameModeChanged ->', mode);
});

// ─── Game lifecycle ───────────────────────────────────────────────────────────

async function onGameLaunched(): Promise<void> {
  const state = (window as any).appState;
  state.gameRunning = true;
  // Not matchActive: the client is running, which in the lobby is not a match.
  // markMatchInProgress() sets it when the first round starts.
  state.pipelineRanThisSession = false;
  state.matchEnded  = false;
  state.appStatus   = computeStatus();
  pushStatusToDesktop();
  // Pre-seed TFT mode immediately. The manifest targets only game 28164 (TFT),
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
  //
  // Gate on state.matchActive, NOT getCurrentMatchId() — currentMatchId only
  // gets set from a real pseudo_match_id/game_info.matchId GEP field, or from
  // runCoachingPipeline's own forceMatchId() fallback. If GEP never delivers
  // either match-id field for this match AND match_end/its info-fallback also
  // never fire (both known-flaky — me.placement never fires at all), matchId
  // stays null all game. flushSync() also gates on currentMatchId, so the
  // ledger never even reaches disk — the buffered match sits only in memory
  // and this branch used to skip it entirely, losing the match with zero
  // trace. matchActive is set independently at match start, so it survives
  // even when neither match-id field ever arrives. runCoachingPipeline
  // already handles a null matchId (forceMatchId + flushSync) and aborts
  // cleanly if the resulting ledger turns out empty.
  const matchId = getCurrentMatchId();
  if (state.matchActive && !state.isProcessing) {
    console.log('[bg] game closed with pending match — triggering pipeline (matchId:', matchId ?? '(none yet — will fall back)', ')');
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
const TFT_CLASS_ID = 28164;
const LOL_CLASS_ID  = 5426; // TFT runs inside the League client — Overwolf reports classId 5426 for both

function isTftGame(gameInfo: any): boolean {
  const cid = gameInfo?.classId;
  // TFT frequently appears as classId 5426 (League executable) in onGameInfoUpdated,
  // since TFT is launched from inside the League client. classId 28164 is TFT's own
  // entry in Overwolf's game list and is what the manifest targets.
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

// ─── Player Trends (see src/profile/) ───────────────────────────────────────
// Set-invariant behavioral feature extraction + incremental retrain, run
// right after every saveMatch. context is recomputed here rather than
// threaded out of extractDecisionPoints (which builds an equivalent context
// internally but doesn't return it) — consistent with this codebase's
// existing tolerance for cheap redundant recomputation of pure functions
// (checkers/combat.ts and positioning.ts both already independently call
// computeActiveComp rather than sharing one computed value).
function computeTrendData(
  snapshot: import('../shared/types').MatchSnapshot,
  meta: import('../shared/types').MetaData,
  points: import('../shared/types').DecisionPoint[]
): { featureVector: import('../shared/types').FeatureVector; matchLabels: import('../shared/types').MatchLabels } {
  const context = { ...buildMatchContext(snapshot, meta), plan: buildMatchPlan(snapshot, meta) };
  return {
    featureVector: extractFeatureVector(snapshot, points, context, meta),
    matchLabels:   extractMatchLabels(snapshot, context),
  };
}

// Rebuilds the whole-history PlayerProfile from every match's persisted
// featureVector/matchLabels — the "retrain" step. Cheap at this project's
// realistic scale (n<=200 matches, ~29 features), so it's just a function
// call after every save rather than a separate training pipeline.
// Prior matches' behavioural feature vectors, oldest first, for the rule
// engine's self-relative clauses (see src/coach/history-context.ts). Loaded
// here rather than inside the coach layer because architectural invariant 5
// keeps persistence out of the coaching logic — the engine takes history as an
// argument and stays a pure function of its inputs.
//
// loadAllFeatureRecords() returns the index order, which db.ts writes
// newest-first; history-context.ts wants a newest-LAST window, hence the
// reverse. `excludeMatchId` drops the match currently being reported on, so a
// regenerated report can never count this game toward its own "happened in N of
// your last 10" claim.
function priorFeatureHistory(excludeMatchId?: string): MatchHistoryEntry[] {
  try {
    const { records } = loadAllFeatureRecords();
    return records
      .filter(r => r.matchId !== excludeMatchId)
      .reverse();
  } catch (e) {
    console.warn('[bg] could not load match history for self-relative context —', e);
    return [];
  }
}

function retrainPlayerProfile(): void {
  const { records, skippedStaleSchemaCount } = loadAllFeatureRecords();
  const profile = buildPlayerProfile(records, skippedStaleSchemaCount);
  savePlayerProfile(profile);
  console.log('[bg] player profile retrained — sampleSize:', profile.sampleSize, 'confidence:', profile.confidence);
}

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
  if (state.pipelineRanThisSession) {
    // A real report already went out for this game session. Any further
    // trigger (typically onGameClosed's safety net firing on stray
    // round_start/round_end/battle_end noise from post-elimination spectate,
    // since the League client stays open watching remaining players finish)
    // is noise, not a second match. Ledger switches matchId on pseudo_match_id
    // changes, but spectate noise for the SAME match doesn't resend it, so the
    // existing zero-round guard below can't tell it apart from a real short
    // match — this flag is the actual fix. Drop the stray buffer so it can't
    // bleed into whatever the next real match's ledger becomes.
    console.log('[bg] pipeline already ran this session — ignoring duplicate trigger (likely post-elimination spectate noise)');
    resetLedger();
    return;
  }
  state.isProcessing = true;
  state.matchActive  = false;
  state.matchEnded   = true;
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
    if (snapshot.rounds.length === 0) {
      // A non-empty ledger with zero real rounds means GEP delivered a few
      // stray info-updates but no round_start/round_end pair ever fired —
      // e.g. staying in the post-game lobby to spectate other players can
      // re-trigger onMatchStartedCb (any pseudo_match_id sighting counts,
      // see listeners.ts) and then onGameClosed's safety net when you finally
      // leave, with nothing but spectate noise buffered under a phantom
      // matchId. Without this guard that produces a fake "8th place" report
      // (extractFinalPlacement's last-resort default) with no real data
      // behind it. A genuine match always reconstructs at least one round.
      console.warn('[bg] ledger has', ledger.length, 'entries but zero reconstructed rounds — likely spectate/lobby noise, not a real match; aborting pipeline for matchId:', matchId);
      return;
    }
    // Rounds alone don't make it the player's match: a ledger that began after
    // they were eliminated still gets round_start/round_end from the lobby
    // they're spectating. Those rounds are dropped in reconstruction, and a
    // capture that never saw the player's gold or board is that same noise —
    // the source of a QA report that coached "level 1, empty board" at 6-3.
    if (!isUsableCapture(snapshot)) {
      console.warn('[bg] capture is not a playable match (coverage:', JSON.stringify(snapshot.capture), ') — aborting pipeline for matchId:', matchId);
      return;
    }

    // Past this point we're committed to producing a real report for this
    // session — block any later trigger (see the entry guard above).
    state.pipelineRanThisSession = true;

    // 3. Load meta data for this set.
    const setId    = detectSet(ledger);
    console.log('[bg] pipeline step 3a: set detected —', setId);
    const meta     = await loadMeta(setId);
    console.log('[bg] pipeline step 3b: meta loaded — champions:', Object.keys(meta.champions ?? {}).length);

    // 4. Run rule engine.
    const points   = extractDecisionPoints(snapshot, meta, priorFeatureHistory());
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
    const { featureVector, matchLabels } = computeTrendData(snapshot, meta, points);
    const persisted = saveMatch({
      pseudoMatchId:  matchId,
      datePlayed,
      setId,
      placement:      snapshot.finalPlacement,
      placementSource: snapshot.placementSource,
      lastRound,
      brief,
      coachingReport: report,
      featureVector,
      matchLabels,
    });
    if (persisted) {
      console.log('[bg] pipeline step 7: match saved to DB');
      retrainPlayerProfile();
    } else {
      // The report still displays below (it's already in memory) but this
      // match won't appear in history — surface that now rather than let it
      // go unnoticed, since saveMatch used to be void and this failure mode
      // was previously silent.
      console.error('[bg] pipeline step 7: saveMatch failed — report will display but will NOT appear in match history');
    }

    // 8. Push to UI.
    state.latestReport = report;
    readHotkeyBinding((binding) => {
      const historyWarning = persisted ? '' : ' (history save failed — storage may be full)';
      // A set with no data/ folder only gets set-agnostic coaching (see
      // loadMeta) — say so, or the thinner report reads as the whole story.
      const setWarning = meta.setDataMissing ? ' (no data for this set yet — econ, HP, leveling and streak notes only)' : '';
      showInGameToast(`Coaching report ready${setWarning}${historyWarning} — press ${binding ?? '(hotkey not set)'} to view`);
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

// Rebuilds a saved match's record from its ledger on disk with the parsing and
// rules live now, keeping what the ledger cannot reproduce (datePlayed, the
// Riot cross-check). Never opens a window — callers decide that. Shared by
// the Riot placement recovery and the two debug entry points.
// datePlayed defaults to the ledger's last entry — when the match ended.
// Returns null for a ledger that is not a playable match (spectating noise, a
// fragment): those must never be saved as one.
async function rebuildMatchFromLedger(matchId: string, datePlayed?: number) {
  const ledger = await readLedger(matchId);
  if (ledger.length === 0) return null;

  const snapshot = reconstructSnapshots(ledger);
  if (!isUsableCapture(snapshot)) return null;
  datePlayed ??= ledger.at(-1)!.ts;
  const setId    = detectSet(ledger);
  const meta     = await loadMeta(setId);
  const points   = extractDecisionPoints(snapshot, meta, priorFeatureHistory(matchId));
  const brief    = buildBrief(snapshot, points, meta);
  const report   = await generateCoachingReport(brief);

  const { featureVector, matchLabels } = computeTrendData(snapshot, meta, points);
  const persisted = saveMatch({
    ...(loadMatch(matchId) ?? {}),
    pseudoMatchId:   matchId,
    datePlayed,
    setId,
    placement:       snapshot.finalPlacement,
    placementSource: snapshot.placementSource,
    lastRound:       snapshot.rounds.at(-1)?.label ?? 'unknown',
    brief,
    coachingReport:  report,
    featureVector,
    matchLabels,
  });
  if (persisted) retrainPlayerProfile();
  return { snapshot, report, persisted };
}

// ─── Recovering matches that were recorded but never reported ────────────────
// See recovery.ts. Runs once, shortly after the background window starts, and
// never during a match. The newest recovered report is handed to the desktop
// window's history without restoring the window, so it cannot pop up over a
// game.

const RECOVERY_CHECKED_KEY = 'tft:ledgers-checked';
const RECOVERY_DELAY_MS = 5000;

function loadCheckedLedgers(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(RECOVERY_CHECKED_KEY) ?? '[]') as string[]); }
  catch { return new Set(); }
}

function saveCheckedLedgers(ids: Set<string>): void {
  try { localStorage.setItem(RECOVERY_CHECKED_KEY, JSON.stringify([...ids].slice(-500))); }
  catch (e) { console.warn('[bg] recovery: could not remember checked ledgers —', e); }
}

function listLedgerFiles(): Promise<string[]> {
  return new Promise(resolve => {
    if (typeof overwolf.io?.dir !== 'function') { resolve([]); return; }
    overwolf.io.dir(getLedgerDir(), (result: any) => {
      resolve(result?.success
        ? (result.data ?? []).filter((f: any) => f?.type === 'file').map((f: any) => String(f.name))
        : []);
    });
  });
}

async function recoverUnreportedMatches(): Promise<void> {
  const state = (window as any).appState;
  if (state.matchActive || state.isProcessing) return;

  const checked = loadCheckedLedgers();
  const ids = pickLedgersToRecover(await listLedgerFiles(), id => !!loadMatch(id), checked, Date.now());
  if (ids.length === 0) return;
  console.log('[bg] recovery: building reports for', ids.length, 'recorded match(es) with none:', ids.join(', '));

  let newest: { report: any; datePlayed: number } | undefined;
  for (const id of ids) {
    checked.add(id);
    try {
      const rebuilt = await rebuildMatchFromLedger(id);
      if (!rebuilt?.persisted) {
        console.log('[bg] recovery:', id, rebuilt ? 'could not be saved' : 'is not a playable match — skipped');
        continue;
      }
      const datePlayed = loadMatch(id)?.datePlayed ?? 0;
      console.log('[bg] recovery:', id, 'recovered — placement', rebuilt.snapshot.finalPlacement);
      if (!newest || datePlayed > newest.datePlayed) newest = { report: rebuilt.report, datePlayed };
    } catch (e) {
      console.error('[bg] recovery:', id, 'failed —', e);
    }
  }
  saveCheckedLedgers(checked);

  if (newest) {
    state.latestReport = newest.report;
    try {
      const mw = (overwolf.windows.getMainWindow() as any);
      if (typeof mw?.receiveReport === 'function') mw.receiveReport(newest.report);
    } catch (e) {
      console.warn('[bg] recovery: desktop window not ready —', e);
    }
  }
}

setTimeout(() => { recoverUnreportedMatches(); }, RECOVERY_DELAY_MS);

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

// Toast duration must match index.tsx's own setTimeout(() => setToast(null), 5000)
// so the window minimizes right as the toast finishes fading, not before/after.
const TOAST_DURATION_MS = 5000;
const IN_GAME_WINDOW_POSITIONED_KEY = 'tft:in-game-window-positioned';

// The in_game window requires an explicit restore() before sendMessage —
// Overwolf won't render a minimized/never-shown window's content even if a
// message is delivered to it. Positioned bottom-right on first-ever call
// (typical toast corner); Overwolf persists position after that, so later
// calls just clamp it back on-screen via ensureWindowOnScreen. Minimized
// again after TOAST_DURATION_MS so it isn't sitting restored (and blocking
// game input over its full bounds) between toasts.
function showInGameToast(message: string): void {
  overwolf.windows.obtainDeclaredWindow('in_game', (result: any) => {
    if (!result.success) {
      console.error('[bg] failed to obtain in_game window:', result.error);
      return;
    }
    const win = result.window;

    function send() {
      overwolf.windows.restore(win.id, () => {
        overwolf.windows.sendMessage(win.id, 'toast', message, () => {});
        setTimeout(() => overwolf.windows.minimize(win.id), TOAST_DURATION_MS);
      });
    }

    if (localStorage.getItem(IN_GAME_WINDOW_POSITIONED_KEY)) {
      ensureWindowOnScreen(win, send);
      return;
    }

    overwolf.utils.getMonitorsList((monitorsResult: any) => {
      const monitors = monitorsResult?.success ? monitorsResult.displays ?? [] : [];
      const primary  = monitors.find((m: any) => m.is_primary) ?? monitors[0];
      localStorage.setItem(IN_GAME_WINDOW_POSITIONED_KEY, '1');

      if (!primary) {
        send();
        return;
      }

      const margin = 20;
      const left = Math.round(primary.x + primary.width - win.width - margin);
      const top  = Math.round(primary.y + primary.height - win.height - margin);
      overwolf.windows.changePosition(win.id, left, top, () => send());
    });
  });
}

// ─── Optional Riot API enrichment ──────────────────────────────────────────
// For a player signed in with Riot (src/enrichment/riot-sign-in.ts), through
// the coachv backend (src/enrichment/coachv-backend.ts). Both steps are
// best-effort: no account, an expired session, a rate limit or a network
// failure here must never affect the core local pipeline above, which already
// fully succeeded by the time this runs.

const SIGN_IN_EXPIRED_LABEL = 'Riot sign-in expired — sign in again in ⚙';

const RIOT_PLACEMENT_RETRY_DELAYS_MS = [0, 60_000, 180_000];

async function runRiotEnrichment(matchId: string, finalPlacement: number, datePlayed: number): Promise<void> {
  const settings = loadSettings();
  if (!hasLinkedAccount(settings)) return;
  const { platform } = settings;
  const { puuid, session } = settings.account!;

  // Step 9: rank refresh, pushed to the desktop window's StatusBar.
  try {
    const entries = await getRank(session, platform);
    const label = formatRiotRank(entries);
    const mw = (overwolf.windows.getMainWindow() as any);
    if (typeof mw?.receiveRiotRank === 'function') mw.receiveRiotRank(label);
    console.log('[bg] riot step 9: rank refreshed —', label);
  } catch (e) {
    console.warn('[bg] riot step 9: rank refresh failed —', e);
    // Surface a lapsed session in the status bar instead of only logging, so
    // the player knows why rank/cross-check stopped updating.
    if (e instanceof BackendError && e.status === 401) {
      const mw = (overwolf.windows.getMainWindow() as any);
      if (typeof mw?.receiveRiotRank === 'function') mw.receiveRiotRank(SIGN_IN_EXPIRED_LABEL, true);
    }
  }

  // Step 10: Riot's official placement (tft-match-v1 — final result only, no
  // round-by-round data, see enrichment/riot-api.ts). Always appended to the
  // ledger, so every later replay and scripts/rule-audit.ts sees it. When GEP
  // sent no placement at all — the client closed straight after elimination —
  // the saved record is rebuilt from that ledger so history and Player Trends
  // get the real result instead of a placeholder 8th. A GEP placement is never
  // overridden: a disagreement is recorded in riotCrossCheck only.
  try {
    const record = loadMatch(matchId);
    if (!record) return;
    const gepHadNone = record.placementSource === 'none';

    // Riot publishes a match a minute or two after it ends, and a client closed
    // on elimination gets here sooner than that — so a match whose placement
    // depends on this lookup is retried rather than given up after one call.
    let match: RiotMatch | null = null;
    for (const delayMs of gepHadNone ? RIOT_PLACEMENT_RETRY_DELAYS_MS : [0]) {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      const candidate = await getLatestMatch(session, platform);
      if (!candidate) continue;
      // Skip a clearly different match — the previous one (not yet published
      // this one), or a later one the user already queued into.
      const driftMs = Math.abs(candidate.info.game_datetime - datePlayed);
      if (driftMs > 5 * 60 * 1000) {
        console.log('[bg] riot step 10: most recent Riot match is', Math.round(driftMs / 1000), 's away from local match end — not this one');
        continue;
      }
      match = candidate;
      break;
    }
    if (!match) return;

    const participant = match.info.participants.find(p => p.puuid === puuid);
    if (!participant) return;

    await appendToSavedLedger(matchId, [{
      ts: Date.now(), kind: 'info', feature: RIOT_LEDGER_FEATURE, key: 'placement', value: participant.placement,
    }]);
    if (gepHadNone) {
      await rebuildMatchFromLedger(matchId, record.datePlayed);
      console.log('[bg] riot step 10: GEP sent no placement — record rebuilt with Riot\'s', participant.placement);
    }

    const current = loadMatch(matchId) ?? record;
    saveMatch({
      ...current,
      riotCrossCheck: {
        riotPlacement: participant.placement,
        matched: participant.placement === current.placement,
        checkedAt: Date.now(),
      },
    });
    console.log('[bg] riot step 10: placement cross-check —', 'local:', finalPlacement, 'riot:', participant.placement);

    // Step 11 used to regenerate and re-send a second report when Riot's
    // final board had more equipped items than GEP captured. That created a
    // confusing "second report" after the match was already finished and the
    // local report was visible. Keep the cross-check for diagnostics, but do
    // not overwrite or redisplay the user's first report here.
    try {
      const riotBoard = riotUnitsToBoardState(participant.units ?? []);
      const localSnapshot = reconstructSnapshots(await readLedger(matchId));
      if (countBoardItems(riotBoard) <= countBoardItems(localSnapshot.finalBoard)) {
        console.log('[bg] riot step 11: GEP finalBoard already at least as complete as Riot\'s — no reprocess needed');
        return;
      }

      console.log('[bg] riot step 11: Riot\'s final board has more equipped items than GEP captured — keeping the original report and only recording the diagnostic cross-check');
    } catch (e) {
      console.warn('[bg] riot step 11: finalBoard reconciliation failed —', e);
    }
  } catch (e) {
    console.warn('[bg] riot step 10: placement cross-check failed —', e);
  }
}

// ─── Hotkey listener ──────────────────────────────────────────────────────────

// See desktop-toggle.ts for why this is a custom hotkey that takes focus.
registerToggleHotkey();

// ─── Riot sign-in return ────────────────────────────────────────────────────
// The backend sends the browser to coachv://rso?… once Riot sign-in finishes;
// Overwolf delivers that link to the running app here (manifest
// data.url_protocol). The docs name the fields both origin/parameter and
// source/url, so both are read.
overwolf.extensions?.onAppLaunchTriggered?.addListener((event: any) => {
  const origin = event?.origin ?? event?.source;
  const link = String(event?.parameter ?? event?.url ?? '');
  if (origin !== 'urlscheme' || !link) return;

  const result = completeRiotSignIn(link);
  if (!result.ok && result.reason === 'not_ours') return;
  console.log('[bg] riot sign-in:', result.ok ? `signed in as ${result.account.gameName}#${result.account.tagLine}` : result.reason);

  const mw = (overwolf.windows.getMainWindow() as any);
  if (typeof mw?.receiveRiotSignIn === 'function') {
    mw.receiveRiotSignIn(result.ok ? { ok: true } : { ok: false, message: signInFailureMessage(result.reason) });
  }
  // The player is in their browser; bring them back to where they started.
  showDesktopWindow();
});

// Make sure the desktop window exists and is on-screen, but do NOT restore it
// here. Restoring on background startup can steal focus and kick the user out
// of gameplay when Overwolf reloads or re-attaches the controller. The desktop
// window is restored explicitly only when we actually need to show a report or
// when the user toggles it with the hotkey.
overwolf.windows.obtainDeclaredWindow('desktop', (result: any) => {
  if (!result.success) return;
  ensureWindowOnScreen(result.window, () => {
    // Small delay to let the desktop React tree mount before the first status
    // message arrives. No restore() call here on purpose.
    setTimeout(pushStatusToDesktop, 500);
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
(window as any).__debugLedgerCoverage = async (matchId?: string) => {
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
  const ledger = await readLedger(id);
  const coverage = summarizeLedgerCoverage(ledger);
  console.log(`[debug] ledger coverage for ${id} (placement ${record.placement}, ${ledger.length} ledger entries):\n${formatLedgerCoverage(coverage)}`);
  return coverage;
};

// Pulls actual raw payload values for specific feature.key pairs from a saved
// match — use this before writing parsing logic for a newly-discovered key,
// since __debugLedgerCoverage only tells you a key exists, not its shape.
//
//   window.__debugRawSamples()                                — every key, 5 samples each, most recent match
//   window.__debugRawSamples(['roster.player_status'])         — just this key, most recent match
//   window.__debugRawSamples(['me.picked_augment'], '<matchId>') — a specific match
(window as any).__debugRawSamples = async (keyFilter?: string[], matchId?: string) => {
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
  const ledger = await readLedger(id);
  const samples = sampleRawValues(ledger, 5, keyFilter);
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

  const rebuilt = await rebuildMatchFromLedger(id, record.datePlayed);
  if (!rebuilt) {
    console.warn('[debug] no ledger found on disk for matchId:', id);
    return undefined;
  }
  const { snapshot, report } = rebuilt;

  console.log(`[debug] reprocessed ${id} — old placement:${record.placement} new placement:${snapshot.finalPlacement} (${snapshot.placementSource}), augments:${JSON.stringify(snapshot.augments)}, godPicks:${JSON.stringify(snapshot.godPicks)}`);

  (window as any).appState.latestReport = report;
  openDesktopWindow(report);
  return report;
};

// Recovers a match whose ledger reached disk but never made it into DB —
// e.g. saveMatch failing on a localStorage quota error (see the eviction
// retry in src/persistence/db.ts). __debugReprocessMatch above requires
// loadMatch(id) to already succeed, so it can't help here; this reads
// straight from the ledger file instead of requiring an existing DB record.
//
//   window.__debugRecoverMatch('<matchId>') — matchId from the failed
//   "[db] saveMatch failed" log line (e.g. "fallback-1785165189062")
(window as any).__debugRecoverMatch = async (matchId: string) => {
  const rebuilt = await rebuildMatchFromLedger(matchId, Date.now());
  if (!rebuilt) {
    console.warn('[debug] no ledger found on disk for matchId:', matchId);
    return undefined;
  }
  const { snapshot, report, persisted } = rebuilt;
  console.log(`[debug] recovered ${matchId} — placement:${snapshot.finalPlacement} (${snapshot.placementSource}) persisted:${persisted}`);
  if (persisted) {
    (window as any).appState.latestReport = report;
    openDesktopWindow(report);
  }
  return report;
};

// One-time backfill: attaches featureVector/matchLabels to every already-
// indexed match that doesn't have them yet (older matches saved before the
// Player Trends feature existed), then retrains the profile once at the end.
//
// Index-only, by design: this only reaches matches already present in
// tft:index/tft:match:<id>. It does NOT enumerate raw .jsonl ledger files
// that have no matching index entry (e.g. from a save that hit the
// localStorage quota) — that would need Overwolf's directory-listing API
// (overwolf.io.dir), which nothing in this codebase uses or has verified yet.
// Treat "sweep up orphaned ledger files" as a separate follow-up, not done here.
//
//   window.__debugBackfillFeatureVectors()
(window as any).__debugBackfillFeatureVectors = async () => {
  const summaries = listRecentMatches(200);
  let processed = 0;
  let skipped   = 0;

  for (const s of summaries) {
    const record = loadMatch(s.pseudo_match_id);
    if (!record) { skipped++; continue; }
    if (record.featureVector && record.matchLabels) { skipped++; continue; } // already backfilled

    const ledger = await readLedger(s.pseudo_match_id);
    if (ledger.length === 0) { skipped++; continue; }

    const snapshot = reconstructSnapshots(ledger);
    if (snapshot.rounds.length === 0) { skipped++; continue; }

    const setId = detectSet(ledger);
    const meta  = await loadMeta(setId);
    // No history passed deliberately: this loop backfills featureVector/
    // matchLabels for old matches and throws the points away. A history clause
    // here would be computed and discarded, and worse, each backfilled match
    // would see a different slice of history depending on loop order.
    const points = extractDecisionPoints(snapshot, meta);
    const { featureVector, matchLabels } = computeTrendData(snapshot, meta, points);

    saveMatch({ ...record, featureVector, matchLabels });
    processed++;
  }

  retrainPlayerProfile();
  console.log(`[debug] backfill complete — processed:${processed} skipped:${skipped}`);
  return { processed, skipped };
};

// ─── Meta crawler (see src/enrichment/meta-crawler.ts) ──────────────────────
// Not scheduled. It pulled Challenger/GM/Master matches with the player's own
// pasted API key; with Riot sign-in there is no key on this machine, and a
// crawl from every install would spend the backend's one production key. It
// belongs in a scheduled backend job — until then the aggregate meta table is
// simply absent, which meta-blend.ts already treats as "no meta context".
