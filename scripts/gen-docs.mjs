#!/usr/bin/env node
// Regenerate the reference tables in WRITING_PLUGINS.md from the webmail's
// own catalogues, so the docs list exactly what the host offers.
//
//   node scripts/gen-docs.mjs           rewrite the generated sections
//   node scripts/gen-docs.mjs --check   fail if a section is out of date
//
// Reads the webmail source from BULWARK_WEBMAIL (default: a checkout named
// jmap-webmail-plugins next to this repo):
//   lib/plugin-hook-catalog.ts              hooks
//   lib/plugin-slot-catalog.ts              UI surfaces
//   lib/plugin-types.ts                     ALL_PERMISSIONS, IMPLICIT_PERMISSIONS
//   lib/plugin-sandbox/permission-text.ts   HIGH_RISK_PERMISSIONS
//   lib/plugin-sandbox/host-api.ts          PERM_PER_METHOD (read as text)
//   locales/en/common.json                  what the consent dialog says
//
// The TypeScript files are bundled with esbuild into a temporary ES module
// and imported. Each table sits between markers in WRITING_PLUGINS.md:
//   <!-- generated:hooks -->  ...  <!-- /generated:hooks -->
// Text outside the markers is never touched.

import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEBMAIL = path.resolve(process.env.BULWARK_WEBMAIL || path.join(path.dirname(ROOT), 'jmap-webmail-plugins'));
const DOC = path.join(ROOT, 'WRITING_PLUGINS.md');
const SHOTS = 'docs/screenshots';
const check = process.argv.includes('--check');

function need(rel) {
  const file = path.join(WEBMAIL, rel);
  if (!existsSync(file)) {
    console.error(`${file} not found. Set BULWARK_WEBMAIL to the webmail checkout.`);
    process.exit(2);
  }
  return file;
}

async function loadCatalogues() {
  const files = {
    hooks: need('lib/plugin-hook-catalog.ts'),
    slots: need('lib/plugin-slot-catalog.ts'),
    types: need('lib/plugin-types.ts'),
    risk: need('lib/plugin-sandbox/permission-text.ts'),
  };
  const entry = [
    `export { HOOK_CATALOG } from ${JSON.stringify(files.hooks)};`,
    `export { SLOT_CATALOG } from ${JSON.stringify(files.slots)};`,
    `export { ALL_PERMISSIONS, IMPLICIT_PERMISSIONS } from ${JSON.stringify(files.types)};`,
    `export { HIGH_RISK_PERMISSIONS, permissionKey } from ${JSON.stringify(files.risk)};`,
  ].join('\n');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bulwark-gen-docs-'));
  const out = path.join(dir, 'catalogues.mjs');
  try {
    await build({
      stdin: { contents: entry, resolveDir: WEBMAIL, loader: 'ts' },
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: out,
      logLevel: 'error',
    });
    return await import(pathToFileURL(out).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** PERM_PER_METHOD as written in host-api.ts: 'method': 'permission' | null. */
function readMethodPermissions() {
  const src = readFileSync(need('lib/plugin-sandbox/host-api.ts'), 'utf8');
  const start = src.indexOf('export const PERM_PER_METHOD');
  const end = src.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error('PERM_PER_METHOD not found in host-api.ts');
  const out = [];
  for (const m of src.slice(start, end).matchAll(/^\s*'([\w.]+)'\s*:\s*(null|'([\w:-]+)')/gm)) {
    out.push([m[1], m[3] ?? null]);
  }
  return out;
}

// Markdown table cells: no pipes or line breaks inside.
const NL = '\n';
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const code = (s) => '`' + String(s).replace(/\|/g, '\\|') + '`';

// ─── Permissions ─────────────────────────────────────────────

function permissionsTable(cat, locale) {
  const texts = locale.plugins?.permissions ?? {};
  const implicit = new Set(cat.IMPLICIT_PERMISSIONS);
  const rows = [
    '| Permission | What the consent dialog says | High risk |',
    '|---|---|---|',
  ];
  for (const perm of cat.ALL_PERMISSIONS) {
    const text = texts[cat.permissionKey(perm)];
    // The consent dialog fills in the installation's name; the docs say Bulwark.
    let said = text && typeof text === 'object' ? `**${text.title}.** ${text.body}`.replace(/\{appName\}/g, 'Bulwark') : '';
    if (implicit.has(perm)) said = `${said} Always granted; not shown in the dialog.`.trim();
    rows.push(`| ${code(perm)} | ${cell(said)} | ${cat.HIGH_RISK_PERMISSIONS.has(perm) ? 'yes' : ''} |`);
  }
  return rows.join('\n');
}

// ─── Hooks ───────────────────────────────────────────────────

const HOOK_GROUPS = {
  'mail-list': 'Mail: message list',
  'mail-read': 'Mail: reading',
  'mail-compose': 'Mail: writing',
  'mail-send': 'Mail: sending',
  'mail-organize': 'Mail: organizing',
  'mail-mailboxes': 'Mail: folders',
  'mail-search': 'Mail: search',
  'mail-attachments': 'Mail: attachments',
  'mail-sync': 'Mail: new mail',
  calendar: 'Calendar',
  contacts: 'Contacts',
  tasks: 'Tasks',
  files: 'Files',
  settings: 'Settings',
  identities: 'Sender identities',
  filters: 'Filters',
  vacation: 'Out of office',
  templates: 'Templates',
  auth: 'Sign-in and accounts',
  security: 'Account security',
  navigation: 'Navigation',
  theme: 'Theme and language',
  notifications: 'Notifications',
  app: 'App lifecycle',
  ui: 'Layout',
  keyboard: 'Keyboard',
  tabs: 'Inbox tabs',
};

function hooksTables(cat) {
  const byGroup = new Map();
  for (const [name, spec] of Object.entries(cat.HOOK_CATALOG)) {
    if (!byGroup.has(spec.group)) byGroup.set(spec.group, []);
    byGroup.get(spec.group).push([name, spec]);
  }
  const order = [...Object.keys(HOOK_GROUPS), ...[...byGroup.keys()].filter((g) => !(g in HOOK_GROUPS))];
  const parts = [`${Object.keys(cat.HOOK_CATALOG).length} hooks in ${byGroup.size} groups.`];
  for (const group of order) {
    const hooks = byGroup.get(group);
    if (!hooks) continue;
    parts.push(`#### ${HOOK_GROUPS[group] ?? group}`);
    parts.push([
      '| Hook | Kind | Permission | Receives | When |',
      '|---|---|---|---|---|',
      ...hooks.map(([name, s]) => `| ${code(name)} | ${s.kind} | ${code(s.permission)} | ${code(s.payload)} | ${cell(s.when)} |`),
    ].join('\n'));
  }
  return parts.join('\n\n');
}

// ─── UI surfaces ─────────────────────────────────────────────

const AREAS = {
  app: 'App',
  dialog: 'Dialogs',
  navigation: 'Navigation',
  'mail-list': 'Message list',
  reader: 'Reader',
  composer: 'Composer',
  calendar: 'Calendar',
  contacts: 'Contacts',
  tasks: 'Tasks',
  files: 'Files',
  settings: 'Settings',
  admin: 'Admin dashboard',
};

// Screenshots taken with the slot-showcase plugin, per area:
// [file name without the -light/-dark/-phone suffix, caption].
const AREA_SHOTS = {
  app: [
    ['command-palette', 'command-palette: two entries, typed "showcase"'],
    ['notifications', 'A notification from api.notifications.show in the notifications panel'],
  ],
  dialog: [['dialog', 'plugin-dialog opened with api.ui.openDialog']],
  navigation: [
    ['navigation', 'app-top-banner, navigation-rail-bottom ("slot: rail"), sidebar-section, sidebar-widget, top-bar-actions (flask icon next to Refresh), the page entry in the rail'],
    ['navigation-sidebar', 'sidebar-section and sidebar-widget in the phone menu'],
    ['navigation-top-bar', 'top-bar-actions in the phone top bar menu'],
    ['app-page', 'app-page, the page registered with api.ui.setPages'],
  ],
  'mail-list': [
    ['message-list', 'message-list-header and message-row-actions (hover)'],
    ['message-list-context-menu', 'context-menu-email and the row action in the right-click menu'],
    ['message-list-bulk', 'message-bulk-actions in the selection toolbar'],
  ],
  reader: [
    ['reader', 'toolbar-actions, reader-actions, reader-header, reader-below-subject, email-banner, reader-above-quote, email-footer, email-detail-sidebar'],
    ['reader-attachment-menu', 'attachment-actions and attachment-menu'],
    ['reader-details', 'email-details-section in the message details'],
    ['reader-actions', 'reader-actions in the phone "More actions" panel'],
    ['reader-thread', 'thread-summary and reader-above-quote in a conversation on a phone'],
  ],
  composer: [
    ['composer', 'composer-above-body, composer-below-body, composer-toolbar, composer-attachment-source (side panels hidden, see the next picture)'],
    ['composer-sidebars', 'composer-sidebar and composer-sidebar-right'],
    ['composer-send-menu', 'composer-send-menu'],
    ['composer-attach-menu', 'composer-attach-menu'],
  ],
  calendar: [
    ['calendar', 'calendar-day-header labels and mini-calendar-marks dots from api.ui.setDayLabels'],
    ['calendar-event', 'calendar-event-detail'],
    ['calendar-event-form', 'calendar-event-actions and calendar-event-form'],
  ],
  contacts: [['contacts', 'contact-list-actions, contact-cryptokeys, contact-detail-section']],
  tasks: [['tasks', 'task-list-actions and task-detail-section']],
  files: [
    ['files', 'file-actions in the selection toolbar and file-preview-section in the details panel'],
    ['files-menu', 'file-actions in a file\'s menu'],
  ],
  settings: [
    ['settings', 'settings-section, listed under Apps'],
    ['settings-page', 'settings-page, listed under Plugins'],
  ],
};

const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function shotsFor(area) {
  const out = [];
  for (const [base, caption] of AREA_SHOTS[area] ?? []) {
    const has = (variant) => existsSync(path.join(ROOT, SHOTS, `${base}-${variant}.png`));
    const src = (variant) => `${SHOTS}/${base}-${variant}.png`;
    const alt = attr(caption);
    const cells = [];
    if (has('light')) {
      cells.push(has('dark')
        ? `<picture><source media="(prefers-color-scheme: dark)" srcset="${src('dark')}"><img src="${src('light')}" alt="${alt}" width="640"></picture>`
        : `<img src="${src('light')}" alt="${alt}" width="640">`);
    } else if (has('dark')) {
      cells.push(`<img src="${src('dark')}" alt="${alt}" width="640">`);
    }
    if (has('phone')) cells.push(`<img src="${src('phone')}" alt="${cells.length ? 'The same on a phone' : alt}" width="195">`);
    if (cells.length === 0) continue;
    out.push(['<p>', ...cells, `<br><em>${caption.replace(/</g, '&lt;')}</em>`, '</p>'].join(NL));
  }
  return out.join(NL + NL);
}

function propsCell(props) {
  if (props === '*') return 'whatever the plugin passed as `extraProps`, plus `onResult`';
  const entries = Object.entries(props);
  if (entries.length === 0) return '';
  return entries.map(([name, perm]) => (perm ? `${code(name)} (${code(perm)})` : code(name))).join(', ');
}

function surfacesTables(cat) {
  const byArea = new Map();
  for (const [name, spec] of Object.entries(cat.SLOT_CATALOG)) {
    if (!byArea.has(spec.area)) byArea.set(spec.area, []);
    byArea.get(spec.area).push([name, spec]);
  }
  const order = [...Object.keys(AREAS), ...[...byArea.keys()].filter((a) => !(a in AREAS))];
  const parts = [`${Object.keys(cat.SLOT_CATALOG).length} surfaces. A plugin may use a surface with any one of the listed permissions; a prop or context key with a permission in brackets is only passed when the plugin holds that permission too.`];
  for (const area of order) {
    const slots = byArea.get(area);
    if (!slots) continue;
    parts.push(`#### ${AREAS[area] ?? area}`);
    parts.push([
      '| Surface | Kind | Permission | Props or context | Where |',
      '|---|---|---|---|---|',
      ...slots.map(([name, s]) => `| ${code(name)} | ${s.kind}${s.inline ? ', inline' : ''} | ${s.permissions.map(code).join(' or ')} | ${propsCell(s.props)} | ${cell(s.where)} |`),
    ].join('\n'));
    const shots = shotsFor(area);
    if (shots) parts.push(shots);
  }
  return parts.join('\n\n');
}

// ─── API permissions ─────────────────────────────────────────

function apiPermissionsTable(methods) {
  return [
    '| Method | Permission |',
    '|---|---|',
    ...methods.map(([method, perm]) => `| ${code(`api.${method}`)} | ${perm ? code(perm) : 'none'} |`),
  ].join('\n');
}

// ─── Splice ──────────────────────────────────────────────────

function splice(text, name, body) {
  const open = `<!-- generated:${name} -->`;
  const close = `<!-- /generated:${name} -->`;
  const a = text.indexOf(open);
  const b = text.indexOf(close);
  if (a < 0 || b < a) throw new Error(`WRITING_PLUGINS.md has no ${open} ... ${close} section`);
  return `${text.slice(0, a + open.length)}\n<!-- Generated by scripts/gen-docs.mjs; edit the webmail catalogues, not this table. -->\n\n${body}\n\n${text.slice(b)}`;
}

const cat = await loadCatalogues();
const locale = JSON.parse(readFileSync(need('locales/en/common.json'), 'utf8'));
// The host's method names differ from the api object in a few places.
// proxy.cancel has no method of its own: it is the signal of api.proxy.fetch.
const RENAME = { contact: 'contacts', addressbook: 'addressBooks', 'plugin.getConfig': 'config.get', 'contact.delete': 'contacts.remove' };
const methods = readMethodPermissions().filter(([m]) => m !== 'proxy.cancel').map(([m, p]) => {
  if (RENAME[m]) return [RENAME[m], p];
  const [ns, fn] = m.split('.');
  return [RENAME[ns] ? `${RENAME[ns]}.${fn}` : m, p];
});

const current = readFileSync(DOC, 'utf8');
let next = current;
next = splice(next, 'permissions', permissionsTable(cat, locale));
next = splice(next, 'hooks', hooksTables(cat));
next = splice(next, 'surfaces', surfacesTables(cat));
next = splice(next, 'api-permissions', apiPermissionsTable(methods));
// Keep the file's line endings (a Windows checkout has CRLF).
next = next.replace(/\r?\n/g, current.includes('\r\n') ? '\r\n' : '\n');

if (check) {
  if (next !== current) {
    console.error('WRITING_PLUGINS.md is out of date; run node scripts/gen-docs.mjs');
    process.exit(1);
  }
  console.log('WRITING_PLUGINS.md is up to date');
} else {
  writeFileSync(DOC, next);
  console.log(`WRITING_PLUGINS.md: ${cat.ALL_PERMISSIONS.length} permissions, ${Object.keys(cat.HOOK_CATALOG).length} hooks, ${Object.keys(cat.SLOT_CATALOG).length} surfaces, ${methods.length} API methods`);
}
