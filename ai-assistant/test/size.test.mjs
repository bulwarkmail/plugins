import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';

// The webmail refuses a manifest.json over 512 KB unpacked
// (lib/extension-package.ts MAX_MANIFEST_BYTES), so the texts stay in the
// bundle. This keeps a margin below that, and keeps the bundle in check.
const MANIFEST_LIMIT = 480 * 1024;
const BUNDLE_LIMIT = 2.5 * 1024 * 1024;

describe('the package', () => {
  it('keeps manifest.json well under the webmail\'s 512 KB limit and the bundle under 2.5 MB', async () => {
    const zip = await JSZip.loadAsync(readFileSync(new URL('../ai-assistant.zip', import.meta.url)));
    const manifest = await zip.file('manifest.json').async('uint8array');
    const bundle = await zip.file('index.js').async('uint8array');
    expect(manifest.byteLength).toBeLessThan(MANIFEST_LIMIT);
    expect(bundle.byteLength).toBeLessThan(BUNDLE_LIMIT);
  });
});
