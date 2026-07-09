import React, { useState } from 'react';
import { loadSettings, saveSettings, type RiotSettings, type RiotContinent, type RiotPlatform } from '../../persistence/settings';
import { getAccountByRiotId, getLeagueEntriesByPuuid, formatRiotRank, RiotApiError } from '../../enrichment/riot-api';

const CONTINENTS: RiotContinent[] = ['americas', 'europe', 'asia'];
const PLATFORMS: RiotPlatform[] = [
  'na1', 'br1', 'la1', 'la2', 'oc1',
  'euw1', 'eun1', 'tr1', 'ru',
  'kr', 'jp1',
];

const inputStyle: React.CSSProperties = {
  background: '#11111b', border: '1px solid #45475a', borderRadius: 4,
  color: '#cdd6f4', fontSize: 12, padding: '6px 8px', width: '100%',
  boxSizing: 'border-box', fontFamily: 'inherit',
};

const labelStyle: React.CSSProperties = {
  display: 'block', color: '#9399b2', fontSize: 11, marginBottom: 4,
};

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<RiotSettings>(() => loadSettings());
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'ok'; label: string; rank: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  function update<K extends keyof RiotSettings>(key: K, value: RiotSettings[K]) {
    setForm(f => ({ ...f, [key]: value }));
  }

  async function handleVerify() {
    setStatus({ kind: 'checking' });
    try {
      const account = await getAccountByRiotId(form.gameName.trim(), form.tagLine.trim(), form.riotApiKey.trim(), form.continent);
      let rankLabel = 'Unranked';
      try {
        const entries = await getLeagueEntriesByPuuid(account.puuid, form.riotApiKey.trim(), form.platform);
        rankLabel = formatRiotRank(entries);
      } catch (_) {
        // Rank lookup failing shouldn't block linking the account — leave as Unranked.
      }
      const next: RiotSettings = { ...form, riotApiKey: form.riotApiKey.trim(), puuid: account.puuid };
      setForm(next);
      saveSettings(next);
      setStatus({ kind: 'ok', label: `${account.gameName}#${account.tagLine}`, rank: rankLabel });
    } catch (e) {
      const message = e instanceof RiotApiError ? e.message : 'Could not reach Riot API — check network.';
      setStatus({ kind: 'error', message });
    }
  }

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
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Riot API Settings</div>
        <div style={{ fontSize: 11, color: '#6c7086', marginBottom: 10 }}>
          Optional — adds your current rank to the status bar and cross-checks
          your placement against Riot's own record. Coaching reports work
          fully without this.
        </div>
        <div style={{ fontSize: 11, color: '#9399b2', marginBottom: 14, lineHeight: 1.5 }}>
          1. Get a free personal key at{' '}
          <a href="https://developer.riotgames.com" target="_blank" rel="noreferrer" style={{ color: '#89b4fa' }}>
            developer.riotgames.com
          </a>{' '}
          (sign in, copy the key on the dashboard — it starts with{' '}
          <code>RGAPI-</code> and expires after ~24h, just come back and
          re-paste a new one when it does).<br />
          2. Enter your Riot ID below, split at the <code>#</code>.<br />
          3. Pick the region you actually play on, then Save &amp; Verify.
        </div>

        <label style={labelStyle}>Riot API Key</label>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <input
            style={inputStyle}
            type={showKey ? 'text' : 'password'}
            value={form.riotApiKey}
            onChange={e => update('riotApiKey', e.target.value)}
            placeholder="RGAPI-..."
          />
          <button
            onClick={() => setShowKey(s => !s)}
            style={{ background: 'transparent', border: '1px solid #45475a', borderRadius: 4, color: '#9399b2', fontSize: 10, padding: '0 8px', cursor: 'pointer' }}
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Game Name</label>
            <input style={inputStyle} value={form.gameName} onChange={e => update('gameName', e.target.value)} placeholder="e.g. Faker" />
          </div>
          <div style={{ width: 90 }}>
            <label style={labelStyle}>Tag Line</label>
            <input style={inputStyle} value={form.tagLine} onChange={e => update('tagLine', e.target.value)} placeholder="e.g. NA1" />
          </div>
        </div>
        <div style={{ fontSize: 10, color: '#6c7086', marginBottom: 10 }}>
          From your Riot ID shown in-client, e.g. <code>Faker#NA1</code> → Game
          Name <code>Faker</code>, Tag Line <code>NA1</code>.
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Continent</label>
            <select style={inputStyle} value={form.continent} onChange={e => update('continent', e.target.value as RiotContinent)}>
              {CONTINENTS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Platform</label>
            <select style={inputStyle} value={form.platform} onChange={e => update('platform', e.target.value as RiotPlatform)}>
              {PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>
        <div style={{ fontSize: 10, color: '#6c7086', marginBottom: 14 }}>
          Continent routes match/account lookups (Americas/Europe/Asia).
          Platform is your actual server (na1, euw1, kr, ...) and routes rank
          lookups.
        </div>

        {status.kind === 'ok' && (
          <div style={{ fontSize: 11, color: '#a6e3a1', marginBottom: 10 }}>
            Linked: {status.label} — {status.rank}
          </div>
        )}
        {status.kind === 'error' && (
          <div style={{ fontSize: 11, color: '#f38ba8', marginBottom: 10 }}>
            {status.message}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: '1px solid #45475a', borderRadius: 4, color: '#9399b2', fontSize: 11, padding: '6px 12px', cursor: 'pointer' }}
          >
            Close
          </button>
          <button
            onClick={handleVerify}
            disabled={status.kind === 'checking' || !form.riotApiKey || !form.gameName || !form.tagLine}
            style={{ background: '#313244', border: '1px solid #45475a', borderRadius: 4, color: '#cdd6f4', fontSize: 11, padding: '6px 12px', cursor: 'pointer' }}
          >
            {status.kind === 'checking' ? 'Checking…' : 'Save & Verify'}
          </button>
        </div>
      </div>
    </div>
  );
}
