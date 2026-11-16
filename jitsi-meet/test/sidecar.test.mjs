// The sidecar's answers: the event's link never carries a token, and only
// the person who added a meeting gets a moderator token for it, at join time.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createHandler } from '../server/lib/handler.js';

const JITSI = 'https://meet.example.com';
const SECRET = 'test-secret';
const USERS = {
  'token-alice': { sub: 'alice-id', email: 'alice@example.com', name: 'Alice' },
  'token-bob': { sub: 'bob-id', email: 'bob@example.com', name: 'Bob' },
};

let server;
afterEach(() => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function sidecar({ jwtSecret = SECRET } = {}) {
  const authenticate = async (req) => USERS[(req.headers.authorization || '').replace(/^Bearer /, '')] || null;
  server = createServer(createHandler({ jitsiUrl: JITSI, jwtSecret, authenticate }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return async (user, body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/jitsi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer token-${user}`, 'X-JMAP-Username': 'mallory@example.com' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
}

function claimsOf(url) {
  const token = new URL(url).searchParams.get('jwt');
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

describe('jitsi sidecar', () => {
  it('gives the event a room link without a token, also with JWT auth on', async () => {
    const post = await sidecar();
    const { status, body } = await post('alice', { eventTitle: 'Planning' });
    expect(status).toBe(200);
    const url = new URL(body.url);
    expect(url.search).toBe('');
    expect(body.url).not.toMatch(/jwt/i);
    expect(url.origin).toBe(JITSI);
    expect(url.pathname).toMatch(/^\/planning-[0-9a-f]{8}-[0-9a-f]{16}$/);
  });

  it('gives the organizer a short-lived moderator link for their own room', async () => {
    const post = await sidecar();
    const { body: made } = await post('alice', { eventTitle: 'Planning' });
    const { status, body } = await post('alice', { action: 'join', url: made.url });
    expect(status).toBe(200);
    expect(body.url.startsWith(`${made.url}?jwt=`)).toBe(true);
    const claims = claimsOf(body.url);
    expect(claims.room).toBe(new URL(made.url).pathname.slice(1));
    expect(claims.context.user).toEqual({ name: 'Alice', email: 'alice@example.com', moderator: true });
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it('refuses a moderator link to anyone else, an attendee who signs in included', async () => {
    const post = await sidecar();
    const { body: made } = await post('alice', { eventTitle: 'Planning' });
    const { status, body } = await post('bob', { action: 'join', url: made.url });
    expect(status).toBe(403);
    expect(body.url).toBeUndefined();
  });

  it('refuses a room made before host tags, and a room on another server', async () => {
    const post = await sidecar();
    expect((await post('alice', { action: 'join', url: `${JITSI}/planning-1a2b3c4d` })).status).toBe(403);
    expect((await post('alice', { action: 'join', url: 'https://evil.example/planning-1a2b3c4d-0123456789abcdef' })).status).toBe(400);
  });

  it('without a JWT secret hands out plain room links only', async () => {
    const post = await sidecar({ jwtSecret: null });
    const { body: made } = await post('alice', { eventTitle: 'Planning' });
    expect(new URL(made.url).pathname).toMatch(/^\/planning-[0-9a-f]{8}$/);
    const { status, body } = await post('bob', { action: 'join', url: made.url });
    expect(status).toBe(200);
    expect(body.url).toBe(made.url);
  });
});
