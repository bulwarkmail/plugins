/**
 * Jitsi Meet Plugin — adds "Add Jitsi Meeting" to calendar events.
 *
 * Admin must configure `jitsi-url` (and optionally `jitsi-jwt-secret`)
 * via the plugin configuration page in Admin → Plugins → jitsi-meet → Configure.
 *
 * Demonstrates:
 * - Reading admin-managed plugin configuration
 * - Registering a calendar event action
 * - Using toast for user feedback
 * - Client-side JWT creation with Web Crypto API
 */

// ─── Jitsi helpers ──────────────────────────────────────────────

/** Generate a URL-safe room name from an event title, with a random suffix for uniqueness. */
function generateRoomName(eventTitle) {
  const slug = eventTitle
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  const suffix = crypto.randomUUID().slice(0, 8);
  return slug ? `${slug}-${suffix}` : suffix;
}

/** Build the full Jitsi meeting URL (without JWT). */
function buildMeetingUrl(jitsiUrl, roomName) {
  const base = jitsiUrl.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(roomName)}`;
}

/**
 * Create a HS256 JWT for Jitsi authentication.
 * Uses the Web Crypto API (works in all modern browsers).
 * The token is valid for 24 hours from creation.
 */
async function createJitsiJwt({ secret, roomName, userEmail, userName, jitsiUrl }) {
  let domain;
  try {
    domain = new URL(jitsiUrl).hostname;
  } catch {
    domain = jitsiUrl;
  }

  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: "bulwark-webmail",
    sub: domain,
    aud: "jitsi",
    room: roomName,
    iat: now,
    exp: now + 86400,
    context: {
      user: {
        ...(userName ? { name: userName } : {}),
        ...(userEmail ? { email: userEmail } : {}),
      },
    },
  };

  const enc = new TextEncoder();
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  const signatureB64 = base64url(signature);

  return `${signingInput}.${signatureB64}`;
}

function base64url(input) {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ─── Plugin entry point ─────────────────────────────────────────

export function activate(api) {
  const disposables = [];

  // Load admin config (async) and register the action once ready
  api.admin
    .getAllConfig()
    .then((config) => {
      const jitsiUrl = config["jitsi-url"];

      if (!jitsiUrl) {
        api.log.warn(
          "Jitsi Meet plugin: no 'jitsi-url' configured. Go to Admin → Plugins → jitsi-meet → Configure.",
        );
        return;
      }

      const jwtSecret = config["jitsi-jwt-secret"] || "";

      api.log.info(`Jitsi Meet plugin activated (server: ${jitsiUrl})`);

      disposables.push(
        api.ui.registerCalendarEventAction({
          id: "add-jitsi-meeting",
          label: "Add Jitsi Meeting",
          order: 10,
          onClick: async (eventData, { setVirtualLocation }) => {
            try {
              const roomName = generateRoomName(eventData.title || "meeting");
              let url = buildMeetingUrl(jitsiUrl, roomName);

              if (jwtSecret) {
                const token = await createJitsiJwt({
                  secret: jwtSecret,
                  roomName,
                  jitsiUrl,
                });
                url += `?jwt=${token}`;
              }

              setVirtualLocation(url);
              api.toast.success("Jitsi meeting link added");
            } catch (err) {
              api.log.error("Failed to create Jitsi meeting link", err);
              api.toast.error("Failed to create Jitsi meeting link");
            }
          },
        }),
      );
    })
    .catch((err) => {
      api.log.error("Failed to load Jitsi Meet plugin config", err);
    });

  return {
    dispose: () => {
      disposables.forEach((d) => d.dispose());
    },
  };
}
