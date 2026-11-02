import zlib from 'node:zlib';
import { test, expect } from '@playwright/test';
import { adminApi, install } from './admin.mjs';
import { installPlugin, uninstallPlugin, preparePage, signIn, waitForPlugin } from '../../e2e/helpers.mjs';
import { ID, acceptPrivacy, ask, chatInput, configure, mockReadsChunked, mockRequests, mockScript, openMessage, readerPanel, waitDone } from './common.mjs';
import { USER, importMessages } from './jmap.mjs';

// More context (package B of the 2.2 work): an attachment's text and a
// picture reach the AI service, the picture only when the model can see
// images, and messages ticked in the list become one context. Also the @
// menu by keyboard, the chips' names, and a narrow panel. (Phones have no
// chat: the reader shows a bar of actions, the composer a rewrite dialog.)

// New mail per worker: a worker that restarts after a failure seeds again,
// and the same Message-IDs would join the first copies' conversations.
const RUN = Date.now().toString(36);
const ATTACH_SUBJECT = `Workshop notes ${RUN}`;
const SELECT = `Selection ${RUN}`;
const SELECT_SUBJECTS = [`${SELECT}: venue`, `${SELECT}: catering`, `${SELECT}: budget`];

// ── files with real content ──
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
/** A w×h PNG with stripes, so it has real pixels. */
function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; const s = Math.floor(y / (h / 5)) % 2 === 0; raw[o] = s ? r : 255 - r; raw[o + 1] = s ? g : 255 - g; raw[o + 2] = s ? b : 255 - b; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A one-page PDF with real text. */
function pdf(lines) {
  const content = `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? '0 -16 Td ' : ''}(${l}) Tj`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test.beforeAll(async () => {
  if (!process.env.BULWARK_JMAP_URL) return;
  const now = Date.now();
  await importMessages([
    { messageId: `ctx-attach-${RUN}@e2e.bulwark.test`, from: 'Bob <bob@example.org>', to: USER, subject: ATTACH_SUBJECT, date: now - 3600_000,
      text: 'Hi,\n\nthe agenda is attached, and a photo of the whiteboard.\n\nBob',
      attachments: [
        { name: 'agenda.pdf', type: 'application/pdf', data: pdf(['Workshop agenda', '09:30 Launch plan (codeword PELICAN)', '11:00 Budget']) },
        { name: 'whiteboard.png', type: 'image/png', data: png(320, 200, [40, 120, 200]) },
      ] },
    ...SELECT_SUBJECTS.map((subject, i) => ({
      messageId: `ctx-select-${i}-${RUN}@e2e.bulwark.test`, from: `${['Anna', 'Ben', 'Cleo'][i]} <${['anna', 'ben', 'cleo'][i]}@example.org>`, to: USER, subject, date: now - (5 + i) * 3600_000,
      text: `Selection body ${i + 1}: ${['the venue is booked for Friday', 'catering needs the head count by Wednesday', 'the budget is 2000 EUR'][i]}.`,
    })),
  ]);
});

async function setUp(page, api, { config = {}, viewport = { width: 1600, height: 900 } } = {}) {
  test.skip(!(await mockReadsChunked()), 'the mock AI server is not running');
  await configure(api, { instructions: '', anthropicImages: 'auto', ...config });
  await page.setViewportSize(viewport);
  await preparePage(page, { theme: 'light' });
  await signIn(page);
  await waitForPlugin(page, ID);
}

/** Every text of a request body, for searching. */
const bodyText = (request) => JSON.stringify(request.body);
/** The tool results of an Anthropic request's last user message. */
const toolResults = (request) => (request.body.messages.at(-1).content ?? []).filter((b) => b.type === 'tool_result');

/** Open a message by its subject and wait until the reader shows it. */
async function open(page, subject) {
  const row = () => page.getByText(subject, { exact: true }).locator('visible=true').first();
  await openMessage(page, subject, row());
  const shown = page.getByRole('heading', { name: subject });
  if (!(await shown.isVisible({ timeout: 10_000 }).catch(() => false))) await row().click();
  await expect(shown).toBeVisible({ timeout: 30_000 });
}

async function openAttachMessage(page) {
  await open(page, ATTACH_SUBJECT);
  return readerPanel(page);
}

test('an attachment\'s text reaches the AI service', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api);
    const { frame } = await openAttachMessage(page);
    // A chip per attachment, named for screen readers.
    await expect(frame.getByRole('group', { name: /^Attachment agenda\.pdf, \d+ KB$/ })).toBeVisible();
    await expect(frame.getByRole('group', { name: /^Picture whiteboard\.png, \d+ KB$/ })).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Leave agenda.pdf out' })).toBeAttached();
    await mockScript('ctx-pdf', [
      { tools: [{ name: 'read_attachment', input: { name: 'agenda.pdf' } }] },
      { text: 'The agenda starts with the launch plan.' },
    ]);
    await ask(frame, '[[mock:ctx-pdf]] What is on the agenda?');
    await acceptPrivacy(page, { frame, expectText: 'it sends the attachment\'s text' });
    await waitDone(frame);
    const requests = await mockRequests('ctx-pdf');
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(bodyText(requests[0])).toContain('1. agenda.pdf (application/pdf');
    const [result] = toolResults(requests[1]);
    expect(String(result.content)).toContain('<attachment name="agenda.pdf" format="pdf"');
    expect(String(result.content)).toContain('codeword PELICAN');
    await expect(frame.getByText('The agenda starts with the launch plan.')).toBeVisible();
  } finally {
    await uninstallPlugin(api, ID);
  }
});

for (const [images, sees] of [['yes', true], ['no', false]]) {
  test(`a picture reaches the AI service ${sees ? 'as an image' : 'as its name only'} (Anthropic images: ${images})`, async ({ page }) => {
    const api = await install(await adminApi(), ID, installPlugin);
    try {
      await setUp(page, api, { config: { anthropicImages: images } });
      const { frame } = await openAttachMessage(page);
      const script = `ctx-image-${images}`;
      await mockScript(script, [
        { tools: [{ name: 'read_attachment', input: { name: 'whiteboard.png' } }] },
        { text: 'Blue and white stripes.' },
      ]);
      await ask(frame, `[[mock:${script}]] What is on the whiteboard?`);
      await acceptPrivacy(page, { frame });
      await waitDone(frame);
      const requests = await mockRequests(script);
      const [result] = toolResults(requests[1]);
      if (sees) {
        expect(Array.isArray(result.content)).toBe(true);
        const image = result.content.find((b) => b.type === 'image');
        expect(image?.source?.type).toBe('base64');
        expect(image.source.media_type).toMatch(/^image\/(jpeg|png)$/);
        expect(image.source.data.length).toBeGreaterThan(100);
        expect(result.content.find((b) => b.type === 'text').text).toContain('whiteboard.png (320×200)');
      } else {
        expect(result.content).toBe('[Image: whiteboard.png. This model can\'t see images.]');
        expect(bodyText(requests[1])).not.toContain('"type":"image"');
        expect(bodyText(requests[0])).toContain('This model can\'t see images');
      }
    } finally {
      await uninstallPlugin(api, ID);
    }
  });
}

test('three messages ticked in the list become one context', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    // A quick action sends a fixed text: the marker goes in the standing instructions.
    await setUp(page, api, { config: { instructions: '[[mock:ctx-select]]' } });
    await mockScript('ctx-select', [
      { tools: [{ name: 'read_messages', input: {} }] },
      { text: 'Venue, catering and budget are settled.' },
    ]);
    await open(page, SELECT_SUBJECTS[0]);
    await page.getByRole('combobox', { name: /Search mail/ }).fill(SELECT);
    await page.getByRole('combobox', { name: /Search mail/ }).press('Enter');
    await expect(page.getByText(SELECT_SUBJECTS[2], { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    for (const subject of SELECT_SUBJECTS) {
      await page.getByRole('checkbox', { name: new RegExp(`: ${subject}$`) }).first().check({ force: true });
    }
    const { frame } = await readerPanel(page);
    await expect(frame.getByRole('group', { name: '3 selected messages' })).toBeVisible({ timeout: 30_000 });
    await frame.getByRole('button', { name: 'Actions' }).click();
    await frame.getByRole('menuitem', { name: 'Summarize these' }).click();
    await acceptPrivacy(page, { frame, expectText: 'the messages you selected in the list' });
    await waitDone(frame);
    const requests = await mockRequests('ctx-select');
    expect(bodyText(requests[0])).toContain('The user selected 3 messages in the list');
    const results = toolResults(requests[1]);
    // One lookup, one result with all three.
    expect(results).toHaveLength(1);
    const text = String(results[0].content);
    expect(text.match(/<message id=/g)).toHaveLength(3);
    for (const i of [1, 2, 3]) expect(text).toContain(`Selection body ${i}`);
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('the @ menu works by keyboard and its picks become chips', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await setUp(page, api);
    const { frame } = await openAttachMessage(page);
    const input = chatInput(frame);
    await input.fill('');
    await input.pressSequentially(`Compare with @${RUN}`, { delay: 20 });
    const list = frame.getByRole('listbox', { name: 'Mention a message or contact' });
    await expect(list).toBeVisible({ timeout: 30_000 });
    await expect(input).toHaveAttribute('aria-controls', await list.getAttribute('id'));
    const options = list.getByRole('option');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await input.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveAttribute('aria-activedescendant', await options.nth(1).getAttribute('id'));
    const picked = (await options.nth(1).locator('span').first().textContent()).trim();
    await input.press('Enter');
    await expect(list).toBeHidden();
    await expect(input).toHaveValue('Compare with ');
    const chip = frame.getByRole('group', { name: new RegExp(`^Message “${picked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}”`) });
    await expect(chip).toBeVisible();
    // Escape closes the menu and keeps the text.
    await input.pressSequentially(`@${RUN}`, { delay: 20 });
    await expect(list).toBeVisible({ timeout: 30_000 });
    await input.press('Escape');
    await expect(list).toBeHidden();
    await expect(input).toHaveValue(`Compare with @${RUN}`);
    // The chip's remove button by keyboard.
    await chip.getByRole('button', { name: `Leave ${picked} out` }).focus();
    await page.keyboard.press('Enter');
    await expect(chip).toHaveCount(0);
  } finally {
    await uninstallPlugin(api, ID);
  }
});

test('the chips fit a narrow panel', async ({ page }) => {
  const api = await install(await adminApi(), ID, installPlugin);
  try {
    await page.addInitScript(() => { try { localStorage.setItem('emailDetailSidebarWidth', '200'); } catch { /* blocked */ } });
    await setUp(page, api);
    const { frame } = await openAttachMessage(page);
    const box = await frame.locator('[data-assistant-input]').boundingBox();
    const chips = frame.locator('[data-context-chip]');
    await expect(chips).toHaveCount(3);
    for (const b of await Promise.all((await chips.all()).map((c) => c.boundingBox()))) {
      expect(b.x).toBeGreaterThanOrEqual(box.x - 0.5);
      expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
    }
    const boxes = await Promise.all((await chips.all()).map((c) => c.boundingBox()));
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width - 0.5);
  } finally {
    await uninstallPlugin(api, ID);
  }
});
