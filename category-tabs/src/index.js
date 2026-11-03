/**
 * Inbox Category Tabs — Gmail-style Primary / Social / Promotions / Updates
 * tabs for the Bulwark message list (issue #656).
 *
 * Demonstrates the full category-tabs extension surface:
 *   - `api.tabs.set(config)` — register native tabs the host renders above
 *     the message list (permission ui:message-list-tabs).
 *   - Search-based tabs: each tab carries a raw JMAP Email filter (`query`)
 *     evaluated server-side at view time. No mail is modified.
 *   - Sieve mode: tabs filter on durable `$category-*` keywords assigned at
 *     delivery by a managed Sieve section, injected via the
 *     `onSieveScriptGenerate` transform + `api.sieve.regenerate()`.
 *   - `onEmailCategorize` — persists per-sender overrides ("always put mail
 *     from X in tab Y"), Gmail-style.
 *   - A `settings-section` slot where the user customizes everything: which
 *     tabs exist (including their own custom tabs), labels, icons, colors,
 *     order, the sender/subject rule lists, the classification mode, and
 *     their per-sender pins. Config lives in api.storage; saving re-registers
 *     the tabs live and (in sieve mode) regenerates the managed script.
 */

const { createElement: h, useState, useEffect } = require('react');

// The background iframe AND the settings slot iframe both evaluate this
// bundle; `activate` only runs in the background, so grab the api at module
// scope — the host injects it as '@plugin-host' in every sandbox context.
let api = null;
try { api = require('@plugin-host'); } catch { /* evaluated outside a sandbox */ }

// ── Default classification rules (user-editable in settings) ──────────────

const SOCIAL_DOMAINS = [
  'reddit.com', 'redditmail.com',
  'linkedin.com', 'linkedinmail.com', 'e.linkedin.com',
  'facebookmail.com', 'facebook.com',
  'nextdoor.com', 'rs.email.nextdoor.com',
  'instagram.com', 'mail.instagram.com',
  'x.com', 'twitter.com', 'youtube.com',
  'discoursemail.com', 'meetup.com', 'bsky.app', 'discord.com',
];

const ESP_SENDERS = [
  'sendgrid.net', 'mailchimp', 'mcsv.net', 'rsgsv.net', 'mcdlv.net',
  'mailgun', 'sparkpostmail', 'klaviyo', 'mktomail', 'marketo',
  'hubspotemail', 'createsend', 'mandrillapp', 'amazonses', 'sailthru',
  'braze', 'iterable', 'constantcontact', 'eloqua',
];

const UPDATES_SUBJECTS = [
  'receipt', 'invoice', 'order confirmation', 'your order', 'shipped',
  'tracking', 'verification code', 'verify your', 'confirm your',
  'one-time', 'security code', 'password reset', 'sign-in', 'otp',
  'payment', 'statement', 'renewal',
];

function defaultConfig() {
  // Locale-aware defaults; once the user saves, their labels win.
  const t = (key, fallback) => {
    try {
      const v = api ? api.i18n.t(key) : key;
      return v === key ? fallback : v;
    } catch { return fallback; }
  };
  return {
    mode: 'search', // 'search' (live JMAP query) | 'sieve' (durable keywords)
    tabs: [
      { id: 'primary', label: t('tab.primary', 'Primary'), icon: 'Inbox', color: '', order: 10, enabled: true, isDefault: true, senders: [], subjects: [], bulkMarkers: false },
      { id: 'social', label: t('tab.social', 'Social'), icon: 'Users', color: '', order: 20, enabled: true, senders: [...SOCIAL_DOMAINS], subjects: [], bulkMarkers: false },
      { id: 'promotions', label: t('tab.promotions', 'Promotions'), icon: 'Tag', color: '', order: 30, enabled: true, senders: [...ESP_SENDERS], subjects: [], bulkMarkers: true },
      { id: 'updates', label: t('tab.updates', 'Updates'), icon: 'Bell', color: '', order: 40, enabled: true, senders: [], subjects: [...UPDATES_SUBJECTS], bulkMarkers: false },
    ],
  };
}

// ── Storage ────────────────────────────────────────────────────────────────
// Slot and background run in separate iframes; api.storage is the shared
// source of truth. Always read fresh before acting on config.

async function loadConfig() {
  const stored = await api.storage.get('config');
  if (!stored || !Array.isArray(stored.tabs)) return defaultConfig();
  return stored;
}

async function loadOverrides() {
  return (await api.storage.get('senderOverrides')) || {}; // { sender: tabId }
}

// ── Tab definition building (shared by background + settings slot) ────────

function keywordFor(tab) {
  return `$category-${tab.id}`;
}

/** JMAP filter that positively matches a tab's rules, or null when rule-less. */
function ruleQuery(tab) {
  const conditions = [];
  for (const s of tab.senders || []) conditions.push({ from: s });
  for (const s of tab.subjects || []) conditions.push({ subject: s });
  if (tab.bulkMarkers) conditions.push({ header: ['List-Unsubscribe'] });
  if (conditions.length === 0) return null;
  return conditions.length === 1 ? conditions[0] : { operator: 'OR', conditions };
}

/** Layer the user's per-sender pins over a tab's base query. */
function withOverrides(tabId, base, overrides) {
  const add = [];
  const remove = [];
  for (const [sender, target] of Object.entries(overrides)) {
    (target === tabId ? add : remove).push({ from: sender });
  }
  let query = base;
  if (add.length > 0) {
    query = query ? { operator: 'OR', conditions: [query, ...add] } : (add.length === 1 ? add[0] : { operator: 'OR', conditions: add });
  }
  if (query && remove.length > 0) {
    query = { operator: 'AND', conditions: [query, { operator: 'NOT', conditions: remove }] };
  }
  return query;
}

/** Build the api.tabs.set payload from the stored user config. */
function buildTabDefs(config, overrides) {
  const tabs = [];
  for (const tab of config.tabs) {
    if (!tab.enabled) continue;
    const base = { id: tab.id, label: tab.label, icon: tab.icon || undefined, color: tab.color || undefined, order: tab.order };
    if (tab.isDefault) {
      tabs.push(base);
      continue;
    }
    if (config.mode === 'sieve') {
      tabs.push({ ...base, keyword: keywordFor(tab) });
      continue;
    }
    const query = withOverrides(tab.id, ruleQuery(tab), overrides);
    if (!query) continue; // a rule-less tab matches nothing in search mode
    tabs.push({ ...base, query });
  }
  return tabs;
}

/** Register (or clear) the strip from the current stored state. */
async function applyTabs() {
  const [config, overrides] = await Promise.all([loadConfig(), loadOverrides()]);
  const tabs = buildTabDefs(config, overrides);
  if (tabs.length < 2) {
    await api.tabs.clear();
    return;
  }
  await api.tabs.set({ mailboxRoles: ['inbox'], tabs });
}

// ── Sieve section (mode: 'sieve') ──────────────────────────────────────────
// Injected into the account's active script via the onSieveScriptGenerate
// transform. Wrapped in sentinel comments and REPLACED on every regeneration
// (the previous run's section round-trips through the host's generator) —
// never blindly appended.

const SIEVE_BEGIN = '# BEGIN category-tabs (managed by the Inbox Category Tabs plugin)';
const SIEVE_END = '# END category-tabs';
const SIEVE_REQUIRE = 'require ["imap4flags"];';

function sieveList(items) {
  return items.map((s) => JSON.stringify(s)).join(', ');
}

function buildSieveSection(config, overrides) {
  const rules = [];
  const pinsFor = (tabId) => Object.entries(overrides).filter(([, t]) => t === tabId).map(([s]) => s);

  // Pins to the default tab beat every heuristic — an empty block stops the
  // elsif chain so no category keyword is set.
  const defaultTab = config.tabs.find((t) => t.isDefault && t.enabled);
  const defaultPins = defaultTab ? pinsFor(defaultTab.id) : [];
  if (defaultPins.length > 0) {
    rules.push(`if header :contains "from" [${sieveList(defaultPins)}] { }`);
  }

  const ordered = config.tabs
    .filter((t) => t.enabled && !t.isDefault)
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  for (const tab of ordered) {
    const tests = [];
    const senders = [...(tab.senders || []), ...pinsFor(tab.id)];
    if (senders.length > 0) tests.push(`header :contains "from" [${sieveList(senders)}]`);
    if ((tab.subjects || []).length > 0) tests.push(`header :contains "subject" [${sieveList(tab.subjects)}]`);
    if (tab.bulkMarkers) {
      tests.push('exists "list-unsubscribe"');
      tests.push('header :contains "precedence" ["bulk", "list"]');
    }
    if (tests.length === 0) continue;
    const test = tests.length === 1 ? tests[0] : `anyof (\n    ${tests.join(',\n    ')}\n)`;
    rules.push(`elsif ${test} {\n    setflag "${keywordFor(tab)}";\n}`);
  }

  if (rules.length === 0) return '';
  // The chain must open with `if` no matter which rule lands first.
  rules[0] = rules[0].replace(/^elsif/, 'if');
  return `${SIEVE_BEGIN}\n${rules.join('\n')}\n${SIEVE_END}`;
}

function spliceSieveSection(script, section) {
  // Strip any previous managed section.
  const beginIdx = script.indexOf(SIEVE_BEGIN);
  const endIdx = script.indexOf(SIEVE_END);
  let out = script;
  if (beginIdx !== -1 && endIdx !== -1) {
    out = script.slice(0, beginIdx) + script.slice(endIdx + SIEVE_END.length);
  }
  out = out.trimEnd();
  if (!section) return out + '\n';
  // `require` must precede all other commands (RFC 5228 §3.2); a leading
  // require block before the host's own requires is still a valid prefix.
  if (!out.includes('"imap4flags"')) {
    out = `${SIEVE_REQUIRE}\n${out}`;
  }
  return `${out}\n\n${section}\n`;
}

async function syncSieve(config) {
  if (config.mode !== 'sieve') return;
  try {
    if (!(await api.sieve.isSupported())) {
      api.log.warn('Sieve mode selected but the server has no Sieve capability; tabs will only match manually categorized mail.');
      return;
    }
    // Triggers the host's script rebuild, which runs our
    // onSieveScriptGenerate transform below.
    await api.sieve.regenerate();
  } catch (err) {
    api.log.error('Sieve sync failed:', err && err.message);
  }
}

// ── Settings UI (settings-section slot) ────────────────────────────────────
// Runs in its own slot iframe but shares this bundle, so the builders above
// are reused. All state flows through api.storage; Save re-registers the
// tabs live via api.tabs.set (the host refetches the list automatically).
//
// The iframe has no host CSS — only the replayed theme tokens (host-theme.ts)
// — so the app's settings design language (SettingsSection / SettingItem /
// ToggleSwitch / Input / Button) is recreated here as a small stylesheet on
// the same tokens. Class-based styling also gives hover/focus states that
// inline styles can't express.

const STYLES = `
.ct { font-size: 14px; color: var(--color-foreground); max-width: 860px; }
.ct h3 { font-size: 18px; font-weight: 500; margin: 0 0 4px; }
.ct-desc { font-size: 14px; color: var(--color-muted-foreground); margin: 0 0 8px; }
.ct-group-label { font-size: 14px; font-weight: 500; margin: 20px 0 8px; }

.ct-row { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--color-border); }
.ct-row:last-child { border-bottom: none; }
.ct-row-label { font-size: 14px; font-weight: 500; }
.ct-row-desc { font-size: 12px; color: var(--color-muted-foreground); margin-top: 4px; }

.ct-card { border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-card, var(--color-background)); padding: 14px 16px; margin-bottom: 10px; transition: opacity 0.2s; }
.ct-card.ct-disabled { opacity: 0.55; }
.ct-card-header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.ct-card-body { margin-top: 12px; display: flex; flex-direction: column; gap: 10px; }

.ct-input, .ct-textarea, .ct-select {
  font: inherit; font-size: 14px; border-radius: 6px;
  border: 1px solid var(--color-input); background: var(--color-background);
  color: var(--color-foreground); padding: 0 12px; width: 100%;
  box-sizing: border-box; transition: border-color 0.2s, box-shadow 0.2s;
}
.ct-input { height: 36px; }
.ct-input::placeholder, .ct-textarea::placeholder { color: var(--color-muted-foreground); }
.ct-input:hover, .ct-textarea:hover { border-color: var(--color-muted-foreground); }
.ct-input:focus-visible, .ct-textarea:focus-visible, .ct-select:focus-visible {
  outline: none; border-color: var(--color-ring); box-shadow: 0 0 0 2px var(--color-ring);
}
.ct-textarea { min-height: 72px; padding: 8px 12px; resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5; }
.ct-select { height: 36px; width: auto; background: var(--color-muted); cursor: pointer; }
.ct-select:hover { border-color: var(--color-muted-foreground); }
.ct-color { padding: 3px; height: 36px; cursor: pointer; }

.ct-btn { display: inline-flex; align-items: center; justify-content: center;
  font: inherit; font-size: 14px; font-weight: 500; border-radius: 6px;
  height: 36px; padding: 0 16px; cursor: pointer; border: 1px solid transparent;
  transition: background-color 0.2s, color 0.2s, box-shadow 0.2s, opacity 0.2s; }
.ct-btn:disabled { opacity: 0.5; pointer-events: none; }
.ct-btn-primary { background: var(--color-primary); color: var(--color-primary-foreground); box-shadow: 0 1px 2px rgb(0 0 0 / 0.05); }
.ct-btn-primary:hover { opacity: 0.9; box-shadow: 0 1px 3px rgb(0 0 0 / 0.1); }
.ct-btn-outline { background: var(--color-background); border-color: var(--color-input); color: var(--color-foreground); }
.ct-btn-outline:hover { background: var(--color-accent); color: var(--color-accent-foreground); }
.ct-btn-ghost-danger { background: transparent; color: var(--color-destructive); }
.ct-btn-ghost-danger:hover { background: var(--color-destructive); color: var(--color-destructive-foreground); }
.ct-btn-sm { height: 30px; padding: 0 10px; font-size: 12px; }

.ct-toggle { position: relative; display: inline-flex; align-items: center; flex: none;
  width: 44px; height: 24px; border-radius: 9999px; border: none; padding: 0;
  cursor: pointer; transition: background-color 0.15s; }
.ct-toggle[aria-checked="true"] { background: var(--color-primary); }
.ct-toggle[aria-checked="false"] { background: var(--color-muted); box-shadow: inset 0 0 0 1px var(--color-muted-foreground); }
.ct-knob { display: inline-block; width: 16px; height: 16px; border-radius: 9999px;
  background: var(--color-background); margin-inline-start: 4px; transition: margin 0.15s; }
.ct-toggle[aria-checked="false"] .ct-knob { background: var(--color-muted-foreground); }
.ct-toggle[aria-checked="true"] .ct-knob { margin-inline-start: 24px; }

.ct-chip { font-size: 11px; color: var(--color-muted-foreground); background: var(--color-muted);
  border-radius: 9999px; padding: 2px 8px; white-space: nowrap; }
.ct-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
.ct-grid-wide { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
.ct-field-label { display: block; font-size: 12px; font-weight: 500; color: var(--color-muted-foreground); margin-bottom: 4px; }
.ct-inline { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.ct-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px;
  background: var(--color-muted); padding: 1px 6px; border-radius: 4px; }
.ct-footer { display: flex; gap: 8px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--color-border); }
`;

function Toggle({ checked, onChange, label }) {
  return h('button', {
    type: 'button', role: 'switch', 'aria-checked': checked, className: 'ct-toggle',
    title: label, 'aria-label': label,
    onClick: () => onChange(!checked),
  }, h('span', { className: 'ct-knob' }));
}

function Field(label, control) {
  return h('div', null, h('label', { className: 'ct-field-label' }, label), control);
}

function SettingRow({ label, description, children }) {
  return h('div', { className: 'ct-row' },
    h('div', { style: { flex: '1 1 180px', minWidth: 0 } },
      h('div', { className: 'ct-row-label' }, label),
      description ? h('div', { className: 'ct-row-desc' }, description) : null,
    ),
    h('div', { style: { flexShrink: 0 } }, children),
  );
}

function listToText(list) { return (list || []).join('\n'); }
function textToList(text) {
  return String(text || '').split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 200);
}

function slugify(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'tab';
}

function TabEditor({ tab, onChange, onRemove }) {
  const set = (patch) => onChange({ ...tab, ...patch });
  return h('div', { className: `ct-card${tab.enabled ? '' : ' ct-disabled'}` },
    h('div', { className: 'ct-card-header' },
      h(Toggle, { checked: !!tab.enabled, onChange: (v) => set({ enabled: v }), label: 'Show this tab' }),
      h('input', {
        className: 'ct-input', style: { flex: '1 1 140px', width: 'auto', minWidth: 0, maxWidth: '240px', fontWeight: 500 },
        value: tab.label, maxLength: 40, placeholder: 'Tab name',
        onChange: (e) => set({ label: e.target.value }),
      }),
      h('span', { className: 'ct-chip' }, tab.isDefault ? 'default bucket' : `#${tab.id}`),
      h('div', { style: { flex: 1 } }),
      !tab.isDefault && tab.custom
        ? h('button', { className: 'ct-btn ct-btn-ghost-danger ct-btn-sm', onClick: onRemove }, 'Remove')
        : null,
    ),
    h('div', { className: 'ct-card-body' },
      h('div', { className: 'ct-grid' },
        Field('Icon (Lucide name)', h('input', { className: 'ct-input', value: tab.icon || '', placeholder: 'Tag', onChange: (e) => set({ icon: e.target.value }) })),
        Field('Color', h('input', { className: 'ct-input ct-color', type: 'color', value: tab.color || '#888888', onChange: (e) => set({ color: e.target.value }) })),
        Field('Order', h('input', { className: 'ct-input', type: 'number', value: tab.order, onChange: (e) => set({ order: Number(e.target.value) || 0 }) })),
      ),
      tab.isDefault ? null : h('div', { className: 'ct-grid-wide' },
        Field('Sender domains / addresses (one per line)',
          h('textarea', { className: 'ct-textarea', value: listToText(tab.senders), onChange: (e) => set({ senders: textToList(e.target.value) }) })),
        Field('Subject keywords (one per line)',
          h('textarea', { className: 'ct-textarea', value: listToText(tab.subjects), onChange: (e) => set({ subjects: textToList(e.target.value) }) })),
      ),
      tab.isDefault ? null : h('div', { className: 'ct-inline' },
        h(Toggle, { checked: !!tab.bulkMarkers, onChange: (v) => set({ bulkMarkers: v }), label: 'Match bulk-mail markers' }),
        h('span', null, 'Match bulk-mail markers (List-Unsubscribe / Precedence: bulk)'),
      ),
    ),
  );
}

function SettingsPage() {
  const [config, setConfig] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      setConfig(await loadConfig());
      setOverrides(await loadOverrides());
    })();
  }, []);

  if (!config) {
    return h('div', { className: 'ct', style: { padding: '4px 2px', color: 'var(--color-muted-foreground)' } },
      h('style', null, STYLES), 'Loading…');
  }

  const updateTab = (idx, next) => {
    const tabs = config.tabs.slice();
    tabs[idx] = next;
    setConfig({ ...config, tabs });
  };

  const addTab = () => {
    const label = 'New tab';
    let id = slugify(label);
    let n = 2;
    while (config.tabs.some((t) => t.id === id)) id = `${slugify(label)}-${n++}`;
    setConfig({
      ...config,
      tabs: [...config.tabs, {
        id, label, icon: 'Folder', color: '', order: 100,
        enabled: true, custom: true, senders: [], subjects: [], bulkMarkers: false,
      }],
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.storage.set('config', config);
      await api.storage.set('senderOverrides', overrides);
      await applyTabs();
      await syncSieve(config);
      api.toast.success('Category tabs updated');
    } catch (err) {
      api.toast.error(`Could not apply tabs: ${err && err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const reset = () => setConfig(defaultConfig());

  return h('div', { className: 'ct', style: { padding: '4px 2px' } },
    h('style', null, STYLES),
    h('h3', null, 'Inbox category tabs'),
    h('p', { className: 'ct-desc' },
      'Tabs above the inbox message list. Rules are matched server-side; tune the lists to your own traffic.'),

    h(SettingRow, {
      label: 'Classification mode',
      description: config.mode === 'sieve'
        ? 'Durable $category keywords are assigned at delivery by a managed filter section.'
        : 'Live queries — nothing is written to your mail.',
    }, h('select', {
      className: 'ct-select', value: config.mode,
      onChange: (e) => setConfig({ ...config, mode: e.target.value }),
    },
      h('option', { value: 'search' }, 'Search (recommended)'),
      h('option', { value: 'sieve' }, 'Sieve keywords'),
    )),

    h('div', { className: 'ct-group-label' }, 'Tabs'),
    h('div', null,
      config.tabs.map((tab, idx) => h(TabEditor, {
        key: tab.id, tab,
        onChange: (next) => updateTab(idx, next),
        onRemove: () => setConfig({ ...config, tabs: config.tabs.filter((t) => t.id !== tab.id) }),
      })),
      h('button', { className: 'ct-btn ct-btn-outline', onClick: addTab }, '+ Add custom tab'),
    ),

    Object.keys(overrides).length > 0 ? h('div', null,
      h('div', { className: 'ct-group-label' }, 'Per-sender pins'),
      h('p', { className: 'ct-desc', style: { fontSize: '12px' } },
        'Created when you move a message to a tab — future mail from these senders always lands there.'),
      h('div', null, Object.entries(overrides).map(([sender, tabId]) => h(SettingRow, {
        key: sender,
        label: h('span', { className: 'ct-code' }, sender),
        description: `→ ${tabId}`,
      },
        h('button', {
          className: 'ct-btn ct-btn-outline ct-btn-sm',
          onClick: () => {
            const next = { ...overrides };
            delete next[sender];
            setOverrides(next);
          },
        }, 'Remove'),
      ))),
    ) : null,

    h('div', { className: 'ct-footer' },
      h('button', { className: 'ct-btn ct-btn-primary', disabled: saving, onClick: save },
        saving ? 'Applying…' : 'Save & apply'),
      h('button', { className: 'ct-btn ct-btn-outline', onClick: reset }, 'Reset to defaults'),
    ),
  );
}

// ── Plugin exports ─────────────────────────────────────────────────────────

export async function activate(hostApi) {
  api = hostApi; // same object as require('@plugin-host'); kept for clarity
  await applyTabs();
  await syncSieve(await loadConfig());
  api.log.info('Category tabs active');
}

export const slots = {
  'settings-section': {
    component: SettingsPage,
    order: 60,
  },
};

export const hooks = {
  /**
   * Transform: splice the managed classifier section into the account's
   * active Sieve script whenever the host rebuilds it (user saves filters,
   * or we call api.sieve.regenerate()). Reads config fresh from storage so
   * settings saved in the slot iframe are always honored.
   */
  async onSieveScriptGenerate(script) {
    if (!api) return undefined;
    const config = await loadConfig();
    if (config.mode !== 'sieve') return undefined;
    const overrides = await loadOverrides();
    return spliceSieveSection(String(script ?? ''), buildSieveSection(config, overrides));
  },

  /**
   * Observer: the host applied a categorize move (api.tabs.categorize or
   * native UI). Persist a per-sender override so future mail from these
   * senders lands in the chosen tab, then reapply tabs + Sieve.
   */
  async onEmailCategorize(ctx) {
    if (!api || !ctx || !Array.isArray(ctx.senders) || ctx.senders.length === 0) return;
    const overrides = await loadOverrides();
    for (const sender of ctx.senders) overrides[sender] = ctx.toTabId;
    await api.storage.set('senderOverrides', overrides);
    await applyTabs();
    await syncSieve(await loadConfig());
    api.toast.info(`Future mail from ${ctx.senders.join(', ')} will land in "${ctx.toTabId}"`);
  },
};
