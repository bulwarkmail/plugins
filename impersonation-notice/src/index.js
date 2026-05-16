/**
 * Impersonation Notice
 *
 * Renders a persistent top-of-app banner whenever the active session is a
 * Stalwart master-user impersonation. Detection is purely on the username:
 * Stalwart's impersonation syntax is "<target>%<master>", so any session
 * username containing '%' is treated as impersonated.
 *
 * The banner is configured by the admin (return URL, label, colour, role
 * label) — there are no per-user settings.
 *
 * Demonstrates:
 *   - api.ui.registerAppTopBanner   (new global-banner slot)
 *   - api.ui.registerAdminPage      (admin-only configuration UI)
 *   - api.admin.getConfig/setConfig (organisation-wide settings)
 *   - api.i18n.addTranslations / t() (en + de strings out of the box)
 */

const STYLE_ID = 'plugin-impersonation-notice-style';

const STYLES = `
.imp-notice-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  flex-shrink: 0;
  width: 100%;
  box-sizing: border-box;
}
.imp-notice-banner-left {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.imp-notice-banner-icon {
  flex-shrink: 0;
  display: inline-flex;
  width: 14px;
  height: 14px;
}
.imp-notice-banner-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.imp-notice-banner-text strong {
  font-weight: 700;
}
.imp-notice-banner-button {
  flex-shrink: 0;
  font: inherit;
  font-weight: 500;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  padding: 4px 12px;
  border-radius: 6px;
  cursor: pointer;
  opacity: 0.95;
  transition: opacity 0.12s ease;
}
.imp-notice-banner-button:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.08);
}

/* Admin page */
.imp-admin-wrap { padding: 24px; max-width: 720px; }
.imp-admin-section { margin-bottom: 24px; }
.imp-admin-section h2 {
  font-size: 16px; font-weight: 600; margin: 0 0 8px 0;
}
.imp-admin-section p { margin: 0 0 12px 0; color: var(--muted-foreground); font-size: 13px; }
.imp-admin-field { display: block; margin-bottom: 14px; }
.imp-admin-field label {
  display: block; font-size: 13px; font-weight: 500; margin-bottom: 4px;
}
.imp-admin-field input[type="text"], .imp-admin-field input[type="url"] {
  width: 100%; padding: 6px 10px; font: inherit;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--background); color: var(--foreground);
}
.imp-admin-field .imp-admin-hint {
  font-size: 12px; color: var(--muted-foreground); margin-top: 4px;
}
.imp-admin-save {
  font: inherit; padding: 6px 16px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--primary); color: var(--primary-foreground);
  cursor: pointer;
}
.imp-admin-status-pill {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 600;
  padding: 3px 10px; border-radius: 999px;
  margin-left: 8px;
}
.imp-admin-status-on { background: rgba(34, 197, 94, 0.15); color: rgb(22, 163, 74); }
.imp-admin-status-off { background: rgba(239, 68, 68, 0.15); color: rgb(220, 38, 38); }
.imp-admin-color-row { display: flex; gap: 10px; align-items: center; }
.imp-admin-color-row input[type="color"] {
  width: 36px; height: 32px; padding: 0; border: 1px solid var(--border);
  border-radius: 6px; background: transparent;
}
.imp-admin-preview {
  margin-top: 8px; border-radius: 6px; overflow: hidden;
  border: 1px solid var(--border);
}
`;

function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

function getReact() {
  return globalThis.__PLUGIN_EXTERNALS__?.React;
}

const DEFAULT_CONFIG = {
  returnUrl: '',
  returnLabel: 'Back to platform',
  bannerBackground: '#3b82f6',
  bannerBackgroundDark: '#1e40af',
  bannerForeground: '#ffffff',
  actorRoleLabel: 'as Platform Admin',
};

function detectDarkMode() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.classList.contains('dark');
}

// Subscribe to dark-mode toggles via MutationObserver on <html>'s class
// attribute. Returns an unsubscribe function. fn() is called with the
// current isDark boolean each time it changes.
function subscribeDarkMode(fn) {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {};
  }
  let last = detectDarkMode();
  const observer = new MutationObserver(() => {
    const now = detectDarkMode();
    if (now !== last) {
      last = now;
      fn(now);
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

// ─── Cached admin config (synchronous-readable) ─────────────────
//
// The banner render must be synchronous. Admin config arrives async via
// api.admin.getConfig — we keep a snapshot and notify React subscribers
// when it lands so the banner re-renders with the right styling.
function createConfigCache(api) {
  let cache = { ...DEFAULT_CONFIG };
  let loaded = false;
  let loadPromise = null;
  const listeners = new Set();

  function load() {
    if (loaded) return Promise.resolve(cache);
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        const all = await api.admin.getAllConfig();
        cache = { ...DEFAULT_CONFIG, ...(all || {}) };
      } catch (err) {
        api.log.warn('Failed to load impersonation-notice config', err);
      }
      loaded = true;
      loadPromise = null;
      listeners.forEach((fn) => {
        try { fn(); } catch { /* ignore */ }
      });
      return cache;
    })();
    return loadPromise;
  }

  return {
    get: () => cache,
    refresh: () => { loaded = false; return load(); },
    load,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function looksLikeImpersonation(username) {
  return typeof username === 'string' && username.includes('%');
}

function parseImpersonatedMailbox(username) {
  if (!looksLikeImpersonation(username)) return null;
  return username.split('%')[0] || null;
}

// ─── Banner ──────────────────────────────────────────────────────

function makeBanner(api, configCache) {
  return function ImpersonationBanner(props) {
    const React = getReact();
    if (!React) return null;
    const { useState, useEffect } = React;

    const [cfg, setCfg] = useState(configCache.get());
    const [busy, setBusy] = useState(false);
    const [isDark, setIsDark] = useState(detectDarkMode);

    useEffect(() => {
      configCache.load();
      return configCache.subscribe(() => setCfg({ ...configCache.get() }));
    }, []);

    useEffect(() => subscribeDarkMode(setIsDark), []);

    const mailbox = parseImpersonatedMailbox(props.username);

    // Drop the impersonation session as soon as the tab is closed or
    // refreshed. We use keepalive so the DELETE survives the unload.
    // Side effect: a refresh also drops the session — the admin has to
    // re-click "Open Webmail" from the platform. That's the right
    // behaviour for a short-lived support handoff; persistent identity
    // is what password login is for.
    useEffect(() => {
      if (!mailbox) return;
      const drop = () => {
        try {
          fetch('/api/auth/session?all=true', {
            method: 'DELETE',
            credentials: 'same-origin',
            keepalive: true,
          });
        } catch { /* ignore */ }
      };
      window.addEventListener('pagehide', drop);
      window.addEventListener('beforeunload', drop);
      return () => {
        window.removeEventListener('pagehide', drop);
        window.removeEventListener('beforeunload', drop);
      };
    }, [mailbox]);

    if (!mailbox) return null;

    async function handleReturn() {
      if (busy) return;
      setBusy(true);
      try {
        await fetch('/api/auth/session?all=true', {
          method: 'DELETE',
          credentials: 'same-origin',
          keepalive: true,
        });
      } catch (err) {
        api.log.warn('Logout call before platform return failed', err);
      }
      const target = (cfg.returnUrl || '').trim();
      if (target) {
        window.location.href = target;
      } else {
        window.location.reload();
      }
    }

    const text = React.createElement(
      'span',
      { className: 'imp-notice-banner-text' },
      api.i18n.t('viewing'),
      ' ',
      React.createElement('strong', null, mailbox),
      cfg.actorRoleLabel ? ' ' + cfg.actorRoleLabel : '',
    );

    const left = React.createElement(
      'div',
      { className: 'imp-notice-banner-left' },
      React.createElement('span', {
        className: 'imp-notice-banner-icon',
        'aria-hidden': 'true',
        dangerouslySetInnerHTML: { __html: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>' },
      }),
      text,
    );

    const button = (cfg.returnUrl || '').trim()
      ? React.createElement(
          'button',
          {
            type: 'button',
            className: 'imp-notice-banner-button',
            onClick: handleReturn,
            disabled: busy,
          },
          '← ',
          cfg.returnLabel || api.i18n.t('back'),
        )
      : null;

    const bg = isDark
      ? (cfg.bannerBackgroundDark || cfg.bannerBackground)
      : cfg.bannerBackground;

    return React.createElement(
      'div',
      {
        className: 'imp-notice-banner',
        role: 'status',
        'aria-live': 'polite',
        style: { background: bg, color: cfg.bannerForeground },
      },
      left,
      button,
    );
  };
}

// ─── Admin page ─────────────────────────────────────────────────

function makeAdminPage(api, configCache) {
  return function ImpersonationAdminPage() {
    const React = getReact();
    if (!React) return null;
    const { useState, useEffect } = React;

    const [cfg, setCfg] = useState(configCache.get());
    const [saving, setSaving] = useState(false);
    const [savedAt, setSavedAt] = useState(0);
    // Server-side configured status — probed by hitting the impersonate route
    // with a bogus token. 404 = feature disabled (env vars missing); anything
    // else = configured (it got past the gate and is now validating the JWT).
    const [serverStatus, setServerStatus] = useState('unknown');

    useEffect(() => {
      let active = true;
      configCache.refresh().then(() => {
        if (active) setCfg({ ...configCache.get() });
      });
      fetch('/api/auth/impersonate?token=probe', {
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
      })
        .then((r) => {
          if (!active) return;
          setServerStatus(r.status === 404 ? 'off' : 'on');
        })
        .catch(() => {
          if (active) setServerStatus('unknown');
        });
      return () => { active = false; };
    }, []);

    function update(key, value) {
      setCfg((prev) => ({ ...prev, [key]: value }));
    }

    async function save() {
      setSaving(true);
      try {
        await Promise.all(
          Object.keys(DEFAULT_CONFIG).map((k) =>
            api.admin.setConfig(k, cfg[k] ?? DEFAULT_CONFIG[k]),
          ),
        );
        await configCache.refresh();
        setSavedAt(Date.now());
      } catch (err) {
        api.log.error('Failed to save impersonation-notice config', err);
        api.toast.error(api.i18n.t('saveFailed'));
      } finally {
        setSaving(false);
      }
    }

    const h = React.createElement;

    const statusPill = serverStatus === 'on'
      ? h('span', { className: 'imp-admin-status-pill imp-admin-status-on' }, '● ', api.i18n.t('statusOn'))
      : serverStatus === 'off'
        ? h('span', { className: 'imp-admin-status-pill imp-admin-status-off' }, '○ ', api.i18n.t('statusOff'))
        : h('span', { className: 'imp-admin-status-pill imp-admin-status-off' }, '… ', api.i18n.t('statusUnknown'));

    const previewMailbox = 'alice@example.test';
    function buildPreviewBanner(bgColor) {
      return h(
        'div',
        {
          className: 'imp-notice-banner',
          style: { background: bgColor, color: cfg.bannerForeground },
        },
        h('div', { className: 'imp-notice-banner-left' },
          h('span', { className: 'imp-notice-banner-text' },
            api.i18n.t('viewing'), ' ',
            h('strong', null, previewMailbox),
            cfg.actorRoleLabel ? ' ' + cfg.actorRoleLabel : '',
          ),
        ),
        (cfg.returnUrl || '').trim()
          ? h('button', { className: 'imp-notice-banner-button', type: 'button', tabIndex: -1 },
              '← ', cfg.returnLabel || api.i18n.t('back'))
          : null,
      );
    }
    const previewBanner = h('div', null,
      buildPreviewBanner(cfg.bannerBackground || '#3b82f6'),
      buildPreviewBanner(cfg.bannerBackgroundDark || '#1e40af'),
    );

    return h(
      'div',
      { className: 'imp-admin-wrap' },
      h('div', { className: 'imp-admin-section' },
        h('h2', null, api.i18n.t('adminTitle'), statusPill),
        h('p', null,
          serverStatus === 'on'
            ? api.i18n.t('serverConfigured')
            : serverStatus === 'off'
              ? api.i18n.t('serverNotConfigured')
              : api.i18n.t('serverProbeFailed'),
        ),
      ),
      h('div', { className: 'imp-admin-section' },
        h('h2', null, api.i18n.t('appearance')),
        h('div', { className: 'imp-admin-field' },
          h('label', null, api.i18n.t('returnUrlLabel')),
          h('input', {
            type: 'url',
            value: cfg.returnUrl || '',
            placeholder: 'https://platform.example.com/admin',
            onChange: (e) => update('returnUrl', e.target.value),
          }),
          h('div', { className: 'imp-admin-hint' }, api.i18n.t('returnUrlHint')),
        ),
        h('div', { className: 'imp-admin-field' },
          h('label', null, api.i18n.t('returnLabelLabel')),
          h('input', {
            type: 'text',
            value: cfg.returnLabel || '',
            onChange: (e) => update('returnLabel', e.target.value),
          }),
        ),
        h('div', { className: 'imp-admin-field' },
          h('label', null, api.i18n.t('actorRoleLabelLabel')),
          h('input', {
            type: 'text',
            value: cfg.actorRoleLabel || '',
            placeholder: 'as Platform Admin',
            onChange: (e) => update('actorRoleLabel', e.target.value),
          }),
        ),
        h('div', { className: 'imp-admin-field' },
          h('label', null, api.i18n.t('colorsLabel')),
          h('div', { className: 'imp-admin-color-row' },
            h('input', { type: 'color', value: cfg.bannerBackground || '#3b82f6', onChange: (e) => update('bannerBackground', e.target.value) }),
            h('span', { className: 'imp-admin-hint' }, api.i18n.t('backgroundLight')),
            h('input', { type: 'color', value: cfg.bannerBackgroundDark || '#1e40af', onChange: (e) => update('bannerBackgroundDark', e.target.value) }),
            h('span', { className: 'imp-admin-hint' }, api.i18n.t('backgroundDark')),
            h('input', { type: 'color', value: cfg.bannerForeground || '#ffffff', onChange: (e) => update('bannerForeground', e.target.value) }),
            h('span', { className: 'imp-admin-hint' }, api.i18n.t('foreground')),
          ),
        ),
        h('div', { className: 'imp-admin-field' },
          h('label', null, api.i18n.t('preview')),
          h('div', { className: 'imp-admin-preview' }, previewBanner),
        ),
        h('button', {
          className: 'imp-admin-save',
          onClick: save,
          disabled: saving,
        }, saving ? api.i18n.t('saving') : api.i18n.t('save')),
        savedAt && Date.now() - savedAt < 4000
          ? h('span', { style: { marginLeft: '12px', color: 'rgb(22, 163, 74)', fontSize: '12px' } }, '✓ ' + api.i18n.t('saved'))
          : null,
      ),
      h('div', { className: 'imp-admin-section' },
        h('h2', null, api.i18n.t('serverSetup')),
        h('p', null, api.i18n.t('serverSetupBody')),
        h('pre', {
          style: {
            background: 'var(--muted)', padding: '12px', borderRadius: '6px',
            fontSize: '12px', overflow: 'auto', margin: 0,
          },
        },
          'BULWARK_JWT_AUTH_SECRET=<32+ random chars>\n' +
          'BULWARK_STALWART_MASTER_USER=master@example.test\n' +
          'BULWARK_STALWART_MASTER_PASSWORD=<master password>\n' +
          'BULWARK_JWT_AUTH_ISSUER=platform-api/webmail  # optional',
        ),
      ),
    );
  };
}

// ─── Activate ───────────────────────────────────────────────────

export function activate(api) {
  ensureStyles();

  api.i18n.addTranslations('en', {
    viewing: 'You are viewing',
    back: 'Back to platform',
    statusOn: 'Server enabled',
    statusOff: 'Server disabled',
    statusUnknown: 'Probing…',
    adminTitle: 'Impersonation Notice',
    serverConfigured: 'The /api/auth/impersonate route is configured on the server. Platforms can mint JWTs and hand users off into mailboxes.',
    serverNotConfigured: 'The /api/auth/impersonate route is not configured on the server. Set BULWARK_JWT_AUTH_SECRET, BULWARK_STALWART_MASTER_USER and BULWARK_STALWART_MASTER_PASSWORD in the environment, then restart.',
    serverProbeFailed: 'Could not probe the impersonate route. Check your reverse-proxy.',
    appearance: 'Banner appearance',
    returnUrlLabel: 'Platform return URL',
    returnUrlHint: 'Where the "Back to platform" button sends the user after the impersonated session is cleared. Leave blank to hide the button.',
    returnLabelLabel: 'Button label',
    actorRoleLabelLabel: 'Role suffix',
    colorsLabel: 'Colours',
    backgroundLight: 'light bg',
    backgroundDark: 'dark bg',
    foreground: 'text',
    preview: 'Preview',
    save: 'Save changes',
    saving: 'Saving…',
    saved: 'Saved',
    saveFailed: 'Failed to save settings',
    serverSetup: 'Server-side configuration',
    serverSetupBody: 'For security the JWT signing secret and master credentials live only in the environment (never in the admin database). Set these on the Bulwark process and restart:',
  });
  api.i18n.addTranslations('de', {
    viewing: 'Du siehst',
    back: 'Zurück zur Platform',
    statusOn: 'Server aktiv',
    statusOff: 'Server deaktiviert',
    statusUnknown: 'Prüfe…',
    adminTitle: 'Impersonation-Hinweis',
    serverConfigured: 'Die Route /api/auth/impersonate ist auf dem Server konfiguriert. Plattformen können JWTs ausstellen und Benutzer in Postfächer einsetzen.',
    serverNotConfigured: 'Die Route /api/auth/impersonate ist auf dem Server nicht konfiguriert. Setze BULWARK_JWT_AUTH_SECRET, BULWARK_STALWART_MASTER_USER und BULWARK_STALWART_MASTER_PASSWORD im Environment und starte den Prozess neu.',
    serverProbeFailed: 'Die Impersonate-Route konnte nicht geprüft werden. Prüfe deinen Reverse-Proxy.',
    appearance: 'Banner-Aussehen',
    returnUrlLabel: 'Platform-Rück-URL',
    returnUrlHint: 'Wohin der „Zurück zur Platform"-Button springt, nachdem die Impersonation-Sitzung beendet wurde. Leer = Button ausblenden.',
    returnLabelLabel: 'Button-Beschriftung',
    actorRoleLabelLabel: 'Rollen-Zusatz',
    colorsLabel: 'Farben',
    backgroundLight: 'Hell-Hintergrund',
    backgroundDark: 'Dunkel-Hintergrund',
    foreground: 'Text',
    preview: 'Vorschau',
    save: 'Speichern',
    saving: 'Speichere…',
    saved: 'Gespeichert',
    saveFailed: 'Speichern fehlgeschlagen',
    serverSetup: 'Server-Konfiguration',
    serverSetupBody: 'Aus Sicherheitsgründen liegen das JWT-Signaturgeheimnis und die Master-Zugangsdaten ausschließlich im Environment (nicht in der Admin-Datenbank). Setze diese am Bulwark-Prozess und starte neu:',
  });

  const configCache = createConfigCache(api);
  void configCache.load();

  const disposables = [];

  disposables.push(
    api.ui.registerAppTopBanner(makeBanner(api, configCache)),
  );

  disposables.push(
    api.ui.registerAdminPage({
      id: 'impersonation-notice',
      label: 'Impersonation Notice',
      render: makeAdminPage(api, configCache),
    }),
  );

  api.log.info('Impersonation Notice plugin activated');

  return {
    dispose: () => {
      disposables.forEach((d) => d.dispose());
      const style = typeof document !== 'undefined'
        ? document.getElementById(STYLE_ID) : null;
      if (style) style.remove();
    },
  };
}
