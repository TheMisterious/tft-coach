import React, { useEffect, useState } from 'react';
import type { AppStatus } from '../../shared/types';
import { useHotkeyBinding, HOTKEY_NAME, GAME_ID } from '../useHotkeyBinding';
import { SettingsPanel } from './SettingsPanel';
import { loadSettings, hasLinkedAccount } from '../../persistence/settings';
import { getLeagueEntriesByPuuid, formatRiotRank, RiotApiError } from '../../enrichment/riot-api';

const KEY_EXPIRED_LABEL = 'Riot key expired — renew in ⚙';

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

  useEffect(() => {
    // Exposed so background/main.ts can push a fresh rank (or a key-expired
    // notice) right after a match finishes, same pattern as
    // receiveReport/receiveStatusUpdate. A 401/403 mid-session (most common
    // for a free personal key, which expires every ~24h) previously only
    // logged a console.warn — invisible unless the user had devtools open —
    // so rank/cross-check silently stopped working with no indication why.
    (window as any).receiveRiotRank = (label: string, isError = false) => {
      rankCache = { label, fetchedAt: Date.now() };
      setRankLabel(label);
      setRankIsError(isError);
    };

    const settings = loadSettings();
    if (!hasLinkedAccount(settings)) return;
    if (rankCache && Date.now() - rankCache.fetchedAt < RANK_TTL_MS) return;

    getLeagueEntriesByPuuid(settings.puuid!, settings.riotApiKey, settings.platform)
      .then(entries => {
        const formatted = formatRiotRank(entries);
        rankCache = { label: formatted, fetchedAt: Date.now() };
        setRankLabel(formatted);
        setRankIsError(false);
      })
      .catch(e => {
        console.warn('[StatusBar] rank fetch failed:', e);
        if (e instanceof RiotApiError && (e.status === 401 || e.status === 403)) {
          rankCache = { label: KEY_EXPIRED_LABEL, fetchedAt: Date.now() };
          setRankLabel(KEY_EXPIRED_LABEL);
          setRankIsError(true);
        }
      });
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
        title="Riot API settings"
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
          // Re-check rank immediately if the user just linked/changed an account.
          const settings = loadSettings();
          if (!hasLinkedAccount(settings)) return;
          getLeagueEntriesByPuuid(settings.puuid!, settings.riotApiKey, settings.platform)
            .then(entries => {
              const formatted = formatRiotRank(entries);
              rankCache = { label: formatted, fetchedAt: Date.now() };
              setRankLabel(formatted);
              setRankIsError(false);
            })
            .catch(e => {
              console.warn('[StatusBar] rank fetch failed:', e);
              if (e instanceof RiotApiError && (e.status === 401 || e.status === 403)) {
                rankCache = { label: KEY_EXPIRED_LABEL, fetchedAt: Date.now() };
                setRankLabel(KEY_EXPIRED_LABEL);
                setRankIsError(true);
              }
            });
        }} />
      )}
    </div>
  );
}
