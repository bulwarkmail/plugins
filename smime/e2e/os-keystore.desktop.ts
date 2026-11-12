/**
 * S/MIME with a key from CurrentUser\My, through plugin, webmail and desktop shell. Sends
 * a signed mail to itself, which also files its certificate, then an encrypted one, and
 * reads both. Windows only. It needs an app built with the keystore host API and the
 * helper, so it runs from repos/desktop and not with this repo's Playwright config (the
 * name keeps that config from picking it up):
 *
 *   # in repos/plugins, on this branch (it needs smime's dependencies: npm ci --prefix smime)
 *   node scripts/build.mjs smime
 *   mkdir <dir> && /c/Windows/System32/tar.exe -xf smime/smime.zip -C <dir>
 *   git checkout -- smime/smime.zip
 *
 *   # in repos/desktop, with the webmail rebuilt and the helper built (npm run build:native)
 *   unset ELECTRON_RUN_AS_NODE
 *   node build.mjs
 *   cp <repos/plugins>/smime/e2e/os-keystore.desktop.ts test/smime-os-keystore.spec.ts
 *   BULWARK_SMIME_DIR=<dir> vw exec --env IT_ENT_PASSWORD="vault://Stalwart test – ent-* throwaway accounts/password" \
 *     -- npx playwright test test/smime-os-keystore.spec.ts
 *   rm test/smime-os-keystore.spec.ts
 *
 * The test certificate is a throwaway for ent-alice@example.org. TestCerts records its
 * thumbprint, removes only that, and compares the whole store with what it was. The
 * thumbprint and the counts are in the output. Never touches any other certificate.
 *
 * The plugin is seeded into the throwaway profile as an admin would have installed it,
 * signed with a key made here: an admin login needs a secret that only main has, and a
 * user's upload doesn't get the privileged tier.
 *
 * Native dialogs are answered with their first button, "Allow for this session".
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { profilePaths } from '../src/main/profile';
import { ACCOUNT, fakeOsIntegration, launchStandalone, prompts, removeProfile, requireAccount, signIn, STALWARTS, tempProfile } from './helpers';
import { storeThumbprints, TestCerts, type TestCert } from './test-certs';

const PLUGIN_DIR = process.env.BULWARK_SMIME_DIR ?? '';
const MAIL_ARGS = `-Type Custom -KeyExportPolicy NonExportable -KeyAlgorithm RSA -KeyLength 2048 -KeyUsage DigitalSignature,KeyEncipherment `
  + `-TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.4','2.5.29.17={text}email=${ACCOUNT}')`;
const run = `${Date.now()}`;

/** As savePlugin leaves it: bundle, signature, signing key and the registry entry. */
function seedPlugin(profile: string): void {
  const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'));
  const code = readFileSync(path.join(PLUGIN_DIR, 'index.js'), 'utf8');
  const { adminConfig } = profilePaths(profile);
  const plugins = path.join(adminConfig, 'plugins');
  mkdirSync(plugins, { recursive: true });
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(path.join(adminConfig, 'plugin-signing.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(path.join(plugins, 'smime.js'), code);
  writeFileSync(path.join(plugins, 'smime.sig'), sign(null, Buffer.from(code, 'utf8'), privateKey).toString('base64'));
  const now = new Date().toISOString();
  writeFileSync(path.join(plugins, 'registry.json'), JSON.stringify({
    plugins: [{
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      description: manifest.description,
      type: manifest.type,
      tier: manifest.tier,
      permissions: [...manifest.permissions, ...manifest.optionalPermissions],
      entrypoint: manifest.entrypoint,
      enabled: true,
      forceEnabled: true,
      settingsSchema: manifest.settingsSchema,
      locales: manifest.locales,
      minAppVersion: manifest.minAppVersion,
      installedAt: now,
      updatedAt: now,
      bundleHash: createHash('sha256').update(code, 'utf8').digest('hex'),
    }],
  }));
}

async function compose(page: Page, subject: string, options: RegExp[]): Promise<void> {
  await page.keyboard.press('c');
  const composer = page.locator('[data-testid="email-composer"]');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  const to = page.locator('[data-testid="composer-to"] input').first();
  await to.click();
  await to.fill(ACCOUNT);
  await to.press('Enter');
  await page.locator('[data-testid="composer-subject"]').fill(subject);
  await composer.locator('[contenteditable="true"]').first().fill(`Body of ${subject}`);
  for (const name of options) {
    await page.locator('[data-testid="composer-options-menu"]').click();
    await page.getByRole('menuitemcheckbox', { name }).click();
  }
  await page.locator('[data-testid="composer-send"]').first().click();
  await composer.waitFor({ state: 'hidden', timeout: 120_000 });
}

async function openMail(page: Page, subject: string): Promise<void> {
  const row = page.getByText(subject, { exact: true }).first();
  await expect(row).toBeVisible({ timeout: 120_000 });
  await row.click();
}

/** The plugin's banner lives in one of its frames, and there are several. */
async function expectBanner(page: Page, text: RegExp): Promise<void> {
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      if (!frame.url().includes('plugin-sandbox-privileged')) continue;
      if (await frame.getByText(text).first().isVisible().catch(() => false)) return true;
    }
    return false;
  }, { timeout: 60_000, intervals: [500] }).toBe(true);
}

/** Opening a message asks nobody: the banner has a button for it. */
async function clickOpenInBanner(page: Page): Promise<void> {
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      if (!frame.url().includes('plugin-sandbox-privileged')) continue;
      const button = frame.getByRole('button', { name: /^open$/i }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        return true;
      }
    }
    return false;
  }, { timeout: 60_000, intervals: [500] }).toBe(true);
}

test.describe('S/MIME with a key from CurrentUser\\My', () => {
  test.skip(process.platform !== 'win32', 'creates a certificate in CurrentUser\\My');
  test.skip(!PLUGIN_DIR, 'set BULWARK_SMIME_DIR to the unpacked plugin');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(420_000);

  let certs: TestCerts;
  let cert: TestCert;
  let profile = '';
  let launched: Awaited<ReturnType<typeof launchStandalone>>;
  let countBefore = 0;

  test.beforeAll(async () => {
    requireAccount();
    countBefore = storeThumbprints().length;
    certs = new TestCerts();
    cert = certs.create({ name: 'smime-e2e', args: MAIL_ARGS });
    console.log(`certificate ${cert.thumbprint} (${cert.subject}), store had ${countBefore}, now ${storeThumbprints().length}`);
    expect(storeThumbprints()).toHaveLength(countBefore + 1);
    expect(certs.canExport(cert.thumbprint)).toBe(false);

    profile = tempProfile('smime');
    seedPlugin(profile);
    launched = await launchStandalone(profile);
    await fakeOsIntegration(launched.app, 0);
    await signIn(launched.page, STALWARTS[0].url);
  });

  test.afterAll(async () => {
    await launched?.app.close().catch(() => undefined);
    if (profile) removeProfile(profile);
    certs?.finish();
    const countAfter = storeThumbprints().length;
    console.log(`store has ${countAfter} again, ${cert?.thumbprint ?? 'nothing'} removed`);
    expect(countAfter).toBe(countBefore);
  });

  test('nothing asks at start-up', async () => {
    const asked = await prompts(launched.app);
    expect(asked.filter((prompt) => /certificate/i.test(`${prompt.message} ${prompt.detail}`))).toEqual([]);
  });

  test('signs with the OS key: the shell asks, and the signature matches', async () => {
    const { page, app } = launched;
    const subject = `OS key signed ${run}`;
    await compose(page, subject, [/sign \(s\/mime\)/i]);
    await openMail(page, subject);
    // The test certificate is self-signed and nobody trusts it, so the signer reads as not verified.
    await expectBanner(page, /signature matches, signer not verified/i);
    // The shell's dialog names the certificate. The run id is the last word of its subject.
    const runId = cert.subject.split(' ').pop()!;
    const asked = await prompts(app);
    expect(asked.some((prompt) => prompt.detail?.includes(runId))).toBe(true);
  });

  test('decrypts with the OS key', async () => {
    const { page } = launched;
    // Reading the signed mail filed its certificate as the recipient's.
    const subject = `OS key encrypted ${run}`;
    await compose(page, subject, [/encrypt \(s\/mime\)/i]);
    await openMail(page, subject);
    await clickOpenInBanner(page);
    await expectBanner(page, /^decrypted$/i);
    await expect(page.frameLocator('iframe[title="Email content"]').getByText(`Body of ${subject}`).first()).toBeVisible({ timeout: 30_000 });
  });
});
