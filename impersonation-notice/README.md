# Impersonation Notice

Persistent top-of-app banner shown while a Stalwart master-user impersonation session is active. Pairs with Bulwark's built-in `/api/auth/impersonate` JWT route (Bulwark ≥ 1.6.7).

## What it does

When the active session is an impersonation, the plugin renders a strip across the very top of the app, above the navigation rail, sidebar and content, showing the mailbox being viewed and an optional "Back to platform" button.

Newer Bulwark versions tell the plugin so directly. Since Bulwark 1.11.1 the impersonated session signs in with the plain mailbox, so on versions without that flag the banner only shows for a username in Stalwart's master-user syntax `<target>%<master>`, for example when someone signs in with it on the login page. Detection is automatic; admins only configure the platform return URL and the banner text. The strip is the app's own one-line info bar in the warning tone, so it follows light, dark and custom themes. (The colour settings of 1.3 and older are gone; values saved for them are ignored.)

## How a platform hands users in

```
GET https://webmail.example.com/api/auth/impersonate?token=<HS256 JWT>
```

The server-side route (built into Bulwark) verifies the JWT, uses the master credentials once to create an app password for the target mailbox, signs in with it, and 303-redirects to `/`. The plugin then surfaces the impersonation status to the user.

The cryptographic configuration (signing secret, master credentials) lives in the Bulwark process environment, not in admin config. See the "Server-side configuration" section of the plugin admin page.

## Admin settings

| Key                | Default             | Notes                                                                                  |
| ------------------ | ------------------- | -------------------------------------------------------------------------------------- |
| `returnUrl`        | _empty_             | Opened in a new tab by "Back to platform", which also signs out of the impersonated session. Empty hides the button. |
| `returnLabel`      | `Back to platform`  | Button label.                                                                          |
| `actorRoleLabel`   | `as Platform Admin` | Suffix appended to the mailbox in the banner copy.                                     |

All settings are organisation-wide (`api.admin.setConfig`). Per-user override is intentionally not exposed.

## Permissions

- `account:read` — receive the session username and whether it is an impersonation (the banner slot's `username` and `impersonated` props)
- `auth:emit` — sign out when "Back to platform" is clicked
- `ui:app-top-banner` — render the strip
- `ui:admin-page` — configuration UI
- `admin:config` — read/write org-wide settings

## Building

```sh
npm install
npm run build
```

Outputs `dist/index.js`. Zip the manifest, the `dist/` folder, and the optional `media/` folder for distribution.
