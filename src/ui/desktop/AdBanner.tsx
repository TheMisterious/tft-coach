import React, { useEffect, useRef } from 'react';
import styles from './AdBanner.module.css';

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
// this container must never be conditionally hidden or resized after the
// OwAd instance is created (see AdBanner.module.css comment).
export function AdBanner() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let ad: { shutdown: () => void } | undefined;
    let cancelled = false;

    loadAdsSdk()
      .then(() => {
        if (cancelled || !containerRef.current || !window.OwAd) return;
        ad = new window.OwAd(containerRef.current, { size: { width: 728, height: 90 } });
      })
      .catch(err => console.error(err));

    return () => {
      cancelled = true;
      ad?.shutdown();
    };
  }, []);

  return (
    <div className={styles.wrap}>
      <div ref={containerRef} className={styles.container} />
    </div>
  );
}
