import { createServer } from 'node:http';
import { createHandler } from './lib/handler.js';
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

const server = createServer(createHandler({ jitsiUrl: JITSI_URL, jwtSecret: JITSI_JWT_SECRET, authenticate }));

server.listen(PORT, () => {
  console.log(`Jitsi sidecar listening on :${PORT}`);
  console.log(`JITSI_URL: ${JITSI_URL}`);
  console.log(`OIDC issuer: ${OIDC_ISSUER_URL}`);
  console.log(`JWT auth: ${JITSI_JWT_SECRET ? 'enabled' : 'disabled'}`);
});
