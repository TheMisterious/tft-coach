// The app's session with this backend — not a Riot token.
//
// After Riot Sign On the app gets an HMAC-signed claim of WHICH account signed
// in (its PUUID) and until when. The proxy routes trust only that claim, so a
// session can read its own account's rank and match and nothing else: the
// production key is never usable for an arbitrary PUUID, and no Riot access
// or refresh token is kept anywhere.

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(puuid: string, secret: string, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = now + SESSION_TTL_MS;
  const payload = base64url(encoder.encode(JSON.stringify({ sub: puuid, exp: expiresAt })));
  const signed = `v1.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(signed)));
  return { token: `${signed}.${base64url(sig)}`, expiresAt };
}

// The session's PUUID, or null when the token is malformed, forged or expired.
export async function verifySession(token: string, secret: string, now = Date.now()): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC', await hmacKey(secret), fromBase64url(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;
    const claim = JSON.parse(decoder.decode(fromBase64url(parts[1]))) as { sub?: unknown; exp?: unknown };
    if (typeof claim.sub !== 'string' || typeof claim.exp !== 'number' || claim.exp <= now) return null;
    return claim.sub;
  } catch {
    return null;
  }
}

// The app's own random value, round-tripped through Riot so the app can tell
// a sign-in it started from one somebody else's link started.
export function isValidState(state: string | null): state is string {
  return !!state && /^[A-Za-z0-9_-]{16,128}$/.test(state);
}
