// The built bundle, evaluated the way the webmail's sandbox does it
// (CommonJS with React and '@plugin-host' handed in), against the fake api.
import { beforeAll, describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import * as kit from '../../test-utils/ui-kit.mjs';

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
  return mod.exports.default ?? mod.exports;
}

// The banner's text, as the first render puts it on the page.
const text = (el) => renderToStaticMarkup(el).replace(/<[^>]+>/g, '');

const api = () => fakeApi({ id: 'impersonation-notice', handlers: { 'admin.getAllConfig': async () => ({}) } });

describe('when the banner shows', () => {
  it('shows for a session the host marks as impersonated, whose username is the plain mailbox', () => {
    const slot = load(api()).slots['app-top-banner'];
    const props = { username: 'alice@example.org', impersonated: true };
    expect(slot.shouldShow(props)).toBe(true);
    expect(text(React.createElement(slot.component, props))).toBe('You are viewing alice@example.org as Platform Admin');
  });

  it('still shows for a target%master username from a host without the flag', () => {
    const slot = load(api()).slots['app-top-banner'];
    const props = { username: 'alice@example.org%admin' };
    expect(slot.shouldShow(props)).toBe(true);
    expect(text(React.createElement(slot.component, props))).toBe('You are viewing alice@example.org as Platform Admin');
  });

  it('stays hidden for an ordinary session', () => {
    const slot = load(api()).slots['app-top-banner'];
    for (const props of [{ username: 'alice@example.org' }, { username: 'alice@example.org', impersonated: false }, {}]) {
      expect(slot.shouldShow(props)).toBe(false);
      expect(text(React.createElement(slot.component, props))).toBe('');
    }
  });
});
