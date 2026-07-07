import React from 'react';
import type { AppStatus } from '../../shared/types';

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
    </div>
  );
}
