import React, { useEffect, useState } from 'react';
import type { AppStatus } from '../../shared/types';
import { useHotkeyBinding, HOTKEY_NAME, GAME_ID } from '../useHotkeyBinding';
import { SettingsPanel } from './SettingsPanel';
import { loadSettings, hasLinkedAccount, hasExpiredAccount } from '../../persistence/settings';
import { formatRiotRank } from '../../enrichment/riot-api';
import { getRank, BackendError } from '../../enrichment/coachv-backend';
import { RIOT_SIGN_IN_EVENT, type RiotSignInNotice } from '../../enrichment/riot-sign-in';

const SIGN_IN_EXPIRED_LABEL = 'Riot sign-in expired — sign in again in ⚙';

declare const overwolf: any;

// Cheap TTL cache so rank isn't re-fetched on every StatusBar re-render —
// the background pipeline also pushes a fresh value after each match via
// receiveRiotRank (see background/main.ts), this is just the on-open fetch.
const RANK_TTL_MS = 10 * 60 * 1000;
let rankCache: { label: string; fetchedAt: number } | null = null;

interface StatusConfig {
  label: string;
  color: string;
}

const CFG: Record<AppStatus, StatusConfig> = {
  no_game:   { label: 'Not in match',    color: '#585b70' },
  in_match:  { label: 'In TFT match',    color: '#a6e3a1' },
};

export function StatusBar({ status }: { status: AppStatus }) {
  const { label, color } = CFG[status];
  const binding = useHotkeyBinding();
  const [capturing, setCapturing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rankLabel, setRankLabel] = useState<string | null>(rankCache?.label ?? null);
  const [rankIsError, setRankIsError] = useState(false);

  // The signed-in player's rank, through the coachv backend. A 401 means the
  // sign-in session lapsed — said in the bar rather than only logged, so the
  // player knows why rank and the placement check stopped.
  function refreshRank(force = false) {
    const settings = loadSettings();
    if (hasExpiredAccount(settings)) {
      setRankLabel(SIGN_IN_EXPIRED_LABEL);
      setRankIsError(true);
      return;
    }
    if (!hasLinkedAccount(settings)) {
      rankCache = null;
      setRankLabel(null);
      return;
    }
    if (!force && rankCache && Date.now() - rankCache.fetchedAt < RANK_TTL_MS) return;

    getRank(settings.account!.session, settings.platform)
      .then(entries => {
        const formatted = formatRiotRank(entries);
        rankCache = { label: formatted, fetchedAt: Date.now() };
        setRankLabel(formatted);
        setRankIsError(false);
      })
      .catch(e => {
        console.warn('[StatusBar] rank fetch failed:', e);
        if (e instanceof BackendError && e.status === 401) {
          rankCache = { label: SIGN_IN_EXPIRED_LABEL, fetchedAt: Date.now() };
          setRankLabel(SIGN_IN_EXPIRED_LABEL);
          setRankIsError(true);
        }
      });
  }

  useEffect(() => {
    // Exposed so background/main.ts can push a fresh rank (or an expired
    // sign-in notice) right after a match finishes, same pattern as
    // receiveReport/receiveStatusUpdate.
    (window as any).receiveRiotRank = (label: string, isError = false) => {
      rankCache = { label, fetchedAt: Date.now() };
      setRankLabel(label);
      setRankIsError(isError);
    };
    // Riot sign-in finished in the browser; background/main.ts calls this.
    // StatusBar is always mounted, so it relays to whatever else is open.
    (window as any).receiveRiotSignIn = (notice: RiotSignInNotice) => {
      window.dispatchEvent(new CustomEvent(RIOT_SIGN_IN_EVENT, { detail: notice }));
      refreshRank(true);
    };

    refreshRank();
  }, []);

  useEffect(() => {
    if (!capturing) return;

    function onKeyDown(e: KeyboardEvent) {
      // Wait for a real key, not a bare modifier press.
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      overwolf.settings.hotkeys.assign({
        name: HOTKEY_NAME,
        gameId: GAME_ID,
        // JS keyCode lines up with the Windows VirtualKey codes Overwolf's
        // hotkeys API expects for standard alphanumeric/function keys.
        virtualKey: e.keyCode,
        modifiers: { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey },
      }, () => {});
      setCapturing(false);
    }

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturing]);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7,
      padding: '5px 14px',
      background: '#181825',
      borderBottom: '1px solid #313244',
      fontSize: 11,
      fontFamily: 'Segoe UI, system-ui, sans-serif',
      userSelect: 'none',
      flexShrink: 0,
    }}>
      <span style={{
        width: 6, height: 6,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }} />
      <span style={{ color, fontWeight: 600, letterSpacing: 0.2 }}>{label}</span>

      <span style={{ flex: 1 }} />

      {rankLabel && (
        <span style={{ color: rankIsError ? '#f38ba8' : '#f9e2af', fontWeight: 600 }}>{rankLabel}</span>
      )}

      <span style={{ color: '#6c7086' }}>Toggle overlay:</span>
      {capturing ? (
        <span style={{ color: '#f9e2af', fontWeight: 600 }}>Press a key…</span>
      ) : (
        <span style={{ color: '#cdd6f4', fontWeight: 600 }}>{binding ?? 'Not set'}</span>
      )}
      <button
        onClick={() => setCapturing(true)}
        disabled={capturing}
        style={{
          background: 'transparent', border: '1px solid #45475a', borderRadius: 4,
          color: '#9399b2', fontSize: 10, padding: '2px 8px', cursor: 'pointer',
        }}
      >
        Rebind
      </button>
      <button
        onClick={() => setSettingsOpen(true)}
        title="Riot account"
        style={{
          background: 'transparent', border: '1px solid #45475a', borderRadius: 4,
          color: '#9399b2', fontSize: 10, padding: '2px 8px', cursor: 'pointer',
        }}
      >
        ⚙
      </button>
      {settingsOpen && (
        <SettingsPanel onClose={() => {
          setSettingsOpen(false);
          // Signed in, out, or switched server while it was open.
          refreshRank(true);
        }} />
      )}
    </div>
  );
}
