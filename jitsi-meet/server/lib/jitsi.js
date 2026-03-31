import { webcrypto } from 'node:crypto';

const crypto = webcrypto;

/** Generate a URL-safe room name from an event title, with a random suffix for uniqueness. */
export function generateRoomName(eventTitle) {
  const slug = eventTitle
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  const suffix = crypto.randomUUID().slice(0, 8);
  return slug ? `${slug}-${suffix}` : suffix;
}

/** Build the full Jitsi meeting URL (without JWT). */
export function buildMeetingUrl(jitsiUrl, roomName) {
  const base = jitsiUrl.replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(roomName)}`;
}

/**
 * Create a HS256 JWT for Jitsi authentication.
 * The token is valid for 24 hours from creation.
 */
export async function createJitsiJwt({ secret, roomName, userEmail, userName, jitsiUrl }) {
  let domain;
  try {
    domain = new URL(jitsiUrl).hostname;
  } catch {
    domain = jitsiUrl;
  }

  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: 'bulwark-webmail',
    sub: domain,
    aud: 'jitsi',
    room: roomName,
    iat: now,
    exp: now + 86400,
    context: {
      user: {
        name: userName || undefined,
        email: userEmail || undefined,
      },
    },
  };

  const enc = new TextEncoder();
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  const signatureB64 = base64url(signature);

  return `${signingInput}.${signatureB64}`;
}

function base64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
