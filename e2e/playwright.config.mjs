import { defineConfig } from '@playwright/test';

// End-to-end tests of plugins: `<plugin>/e2e/*.spec.mjs` and `e2e/*.spec.mjs`.
// Needs a running webmail and the services from test-env; see e2e/helpers.mjs.
export default defineConfig({
  testDir: '..',
  testMatch: ['*/e2e/**/*.spec.mjs', 'e2e/**/*.spec.mjs'],
  testIgnore: ['**/node_modules/**'],
  // With BULWARK_JMAP_URL: check once that the run's accounts exist.
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BULWARK_URL || 'http://localhost:3100',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
});
