// @vitest-environment jsdom
// "Return to my account" (Bulwark 1.22 and later): the host passes
// `canReturn: true` when it still holds the session the admin opened the
// impersonation from, and api.user.returnToOwnAccount() goes back to it.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import * as kit from '../../test-utils/ui-kit.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom gives import.meta.url an http scheme; tests run from the repo root.
const DIR = path.join(process.cwd(), 'impersonation-notice');
let code;

// esbuild doesn't run under jsdom; bundle in a plain node process.
beforeAll(() => {
  const script = `require('esbuild').build(${JSON.stringify({
    entryPoints: [path.join(DIR, 'src/index.js')],
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', 'react/jsx-runtime', '@plugin-host', '@plugin-host/ui'],
  })}).then((o) => process.stdout.write(o.outputFiles[0].text))`;
  code = execFileSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
});

afterEach(cleanup);

function load(api) {
  const mod = { exports: {} };
  const known = { react: React, '@plugin-host': api, '@plugin-host/ui': kit };
  const req = (name) => {
    if (name in known) return known[name];
    throw new Error(`module ${name} is not available`);
  };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, req);
  return mod.exports.default ?? mod.exports;
}

function setUp({ config = {}, returnToOwnAccount = async () => {} } = {}) {
  const api = fakeApi({
    id: 'impersonation-notice',
    handlers: {
      'admin.getAllConfig': async () => config,
      'user.returnToOwnAccount': returnToOwnAccount,
    },
  });
  const slot = load(api).slots['app-top-banner'];
  return { api, slot };
}

async function show(slot, props) {
  await act(async () => {
    render(React.createElement(slot.component, props));
  });
}

const impersonated = { username: 'alice@example.org', impersonated: true };

describe('Return to my account', () => {
  it('is offered when the host says it can return, and asks the host to', async () => {
    const { api, slot } = setUp();
    await show(slot, { ...impersonated, canReturn: true });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Return to my account' }));
    });
    expect(api.calls('user.returnToOwnAccount')).toHaveLength(1);
    // Returning is not signing out: the host decides that, only when there is nothing to return to.
    expect(api.calls('user.logout')).toHaveLength(0);
  });

  it('is not offered when the host has nothing to return to, or does not know the feature', async () => {
    for (const props of [{ ...impersonated, canReturn: false }, impersonated, { ...impersonated, canReturn: 'yes' }]) {
      const { slot } = setUp();
      await show(slot, props);
      expect(screen.queryByRole('button', { name: 'Return to my account' })).toBeNull();
      cleanup();
    }
  });

  it('sits next to the platform button, which still signs out', async () => {
    const { api, slot } = setUp({ config: { returnUrl: 'https://platform.example/admin' } });
    await show(slot, { ...impersonated, canReturn: true });

    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Return to my account', 'Back to platform']);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Back to platform' }));
    });
    expect(api.calls('user.logout')).toHaveLength(1);
    expect(api.calls('user.returnToOwnAccount')).toHaveLength(0);
  });

  it('can be tried again when the host refuses', async () => {
    let refuse = true;
    const { api, slot } = setUp({
      returnToOwnAccount: async () => {
        if (refuse) throw new Error('user.returnToOwnAccount: the session is not an impersonation');
      },
    });
    await show(slot, { ...impersonated, canReturn: true });
    const button = () => screen.getByRole('button', { name: 'Return to my account' });

    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().disabled).toBe(false);
    refuse = false;
    await act(async () => {
      fireEvent.click(button());
    });
    expect(api.calls('user.returnToOwnAccount')).toHaveLength(2);
  });

  it('asks for the permission as optional, so older webmails still install the plugin', () => {
    const manifest = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
    expect(manifest.optionalPermissions).toContain('auth:impersonation-return');
    expect(manifest.permissions).not.toContain('auth:impersonation-return');
  });
});
