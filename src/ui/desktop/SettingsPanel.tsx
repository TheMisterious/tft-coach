import React, { useState, useRef, useEffect } from 'react';
import { loadSettings, saveSettings, hasLinkedAccount, hasExpiredAccount, type RiotSettings, type RiotPlatform } from '../../persistence/settings';
import { backendConfigured } from '../../enrichment/coachv-backend';
import {
  beginRiotSignIn, cancelRiotSignIn, signOutOfRiot, RIOT_SIGN_IN_EVENT, type RiotSignInNotice,
} from '../../enrichment/riot-sign-in';

const PLATFORMS: RiotPlatform[] = [
  'na1', 'br1', 'la1', 'la2',
  'euw1', 'eun1', 'tr1', 'ru',
  'kr', 'jp1',
  'oc1', 'vn2', 'sg2', 'th2', 'tw2', 'ph2',
];

const inputStyle: React.CSSProperties = {
  background: '#11111b', border: '1px solid #45475a', borderRadius: 4,
  color: '#cdd6f4', fontSize: 12, padding: '6px 8px', width: '100%',
  boxSizing: 'border-box', fontFamily: 'inherit',
};

const labelStyle: React.CSSProperties = {
  display: 'block', color: '#9399b2', fontSize: 11, marginBottom: 4,
};

// Native <select> popups can render outside Overwolf's small frameless CEF
// window bounds (no real OS chrome to clip against), which made the
// 16-option Platform list appear to "overflow through the screen" instead of
// scrolling in place. A self-rendered dropdown stays inside our own DOM, so
// it's fully containable with a plain max-height + overflow-y.
function PlatformSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{ ...inputStyle, textAlign: 'left', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>{value}</span>
        <span style={{ color: '#6c7086', fontSize: 10 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
          maxHeight: 180, overflowY: 'auto',
          background: '#11111b', border: '1px solid #45475a', borderRadius: 4,
          zIndex: 10,
        }}>
          {PLATFORMS.map(p => (
            <div
              key={p}
              onClick={() => { onChange(p); setOpen(false); }}
              style={{
                padding: '6px 8px', fontSize: 12, cursor: 'pointer',
                background: p === value ? '#313244' : 'transparent',
                color: '#cdd6f4',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#313244')}
              onMouseLeave={e => (e.currentTarget.style.background = p === value ? '#313244' : 'transparent')}
            >
              {p}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  background: 'transparent', border: '1px solid #45475a', borderRadius: 4,
  color: '#9399b2', fontSize: 11, padding: '6px 12px', cursor: 'pointer',
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle, background: '#313244', color: '#cdd6f4',
};

// Riot account link, through Riot Sign On: the player signs in on Riot's own
// page in their browser and never types a key or password into coachv. The
// sign-in returns to the app through the background window (see
// src/enrichment/riot-sign-in.ts), which announces it with RIOT_SIGN_IN_EVENT.
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<RiotSettings>(() => loadSettings());
  const [phase, setPhase] = useState<
    | { kind: 'idle' }
    | { kind: 'waiting' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const configured = backendConfigured();

  useEffect(() => {
    function onSignIn(e: Event) {
      const notice = (e as CustomEvent<RiotSignInNotice>).detail;
      setSettings(loadSettings());
      setPhase(notice.ok ? { kind: 'idle' } : { kind: 'error', message: notice.message });
    }
    window.addEventListener(RIOT_SIGN_IN_EVENT, onSignIn);
    return () => window.removeEventListener(RIOT_SIGN_IN_EVENT, onSignIn);
  }, []);

  function setPlatform(platform: RiotPlatform) {
    const next = { ...loadSettings(), platform };
    saveSettings(next);
    setSettings(next);
  }

  function signIn() {
    if (beginRiotSignIn()) setPhase({ kind: 'waiting' });
    else setPhase({ kind: 'error', message: 'Riot sign-in is not set up in this build.' });
  }

  function cancel() {
    cancelRiotSignIn();
    setPhase({ kind: 'idle' });
  }

  function signOut() {
    signOutOfRiot();
    setSettings(loadSettings());
    setPhase({ kind: 'idle' });
  }

  const account = settings.account;
  const linked = hasLinkedAccount(settings);
  const expired = hasExpiredAccount(settings);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100,
    }} onClick={onClose}>
      <div
        style={{
          background: '#181825', border: '1px solid #313244', borderRadius: 8,
          padding: 20, width: 380, fontFamily: 'Segoe UI, system-ui, sans-serif',
          color: '#cdd6f4',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Riot account</div>
        <div style={{ fontSize: 11, color: '#6c7086', marginBottom: 14, lineHeight: 1.5 }}>
          Optional. Signing in adds your current rank to the status bar and
          checks your placement against Riot's own record. Coaching reports
          work fully without it.
        </div>

        {linked && account && (
          <div style={{ fontSize: 12, color: '#a6e3a1', marginBottom: 12 }}>
            Signed in as {account.gameName}#{account.tagLine}
          </div>
        )}
        {expired && account && (
          <div style={{ fontSize: 12, color: '#f9e2af', marginBottom: 12 }}>
            Your sign-in for {account.gameName}#{account.tagLine} has expired. Sign in again to keep rank and placement checks.
          </div>
        )}

        {phase.kind === 'waiting' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <span style={{ fontSize: 11, color: '#9399b2', flex: 1 }}>
              Finish signing in in your browser. This window updates when you're done.
            </span>
            <button onClick={cancel} style={buttonStyle}>Cancel</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {linked ? (
              <button onClick={signOut} style={buttonStyle}>Sign out</button>
            ) : (
              <button
                onClick={signIn}
                disabled={!configured}
                style={{ ...primaryButtonStyle, opacity: configured ? 1 : 0.5, cursor: configured ? 'pointer' : 'default' }}
              >
                {expired ? 'Sign in again with Riot' : 'Sign in with Riot'}
              </button>
            )}
          </div>
        )}
        {!configured && !linked && (
          <div style={{ fontSize: 10, color: '#6c7086', marginTop: -8, marginBottom: 14 }}>
            Riot sign-in is not set up in this build.
          </div>
        )}
        {phase.kind === 'error' && (
          <div style={{ fontSize: 11, color: '#f38ba8', marginBottom: 12 }}>{phase.message}</div>
        )}

        <label style={labelStyle}>Server you play on</label>
        <div style={{ marginBottom: 4 }}>
          <PlatformSelect value={settings.platform} onChange={v => setPlatform(v as RiotPlatform)} />
        </div>
        <div style={{ fontSize: 10, color: '#6c7086', marginBottom: 14 }}>
          na1, euw1, kr, vn2, ... Rank and match lookups go to this server.
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={buttonStyle}>Close</button>
        </div>
      </div>
    </div>
  );
}
