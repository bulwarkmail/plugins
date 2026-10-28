import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as stub from './ui-kit.mjs';

// The unit-test stand-in for `@plugin-host/ui` must offer what the real kit
// in the webmail offers, or tests pass against components plugins can't get.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEBMAIL = path.resolve(process.env.BULWARK_WEBMAIL || path.join(path.dirname(ROOT), 'jmap-webmail-plugins'));
const KIT = path.join(WEBMAIL, 'lib/plugin-sandbox/ui-kit');
const haveWebmail = fs.existsSync(KIT);

function realExports() {
  const names = new Set();
  // KIT_VERSION moved to names.ts in Bulwark 1.18.
  for (const file of ['components.tsx', 'dialog-buttons.tsx', 'index.ts', 'names.ts']) {
    if (!fs.existsSync(path.join(KIT, file))) continue;
    const text = fs.readFileSync(path.join(KIT, file), 'utf8');
    for (const m of text.matchAll(/^export (?:const|function) ([A-Z][A-Za-z]*|use[A-Z][A-Za-z]*|KIT_VERSION)\b/gm)) names.add(m[1]);
  }
  return [...names].sort();
}

describe.skipIf(!haveWebmail)('ui-kit stand-in', () => {
  it('exports the same components as the webmail kit', () => {
    const ours = Object.keys(stub).filter((k) => /^[A-Z]|^use[A-Z]/.test(k)).sort();
    expect(ours).toEqual(realExports());
  });
});
