// Static reference overlay — item recipes and trait thresholds only.
// This content never changes during a match. It is loaded from data/sets/set{N}/ at startup.
//
// Riot compliance: this overlay must not show live board state, opponent info,
// or any dynamic suggestions. Static reference tables are explicitly permitted.

import React, { useEffect, useState } from 'react';

interface TraitBreakpoint {
  trait: string;
  tiers: number[];
}

// Detect active set from background window state.
function detectActiveSet(): string {
  const bg = (window as any).overwolf?.windows?.getMainWindow?.();
  return bg?.appState?.activeSetId ?? 'set14';
}

export function InGameOverlay() {
  const [traits, setTraits] = useState<TraitBreakpoint[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const setId = detectActiveSet();
    fetch(`/data/sets/${setId}/trait-breakpoints.json`)
      .then(r => r.ok ? r.json() : [])
      .then(setTraits)
      .catch(() => setTraits([]));
  }, []);

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        style={{
          position: 'fixed', top: 8, right: 8,
          background: '#313244', color: '#cdd6f4',
          border: 'none', borderRadius: 6,
          padding: '4px 10px', cursor: 'pointer',
          fontFamily: 'Segoe UI, system-ui, sans-serif', fontSize: 12,
        }}
      >
        TFT Coach
      </button>
    );
  }

  return (
    <div style={{
      position: 'fixed', top: 8, right: 8,
      width: 280,
      background: 'rgba(17, 17, 27, 0.92)',
      border: '1px solid #313244',
      borderRadius: 8,
      padding: '10px 12px',
      fontFamily: 'Segoe UI, system-ui, sans-serif',
      fontSize: 12,
      color: '#cdd6f4',
      boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>TFT Coach — Trait Reference</strong>
        <button
          onClick={() => setCollapsed(true)}
          style={{ background: 'none', border: 'none', color: '#6c7086', cursor: 'pointer', fontSize: 16 }}
        >
          ×
        </button>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #313244' }}>
            <th style={{ textAlign: 'left', padding: '4px 0', color: '#6c7086' }}>Trait</th>
            <th style={{ textAlign: 'left', padding: '4px 0', color: '#6c7086' }}>Breakpoints</th>
          </tr>
        </thead>
        <tbody>
          {traits.length === 0 && (
            <tr><td colSpan={2} style={{ color: '#6c7086', padding: '8px 0' }}>Loading…</td></tr>
          )}
          {traits.map(t => (
            <tr key={t.trait} style={{ borderBottom: '1px solid #1e1e2e' }}>
              <td style={{ padding: '3px 0', color: '#cdd6f4' }}>{t.trait}</td>
              <td style={{ padding: '3px 0', color: '#89b4fa' }}>{t.tiers.join(' / ')}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 8, color: '#6c7086', fontSize: 10 }}>
        Press Ctrl+F after match for full coaching report
      </div>
    </div>
  );
}
