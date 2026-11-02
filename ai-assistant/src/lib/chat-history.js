// The reader's running chat (chat:reader) and the chats before it.
//
// The reader keeps one conversation across the messages the user opens.
// When the panel opens after 8 hours without use, that conversation moves
// into the history and a fresh one starts. The history keeps at most 30
// chats and 400 KB; the oldest go first.
//
// The running chat may be open in two frames at once (the reader panel and
// the panel next to Calendar, or two tabs). A save therefore reads what is
// stored and keeps the turns another frame added (merge by turn id). Each
// running chat has an id and the time it started: when another frame moved
// the chat into the history and started a new one, the newer chat wins.

/** No use for this long, and the next opening of the panel starts a fresh chat. */
export const IDLE_MS = 8 * 60 * 60 * 1000;
/** Most chats the history keeps. */
export const MAX_HISTORY = 30;
/** Most characters (as stored, JSON) the history's chats may take together. */
export const MAX_HISTORY_CHARS = 400_000;
/** A chat's title: the start of its first question. */
export const TITLE_CHARS = 60;
export const INDEX_KEY = 'history:index';
export const historyKey = (id) => `history:${id}`;

/** Characters kept of a lookup's result and of the text a turn worked on, in an old chat. */
const KEPT_CHARS = 2000;
/** A chat too big for the history keeps less, step by step: these many characters of each lookup result, then none. */
const SHRINK_STEPS = [KEPT_CHARS, 300, 0];
/** Turn ids a frame removed (Edit, Answer again), kept with the running chat so another frame drops them too. */
const MAX_REMOVED = 200;

export const newChatId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const clip = (text, max) => (typeof text === 'string' && text.length > max ? text.slice(0, max) : text);
const flat = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** What a frame knows about the running chat it shows: { chatId, started, touched, known }. */
const states = new WeakMap();
export function chatState(api, key) {
  let byKey = states.get(api);
  if (!byKey) { byKey = new Map(); states.set(api, byKey); }
  let state = byKey.get(key);
  if (!state) { state = { chatId: null, started: 0, touched: 0, known: new Set() }; byKey.set(key, state); }
  return state;
}

/** The newest time a turn was added (turn.at), or 0. */
export function turnsActivity(turns) {
  let last = 0;
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (typeof turn?.at === 'number' && turn.at > last) last = turn.at;
  }
  return last;
}

/** When a stored chat was last used: its newest turn, else the time it was saved or continued. */
export function lastActivity(record) {
  return Math.max(turnsActivity(record?.turns), typeof record?.at === 'number' ? record.at : 0);
}

/** A chat's title: its first question, on one line, at most 60 characters. */
export function chatTitle(turns) {
  const first = (Array.isArray(turns) ? turns : []).find((turn) => turn?.role === 'user');
  const text = flat(first?.label ?? first?.content ?? '');
  return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1).trimEnd()}…` : text;
}

/** Questions and answers in a chat (the lines that say "now about another message" don't count). */
export const messageCount = (turns) => (Array.isArray(turns) ? turns : []).filter((turn) => turn?.role === 'user' || turn?.role === 'assistant').length;

/**
 * A chat as the history keeps it: no Retry inputs, shorter lookup results
 * (`keep` characters each; 0 drops them and the text a turn worked on),
 * nothing half done.
 */
export function compactTurns(turns, keep = KEPT_CHARS) {
  return (Array.isArray(turns) ? turns : []).map((turn) => {
    if (turn?.role !== 'assistant') return turn;
    const { input, applying, ...rest } = turn;
    void input; void applying;
    const out = { ...rest, source: keep ? clip(rest.source, keep) : '' };
    if (out.status === 'running') out.status = out.content ? 'stopped' : 'error';
    if (Array.isArray(out.steps)) {
      out.steps = out.steps.map((step) => ({
        ...step,
        result: keep ? clip(step.result, keep) : '',
        ...(step.action ? { action: { ...step.action, undo: null, state: ['waiting', 'running'].includes(step.action.state) ? 'skipped' : step.action.state } } : {}),
      }));
    }
    return out;
  });
}

const validEntry = (e) => e && typeof e === 'object' && typeof e.id === 'string' && e.id && typeof e.at === 'number';

/** The history's list, newest first: [{ id, title, at, count, size }]. */
export async function loadIndex(api) {
  try {
    const list = await api.storage.get(INDEX_KEY);
    return Array.isArray(list) ? list.filter(validEntry).sort((a, b) => b.at - a.at) : [];
  } catch {
    return [];
  }
}

/**
 * Keep the newest chats that fit: at most MAX_HISTORY, and MAX_HISTORY_CHARS
 * together. Removes the stored turns of the ones dropped.
 */
async function prune(api, list) {
  const kept = [];
  let total = 0;
  const dropped = [];
  for (const entry of list) {
    const size = typeof entry.size === 'number' ? entry.size : 0;
    if (kept.length < MAX_HISTORY && total + size <= MAX_HISTORY_CHARS) {
      kept.push(entry);
      total += size;
    } else {
      dropped.push(entry);
    }
  }
  for (const entry of dropped) await api.storage.remove(historyKey(entry.id)).catch(() => {});
  return kept;
}

/**
 * The chat in a form that fits the history's MAX_HISTORY_CHARS: shorter
 * lookup results first, then none, then only its newest turns.
 */
function fitting(turns) {
  for (const keep of SHRINK_STEPS) {
    const kept = compactTurns(turns, keep);
    const size = JSON.stringify(kept).length;
    if (size <= MAX_HISTORY_CHARS) return { kept, size };
  }
  let kept = compactTurns(turns, 0);
  while (kept.length > 1 && JSON.stringify(kept).length > MAX_HISTORY_CHARS) kept = kept.slice(1);
  return { kept, size: JSON.stringify(kept).length };
}

/**
 * Put a chat into the history (under `id`; saving the same chat twice keeps
 * one entry). Chats without a question aren't kept. When the plugin's
 * storage is full, the oldest chats go until it fits. Resolves to the
 * entry, or null; throws when even without older chats it can't be kept.
 */
export async function archiveChat(api, turns, { id = newChatId(), at = Date.now(), title } = {}) {
  if (!(Array.isArray(turns) && turns.some((turn) => turn?.role === 'user'))) return null;
  const { kept, size } = fitting(turns);
  const index = await loadIndex(api);
  const old = index.find((e) => e.id === id);
  const entry = { id, title: old?.renamed ? old.title : (title ?? chatTitle(kept)), at, count: messageCount(kept), size, ...(old?.renamed ? { renamed: true } : {}) };
  let others = index.filter((e) => e.id !== id);
  for (;;) {
    // The new one first, so it is never the one dropped for an older chat.
    const next = await prune(api, [entry, ...others]);
    try {
      await api.storage.set(historyKey(id), { turns: kept });
      await api.storage.set(INDEX_KEY, next.sort((a, b) => b.at - a.at));
      return entry;
    } catch (err) {
      // Storage full: make room by dropping the oldest chat, as long as there is one.
      others = next.filter((e) => e.id !== id);
      const oldest = others.pop();
      if (!oldest) throw err;
      await api.storage.remove(historyKey(oldest.id)).catch(() => {});
    }
  }
}

/** An old chat's turns ([] when it is gone). */
export async function loadHistoryChat(api, id) {
  try {
    const saved = await api.storage.get(historyKey(id));
    return Array.isArray(saved?.turns) ? saved.turns : [];
  } catch {
    return [];
  }
}

export async function renameHistoryChat(api, id, title) {
  const name = flat(title).slice(0, TITLE_CHARS * 2);
  if (!name) return loadIndex(api);
  const index = (await loadIndex(api)).map((e) => (e.id === id ? { ...e, title: name, renamed: true } : e));
  await api.storage.set(INDEX_KEY, index);
  return index;
}

export async function deleteHistoryChat(api, id) {
  const index = (await loadIndex(api)).filter((e) => e.id !== id);
  await api.storage.remove(historyKey(id)).catch(() => {});
  await api.storage.set(INDEX_KEY, index);
  return index;
}

/** The text of a chat to search in: its questions and answers, lower case. */
export function searchText(turns) {
  return (Array.isArray(turns) ? turns : [])
    .filter((turn) => turn?.role === 'user' || turn?.role === 'assistant')
    .map((turn) => (turn.role === 'user' ? (turn.label ?? turn.content) : turn.content) ?? '')
    .join('\n')
    .toLowerCase();
}

/** Entries whose title, or (when given) text, holds every word of the query. */
export function filterIndex(index, query, texts = new Map()) {
  const words = flat(query).toLowerCase().split(' ').filter(Boolean);
  if (!words.length) return index;
  return index.filter((e) => {
    const hay = `${String(e.title ?? '').toLowerCase()}\n${texts.get(e.id) ?? ''}`;
    return words.every((w) => hay.includes(w));
  });
}

// ─── The running chat ───

/** Start a new running chat (empty, or with the turns of an old chat to go on with). */
export async function startChat(api, key, turns = [], { id = newChatId(), now = Date.now() } = {}) {
  const state = chatState(api, key);
  state.chatId = id;
  state.started = now;
  state.touched = now;
  for (const turn of turns) state.known.add(turn.id);
  await api.storage.set(key, { id, started: now, turns, at: now });
}

/**
 * Move the running chat into the history and start an empty one. `turns`:
 * the frame's own, merged with what another frame stored for the same chat
 * (else the stored ones). Resolves to { entry, stale, turns }: `stale` when
 * another frame started a different chat since this one loaded; then
 * nothing moves and `turns` is that chat, to show instead. Throws when the
 * history can't take the chat (storage full); then nothing changed.
 */
export async function archiveRunning(api, key, turns, now = Date.now()) {
  const state = chatState(api, key);
  let record = null;
  try { record = await api.storage.get(key); } catch { record = null; }
  const storedId = typeof record?.id === 'string' ? record.id : null;
  const storedTurns = Array.isArray(record?.turns) ? record.turns : [];
  if (storedId && state.chatId && storedId !== state.chatId) {
    // This frame's chat is gone already (another frame moved it): show the one there is now.
    state.chatId = storedId;
    state.started = typeof record.started === 'number' ? record.started : 0;
    state.touched = typeof record.at === 'number' ? record.at : 0;
    for (const turn of storedTurns) state.known.add(turn.id);
    return { entry: null, stale: true, turns: storedTurns };
  }
  let list = Array.isArray(turns) ? turns : storedTurns;
  if (Array.isArray(turns) && record) list = mergeRunning(turns, record, state, now).record.turns;
  const id = state.chatId ?? storedId ?? list[0]?.id ?? newChatId();
  const at = Math.max(turnsActivity(list), state.touched, typeof record?.at === 'number' ? record.at : 0) || now;
  const entry = await archiveChat(api, list, { id, at });
  for (const turn of list) state.known.add(turn.id);
  await startChat(api, key, [], { now });
  return { entry, stale: false, turns: [] };
}

/**
 * When the panel opens: the stored chat moves into the history when it was
 * last used IDLE_MS ago or longer (and `allowed`, the admin's chat tools
 * switch, is on). Also tells this frame which chat it shows. Resolves to
 * true when a fresh chat started.
 */
export async function openRunning(api, key, { allowed = true, now = Date.now() } = {}) {
  const state = chatState(api, key);
  let record = null;
  try { record = await api.storage.get(key); } catch { record = null; }
  const turns = Array.isArray(record?.turns) ? record.turns : [];
  state.chatId = typeof record?.id === 'string' ? record.id : null;
  state.started = typeof record?.started === 'number' ? record.started : 0;
  state.touched = typeof record?.at === 'number' ? record.at : 0;
  state.known = new Set(turns.map((turn) => turn.id));
  if (!allowed || !turns.length) return false;
  const last = lastActivity(record);
  if (!last || now - last < IDLE_MS) return false;
  // When the history can't take it (storage full), the chat stays.
  try {
    await archiveRunning(api, key, turns, now);
  } catch {
    return false;
  }
  return true;
}

/** Whether the chat this frame shows has been idle for IDLE_MS (turns without times: as stored). */
export function isIdle(api, key, turns, now = Date.now()) {
  if (!Array.isArray(turns) || !turns.length) return false;
  const last = Math.max(turnsActivity(turns), chatState(api, key).touched);
  return !!last && now - last >= IDLE_MS;
}

const byTime = (list) => list
  .map((turn, i) => ({ turn, i }))
  .sort((a, b) => ((a.turn.at ?? 0) - (b.turn.at ?? 0)) || (a.i - b.i))
  .map((x) => x.turn);

/**
 * What to save: this frame's turns plus the ones another frame added since.
 * Turns this frame had and dropped stay dropped. When the stored chat is a
 * newer one (another frame started it), this frame's own new turns join it.
 * Returns { record, foreign, dropped }: `foreign` the turns this frame
 * doesn't show yet, `dropped` the ids it should stop showing.
 */
export function mergeRunning(local, stored, state, now = Date.now()) {
  const storedTurns = Array.isArray(stored?.turns) ? stored.turns : [];
  const storedId = typeof stored?.id === 'string' ? stored.id : null;
  const storedStarted = typeof stored?.started === 'number' ? stored.started : 0;
  const theirs = storedId && state.chatId && storedId !== state.chatId && storedStarted > state.started;
  const dropped = new Set();
  let base = local;
  if (theirs) {
    // Our chat went into the history elsewhere: keep only what we added since.
    base = local.filter((turn) => !state.known.has(turn.id));
    for (const turn of local) if (state.known.has(turn.id)) dropped.add(turn.id);
    state.chatId = storedId;
    state.started = storedStarted;
    state.touched = typeof stored?.at === 'number' ? stored.at : state.touched;
  } else if (!state.chatId) {
    state.chatId = storedId ?? newChatId();
    state.started = storedId ? storedStarted : now;
  }
  // Turns another frame removed (Edit, Answer again) go here too; the ones
  // this frame removed join that list for the others.
  const storedRemoved = Array.isArray(stored?.removed) ? stored.removed : [];
  const before = new Set(base.map((turn) => turn.id));
  const removedHere = theirs ? [] : storedTurns.filter((turn) => turn && state.known.has(turn.id) && !before.has(turn.id)).map((turn) => turn.id);
  const removed = new Set([...storedRemoved.filter((id) => typeof id === 'string'), ...removedHere]);
  if (removed.size) {
    for (const turn of base) if (removed.has(turn.id)) dropped.add(turn.id);
    base = base.filter((turn) => !removed.has(turn.id));
  }
  const mine = new Set(base.map((turn) => turn.id));
  const foreign = storedTurns.filter((turn) => turn && !mine.has(turn.id) && !state.known.has(turn.id) && !removed.has(turn.id));
  const turns = foreign.length ? byTime([...base, ...foreign]) : base;
  for (const turn of turns) state.known.add(turn.id);
  const at = Math.max(turnsActivity(turns), state.touched) || now;
  const record = { id: state.chatId, started: state.started, turns, at };
  if (removed.size) record.removed = [...removed].slice(-MAX_REMOVED);
  return { record, foreign, dropped };
}

/** The frame's transcript with another frame's turns added and the dropped ones gone. */
export function withForeign(prev, { foreign = [], dropped = new Set() }) {
  if (!foreign.length && !dropped.size) return prev;
  const kept = prev.filter((turn) => !dropped.has(turn.id));
  const ids = new Set(kept.map((turn) => turn.id));
  return byTime([...kept, ...foreign.filter((turn) => !ids.has(turn.id))]);
}

/**
 * Save the running chat, merged with what another frame stored meanwhile.
 * Resolves to { foreign, dropped } for the frame's own transcript.
 */
export async function saveRunning(api, key, turns, now = Date.now()) {
  const state = chatState(api, key);
  let stored = null;
  try { stored = await api.storage.get(key); } catch { stored = null; }
  const { record, foreign, dropped } = mergeRunning(turns, stored, state, now);
  await api.storage.set(key, record);
  return { foreign, dropped };
}
