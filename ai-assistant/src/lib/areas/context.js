// Area "context" of the 2.2 work: its lookups and actions (shapes in README.md).
//
// The assistant may read more than the open message: its attachments (text,
// or the picture itself when the model can see images), the whole
// conversation, the messages ticked in the list and the ones the user
// mentioned with @. The panel (src/ui/panel/areas/context.js) says what is
// in the chat and hands it over as `ctx.context`:
//   { flags: contextFlags(),
//     email: { id, accountId, subject, attachments: [{ index, blobId, name, type, size, inline, cid, alt }] } | null,
//     thread: boolean, selection: { emails: [{ id, accountId }], total } | null,
//     mentioned: [{ id, accountId, subject }] }
// Everything read in one request shares a budget of CONTEXT_BUDGET
// characters and MAX_IMAGES images.

import { has } from '../caps.js';
import { areaAllowed, imagesAllowed } from '../config.js';
import { ownText } from '../draft.js';
import { whenIn } from '../clock.js';

/** Characters of attachments, conversations and messages one request may read. */
export const CONTEXT_BUDGET = 60_000;
/** Characters of one read, unless the model asks for more. */
export const READ_CHARS = 20_000;
/** Most characters the model may ask for in one read. */
export const MAX_READ_CHARS = 100_000;
/** Images one request may carry, and images of one message. */
export const MAX_IMAGES = 8;
export const MAX_IMAGES_PER_MESSAGE = 4;
/** Long edge of an image for OpenAI-compatible servers that aren't OpenAI (local models). */
export const LOCAL_IMAGE_SIDE = 1024;
/** Fewest characters a message of a conversation or selection gets when many share the budget. */
const MIN_PER_MESSAGE = 1500;

const IMAGE_TYPES = /^image\/(jpeg|jpg|png|gif|webp|bmp|heic|heif|avif|tiff)$/i;
const IMAGE_NAMES = /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?)$/i;
/** Whether an attachment is a picture (by its type, or its name when the type says nothing). */
export function isImage(att) {
  const type = String(att?.type ?? '');
  if (IMAGE_TYPES.test(type)) return true;
  return (!type || type === 'application/octet-stream') && IMAGE_NAMES.test(att?.name ?? '');
}

/** Whether the model the user talks to may get images: the admin's choice, or the user's for their own key. */
export function canSeeImages(config = {}, endpoint = null, prefs = {}) {
  if (!endpoint) return false;
  if (endpoint.own) return typeof prefs.ownImages === 'boolean' ? prefs.ownImages : imagesAllowed({}, endpoint);
  return imagesAllowed(config, endpoint);
}

/**
 * What of the context area is on: the admin's switch, the user's switches
 * (prefs ctxAttachments, ctxImages, ctxThread; on unless switched off) and
 * what this webmail offers.
 */
export function contextFlags(api, { config = {}, prefs = {}, endpoint = null } = {}) {
  const on = areaAllowed(config, 'context');
  const reading = on && prefs.ctxAttachments !== false;
  const text = reading && has(api, 'attachmentText', 'email.getAttachmentText');
  const imageCall = reading && has(api, 'attachmentImages', 'email.getAttachmentImage');
  return {
    on,
    attachments: text || imageCall,
    text,
    images: imageCall && prefs.ctxImages !== false && canSeeImages(config, endpoint, prefs),
    thread: on && prefs.ctxThread !== false && has(api, 'threads', 'email.getThread'),
    selection: on && has(api, 'listSelection'),
    mentions: on,
  };
}

// ─── The budget of one request ───

const budgets = new WeakMap();
/** The request's budget, one per lookup context (the chat builds a new context per request). */
export function budgetOf(ctx) {
  let budget = budgets.get(ctx);
  if (!budget) {
    budget = { chars: CONTEXT_BUDGET, images: MAX_IMAGES, perMessage: new Map() };
    budgets.set(ctx, budget);
  }
  return budget;
}

export const SPENT = 'The context budget of this request is used up: answer with what you have, and tell the user to ask again (for example about one attachment at a time) for more.';

/** Characters a read may take: what was asked (or READ_CHARS), within what is left. */
function allowance(budget, asked) {
  const want = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_READ_CHARS) : READ_CHARS;
  return Math.min(want, budget.chars);
}

/** Text cut to `max` characters, at a line break when there is one nearby. */
function cut(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return { text: value, cut: false };
  const at = value.lastIndexOf('\n', max);
  return { text: value.slice(0, at > max * 0.8 ? at : max), cut: true };
}

// ─── Attachments ───

const size = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((bytes ?? 0) / 1024))} KB`);
const attr = (value) => String(value ?? '').replace(/["<>]/g, '');

/** The attachment list for the model, numbered as read_attachment takes them. */
export function attachmentLines(attachments) {
  return attachments.map((a) => {
    const notes = [a.type || 'unknown type', size(a.size)];
    if (a.inline) notes.push('a picture in the message');
    if (a.alt) notes.push(`described as "${attr(a.alt).slice(0, 120)}"`);
    return `${a.index}. ${a.name || '(no name)'} (${notes.join(', ')})`;
  }).join('\n');
}

function findAttachment(attachments, args) {
  const index = Number(args.index);
  if (Number.isInteger(index) && index > 0) return attachments.find((a) => a.index === index) ?? null;
  const name = String(args.name ?? '').trim().toLowerCase();
  if (!name) return attachments.length === 1 ? attachments[0] : null;
  return attachments.find((a) => (a.name ?? '').toLowerCase() === name)
    ?? attachments.find((a) => (a.name ?? '').toLowerCase().includes(name))
    ?? null;
}

/** What the model hears when an attachment can't be read. */
export function statusSentence(status, name) {
  switch (status) {
    case 'too_big': return `${name} can't be read: it is too big (over 20 MB).`;
    case 'no_text': return `The assistant can't read the text in ${name}. It may be a scanned page.`;
    case 'encrypted': return `${name} is protected with a password, so it can't be read.`;
    case 'unsupported': return `${name} is a kind of file the assistant can't read.`;
    case 'tiny':
    case 'tracker': return `${name} is too small to show anything (a spacer, a logo or a tracking pixel).`;
    default: return `${name} couldn't be read.`;
  }
}

async function readAttachmentText(api, email, att, args, budget) {
  if (budget.chars <= 0) return SPENT;
  const maxChars = allowance(budget, args.maxChars);
  const read = await api.email.getAttachmentText(email.id, att.blobId, { maxChars, ...accountArg(email.accountId) });
  const name = read?.name || att.name || 'The attachment';
  if (!read || read.status !== 'ok') return statusSentence(read?.status, name);
  const { text, cut: clipped } = cut(read.text ?? '', maxChars);
  budget.chars -= text.length;
  const more = [
    read.pages ? `pages="${read.pages}"` : '',
    Array.isArray(read.sheets) && read.sheets.length ? `sheets="${attr(read.sheets.join(', '))}"` : '',
  ].filter(Boolean).join(' ');
  const truncated = read.truncated || clipped
    ? `\n(Only the first ${text.length} characters are here. Ask with a larger maxChars, up to ${MAX_READ_CHARS}, if you need more.)`
    : '';
  return `<attachment name="${attr(name)}" format="${attr(read.format)}"${more ? ` ${more}` : ''}>\n${text}\n</attachment>${truncated}`;
}

/** The placeholder the model hears for a picture it doesn't get. */
export function imageStandIn(att, why = 'This model can\'t see images.') {
  return `[Image: ${att.name || 'image'}. ${why}]${att.alt ? ` Its description: ${att.alt}` : ''}`;
}

async function readAttachmentImage(api, email, att, args, ctx, budget) {
  if (!ctx.context?.flags?.images) return imageStandIn(att);
  const used = budget.perMessage.get(email.id) ?? 0;
  if (budget.images <= 0 || used >= MAX_IMAGES_PER_MESSAGE) return imageStandIn(att, 'No more images fit in this request.');
  // Local models get smaller pictures (their encoders shrink them anyway).
  const local = ctx.endpoint?.provider === 'openai' && !/^https:\/\/api\.openai\.com(\/|$)/i.test(ctx.endpoint?.baseUrl ?? '');
  const exif = args.photoDetails === true;
  const read = await api.email.getAttachmentImage(email.id, att.blobId, {
    ...(local ? { maxSide: LOCAL_IMAGE_SIDE } : {}),
    ...(exif ? { exif: true } : {}),
    ...accountArg(email.accountId),
  });
  const name = att.name || 'image';
  if (!read || read.status !== 'ok' || !read.data) return statusSentence(read?.status, name);
  budget.images -= 1;
  budget.perMessage.set(email.id, used + 1);
  const alt = read.alt || att.alt;
  const lines = [`The picture ${name} (${read.width}×${read.height}) is attached.${alt ? ` Its description in the message: ${alt}` : ''}`];
  if (exif) {
    const where = Number.isFinite(read.exif?.lat) && Number.isFinite(read.exif?.lon) ? `${read.exif.lat.toFixed(5)}, ${read.exif.lon.toFixed(5)}` : '';
    lines.push(read.exif?.taken || where
      ? `The photo says it was taken${read.exif?.taken ? ` on ${read.exif.taken}` : ''}${where ? ` at ${where} (latitude, longitude)` : ''}.`
      : 'The photo has no date or place stored.');
  }
  return { text: lines.join('\n'), images: [{ mediaType: read.type, data: read.data, name, width: read.width, height: read.height, ...(alt ? { alt } : {}) }] };
}

// ─── Messages: the conversation, the selection, the mentioned ones ───

function person(p) {
  if (!p) return '';
  return p.name && p.email ? `${p.name} <${p.email}>` : (p.email || p.name || '');
}

const accountArg = (accountId) => (accountId ? { accountId } : {});

/** One message for the model: headers and its own text (quotes of earlier mail cut). */
export function messageBlock(email, max, zone) {
  const own = ownText(email.text ?? '') || String(email.preview ?? '');
  const { text, cut: clipped } = cut(own, Math.max(0, max));
  const when = zone && email.receivedAt ? whenIn(zone, email.receivedAt) : (email.receivedAt ?? '');
  const files = (email.attachments ?? []).filter((a) => !a.inline).map((a) => a.name).filter(Boolean);
  const head = [`From: ${(email.from ?? []).map(person).join(', ')}`];
  if (email.to?.length) head.push(`To: ${email.to.map(person).join(', ')}`);
  head.push(`Date: ${when}`, `Subject: ${email.subject ?? ''}`);
  if (files.length) head.push(`Attachments: ${files.join(', ')}`);
  return `<message id="${attr(email.id)}">\n${head.join('\n')}\n\n${text}${clipped ? '\n[…]' : ''}\n</message>`;
}

/** Messages as one block within the budget; each gets an equal share, at least MIN_PER_MESSAGE. */
export function messagesText(emails, budget, zone, head) {
  if (budget.chars <= 0) return SPENT;
  const share = Math.max(MIN_PER_MESSAGE, Math.floor(budget.chars / Math.max(1, emails.length)) - 300);
  const blocks = [];
  let left = budget.chars;
  for (const email of emails) {
    if (left <= 500) break;
    const block = messageBlock(email, Math.min(share, left - 300), zone);
    blocks.push(block);
    left -= block.length;
  }
  budget.chars = Math.max(0, left);
  const missing = emails.length - blocks.length;
  return `${head}\n${blocks.join('\n\n')}${missing > 0 ? `\n(${missing} more did not fit in this request.)` : ''}`;
}

/** The selected and mentioned messages the model may read, without repeats. */
export function readable(ctx) {
  const c = ctx?.context;
  if (!c) return [];
  const list = [...(c.flags?.selection ? (c.selection?.emails ?? []) : []), ...(c.mentioned ?? [])];
  const seen = new Set();
  return list.filter((m) => {
    const key = `${m?.accountId ?? ''}/${m?.id}`;
    if (!m?.id || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getEmails(api, list) {
  const out = [];
  for (const m of list) {
    try {
      const email = await api.email.get(m.id, ...(m.accountId ? [m.accountId] : []));
      if (email) out.push(email);
    } catch { /* gone since the user picked it */ }
  }
  return out;
}

// ─── The lookups ───

const tools = [
  {
    name: 'read_attachment',
    description: 'Read an attachment of the open email: the text of a document (PDF, Word, Excel, PowerPoint, OpenDocument, text, CSV, calendar or contact file), or a picture. Name it by its file name or its number in the attachment list. Reads up to 20000 characters unless you ask for more with maxChars.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The file name, as in the attachment list' },
        index: { type: 'integer', description: 'Its number in the attachment list (instead of the name)' },
        maxChars: { type: 'integer', description: `How many characters to read, up to ${MAX_READ_CHARS}` },
        photoDetails: { type: 'boolean', description: 'Only when the user asks when or where a photo was taken: also read the date and place stored in it' },
      },
      additionalProperties: false,
    },
    available: (ctx) => !!ctx.context?.flags?.attachments && (ctx.context.email?.attachments?.length ?? 0) > 0,
    run: async (api, args, ctx) => {
      const { email } = ctx.context;
      const att = findAttachment(email.attachments, args);
      if (!att) throw new Error(`there is no such attachment. The attachments are:\n${attachmentLines(email.attachments)}`);
      const budget = budgetOf(ctx);
      if (isImage(att)) return readAttachmentImage(api, email, att, args, ctx, budget);
      if (!ctx.context.flags.text) return `${att.name} can't be read here.`;
      return readAttachmentText(api, email, att, args, budget);
    },
    label: (t, args) => (args?.name ? t('ctx.step.attachment', { name: args.name }) : t('ctx.step.attachment_any')),
    kind: 'ctx.kind.attachment',
    icon: 'paperclip',
  },
  {
    name: 'read_thread',
    description: 'Read the whole conversation the open email belongs to: every message in date order, with sender, date and each message\'s own text (quoted earlier mail is cut).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    available: (ctx) => !!ctx.context?.flags?.thread && !!ctx.context.thread && !!ctx.context.email,
    run: async (api, _args, ctx) => {
      const { email } = ctx.context;
      const emails = (await api.email.getThread(email.id, accountArg(email.accountId))) ?? [];
      if (!emails.length) throw new Error('the conversation could not be read');
      return messagesText(emails, budgetOf(ctx), ctx.zone, `The conversation, ${emails.length} messages, oldest first (data):`);
    },
    label: (t) => t('ctx.step.thread'),
    kind: 'ctx.kind.thread',
    icon: 'messages',
  },
  {
    name: 'read_messages',
    description: 'Read the messages the user selected in the list or mentioned with @: sender, date, subject and text. Without ids it reads all of them.',
    parameters: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Ids of some of them (optional)' } },
      additionalProperties: false,
    },
    available: (ctx) => readable(ctx).length > 0,
    run: async (api, args, ctx) => {
      const all = readable(ctx);
      const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
      const wanted = ids.length ? all.filter((m) => ids.includes(m.id)) : all;
      if (!wanted.length) throw new Error('none of those ids is a selected or mentioned message');
      const emails = await getEmails(api, wanted);
      if (!emails.length) throw new Error('the messages could not be read');
      emails.sort((a, b) => String(a.receivedAt ?? '').localeCompare(String(b.receivedAt ?? '')));
      const sel = ctx.context?.selection;
      const note = sel && sel.total > (sel.emails?.length ?? 0) ? ` The user selected ${sel.total}; only the first ${sel.emails.length} are offered.` : '';
      return messagesText(emails, budgetOf(ctx), ctx.zone, `${emails.length} messages, oldest first (data):${note}`);
    },
    label: (t) => t('ctx.step.messages'),
    kind: 'ctx.kind.messages',
    icon: 'mail',
  },
];

// ─── The actions ───

const actions = [
  {
    name: 'draft_reply_to_senders',
    description: 'Open one new message in the composer to all senders of the messages the user selected in the list, for the user to check and send. It does not send. The user is always asked first.',
    parameters: {
      type: 'object',
      properties: { subject: { type: 'string' }, body: { type: 'string', description: 'Plain text, without signature' } },
      required: ['subject', 'body'],
      additionalProperties: false,
    },
    available: (ctx) => !!ctx.actions && ctx.actions !== 'off' && ctx.mode !== 'composer' && !!ctx.context?.flags?.selection && (ctx.context.selection?.emails?.length ?? 0) > 1,
    // The recipients come from the messages, not from the user: always ask.
    alwaysAsk: true,
    describe: async (api, args, ctx) => {
      const own = new Set((ctx.ownEmails ?? []).map((e) => String(e).toLowerCase()));
      const to = [];
      for (const email of await getEmails(api, ctx.context.selection.emails)) {
        for (const from of email.from ?? []) {
          const address = String(from.email ?? '').trim();
          if (address && !own.has(address.toLowerCase()) && !to.some((a) => a.toLowerCase() === address.toLowerCase())) to.push(address);
        }
      }
      if (!to.length) throw new Error('the selected messages have no senders other than the user');
      const subject = String(args.subject ?? '').trim().slice(0, 200);
      const body = String(args.body ?? '').trim();
      if (!body) throw new Error('body is empty');
      const summary = api.i18n.t('ctx.action.reply_senders', { count: to.length, to: to.join(', '), subject: subject || '…' });
      return { summary, plan: { to: to.slice(0, 50), subject, body } };
    },
    perform: async (api, plan) => {
      const opened = await api.compose.open({ to: plan.to, subject: plan.subject, body: plan.body });
      if (opened === false) throw new Error('the composer did not open');
      return { text: `A new message to ${plan.to.length} people is open in the composer for the user to check and send. It was not sent.`, undo: null };
    },
    undo: async () => {},
    icon: 'mail-plus',
  },
];

export default { tools, actions };
