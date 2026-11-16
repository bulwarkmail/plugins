import { webcrypto } from 'node:crypto';

const crypto = webcrypto;

/** How long a moderator token is valid. It's made when the organizer joins. */
export const MODERATOR_TOKEN_TTL_SECONDS = 3600;

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
 * The room name from a meeting link on this Jitsi server, or null when the
 * link points somewhere else. Query and fragment are ignored.
 */
export function roomFromUrl(jitsiUrl, url) {
  let base;
  let link;
  try {
    base = new URL(jitsiUrl);
    link = new URL(url);
  } catch {
    return null;
  }
  if (link.origin !== base.origin) return null;
  const prefix = base.pathname.replace(/\/+$/, '') + '/';
  if (!link.pathname.startsWith(prefix)) return null;
  const rest = link.pathname.slice(prefix.length);
  if (!rest || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

// The host tag: the last part of a room name, an HMAC of the room and the
// organizer's OIDC subject. Only the person who made the room can get a
// moderator token for it, from any device, and the sidecar keeps no state.
const HOST_TAG = /^(.+)-([0-9a-f]{16})$/;

async function hostTag(secret, hostId, roomBase) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`jitsi-host\n${hostId}\n${roomBase}`)));
  return Array.from(mac.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A new room for an event. With a JWT secret and a known organizer the name
 * ends in the organizer's host tag, so they can later join it as moderator.
 */
export async function createRoomName({ eventTitle, secret, hostId }) {
  const base = generateRoomName(eventTitle);
  if (!secret || !hostId) return base;
  return `${base}-${await hostTag(secret, hostId, base)}`;
}

/** Whether `hostId` is the organizer who made `roomName`. */
export async function isRoomHost({ secret, hostId, roomName }) {
  if (!secret || !hostId) return false;
  const m = HOST_TAG.exec(roomName);
  if (!m) return false;
  const expected = await hostTag(secret, hostId, m[1]);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2].charCodeAt(i);
  return diff === 0;
}

/**
 * Create a HS256 JWT for Jitsi authentication, for one person and one room.
 * It is never put into a link that is stored or sent to anyone.
 */
export async function createJitsiJwt({ secret, roomName, userEmail, userName, jitsiUrl, moderator = false, ttlSeconds = MODERATOR_TOKEN_TTL_SECONDS }) {
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
    exp: now + ttlSeconds,
    context: {
      user: {
        name: userName || undefined,
        email: userEmail || undefined,
        ...(moderator ? { moderator: true } : {}),
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
