import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests of plugin logic: `<plugin>/test/*.test.mjs`. Keep the logic in
// plain ES modules under `<plugin>/src/lib/` so tests import it directly;
// `src/index.js` only wires it to the api.
export default defineConfig({
  // The UI kit the sandbox gives plugins at run time; tests get a stand-in.
  resolve: { alias: { '@plugin-host/ui': fileURLToPath(new URL('./test-utils/ui-kit.mjs', import.meta.url)) } },
  test: {
    include: ['*/test/**/*.test.{js,mjs}', 'test-utils/**/*.test.{js,mjs}', 'scripts/test/**/*.test.{js,mjs}'],
    exclude: ['node_modules/**', 'e2e/**', 'test-env/**'],
    environment: 'node',
    // Some suites bundle their plugin with esbuild in beforeAll; with every
    // file running at once that can take longer than the default 10 s.
    hookTimeout: 60_000,
  },
});
