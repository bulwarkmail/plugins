import { buildMeetingUrl, createJitsiJwt, createRoomName, isRoomHost, roomFromUrl } from './jitsi.js';

const MAX_BODY_BYTES = 16 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

/** Who the organizer is, from the verified OIDC claims only. */
function hostIdOf(claims) {
  if (claims.sub) return `sub:${claims.sub}`;
  if (claims.email) return `email:${String(claims.email).toLowerCase()}`;
  return '';
}

/**
 * The sidecar's request handler.
 *
 *   POST /api/jitsi { eventTitle }            -> { url }  the room link for the event
 *   POST /api/jitsi { action: 'join', url }   -> { url }  a link that joins the room
 *                                                         as moderator, for the organizer
 *
 * The event's link never carries a token: it goes to every attendee. With a
 * JWT secret, the organizer gets a short-lived moderator token at join time,
 * and only for a room they made.
 */
export function createHandler({ jitsiUrl, jwtSecret, authenticate }) {
  return async function handle(req, res) {
    // Health check (unauthenticated)
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { status: 'ok' });
    }

    if (req.method !== 'POST' || req.url !== '/api/jitsi') {
      return sendJson(res, 404, { error: 'Not found' });
    }

    const claims = await authenticate(req);
    if (!claims) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Invalid request body' });
    }
    if (!body || typeof body !== 'object') {
      return sendJson(res, 400, { error: 'Invalid request body' });
    }

    const hostId = hostIdOf(claims);

    if (body.action === 'join') {
      const roomName = typeof body.url === 'string' ? roomFromUrl(jitsiUrl, body.url) : null;
      if (!roomName) {
        return sendJson(res, 400, { error: 'This is not a meeting link of this Jitsi server' });
      }
      const url = buildMeetingUrl(jitsiUrl, roomName);
      // Without JWT auth Jitsi decides who moderates; the plain link is all there is.
      if (!jwtSecret) return sendJson(res, 200, { url });

      if (!(await isRoomHost({ secret: jwtSecret, hostId, roomName }))) {
        return sendJson(res, 403, { error: 'Only the person who added this meeting can join it as moderator' });
      }
      const token = await createJitsiJwt({
        secret: jwtSecret,
        roomName,
        userEmail: claims.email || '',
        userName: claims.name || '',
        jitsiUrl,
        moderator: true,
      });
      return sendJson(res, 200, { url: `${url}?jwt=${token}` });
    }

    const { eventTitle } = body;
    if (!eventTitle || typeof eventTitle !== 'string') {
      return sendJson(res, 400, { error: 'eventTitle is required' });
    }

    const roomName = await createRoomName({ eventTitle, secret: jwtSecret, hostId });
    return sendJson(res, 200, { url: buildMeetingUrl(jitsiUrl, roomName) });
  };
}
