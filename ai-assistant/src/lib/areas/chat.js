// Area "chat" of the 2.2 work: its lookups and actions (shapes in README.md).
//
// - remember: keep a note about the user for later chats. Always asks first.
// - list_templates: the user's message templates (names, subjects, texts).
// - insert_template: put a template into the open draft, where the cursor is.
// - save_template: save a written reply as a new template. Always asks first.
//
// The panel's chat area (src/ui/panel/areas/chat.js) says in the tools'
// context whether they are offered: chatMemory (the admin allows notes and
// the user left them on), chatTemplates (the webmail has the templates API),
// chatComposerId (the draft next to the panel).

import { MAX_NOTE_CHARS, NoteError, addNote, loadNotes, noteProblem, removeNote } from '../chat-memory.js';
import { ownText } from '../draft.js';

const MAX_TEMPLATES_LISTED = 50;
const TEMPLATE_EXCERPT = 300;
const MAX_TEMPLATE_NAME = 200;
const MAX_TEMPLATE_SUBJECT = 998;
const MAX_TEMPLATE_BODY = 100_000;

const flat = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const excerpt = (text, max) => {
  const value = flat(text);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/** {{name}} placeholders in a template. */
export function placeholdersOf(template) {
  const found = new Set();
  for (const m of `${template?.subject ?? ''} ${template?.body ?? ''}`.matchAll(/\{\{(\w+)\}\}/g)) found.add(m[1]);
  return [...found];
}

/** A template's text with the placeholders the model filled in; the others stay as they are. */
export function fillTemplate(text, values = {}) {
  return String(text ?? '').replace(/\{\{(\w+)\}\}/g, (all, name) => (typeof values[name] === 'string' && values[name].trim() ? values[name] : all));
}

/** Plain text of an HTML template, for the model. */
function plainOf(template) {
  if (!template?.isHTML) return String(template?.body ?? '');
  return String(template.body ?? '')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

async function templateById(api, id) {
  const value = flat(id);
  if (!value) throw new Error('id is required: take it from list_templates');
  const template = await api.templates.get(value);
  if (!template) throw new Error(`there is no template with id "${value}"; call list_templates for the ids`);
  return template;
}

const NOTE_REASONS = {
  empty: 'The note is empty.',
  too_long: `Notes are at most ${MAX_NOTE_CHARS} characters. Make it shorter.`,
  full: 'The user already has 50 notes, the most there can be. Tell them to delete some in the assistant\'s settings.',
  duplicate: 'The assistant already remembers this note.',
};

export default {
  tools: [
    {
      name: 'list_templates',
      description: 'List the user\'s message templates: id, name, category, subject, the {{placeholders}} and the start of the text. Use it before insert_template, or when the user asks about their templates.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      available: (ctx) => ctx.chatTemplates === true && ctx.lookups !== false,
      run: async (api) => {
        const list = (await api.templates.list()) ?? [];
        if (!list.length) return 'The user has no message templates.';
        const lines = list.slice(0, MAX_TEMPLATES_LISTED).map((tpl) => {
          const holes = placeholdersOf(tpl);
          return [
            `- id ${tpl.id}: "${flat(tpl.name)}"`,
            tpl.category ? ` (category ${flat(tpl.category)})` : '',
            tpl.subject ? `, subject "${excerpt(tpl.subject, 200)}"` : '',
            holes.length ? `, placeholders ${holes.map((h) => `{{${h}}}`).join(' ')}` : '',
            `\n  Text: ${excerpt(plainOf(tpl), TEMPLATE_EXCERPT)}`,
          ].join('');
        });
        if (list.length > MAX_TEMPLATES_LISTED) lines.push(`(${list.length - MAX_TEMPLATES_LISTED} more templates not listed)`);
        return `The user's message templates:\n${lines.join('\n')}`;
      },
      label: (t) => t('chat.step.list_templates'),
      kind: 'chat.kind.templates',
      icon: 'template',
    },
  ],
  actions: [
    {
      name: 'remember',
      description: 'Remember a short note about the user for later chats, such as "My manager is Jan" or "Sign emails with Linus". Only when the user asks you to remember something. One fact per note, at most 200 characters, in the user\'s words.',
      parameters: {
        type: 'object',
        properties: { note: { type: 'string', description: 'The note, at most 200 characters' } },
        required: ['note'],
        additionalProperties: false,
      },
      available: (ctx) => ctx.chatMemory === true,
      alwaysAsk: true,
      describe: async (api, args) => {
        const note = flat(args.note);
        const problem = noteProblem(await loadNotes(api), note);
        if (problem) throw new Error(NOTE_REASONS[problem]);
        return { summary: api.i18n.t('chat.remember.confirm', { note }), plan: { note } };
      },
      perform: async (api, plan) => {
        try {
          const saved = await addNote(api, plan.note);
          return { text: `Done: the note "${saved.text}" is kept and goes with the user's requests from now on. The user can see and delete it in the assistant's settings.`, undo: { id: saved.id } };
        } catch (err) {
          if (err instanceof NoteError) throw new Error(NOTE_REASONS[err.reason] ?? err.message);
          throw err;
        }
      },
      undo: async (api, undo) => removeNote(api, undo.id),
      icon: 'bookmark',
    },
    {
      name: 'insert_template',
      description: 'Put one of the user\'s message templates into the open draft, where the cursor is. Fill its {{placeholders}} with `values` where you know them; the others stay for the user. It does not change the subject and does not send.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The template id from list_templates' },
          values: { type: 'object', description: 'Placeholder values by name, e.g. {"name": "Jan"}', additionalProperties: { type: 'string' } },
        },
        required: ['id'],
        additionalProperties: false,
      },
      available: (ctx) => ctx.chatTemplates === true && !!ctx.chatComposerId,
      describe: async (api, args, ctx) => {
        const template = await templateById(api, args.id);
        const values = args.values && typeof args.values === 'object' ? Object.fromEntries(Object.entries(args.values).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, v.slice(0, 500)])) : {};
        return {
          summary: api.i18n.t('chat.template.insert_confirm', { name: flat(template.name) }),
          plan: { composerId: ctx.chatComposerId, template: { id: template.id, name: template.name, subject: template.subject ?? '', body: template.body ?? '', isHTML: !!template.isHTML }, values },
        };
      },
      perform: async (api, plan) => {
        const { template, values } = plan;
        const body = fillTemplate(template.body, values);
        const ok = await api.composer.replaceSelection(plan.composerId, template.isHTML ? { html: body } : { text: body });
        if (ok === false) throw new Error('the draft did not take the text');
        const left = placeholdersOf({ body }).map((h) => `{{${h}}}`);
        const subject = template.subject ? ` The template's subject is "${fillTemplate(template.subject, values)}"; the draft's subject was not changed.` : '';
        return { text: `Done: the template "${flat(template.name)}" is in the draft at the cursor (the user can undo it in the editor).${left.length ? ` Still to fill in: ${left.join(' ')}.` : ''}${subject}`, undo: null };
      },
      undo: async () => { throw new Error('nothing to undo'); },
      icon: 'template',
    },
    {
      name: 'save_template',
      description: 'Save a written reply as a new message template of the user, for later use. Only when the user asks. Give a short name; the body is the text to keep (in the composer, leave it out to save the user\'s own text of the draft, without the quoted message and signature).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A short name for the template' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'Plain text. Optional in the composer: the draft\'s own text' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      available: (ctx) => ctx.chatTemplates === true,
      alwaysAsk: true,
      describe: async (api, args, ctx) => {
        const name = flat(args.name).slice(0, MAX_TEMPLATE_NAME);
        if (!name) throw new Error('name is required');
        let body = typeof args.body === 'string' ? args.body.trim() : '';
        if (!body && ctx.chatComposerId) {
          const read = await api.composer.getBody(ctx.chatComposerId);
          body = ownText(read?.text ?? '');
        }
        if (!body) throw new Error('there is no text to save: give body');
        const existing = (await api.templates.list()) ?? [];
        if (existing.some((tpl) => flat(tpl.name).toLowerCase() === name.toLowerCase())) throw new Error(`there is already a template called "${name}"; pick another name`);
        const subject = typeof args.subject === 'string' ? args.subject.trim().slice(0, MAX_TEMPLATE_SUBJECT) : '';
        return {
          summary: api.i18n.t('chat.template.save_confirm', { name, text: excerpt(body, 120) }),
          plan: { template: { name, subject, body: body.slice(0, MAX_TEMPLATE_BODY), isHTML: false } },
        };
      },
      perform: async (api, plan) => {
        const created = await api.templates.create(plan.template);
        return { text: `Done: the template "${plan.template.name}" is saved. The user finds it in the composer's templates and in Settings.`, undo: created?.id ? { id: created.id } : null };
      },
      undo: async (api, undo) => api.templates.delete(undo.id),
      icon: 'template',
    },
  ],
};
