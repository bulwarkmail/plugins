// Area "chat" of the 2.2 work: its part of the plugin's settings (see src/lib/areas/README.md).
//
// Saved prompts: the user's own (prefs.prompts), to add, change and delete,
// and the administrator's (read only). Notes to remember: the switch
// (prefs.memory) and the list of notes, to change and delete, while the
// administrator allows notes (allowMemory).

import { useCallback, useEffect, useState } from 'react';
import { Button, Field, Input, Row, RowAction, Section, SettingRow, Stack, Switch, Text, Textarea } from '@plugin-host/ui';
import { MAX_PROMPTS, MAX_PROMPT_NAME, MAX_PROMPT_TEXT, adminPrompts, promptId, userPrompts } from '../../lib/chat-prompts.js';
import { MAX_NOTES, MAX_NOTE_CHARS, NoteError, loadNotes, removeNote, updateNote } from '../../lib/chat-memory.js';
import { memoryAllowed } from '../../lib/config.js';
import { effectiveActionMode } from '../../lib/actions.js';

const box = { border: '1px solid var(--color-border)', borderRadius: 8, padding: '8px 10px' };
const rowStyle = { display: 'flex', alignItems: 'flex-start', gap: 4, minWidth: 0 };
const textStyle = { flex: 1, minWidth: 0, overflowWrap: 'anywhere' };

/** Shown after the standing instructions; null shows nothing. Props: { api, setup, prefs, savePrefs }. */
export function ChatSection({ api, setup, prefs = {}, savePrefs }) {
  const t = api.i18n.t;
  const config = setup?.config ?? {};
  return (
    <Section title={t('chat.settings.title')} description={t('chat.settings.hint')}>
      <Stack gap={6}>
        <PromptsBlock api={api} config={config} prefs={prefs} savePrefs={savePrefs} />
        {memoryAllowed(config) && <NotesBlock api={api} config={config} prefs={prefs} savePrefs={savePrefs} />}
      </Stack>
    </Section>
  );
}

/** The user's saved prompts, with a form to add or change one, and the administrator's. */
function PromptsBlock({ api, config, prefs, savePrefs }) {
  const t = api.i18n.t;
  const mine = userPrompts(prefs);
  const theirs = adminPrompts(config);
  // null, or { id (null for a new one), name, text }.
  const [form, setForm] = useState(null);
  const save = async () => {
    const name = form.name.trim();
    const text = form.text.trim();
    if (!name || !text) return;
    const list = form.id ? mine.map((p) => (p.id === form.id ? { ...p, name, text } : p)) : [...mine, { id: promptId(), name, text }];
    await savePrefs({ prompts: list });
    setForm(null);
  };
  const remove = async (id) => savePrefs({ prompts: mine.filter((p) => p.id !== id) });

  return (
    <Stack gap={3}>
      <div>
        <h4 className="bk text-sm font-medium text-foreground" style={{ margin: 0 }}>{t('chat.prompts.title')}</h4>
        <Text tone="muted" size="xs">{t('chat.prompts.hint')}</Text>
      </div>
      {mine.length === 0 && !form && <Text tone="muted" size="sm">{t('chat.prompts.empty')}</Text>}
      {mine.length > 0 && (
        <ul aria-label={t('chat.prompts.title')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {mine.map((p) => (
            <li key={p.id} style={{ ...box, ...rowStyle }} data-saved-prompt={p.id}>
              <div style={textStyle}>
                <Text size="sm" weight="medium">{p.name}</Text>
                <Text size="xs" tone="muted" className="whitespace-pre-wrap">{p.text}</Text>
              </div>
              <RowAction icon="pencil" label={t('chat.prompts.edit_named', { name: p.name })} onClick={() => setForm({ id: p.id, name: p.name, text: p.text })} />
              <RowAction icon="trash" danger label={t('chat.prompts.delete_named', { name: p.name })} onClick={() => void remove(p.id)} />
            </li>
          ))}
        </ul>
      )}
      {form ? (
        <form
          style={{ ...box, display: 'flex', flexDirection: 'column', gap: 12 }}
          aria-label={form.id ? t('chat.prompts.edit') : t('chat.prompts.add')}
          onSubmit={(e) => { e.preventDefault(); void save(); }}
        >
          <Field label={t('chat.prompts.name')}>
            <Input autoFocus value={form.name} maxLength={MAX_PROMPT_NAME} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label={t('chat.prompts.text')} hint={t('chat.prompts.text_hint')}>
            <Textarea rows={3} value={form.text} maxLength={MAX_PROMPT_TEXT} onChange={(e) => setForm({ ...form, text: e.target.value })} />
          </Field>
          <Row gap={2}>
            <Button type="submit" disabled={!form.name.trim() || !form.text.trim()}>{t('chat.prompts.save')}</Button>
            <Button variant="secondary" onClick={() => setForm(null)}>{t('common.cancel')}</Button>
          </Row>
        </form>
      ) : (
        <Row>
          <Button variant="secondary" icon="plus" disabled={mine.length >= MAX_PROMPTS} onClick={() => setForm({ id: null, name: '', text: '' })}>{t('chat.prompts.add')}</Button>
        </Row>
      )}
      {theirs.length > 0 && (
        <div data-admin-prompts>
          <Text size="xs" tone="muted">{t('chat.prompts.admin', { names: theirs.map((p) => p.name).join(', ') })}</Text>
        </div>
      )}
    </Stack>
  );
}

/** The switch for notes, and the notes the assistant keeps. */
function NotesBlock({ api, config, prefs, savePrefs }) {
  const t = api.i18n.t;
  const [notes, setNotes] = useState(null);
  const [editing, setEditing] = useState(null); // { id, text }
  const [problem, setProblem] = useState('');
  const reload = useCallback(async () => setNotes(await loadNotes(api)), [api]);
  useEffect(() => { void reload(); }, [reload]);
  const on = prefs.memory !== false;

  const save = async () => {
    try {
      setNotes(await updateNote(api, editing.id, editing.text));
      setEditing(null);
      setProblem('');
    } catch (err) {
      const reason = err instanceof NoteError ? err.reason : 'other';
      setProblem(t(`chat.notes.problem.${reason}`, { max: reason === 'full' ? MAX_NOTES : MAX_NOTE_CHARS }));
    }
  };
  const remove = async (id) => {
    setNotes(await removeNote(api, id));
    api.toast?.success?.(t('chat.notes.deleted'));
  };

  return (
    <Stack gap={3}>
      <SettingRow label={t('chat.notes.switch')} description={t('chat.notes.switch_hint')} htmlFor="ai-chat-memory">
        <Switch id="ai-chat-memory" label={t('chat.notes.switch')} checked={on} onChange={(value) => void savePrefs({ memory: value })} />
      </SettingRow>
      <div>
        <h4 className="bk text-sm font-medium text-foreground" style={{ margin: 0 }}>{t('chat.notes.title')}</h4>
        <Text tone="muted" size="xs">{t('chat.notes.hint', { max: MAX_NOTES })}</Text>
      </div>
      {/* New notes come through the remember action, so they need actions on. */}
      {on && effectiveActionMode(config, prefs) === 'off' && (
        <Text tone="muted" size="sm" data-notes-actions-off>{t(config.actions === 'off' ? 'chat.notes.actions_off_admin' : 'chat.notes.actions_off')}</Text>
      )}
      {notes && notes.length === 0 && <Text tone="muted" size="sm">{t('chat.notes.empty')}</Text>}
      {notes && notes.length > 0 && (
        <ul aria-label={t('chat.notes.title')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {notes.map((note) => (
            <li key={note.id} style={{ ...box, ...rowStyle }} data-note={note.id}>
              {editing?.id === note.id ? (
                <form style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 0 }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
                  <Field label={t('chat.notes.edit_label')} error={problem || undefined}>
                    <Input
                      autoFocus
                      value={editing.text}
                      maxLength={MAX_NOTE_CHARS}
                      onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setEditing(null); setProblem(''); } }}
                    />
                  </Field>
                  <Row gap={2}>
                    <Button type="submit" size="sm" disabled={!editing.text.trim()}>{t('chat.notes.save')}</Button>
                    <Button size="sm" variant="secondary" onClick={() => { setEditing(null); setProblem(''); }}>{t('common.cancel')}</Button>
                  </Row>
                </form>
              ) : (
                <>
                  <div style={textStyle}><Text size="sm">{note.text}</Text></div>
                  <RowAction icon="pencil" label={t('chat.notes.edit_named', { note: note.text })} onClick={() => { setProblem(''); setEditing({ id: note.id, text: note.text }); }} />
                  <RowAction icon="trash" danger label={t('chat.notes.delete_named', { note: note.text })} onClick={() => void remove(note.id)} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Stack>
  );
}
