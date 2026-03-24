# Bulwark Mail Plugins

Example plugins and templates for [Bulwark Mail](https://github.com/nicholasgriffintn/jmap-webmail).

## Quick Start

1. Copy `plugin-template/` and rename it
2. Edit `manifest.json` with your plugin info
3. Write your plugin code in `src/index.js`
4. Build: `npm run build`
5. ZIP the `dist/` output (`manifest.json` and your `.js` file at the ZIP root)
6. Upload via **Admin → Plugins** in Bulwark Mail

## Plugin Structure

```
my-plugin/
├── manifest.json        # Plugin metadata (required)
├── src/
│   └── index.js         # Plugin source code
├── dist/                # Build output (this gets zipped)
│   ├── manifest.json
│   └── index.js
├── package.json         # Build tooling
└── README.md
```

## manifest.json

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "What this plugin does",
  "type": "hook",
  "permissions": ["email:read"],
  "entrypoint": "index.js",
  "minAppVersion": "1.0.0",
  "settingsSchema": {
    "enabled": {
      "type": "boolean",
      "label": "Enable feature",
      "description": "Toggle this plugin's main feature",
      "default": true
    }
  }
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier. Lowercase alphanumeric + hyphens, min 2 chars. Pattern: `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/` |
| `name` | Yes | Display name |
| `version` | Yes | Semantic version |
| `author` | Yes | Author name |
| `description` | Yes | Short description |
| `type` | Yes | `"ui-extension"`, `"sidebar-app"`, or `"hook"` |
| `permissions` | Yes | Array of required permissions (see below) |
| `entrypoint` | Yes | Path to the main JS file |
| `minAppVersion` | No | Minimum Bulwark Mail version |
| `settingsSchema` | No | User-configurable settings (shown in plugin settings UI) |

### Plugin Types

| Type | Use Case |
|------|----------|
| `ui-extension` | Adds buttons, banners, or UI elements to existing views |
| `sidebar-app` | Adds a new panel in the sidebar |
| `hook` | Reacts to events without adding visible UI |

### Settings Schema Types

```json
{
  "toggle": { "type": "boolean", "label": "Enable", "default": true },
  "name": { "type": "string", "label": "Name", "default": "value" },
  "count": { "type": "number", "label": "Count", "default": 5, "min": 1, "max": 100 },
  "mode": { "type": "select", "label": "Mode", "default": "auto", "options": ["auto", "manual"] }
}
```

## Plugin API

Every plugin exports an `activate(api)` function that receives the full Plugin API:

```javascript
export function activate(api) {
  // api.plugin   — Plugin metadata and settings
  // api.ui       — Register UI components
  // api.hooks    — Subscribe to events
  // api.toast    — Show notifications
  // api.storage  — Persistent key-value storage
  // api.log      — Scoped logging

  return { dispose: () => { /* cleanup */ } };
}

export function deactivate() {
  // Optional: extra cleanup when plugin is disabled
}
```

### api.plugin

```javascript
api.plugin.id        // "my-plugin"
api.plugin.version   // "1.0.0"
api.plugin.settings  // { enabled: true, ... } — user-configured values
```

### api.ui — UI Registration

```javascript
// Add button to email toolbar
api.ui.registerToolbarAction({
  id: 'my-action',
  label: 'Do Something',
  icon: '🔧',
  onClick: () => { /* ... */ },
  order: 100,
});

// Show banner above email content
api.ui.registerEmailBanner({
  shouldShow: (email) => email.from.includes('important'),
  render: ({ email }) => React.createElement('div', null, 'Important!'),
});

// Add section below email content
api.ui.registerEmailFooter(MyFooterComponent);

// Add section in Settings
api.ui.registerSettingsSection({
  id: 'my-settings',
  label: 'My Plugin Settings',
  icon: '⚙️',
  render: MySettingsComponent,
});

// Add button to composer toolbar
api.ui.registerComposerAction({
  id: 'my-composer-action',
  label: 'Insert Template',
  icon: '📝',
  onClick: () => { /* ... */ },
});

// Add widget in sidebar
api.ui.registerSidebarWidget({
  id: 'my-widget',
  label: 'My Widget',
  render: MyWidgetComponent,
  order: 50,
});

// Add item to email right-click menu
api.ui.registerContextMenuItem({
  id: 'my-context-action',
  label: 'Process Selected',
  icon: '⚡',
  onClick: (emailIds) => { /* ... */ },
});

// Add item at bottom of navigation rail
api.ui.registerNavigationRailItem(MyNavComponent);
```

### UI Slot Names

| Slot | Location |
|------|----------|
| `toolbar-actions` | Email toolbar area |
| `email-banner` | Above email content |
| `email-footer` | Below email content |
| `composer-toolbar` | Composer toolbar |
| `sidebar-widget` | Sidebar panel area |
| `settings-section` | Settings page |
| `context-menu-email` | Email right-click menu |
| `navigation-rail-bottom` | Bottom of navigation rail |

### api.hooks — Event Hooks

All hooks return a `Disposable` with a `.dispose()` method. Call it to unsubscribe.

```javascript
const sub = api.hooks.onEmailOpen((email) => {
  api.log.info('Opened:', email.subject);
});

// Later: sub.dispose();
```

### api.toast — Notifications

```javascript
api.toast.success('Operation completed');
api.toast.error('Something went wrong');
api.toast.info('FYI: new emails arrived');
api.toast.warning('Attachment too large');
```

### api.storage — Persistent Storage

Plugin-scoped key-value storage (uses localStorage with `plugin:<id>:` prefix).

```javascript
api.storage.set('lastRun', Date.now());
const lastRun = api.storage.get('lastRun');
api.storage.remove('lastRun');
const allKeys = api.storage.keys();
```

### api.log — Logging

```javascript
api.log.debug('Verbose details');
api.log.info('Normal operation');
api.log.warn('Something unexpected');
api.log.error('Error occurred', err);
```

## Complete Hook Reference

### Email Hooks (29)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onEmailOpen` | `email:read` | Email opened for reading |
| `onEmailClose` | `email:read` | Email viewer closed |
| `onEmailContentRender` | `email:read` | Email body rendered |
| `onThreadExpand` | `email:read` | Thread conversation expanded |
| `onComposerOpen` | `email:read` | Compose window opened |
| `onBeforeEmailSend` | `email:send` | Before email is sent (can cancel) |
| `onAfterEmailSend` | `email:send` | After email sent successfully |
| `onDraftAutoSave` | `email:read` | Draft auto-saved |
| `onBeforeEmailDelete` | `email:write` | Before email deleted |
| `onAfterEmailDelete` | `email:write` | After email deleted |
| `onBeforeEmailMove` | `email:write` | Before email moved to folder |
| `onAfterEmailMove` | `email:write` | After email moved |
| `onEmailReadStateChange` | `email:write` | Read/unread toggled |
| `onEmailStarToggle` | `email:write` | Star/flag toggled |
| `onEmailSpamToggle` | `email:write` | Spam status changed |
| `onEmailKeywordChange` | `email:write` | Tag/keyword added or removed |
| `onMailboxChange` | `email:read` | Active folder changed |
| `onMailboxesRefresh` | `email:read` | Mailbox list refreshed |
| `onMailboxCreate` | `email:write` | New folder created |
| `onMailboxRename` | `email:write` | Folder renamed |
| `onMailboxDelete` | `email:write` | Folder deleted |
| `onMailboxEmpty` | `email:write` | Folder emptied |
| `onSearch` | `email:read` | Search initiated |
| `onSearchResults` | `email:read` | Search results received |
| `onEmailSelectionChange` | `email:read` | Email selection changed |
| `onNewEmailReceived` | `email:read` | New email arrived |
| `onPushConnectionChange` | `email:read` | Push notification connection state changed |
| `onQuotaChange` | `email:read` | Storage quota updated |

### Calendar Hooks (16)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onCalendarEventOpen` | `calendar:read` | Calendar event opened |
| `onBeforeEventCreate` | `calendar:write` | Before event created |
| `onAfterEventCreate` | `calendar:write` | After event created |
| `onBeforeEventUpdate` | `calendar:write` | Before event updated |
| `onAfterEventUpdate` | `calendar:write` | After event updated |
| `onBeforeEventDelete` | `calendar:write` | Before event deleted |
| `onAfterEventDelete` | `calendar:write` | After event deleted |
| `onEventRsvp` | `calendar:write` | RSVP response sent |
| `onEventsImport` | `calendar:write` | Calendar events imported |
| `onCalendarDateChange` | `calendar:read` | Calendar date navigated |
| `onCalendarViewChange` | `calendar:read` | View mode changed (day/week/month) |
| `onCalendarChange` | `calendar:write` | Calendar created/updated/deleted |
| `onCalendarVisibilityToggle` | `calendar:read` | Calendar shown/hidden |
| `onICalSubscriptionChange` | `calendar:write` | iCal subscription changed |
| `onCalendarAlert` | `calendar:read` | Calendar reminder triggered |
| `onCalendarAlertAcknowledge` | `calendar:read` | Reminder dismissed |

### Contact Hooks (12)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onContactOpen` | `contacts:read` | Contact opened |
| `onBeforeContactCreate` | `contacts:write` | Before contact created |
| `onAfterContactCreate` | `contacts:write` | After contact created |
| `onBeforeContactUpdate` | `contacts:write` | Before contact updated |
| `onAfterContactUpdate` | `contacts:write` | After contact updated |
| `onBeforeContactDelete` | `contacts:write` | Before contact deleted |
| `onAfterContactDelete` | `contacts:write` | After contact deleted |
| `onContactsImport` | `contacts:write` | Contacts imported |
| `onContactSelectionChange` | `contacts:read` | Contact selection changed |
| `onContactGroupChange` | `contacts:write` | Contact group changed |
| `onContactGroupMemberChange` | `contacts:write` | Group membership changed |
| `onContactMove` | `contacts:write` | Contact moved to another address book |

### File Hooks (15)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onFileNavigate` | `files:read` | File browser navigated |
| `onBeforeFileUpload` | `files:write` | Before file upload |
| `onAfterFileUpload` | `files:write` | After file uploaded |
| `onFileDownload` | `files:read` | File downloaded |
| `onFileUploadCancel` | `files:write` | File upload cancelled |
| `onDirectoryCreate` | `files:write` | Directory created |
| `onBeforeFileDelete` | `files:write` | Before file deleted |
| `onAfterFileDelete` | `files:write` | After file deleted |
| `onFileRename` | `files:write` | File renamed |
| `onFileMove` | `files:write` | File moved |
| `onFileCopy` | `files:write` | File copied |
| `onFileDuplicate` | `files:write` | File duplicated |
| `onFileFavoriteToggle` | `files:write` | File favorite toggled |
| `onFileSelectionChange` | `files:read` | File selection changed |
| `onFileUndo` | `files:write` | File operation undone |

### Auth Hooks (8)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onLogin` | `auth:observe` | User logged in |
| `onBeforeLogout` | `auth:observe` | Before logout |
| `onAfterLogout` | `auth:observe` | After logout |
| `onAccountSwitch` | `auth:observe` | Account switched |
| `onAccountAdd` | `auth:observe` | Account added |
| `onAccountRemove` | `auth:observe` | Account removed |
| `onTokenRefresh` | `auth:observe` | Auth token refreshed |
| `onAuthReady` | `auth:observe` | Auth system initialized |

### Settings Hooks (7)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onSettingChange` | `settings:read` | A setting was changed |
| `onSettingsExport` | `settings:read` | Settings exported |
| `onSettingsImport` | `settings:read` | Settings imported |
| `onSettingsReset` | `settings:read` | Settings reset to defaults |
| `onSettingsSync` | `settings:read` | Settings synced |
| `onKeywordChange` | `settings:read` | Keyword/tag configuration changed |
| `onTrustedSenderChange` | `settings:read` | Trusted sender list changed |

### Identity Hooks (6)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onIdentitiesLoaded` | `identity:read` | Identities loaded |
| `onIdentityCreate` | `identity:write` | Identity created |
| `onIdentityUpdate` | `identity:write` | Identity updated |
| `onIdentityDelete` | `identity:write` | Identity deleted |
| `onIdentitySelect` | `identity:read` | Active identity changed |
| `onSignatureRender` | `identity:read` | Signature rendered |

### Filter Hooks (4)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onFiltersLoaded` | `filters:read` | Filter rules loaded |
| `onFilterRuleChange` | `filters:write` | Filter rule changed |
| `onFiltersSave` | `filters:write` | Filters saved |
| `onSieveScriptChange` | `filters:write` | Sieve script changed |

### Task Hooks (6)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onTasksLoaded` | `tasks:read` | Tasks loaded |
| `onTaskCreate` | `tasks:write` | Task created |
| `onTaskUpdate` | `tasks:write` | Task updated |
| `onTaskDelete` | `tasks:write` | Task deleted |
| `onTaskToggleComplete` | `tasks:write` | Task completed/uncompleted |
| `onTaskFilterChange` | `tasks:read` | Task filter changed |

### Template Hooks (6)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onTemplateCreate` | `templates:write` | Template created |
| `onTemplateUpdate` | `templates:write` | Template updated |
| `onTemplateDelete` | `templates:write` | Template deleted |
| `onTemplateApply` | `templates:read` | Template applied |
| `onTemplatesImport` | `templates:write` | Templates imported |
| `onTemplateRender` | `templates:read` | Template rendered |

### S/MIME Hooks (4)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onSmimeKeyImport` | `smime:read` | S/MIME key imported |
| `onSmimeCertImport` | `smime:read` | S/MIME certificate imported |
| `onSmimeKeyStateChange` | `smime:read` | S/MIME key state changed |
| `onSmimeDefaultsChange` | `smime:read` | S/MIME defaults changed |

### Vacation Hooks (2)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onVacationLoaded` | `vacation:read` | Vacation responder loaded |
| `onVacationUpdate` | `vacation:write` | Vacation responder updated |

### UI Hooks (7)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onViewChange` | `ui:observe` | View/page changed |
| `onSidebarToggle` | `ui:observe` | Sidebar opened/closed |
| `onSidebarCollapse` | `ui:observe` | Sidebar collapsed |
| `onDeviceTypeChange` | `ui:observe` | Device type changed (mobile/desktop) |
| `onColumnResize` | `ui:observe` | Column resized |
| `onMobileBack` | `ui:observe` | Mobile back navigation |
| `onMobileViewSwitch` | `ui:observe` | Mobile view switched |

### Theme Hooks (3)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onThemeChange` | `ui:observe` | Light/dark mode changed |
| `onCustomThemeChange` | `ui:observe` | Custom theme activated/deactivated |
| `onLocaleChange` | `ui:observe` | Language changed |

### Toast Hooks (3)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onToastShow` | `ui:observe` | Toast notification shown |
| `onToastDismiss` | `ui:observe` | Toast dismissed |
| `onBrowserNotification` | `ui:observe` | Browser notification shown |

### Drag & Drop Hooks (4)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onDragStart` | `ui:observe` | Drag started |
| `onDragEnd` | `ui:observe` | Drag ended |
| `onEmailDrop` | `email:write` | Email dropped on target |
| `onTagDrop` | `email:write` | Tag dropped on email |

### Keyboard Hooks (3)
| Hook | Permission | Description |
|------|-----------|-------------|
| `registerShortcut` | `ui:keyboard` | Register a keyboard shortcut |
| `onBeforeShortcut` | `ui:keyboard` | Before shortcut executed |
| `onAfterShortcut` | `ui:keyboard` | After shortcut executed |

### App Lifecycle Hooks (5)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onAppReady` | `app:lifecycle` | App fully loaded (implicit) |
| `onVisibilityChange` | `app:lifecycle` | Tab visibility changed (implicit) |
| `onBeforeUnload` | `app:lifecycle` | Before page unload (implicit) |
| `onAppError` | `app:lifecycle` | App error occurred (implicit) |
| `onInterval` | `app:lifecycle` | Periodic callback (min 60s, implicit) |

### Account Security Hooks (5)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onPasswordChange` | `security:read` | Password changed |
| `onTotpChange` | `security:read` | TOTP 2FA changed |
| `onAppPasswordChange` | `security:read` | App password changed |
| `onEncryptionChange` | `security:read` | Encryption settings changed |
| `onDisplayNameChange` | `security:read` | Display name changed |

### Sidebar App Hooks (3)
| Hook | Permission | Description |
|------|-----------|-------------|
| `onSidebarAppOpen` | `ui:observe` | Sidebar app opened |
| `onSidebarAppClose` | `ui:observe` | Sidebar app closed |
| `onSidebarAppChange` | `ui:observe` | Active sidebar app changed |

## All Permissions

### Email
- `email:read` — Read emails, mailboxes, search, quota
- `email:write` — Modify emails (move, delete, tag, flag)
- `email:send` — Send emails

### Calendar
- `calendar:read` — Read events, calendars, alerts
- `calendar:write` — Create/modify/delete events

### Contacts
- `contacts:read` — Read contacts and groups
- `contacts:write` — Create/modify/delete contacts

### Files
- `files:read` — Browse and download files
- `files:write` — Upload, delete, move files

### Identity
- `identity:read` — Read sender identities
- `identity:write` — Create/modify identities

### Filters
- `filters:read` — Read filter rules
- `filters:write` — Create/modify filter rules

### Tasks
- `tasks:read` — Read tasks
- `tasks:write` — Create/modify tasks

### Templates
- `templates:read` — Read/apply templates
- `templates:write` — Create/modify templates

### S/MIME
- `smime:read` — Read S/MIME keys and certificates

### Vacation
- `vacation:read` — Read vacation responder
- `vacation:write` — Modify vacation responder

### Settings
- `settings:read` — Read settings changes
- `settings:write` — Modify settings

### Security
- `security:read` — Observe security changes

### Auth
- `auth:observe` — Observe auth state

### UI
- `ui:observe` — Observe UI state changes (implicit, always granted)
- `ui:toolbar` — Add toolbar buttons
- `ui:email-banner` — Show email banners
- `ui:email-footer` — Show email footers
- `ui:composer-toolbar` — Add composer buttons
- `ui:sidebar-widget` — Add sidebar widgets
- `ui:settings-section` — Add settings sections
- `ui:context-menu` — Add context menu items
- `ui:navigation-rail` — Add navigation items
- `ui:keyboard` — Register keyboard shortcuts

### App
- `app:lifecycle` — App lifecycle events (implicit, always granted)

## Validation Rules

- Maximum plugin ZIP size: **5 MB**
- Allowed file extensions: `.js`, `.mjs`, `.css`, `.json`, `.png`, `.svg`, `.woff2`, `.jpg`, `.jpeg`, `.webp`
- Code is scanned for suspicious patterns (`eval()`, `new Function()`, `document.cookie`, `document.write`, `innerHTML =`)
- Plugin ID format: `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/` (min 2 chars)
- Plugins receive React, ReactDOM, and ReactJSX via `__PLUGIN_EXTERNALS__` — do not bundle React
- Auto-disabled after 3 errors within 60 seconds

## Available Examples

| Plugin | Type | Description |
|--------|------|-------------|
| [hello-world](hello-world/) | `hook` | Minimal plugin — logs lifecycle events |
| [email-stats](email-stats/) | `sidebar-app` | Sidebar widget showing email statistics |
| [auto-tag](auto-tag/) | `hook` | Automatically tags emails based on rules |
| [send-later](send-later/) | `ui-extension` | Adds "Send Later" button to composer |
| [quick-notes](quick-notes/) | `sidebar-app` | Per-email sticky notes in the sidebar |

## Building Plugins

Plugins are ES modules. Use any bundler (esbuild, Rollup, webpack) to produce a single `.js` file.

### Recommended: esbuild

```bash
npm install --save-dev esbuild
npx esbuild src/index.js --bundle --format=esm --outfile=dist/index.js \
  --external:react --external:react-dom --external:react/jsx-runtime
```

### Important: Do NOT bundle React

Bulwark Mail exposes React to plugins via `__PLUGIN_EXTERNALS__`. Mark React as external in your bundler:

```javascript
// esbuild
{ external: ['react', 'react-dom', 'react/jsx-runtime'] }

// Rollup
{ external: ['react', 'react-dom', 'react/jsx-runtime'] }

// webpack
{ externals: { react: 'react', 'react-dom': 'react-dom', 'react/jsx-runtime': 'react/jsx-runtime' } }
```

## License

All plugins in this repository are released under the [MIT License](LICENSE).
