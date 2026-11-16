// Meeting links in the event. The event goes to every attendee, so its link
// must never carry a Jitsi token (?jwt=...): whoever holds the token joins
// as the person it was made for. Before 1.4.0 the sidecar put the
// organizer's token into the link; those links are cleaned when the event is
// edited.

/** The link without a `jwt` parameter. Anything that isn't a link comes back as it is. */
export function withoutJwt(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.searchParams.has('jwt')) return url;
  parsed.searchParams.delete('jwt');
  return parsed.toString();
}

function tokenClaims(token) {
  const part = String(token || '').split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

/**
 * The link without the token an earlier version of this plugin put in it, or
 * null when it has none. Tokens of other services are left alone.
 */
export function stripPluginToken(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const claims = tokenClaims(parsed.searchParams.get('jwt'));
  if (!claims || claims.iss !== 'bulwark-webmail' || claims.aud !== 'jitsi') return null;
  return withoutJwt(url);
}

/**
 * Whether the link is a room this plugin made with a host tag, which its
 * organizer can join as moderator. The sidecar checks who asks.
 */
export function isHostedRoom(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const room = parsed.pathname.split('/').pop() || '';
  return /(^|-)[0-9a-f]{8}-[0-9a-f]{16}$/.test(room);
}
