// Desktop window entry point.
// Receives new_report messages from the background window and renders them.

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CoachingReportView } from './CoachingReportView';
import { StatusBar } from './StatusBar';
import { AdBanner } from './AdBanner';
import { useAppStore } from '../store';
import { listRecentMatches, loadMatch } from '../../persistence/db';
import type { CoachingReport, AppStatus } from '../../shared/types';

declare const overwolf: any;

function DesktopApp() {
  const {
    currentReport, matchHistory,
    appStatus,
    setCurrentReport, setAppStatus, setMatchHistory,
  } = useAppStore();
  const [activeMatchId, setActiveMatchId] = useState<string | undefined>();

  useEffect(() => {
    // Match history lives in localStorage (persistence/db.ts), shared across
    // windows in the same extension origin — load it directly, no IPC needed.
    setMatchHistory(listRecentMatches());

    // Primary channel: background calls getMainWindow().receiveStatusUpdate() directly.
    // start_window is "desktop" so getMainWindow() reliably returns this window's global.
    // Expose the update functions here so the background can call them synchronously.
    (window as any).receiveStatusUpdate = (s: AppStatus) => {
      console.log('[desktop] receiveStatusUpdate:', s);
      setAppStatus(s);
    };
    (window as any).receiveReport = (report: CoachingReport) => {
      console.log('[desktop] receiveReport: grade=', report?.overall_grade, 'notes=', report?.notes?.length);
      setCurrentReport(report);
      const history = listRecentMatches();
      setMatchHistory(history);
      setActiveMatchId(history[0]?.pseudo_match_id);
    };

    // Fallback channel: sendMessage (kept in case background calls it directly)
    overwolf.windows.onMessageReceived.addListener((msg: any) => {
      console.log('[desktop] onMessageReceived: id=', msg?.id);
      if (msg.id === 'new_report' && msg.content) {
        console.log('[desktop] received new_report via sendMessage');
        setCurrentReport(msg.content as CoachingReport);
        const history = listRecentMatches();
        setMatchHistory(history);
        setActiveMatchId(history[0]?.pseudo_match_id);
      }
      if (msg.id === 'status_update' && msg.content) {
        setAppStatus(msg.content.appStatus as AppStatus);
      }
    });

    // Ensure the background controller is running.
    // is_background_page does not auto-start in all Overwolf versions.
    overwolf.windows.obtainDeclaredWindow('background', (res: any) => {
      if (res.success) overwolf.windows.restore(res.window.id, () => {});
    });

    // Keep only the match/not-match surface in the desktop UI.
    overwolf.games.onGameInfoUpdated.addListener((evt: any) => {
      const gameInfo = evt?.gameInfo;
      if (!gameInfo) return;
      if (!gameInfo.isRunning) {
        setAppStatus('no_game');
      }
    });

    return () => {};
  }, []);

  function handleSelectMatch(matchId: string) {
    setActiveMatchId(matchId);
    // Match history is stored in localStorage, shared across windows in this
    // extension origin (same as listRecentMatches above) — load it directly
    // rather than round-tripping through the background window, which never
    // listened for a 'load_match' message in the first place.
    const record = loadMatch(matchId);
    if (record?.coachingReport) {
      setCurrentReport(record.coachingReport);
    } else {
      console.warn('[desktop] no saved report for match:', matchId);
    }
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      background: '#11111b', fontFamily: 'Segoe UI, system-ui, sans-serif',
    }}>
      <StatusBar status={appStatus} />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <CoachingReportView
          report={currentReport ?? undefined}
          history={matchHistory}
          onSelectMatch={handleSelectMatch}
          activeMatchId={activeMatchId}
        />
      </div>
      <AdBanner />
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<DesktopApp />);
}
