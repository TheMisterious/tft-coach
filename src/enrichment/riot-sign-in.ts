// Riot Sign On, app side.
//
//  1. beginRiotSignIn() (desktop window, Settings) picks a random `state`,
//     remembers it, and opens the backend's /rso/login in the default browser.
//  2. The player signs in on Riot's page; the backend exchanges the code and
//     sends the browser to coachv://rso?state=…&session=…
//  3. Overwolf hands that link to the running app (onAppLaunchTriggered,
//     origin "urlscheme" — see src/background/main.ts), and
//     completeRiotSignIn() accepts it only if `state` is the one this install
//     is waiting for, so nobody can sign a player into an account by sending
//     them a link.
//
// localStorage is shared by every window of the app, so step 1 and step 3 can
// run in different windows.

declare const overwolf: any;

import { APP_SCHEME } from '../shared/backend';
import { backendConfigured, signInUrl } from './coachv-backend';
import { loadSettings, saveSettings, type LinkedRiotAccount } from '../persistence/settings';

const PENDING_KEY = 'tft:rso-pending';

// Dispatched on the desktop window when a sign-in finishes (StatusBar turns
// the background's receiveRiotSignIn call into it), for whatever is open.
export const RIOT_SIGN_IN_EVENT = 'coachv:riot-sign-in';
export type RiotSignInNotice = { ok: true } | { ok: false; message: string };
// Long enough to sign in, including two-factor; short enough that a stale tab
// can't complete a sign-in the player has forgotten about.
export const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;

function randomState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// Returns false when this build has no backend to sign in through.
export function beginRiotSignIn(now = Date.now()): boolean {
  if (!backendConfigured()) return false;
  const state = randomState();
  localStorage.setItem(PENDING_KEY, JSON.stringify({ state, startedAt: now }));
  overwolf.utils.openUrlInDefaultBrowser(signInUrl(state));
  return true;
}

export function cancelRiotSignIn(): void {
  localStorage.removeItem(PENDING_KEY);
}

export function signOutOfRiot(): void {
  const { account: _dropped, ...rest } = loadSettings();
  saveSettings(rest);
}

export type SignInResult =
  | { ok: true; account: LinkedRiotAccount }
  | { ok: false; reason: 'not_ours' | 'no_pending' | 'state_mismatch' | 'expired' | 'cancelled' | 'failed' };

// A link is ours when it is coachv://rso…; Overwolf may deliver it URL-encoded.
export function parseAppLink(raw: string): URL | null {
  const text = raw.startsWith(`${APP_SCHEME}:`) ? raw : safeDecode(raw);
  if (!text.startsWith(`${APP_SCHEME}://rso`)) return null;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function safeDecode(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

export function completeRiotSignIn(rawLink: string, now = Date.now()): SignInResult {
  const link = parseAppLink(rawLink);
  if (!link) return { ok: false, reason: 'not_ours' };

  let pending: { state?: string; startedAt?: number } | null = null;
  try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null'); } catch { pending = null; }
  if (!pending?.state) return { ok: false, reason: 'no_pending' };

  const params = link.searchParams;
  if (params.get('state') !== pending.state) return { ok: false, reason: 'state_mismatch' };
  // From here the link answers OUR request, so it is spent either way.
  localStorage.removeItem(PENDING_KEY);
  if (now - (pending.startedAt ?? 0) > SIGN_IN_WINDOW_MS) return { ok: false, reason: 'expired' };

  const error = params.get('error');
  if (error) return { ok: false, reason: error === 'access_denied' ? 'cancelled' : 'failed' };

  const session = params.get('session');
  const puuid = params.get('puuid');
  const expiresAt = Number(params.get('expiresAt'));
  if (!session || !puuid || !Number.isFinite(expiresAt)) return { ok: false, reason: 'failed' };

  const account: LinkedRiotAccount = {
    puuid,
    gameName: params.get('gameName') ?? '',
    tagLine: params.get('tagLine') ?? '',
    session,
    expiresAt,
  };
  saveSettings({ ...loadSettings(), account });
  return { ok: true, account };
}

export function signInFailureMessage(reason: Exclude<SignInResult, { ok: true }>['reason']): string {
  switch (reason) {
    case 'cancelled': return 'Sign-in was cancelled.';
    case 'expired':   return 'That sign-in took too long. Please try again.';
    case 'failed':    return 'Riot sign-in failed. Please try again.';
    default:          return 'That sign-in link did not come from this app. Please start again from Settings.';
  }
}
