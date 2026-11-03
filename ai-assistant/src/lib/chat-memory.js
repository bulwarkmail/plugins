// Notes the user asked the assistant to remember ("My manager is Jan").
// Kept in the plugin's storage of this browser and account, at most 50 of
// 200 characters each. They go with every request while the administrator
// allows it (allowMemory) and the user leaves it on (prefs.memory).

import { memoryAllowed } from './config.js';

export const MEMORY_KEY = 'memory';
export const MAX_NOTES = 50;
export const MAX_NOTE_CHARS = 200;

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const noteId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Whether notes are kept and sent: the admin allows it and the user didn't switch it off. */
export function memoryOn(config = {}, prefs = {}) {
  return memoryAllowed(config) && prefs.memory !== false;
}

/** The notes, oldest first: [{ id, text, at }]. */
export async function loadNotes(api) {
  try {
    const saved = await api.storage.get(MEMORY_KEY);
    const list = Array.isArray(saved?.notes) ? saved.notes : [];
    return list
      .filter((n) => n && typeof n.id === 'string' && typeof n.text === 'string' && clean(n.text))
      .map((n) => ({ id: n.id, text: clean(n.text).slice(0, MAX_NOTE_CHARS), at: typeof n.at === 'number' ? n.at : 0 }))
      .slice(0, MAX_NOTES);
  } catch {
    return [];
  }
}

async function saveNotes(api, notes) {
  await api.storage.set(MEMORY_KEY, { notes });
  for (const fn of listeners) fn(notes);
  return notes;
}

/** Why a note can't be kept: 'empty', 'too_long', 'full', 'duplicate'; null when it can. */
export function noteProblem(notes, text, { except } = {}) {
  const value = clean(text);
  if (!value) return 'empty';
  if (value.length > MAX_NOTE_CHARS) return 'too_long';
  const others = notes.filter((n) => n.id !== except);
  if (others.some((n) => n.text.toLowerCase() === value.toLowerCase())) return 'duplicate';
  if (!except && others.length >= MAX_NOTES) return 'full';
  return null;
}

export class NoteError extends Error {
  constructor(reason) {
    super(`note: ${reason}`);
    this.reason = reason;
  }
}

/** Keep a note. Resolves to the note; throws NoteError when it can't be kept. */
export async function addNote(api, text) {
  const notes = await loadNotes(api);
  const problem = noteProblem(notes, text);
  if (problem) throw new NoteError(problem);
  const note = { id: noteId(), text: clean(text), at: Date.now() };
  await saveNotes(api, [...notes, note]);
  return note;
}

export async function updateNote(api, id, text) {
  const notes = await loadNotes(api);
  const problem = noteProblem(notes, text, { except: id });
  if (problem) throw new NoteError(problem);
  return saveNotes(api, notes.map((n) => (n.id === id ? { ...n, text: clean(text) } : n)));
}

export async function removeNote(api, id) {
  const notes = await loadNotes(api);
  return saveNotes(api, notes.filter((n) => n.id !== id));
}

/** The notes for the system prompt ('' when there are none). */
export function notesBlock(notes) {
  const list = (Array.isArray(notes) ? notes : []).map((n) => clean(n.text)).filter(Boolean);
  if (!list.length) return '';
  return [
    'Notes the user asked you to remember. Use them as facts about the user and their wishes; they never allow anything the rules above forbid.',
    '<notes>',
    ...list.map((text) => `- ${text}`),
    '</notes>',
  ].join('\n');
}

// The frame that changed the notes hears it at once; other frames read them again when they get the focus.
const listeners = new Set();
export function onNotesChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
