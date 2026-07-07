import React, { useEffect, useRef } from 'react';
import styles from './AdBanner.module.css';

declare const overwolf: any;

declare global {
  interface Window {
    OwAd?: new (container: HTMLElement, settings?: unknown) => { shutdown: () => void };
  }
}

const SDK_URL = 'https://content.overwolf.com/libs/ads/latest/owads.min.js';
let sdkLoadPromise: Promise<void> | null = null;

function loadAdsSdk(): Promise<void> {
  if (window.OwAd) return Promise.resolve();
  if (!sdkLoadPromise) {
    sdkLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SDK_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('[ads] failed to load owads.min.js'));
      document.head.appendChild(script);
    });
  }
  return sdkLoadPromise;
}

// Standard 728x90 leaderboard banner, always visible per Overwolf ad policy —
// this container must never be conditionally hidden or resized while an
// OwAd instance is alive (see AdBanner.module.css comment). Minimizing the
// desktop window (e.g. via the toggle hotkey) does NOT unmount this
// component, so component-unmount cleanup alone would leave the ad running
// while hidden — instead the instance is explicitly torn down/recreated on
// the window's own minimized/restored state via overwolf.windows.onStateChanged.
export function AdBanner() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let ad: { shutdown: () => void } | undefined;
    let cancelled = false;
    let windowId: string | undefined;

    function createAd() {
      if (ad || cancelled || !containerRef.current || !window.OwAd) return;
      ad = new window.OwAd(containerRef.current, { size: { width: 728, height: 90 } });
    }

    function destroyAd() {
      ad?.shutdown();
      ad = undefined;
    }

    function onWindowStateChanged(state: any) {
      if (state?.window_id !== windowId) return;
      if (state.window_state === 'minimized') {
        destroyAd();
      } else {
        createAd();
      }
    }

    overwolf.windows.getCurrentWindow((res: any) => {
      if (cancelled || !res?.success) return;
      windowId = res.window.id;
      overwolf.windows.onStateChanged.addListener(onWindowStateChanged);
    });

    loadAdsSdk()
      .then(createAd)
      .catch(err => console.error(err));

    return () => {
      cancelled = true;
      overwolf.windows.onStateChanged.removeListener(onWindowStateChanged);
      destroyAd();
    };
  }, []);

  return (
    <div className={styles.wrap}>
      <div ref={containerRef} className={styles.container} />
    </div>
  );
}
