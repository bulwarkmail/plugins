const DISCOVERY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
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
  discoveryCacheExpiry = Date.now() + DISCOVERY_CACHE_TTL_MS;
  return discoveryCache;
}

/**
 * Verify a Bearer token by calling the OIDC userinfo endpoint.
 * Returns the user info (including email, name, etc.) on success, or null on failure.
 */
export async function verifyToken(token, issuerUrl) {
  try {
    const discovery = await fetchDiscovery(issuerUrl);
    if (!discovery.userinfo_endpoint) {
      throw new Error('OIDC discovery missing userinfo_endpoint');
    }

    const res = await fetch(discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return null;

    return await res.json();
  } catch (err) {
    console.error('Token verification failed:', err.message);
    return null;
  }
}
