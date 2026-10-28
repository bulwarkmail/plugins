// Bulwark 1.19 and later say per switch (api.host.features) which of its own
// external mail warnings are on; the plugin steps back for each: no send
// confirm with the recipient warning, no banner or toast with the sender
// label. On hosts without api.host it works as before.
// The built bundle runs the way the sandbox runs it, against the fake api.
import { beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import * as kit from '../../test-utils/ui-kit.mjs';
import { coreConfirmsRecipients, coreLabelsSenders } from '../src/lib/handover.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let code;

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(here, '../src/index.js')],
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@plugin-host', '@plugin-host/ui'],
  });
  code = out.outputFiles[0].text;
});

function load(api) {
  const mod = { exports: {} };
  const req = (name) => {
    if (name === '@plugin-host') return api;
    if (name === '@plugin-host/ui') return kit;
    if (name === 'react' || name === 'react/jsx-runtime' || name === 'react-dom') return require(name);
    throw new Error(`module ${name} is not available`);
  };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, req);
  return mod.exports;
}

const OUTGOING = { to: ['dave@org-two.test'], cc: [], bcc: [], fromEmail: 'alice@example.org', subject: 'Hi' };
const INCOMING = { email: { id: 'm1', from: [{ name: 'Dave', email: 'dave@org-two.test' }] } };

function apiFor(hostFeatures) {
  return fakeApi({
    id: 'external-mail-warning',
    settings: { notifyOnIncomingExternal: true },
    hostFeatures,
    handlers: {
      'user.getIdentities': async () => [{ email: 'alice@example.org' }],
      'admin.getConfig': async () => '',
      'ui.confirm': async () => false,
    },
  });
}

async function started(hostFeatures) {
  const api = apiFor(hostFeatures);
  const plugin = load(api);
  await plugin.activate(api);
  return { api, plugin };
}

describe('the host flags', () => {
  it('are true only when the host says that switch is on', () => {
    const both = fakeApi({ hostFeatures: { externalSenderLabel: true, externalRecipientWarning: false } });
    expect(coreLabelsSenders(both)).toBe(true);
    expect(coreConfirmsRecipients(both)).toBe(false);
    // An older host: no api.host (the fake answers any other name with stubs).
    expect(coreLabelsSenders(fakeApi())).toBe(false);
    expect(coreConfirmsRecipients(fakeApi())).toBe(false);
    expect(coreConfirmsRecipients(undefined)).toBe(false);
  });
});

describe("with Bulwark's recipient warning on", () => {
  it('lets the send through without asking but keeps its banner and toast', async () => {
    const { api, plugin } = await started({ externalSenderLabel: false, externalRecipientWarning: true });
    expect(await plugin.hooks.onBeforeEmailSend(OUTGOING)).toBeUndefined();
    expect(api.calls('ui.confirm')).toHaveLength(0);
    expect(plugin.slots['email-banner'].shouldShow(INCOMING)).toBe(true);
    plugin.hooks.onNewEmailReceived({ from: [{ email: 'dave@org-two.test' }] });
    expect(api.calls('toast.warning')).toHaveLength(1);
  });

  it('asks again as soon as the host turns it off', async () => {
    const { api, plugin } = await started({ externalSenderLabel: false, externalRecipientWarning: true });
    api.setHostFeatures({ externalRecipientWarning: false });
    expect(await plugin.hooks.onBeforeEmailSend(OUTGOING)).toBe(false);
    expect(api.calls('ui.confirm')).toHaveLength(1);
  });
});

describe("with Bulwark's sender label on", () => {
  it('shows no banner or toast but still asks before sending outside', async () => {
    const { api, plugin } = await started({ externalSenderLabel: true, externalRecipientWarning: false });
    expect(plugin.slots['email-banner'].shouldShow(INCOMING)).toBe(false);
    plugin.hooks.onNewEmailReceived({ from: [{ email: 'dave@org-two.test' }] });
    expect(api.calls('toast.warning')).toHaveLength(0);
    expect(await plugin.hooks.onBeforeEmailSend(OUTGOING)).toBe(false);
    expect(api.calls('ui.confirm')).toHaveLength(1);
  });
});

describe('on a host without api.host', () => {
  it('asks before sending outside and flags the sender as before', async () => {
    const { api, plugin } = await started(undefined);
    expect(await plugin.hooks.onBeforeEmailSend(OUTGOING)).toBe(false);
    expect(api.calls('ui.confirm')).toHaveLength(1);
    expect(plugin.slots['email-banner'].shouldShow(INCOMING)).toBe(true);
    plugin.hooks.onNewEmailReceived({ from: [{ email: 'dave@org-two.test' }] });
    expect(api.calls('toast.warning')).toHaveLength(1);
  });
});
