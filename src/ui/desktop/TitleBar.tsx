// Window chrome for the desktop window.
//
// REQUIRED, not decorative. The desktop window is an Overwolf NATIVE window
// (manifest.json: native_window + desktop_only, both needed — native_window is
// silently ignored without desktop_only, which is what Overwolf QA flagged on
// v0.0.1). Native windows are created with no OS title bar and no minimise /
// maximise / close buttons; Overwolf's own guidance is to "implement the window
// header with control elements (e.g maximize, minimize) independently in the
// HTML/CSS". The manifest's show_minimize / show_maximize flags do nothing here
// — they only apply to standard (non-native) Overwolf windows.
//
// So without this component the window cannot be moved, minimised, maximised or
// closed by any means. Do not remove it while the window stays native.
//
// Dragging goes through overwolf.windows.dragMove rather than CSS
// -webkit-app-region: drag, which Overwolf does not document as supported.
// dragMove explicitly handles native windows, including the DPI resize when a
// window is dragged between monitors with different scaling.

import React, { useCallback, useEffect, useState } from 'react';
import styles from './TitleBar.module.css';

declare const overwolf: any;

type WindowState = 'normal' | 'maximized' | 'minimized' | 'hidden' | 'closed';

/** Runs `fn` with this window's Overwolf id, or does nothing if it can't be resolved. */
function withWindowId(fn: (id: string) => void): void {
  try {
    overwolf.windows.getCurrentWindow((result: any) => {
      if (result?.success && result.window?.id) fn(result.window.id);
    });
  } catch {
    // Outside Overwolf (e.g. a plain browser during development) the API is
    // absent. The chrome still renders; the buttons are simply inert.
  }
}

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const [version, setVersion] = useState<string>('');

  // Read from the packaged manifest rather than hardcoded, so the chrome can
  // never claim a version that wasn't actually shipped.
  useEffect(() => {
    try {
      overwolf.extensions.current.getManifest((manifest: any) => {
        setVersion(manifest?.meta?.version ?? '');
      });
    } catch {
      // No Overwolf host — render without a version rather than crash.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    function onStateChanged(state: any) {
      if (cancelled) return;
      const next = state?.window_state_ex ?? state?.window_state;
      if (next === 'maximized' || next === 'normal') setMaximized(next === 'maximized');
    }

    try {
      overwolf.windows.getCurrentWindow((result: any) => {
        if (cancelled || !result?.success) return;
        const state: WindowState | undefined = result.window?.stateEx;
        setMaximized(state === 'maximized');
      });
      overwolf.windows.onStateChanged.addListener(onStateChanged);
    } catch {
      // See withWindowId — no Overwolf host, nothing to track.
    }

    return () => {
      cancelled = true;
      try { overwolf.windows.onStateChanged.removeListener(onStateChanged); } catch { /* never attached */ }
    };
  }, []);

  const startDrag = useCallback((e: React.MouseEvent) => {
    // Left button only: a right-drag should not move the window, and a
    // double-click is handled separately below.
    if (e.button !== 0 || e.detail > 1) return;
    withWindowId(id => overwolf.windows.dragMove(id));
  }, []);

  const toggleMaximize = useCallback(() => {
    withWindowId(id => {
      // State is driven by onStateChanged rather than assumed here, so the
      // button stays correct if the window is restored by any other route.
      if (maximized) overwolf.windows.restore(id);
      else overwolf.windows.maximize(id);
    });
  }, [maximized]);

  const minimize = useCallback(() => withWindowId(id => overwolf.windows.minimize(id)), []);
  const close = useCallback(() => withWindowId(id => overwolf.windows.close(id)), []);

  return (
    <div className={styles.bar}>
      <div
        className={styles.drag}
        onMouseDown={startDrag}
        onDoubleClick={toggleMaximize}
      >
        <img className={styles.icon} src="../icons/IconMouseOver.png" alt="" />
        <span className={styles.title}>coachv</span>
        {version && <span className={styles.version}>v{version}</span>}
      </div>

      <div className={styles.controls}>
        <button className={styles.button} onClick={minimize} title="Minimize" aria-label="Minimize">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>

        <button
          className={styles.button}
          onClick={toggleMaximize}
          title={maximized ? 'Restore down' : 'Maximize'}
          aria-label={maximized ? 'Restore down' : 'Maximize'}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
              <path d="M2.5 2.5V0.5H9.5V7.5H7.5" fill="none" stroke="currentColor" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
            </svg>
          )}
        </button>

        <button className={`${styles.button} ${styles.close}`} onClick={close} title="Close" aria-label="Close">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" stroke="currentColor" fill="none" />
          </svg>
        </button>
      </div>
    </div>
  );
}
