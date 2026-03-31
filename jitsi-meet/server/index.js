import { createServer } from 'node:http';
import { generateRoomName, buildMeetingUrl, createJitsiJwt } from './lib/jitsi.js';
import { verifyToken } from './lib/oidc.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const JITSI_URL = process.env.JITSI_URL;
const JITSI_JWT_SECRET = process.env.JITSI_JWT_SECRET;
const OIDC_ISSUER_URL = process.env.OIDC_ISSUER_URL;

if (!JITSI_URL) {
  console.error('JITSI_URL environment variable is required');
  process.exit(1);
}

if (!OIDC_ISSUER_URL) {
  console.error('OIDC_ISSUER_URL environment variable is required (e.g. https://zitadel.example.com)');
  process.exit(1);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
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
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Extract and verify the Bearer token from the Authorization header.
 * Returns the decoded token claims or null.
 */
async function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  return verifyToken(token, OIDC_ISSUER_URL);
}

const server = createServer(async (req, res) => {
  // Health check (unauthenticated)
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { status: 'ok' });
  }

  // POST /api/jitsi — create a meeting URL
  if (req.method === 'POST' && req.url === '/api/jitsi') {
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

    const { eventTitle } = body;
    if (!eventTitle || typeof eventTitle !== 'string') {
      return sendJson(res, 400, { error: 'eventTitle is required' });
    }

    const roomName = generateRoomName(eventTitle);
    let url = buildMeetingUrl(JITSI_URL, roomName);

    if (JITSI_JWT_SECRET) {
      const token = await createJitsiJwt({
        secret: JITSI_JWT_SECRET,
        roomName,
        userEmail: claims.email || req.headers['x-jmap-username'] || '',
        userName: claims.name || '',
        jitsiUrl: JITSI_URL,
      });
      url += `?jwt=${token}`;
    }

    return sendJson(res, 200, { url });
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Jitsi sidecar listening on :${PORT}`);
  console.log(`JITSI_URL: ${JITSI_URL}`);
  console.log(`OIDC issuer: ${OIDC_ISSUER_URL}`);
  console.log(`JWT auth: ${JITSI_JWT_SECRET ? 'enabled' : 'disabled'}`);
});
