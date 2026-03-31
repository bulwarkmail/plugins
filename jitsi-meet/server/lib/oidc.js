import { createPublicKey } from 'node:crypto';

const JWKS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let jwksCache = null;
let jwksCacheExpiry = 0;
let discoveryCache = null;
let discoveryCacheExpiry = 0;

/**
 * Fetch the OIDC discovery document for the given issuer.
 */
async function fetchDiscovery(issuerUrl) {
  if (discoveryCache && Date.now() < discoveryCacheExpiry) return discoveryCache;

  const url = `${issuerUrl.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);

  discoveryCache = await res.json();
  discoveryCacheExpiry = Date.now() + JWKS_CACHE_TTL_MS;
  return discoveryCache;
}

/**
 * Fetch the JWKS from the issuer's jwks_uri.
 */
async function fetchJwks(issuerUrl) {
  if (jwksCache && Date.now() < jwksCacheExpiry) return jwksCache;

  const discovery = await fetchDiscovery(issuerUrl);
  if (!discovery.jwks_uri) throw new Error('OIDC discovery missing jwks_uri');

  const res = await fetch(discovery.jwks_uri);
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);

  const jwks = await res.json();
  jwksCache = jwks.keys || [];
  jwksCacheExpiry = Date.now() + JWKS_CACHE_TTL_MS;
  return jwksCache;
}

/**
 * Find a JWK by kid from the JWKS. If not found, refresh the cache once.
 */
async function findKey(kid, issuerUrl) {
  let keys = await fetchJwks(issuerUrl);
  let key = keys.find((k) => k.kid === kid);
  if (key) return key;

  // Key rotation: clear cache and retry once
  jwksCache = null;
  jwksCacheExpiry = 0;
  keys = await fetchJwks(issuerUrl);
  return keys.find((k) => k.kid === kid) || null;
}

/**
 * Decode a JWT without verification (to read header/payload).
 */
function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  return { header, payload, signature: parts[2], signingInput: `${parts[0]}.${parts[1]}` };
}

/**
 * Verify an RS256 JWT signature using the public key.
 */
async function verifySignature(signingInput, signature, jwk) {
  const keyObject = createPublicKey({ key: jwk, format: 'jwk' });
  const { subtle } = globalThis.crypto;

  const key = await subtle.importKey(
    'spki',
    keyObject.export({ type: 'spki', format: 'der' }),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const signatureBytes = Buffer.from(signature, 'base64url');
  const data = new TextEncoder().encode(signingInput);
  return subtle.verify('RSASSA-PKCS1-v1_5', key, signatureBytes, data);
}

/**
 * Verify a Bearer token against the OIDC issuer's JWKS.
 * Returns the token claims on success, or null on failure.
 */
export async function verifyToken(token, issuerUrl) {
  try {
    const { header, payload, signature, signingInput } = decodeJwt(token);

    // Validate standard claims
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;
    if (payload.nbf && payload.nbf > now + 60) return null;

    // Verify issuer matches
    const expectedIssuer = issuerUrl.replace(/\/+$/, '');
    if (payload.iss && payload.iss.replace(/\/+$/, '') !== expectedIssuer) return null;

    // Find the signing key
    if (!header.kid) return null;
    const jwk = await findKey(header.kid, issuerUrl);
    if (!jwk) return null;

    // Verify signature
    const valid = await verifySignature(signingInput, signature, jwk);
    if (!valid) return null;

    return payload;
  } catch (err) {
    console.error('Token verification failed:', err.message);
    return null;
  }
}
