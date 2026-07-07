import React, { useEffect, useState } from 'react';
import type { AppStatus } from '../../shared/types';
import { useHotkeyBinding, HOTKEY_NAME, GAME_ID } from '../useHotkeyBinding';

declare const overwolf: any;

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
    </div>
  );
}
