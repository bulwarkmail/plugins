import { describe, expect, it } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import {
  IDLE_MS, INDEX_KEY, MAX_HISTORY, MAX_HISTORY_CHARS, archiveChat, archiveRunning, chatState, chatTitle, deleteHistoryChat,
  filterIndex, historyKey, isIdle, loadHistoryChat, loadIndex, mergeRunning, openRunning, renameHistoryChat, saveRunning, withForeign,
} from '../src/lib/chat-history.js';

const KEY = 'chat:reader';
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-02T09:00:00Z');
const exchange = (id, question, at, answer = 'Sure.') => [
  { id: `${id}u`, role: 'user', at, content: question, label: question },
  { id: `${id}a`, role: 'assistant', at, content: answer, status: 'done', task: 'chat', show: 'chat', steps: [] },
];

describe('the running chat when the panel opens', () => {
  it('moves into the history after 8 hours without use, and a fresh one starts', async () => {
    const api = fakeApi();
    const turns = exchange('a', 'Who is Jan?', NOW - IDLE_MS - 1000);
    await api.storage.set(KEY, { id: 'c1', started: NOW - 9 * HOUR, turns, at: NOW - IDLE_MS - 1000 });
    expect(await openRunning(api, KEY, { now: NOW })).toBe(true);
    const running = await api.storage.get(KEY);
    expect(running.turns).toEqual([]);
    expect(running.id).not.toBe('c1');
    const [entry] = await loadIndex(api);
    expect(entry).toMatchObject({ id: 'c1', title: 'Who is Jan?', count: 2, at: NOW - IDLE_MS - 1000 });
    expect((await loadHistoryChat(api, 'c1')).map((t) => t.id)).toEqual(['au', 'aa']);
  });

  it('stays when it was used less than 8 hours ago', async () => {
    const api = fakeApi();
    await api.storage.set(KEY, { id: 'c1', started: NOW - 9 * HOUR, turns: exchange('a', 'Hi', NOW - IDLE_MS + 60_000), at: NOW - IDLE_MS + 60_000 });
    expect(await openRunning(api, KEY, { now: NOW })).toBe(false);
    expect((await api.storage.get(KEY)).turns).toHaveLength(2);
    expect(await loadIndex(api)).toEqual([]);
  });

  it('counts a 2.1 chat (turns without times) from when it was saved', async () => {
    const api = fakeApi();
    const turns = exchange('a', 'Old question', undefined).map(({ at, ...rest }) => { void at; return rest; });
    await api.storage.set(KEY, { turns, at: NOW - 10 * HOUR });
    expect(await openRunning(api, KEY, { now: NOW })).toBe(true);
    expect((await loadIndex(api))[0].title).toBe('Old question');
  });

  it('never splits while the administrator switched chat tools off', async () => {
    const api = fakeApi();
    await api.storage.set(KEY, { id: 'c1', turns: exchange('a', 'Hi', NOW - 20 * HOUR), at: NOW - 20 * HOUR });
    expect(await openRunning(api, KEY, { allowed: false, now: NOW })).toBe(false);
    expect((await api.storage.get(KEY)).turns).toHaveLength(2);
  });

  it('tells a frame its chat is idle from the newest turn', () => {
    const api = fakeApi();
    chatState(api, KEY).touched = 0;
    expect(isIdle(api, KEY, exchange('a', 'Hi', NOW - IDLE_MS), NOW)).toBe(true);
    expect(isIdle(api, KEY, exchange('a', 'Hi', NOW - IDLE_MS + 1), NOW)).toBe(false);
    expect(isIdle(api, KEY, [], NOW)).toBe(false);
  });
});

describe('the history', () => {
  it('titles a chat with its first question, 60 characters at most', () => {
    expect(chatTitle(exchange('a', '  What   is on\nmy calendar?', 1))).toBe('What is on my calendar?');
    const long = chatTitle(exchange('a', 'x'.repeat(100), 1));
    expect(long).toHaveLength(60);
    expect(long.endsWith('…')).toBe(true);
  });

  it('keeps no chat without a question', async () => {
    const api = fakeApi();
    expect(await archiveChat(api, [], { id: 'x' })).toBeNull();
    expect(await loadIndex(api)).toEqual([]);
  });

  it('keeps the newest 30 chats and drops the stored turns of older ones', async () => {
    const api = fakeApi();
    for (let i = 0; i < MAX_HISTORY + 2; i += 1) await archiveChat(api, exchange(`c${i}`, `Question ${i}`, i), { id: `c${i}`, at: i });
    const index = await loadIndex(api);
    expect(index).toHaveLength(MAX_HISTORY);
    expect(index[0].id).toBe(`c${MAX_HISTORY + 1}`);
    expect(index.some((e) => e.id === 'c0' || e.id === 'c1')).toBe(false);
    expect(await api.storage.get(historyKey('c0'))).toBeNull();
    expect(await api.storage.get(historyKey('c2'))).not.toBeNull();
  });

  it('keeps at most 400 KB, dropping the oldest first', async () => {
    const api = fakeApi();
    const big = 'y'.repeat(150_000);
    for (let i = 0; i < 4; i += 1) await archiveChat(api, exchange(`b${i}`, `Big ${i}`, i, big), { id: `b${i}`, at: i });
    const index = await loadIndex(api);
    expect(index.map((e) => e.id)).toEqual(['b3', 'b2']);
    expect(index.reduce((sum, e) => sum + e.size, 0)).toBeLessThanOrEqual(MAX_HISTORY_CHARS);
    expect(await api.storage.get(historyKey('b1'))).toBeNull();
  });

  it('keeps an old chat smaller: no Retry input, shorter lookup results, no Undo', async () => {
    const api = fakeApi();
    const turns = exchange('a', 'Find it', 1);
    turns[1] = { ...turns[1], input: { text: 'z'.repeat(5000) }, steps: [{ id: 's', name: 'search_mail', result: 'r'.repeat(9000), action: { summary: 'Archive', state: 'done', undo: { id: 1 } } }] };
    await archiveChat(api, turns, { id: 'a' });
    const [, answer] = await loadHistoryChat(api, 'a');
    expect(answer.input).toBeUndefined();
    expect(answer.steps[0].result).toHaveLength(2000);
    expect(answer.steps[0].action.undo).toBeNull();
  });

  it('renames and deletes a chat', async () => {
    const api = fakeApi();
    await archiveChat(api, exchange('a', 'First', 1), { id: 'a', at: 1 });
    await archiveChat(api, exchange('b', 'Second', 2), { id: 'b', at: 2 });
    await renameHistoryChat(api, 'a', '  Budget   talk ');
    expect((await loadIndex(api)).find((e) => e.id === 'a').title).toBe('Budget talk');
    // Archiving the same chat again keeps the name the user gave it.
    await archiveChat(api, exchange('a', 'First', 3), { id: 'a', at: 3 });
    expect((await loadIndex(api)).find((e) => e.id === 'a').title).toBe('Budget talk');
    await deleteHistoryChat(api, 'b');
    expect((await loadIndex(api)).map((e) => e.id)).toEqual(['a']);
    expect(await api.storage.get(historyKey('b'))).toBeNull();
    expect((await api.storage.get(INDEX_KEY)).length).toBe(1);
  });

  it('finds chats by every word of the query, in the title or the text', () => {
    const index = [{ id: 'a', title: 'Budget for Q3', at: 2 }, { id: 'b', title: 'Lunch', at: 1 }];
    const texts = new Map([['b', 'where do we meet for lunch on friday']]);
    expect(filterIndex(index, 'budget').map((e) => e.id)).toEqual(['a']);
    expect(filterIndex(index, 'friday lunch', texts).map((e) => e.id)).toEqual(['b']);
    expect(filterIndex(index, 'friday budget', texts)).toEqual([]);
    expect(filterIndex(index, '  ')).toEqual(index);
  });
});

describe('two frames with the same running chat', () => {
  it('keep each other\'s turns when they save', async () => {
    const one = fakeApi();
    // Two frames share the storage: give the second the first one's.
    const two = fakeApi();
    two.storage.get = one.storage.get;
    two.storage.set = one.storage.set;
    await one.storage.set(KEY, { id: 'c1', started: 1, turns: exchange('a', 'First', 10), at: 10 });
    await openRunning(one, KEY, { now: 20 });
    await openRunning(two, KEY, { now: 20 });
    const base = exchange('a', 'First', 10);
    await saveRunning(one, KEY, [...base, ...exchange('b', 'From one', 30)], 40);
    const merged = await saveRunning(two, KEY, [...base, ...exchange('c', 'From two', 35)], 50);
    const stored = await one.storage.get(KEY);
    expect(stored.turns.map((t) => t.id)).toEqual(['au', 'aa', 'bu', 'ba', 'cu', 'ca']);
    expect(merged.foreign.map((t) => t.id)).toEqual(['bu', 'ba']);
    expect(withForeign([...base, ...exchange('c', 'From two', 35)], merged).map((t) => t.id)).toEqual(['au', 'aa', 'bu', 'ba', 'cu', 'ca']);
  });

  it('don\'t bring back turns a frame removed (edit, new chat)', () => {
    const state = { chatId: 'c1', started: 1, touched: 0, known: new Set(['au', 'aa', 'bu', 'ba']) };
    const stored = { id: 'c1', started: 1, turns: [...exchange('a', 'A', 1), ...exchange('b', 'B', 2)], at: 2 };
    const { record } = mergeRunning(exchange('a', 'A', 1), stored, state, 5);
    expect(record.turns.map((t) => t.id)).toEqual(['au', 'aa']);
  });

  it('follow the newer chat when the other frame started one', async () => {
    const api = fakeApi();
    await api.storage.set(KEY, { id: 'c1', started: 1, turns: exchange('a', 'A', 1), at: 1 });
    await openRunning(api, KEY, { now: 2 });
    const other = { id: 'c2', started: 100, turns: exchange('n', 'New', 101), at: 101 };
    const { record, dropped, foreign } = mergeRunning([...exchange('a', 'A', 1), ...exchange('m', 'Mine', 102)], other, chatState(api, KEY), 103);
    expect(record.id).toBe('c2');
    expect(record.turns.map((t) => t.id)).toEqual(['nu', 'na', 'mu', 'ma']);
    expect([...dropped]).toEqual(['au', 'aa']);
    expect(foreign.map((t) => t.id)).toEqual(['nu', 'na']);
  });

  it('keep the chat a frame just started over a stale stored one', async () => {
    const api = fakeApi();
    await api.storage.set(KEY, { id: 'c1', started: 1, turns: exchange('a', 'A', 1), at: 1 });
    await openRunning(api, KEY, { now: 2 });
    await archiveRunning(api, KEY, exchange('a', 'A', 1));
    const fresh = chatState(api, KEY).chatId;
    const { record } = mergeRunning([], { id: 'c1', started: 1, turns: exchange('a', 'A', 1), at: 1 }, chatState(api, KEY), 10);
    expect(record.id).toBe(fresh);
    expect(record.turns).toEqual([]);
  });
});

describe('fixes after the review', () => {
  const shared = () => {
    const one = fakeApi();
    const two = fakeApi();
    two.storage.get = one.storage.get;
    two.storage.set = one.storage.set;
    two.storage.remove = one.storage.remove;
    return [one, two];
  };

  it('a stale tab coming back doesn\'t move away the chat another tab started', async () => {
    const [one, two] = shared();
    const t0 = NOW - IDLE_MS - HOUR;
    await one.storage.set(KEY, { id: 'c1', started: t0, turns: exchange('a', 'Old', t0), at: t0 });
    await openRunning(one, KEY, { now: t0 + 1 });
    expect(await openRunning(two, KEY, { now: NOW })).toBe(true);
    await saveRunning(two, KEY, exchange('m', 'Morning', NOW + 10), NOW + 20);
    // Tab one becomes visible with its copy of last night's chat.
    expect(isIdle(one, KEY, exchange('a', 'Old', t0), NOW + 30)).toBe(true);
    const done = await archiveRunning(one, KEY, exchange('a', 'Old', t0), NOW + 30);
    expect(done.stale).toBe(true);
    expect(done.turns.map((t) => t.id)).toEqual(['mu', 'ma']);
    expect((await one.storage.get(KEY)).turns.map((t) => t.id)).toEqual(['mu', 'ma']);
    expect((await loadIndex(one)).map((e) => e.id)).toEqual(['c1']);
    // Tab two saves again: nothing of its chat is lost.
    const merged = await saveRunning(two, KEY, exchange('m', 'Morning', NOW + 10), NOW + 40);
    expect([...merged.dropped]).toEqual([]);
    expect((await one.storage.get(KEY)).turns.map((t) => t.id)).toEqual(['mu', 'ma']);
  });

  it('New chat keeps what another frame added to the same chat', async () => {
    const [one, two] = shared();
    await one.storage.set(KEY, { id: 'c1', started: 1, turns: exchange('a', 'A', 10), at: 10 });
    await openRunning(one, KEY, { now: 11 });
    await openRunning(two, KEY, { now: 11 });
    await saveRunning(two, KEY, [...exchange('a', 'A', 10), ...exchange('b', 'From two', 20)], 21);
    await archiveRunning(one, KEY, exchange('a', 'A', 10), 30);
    expect((await loadHistoryChat(one, 'c1')).map((t) => t.id)).toEqual(['au', 'aa', 'bu', 'ba']);
  });

  it('a turn one frame removed (Edit) doesn\'t come back from another frame', async () => {
    const [one, two] = shared();
    const both = [...exchange('a', 'A', 10), ...exchange('b', 'B', 20)];
    await one.storage.set(KEY, { id: 'c1', started: 1, turns: both, at: 20 });
    await openRunning(one, KEY, { now: 21 });
    await openRunning(two, KEY, { now: 21 });
    // Frame one edits B: the exchange goes, a new one comes.
    await saveRunning(one, KEY, [...exchange('a', 'A', 10), ...exchange('c', 'B, edited', 30)], 31);
    // Frame two still shows B and saves.
    const merged = await saveRunning(two, KEY, both, 40);
    expect((await one.storage.get(KEY)).turns.map((t) => t.id)).toEqual(['au', 'aa', 'cu', 'ca']);
    expect([...merged.dropped].sort()).toEqual(['ba', 'bu']);
    expect(withForeign(both, merged).map((t) => t.id)).toEqual(['au', 'aa', 'cu', 'ca']);
  });

  it('a chat over 400 KB is kept, smaller', async () => {
    const api = fakeApi();
    const big = [];
    for (let i = 0; i < 20; i += 1) {
      big.push({ id: `u${i}`, role: 'user', at: i, content: 'q', label: 'q' });
      big.push({ id: `a${i}`, role: 'assistant', at: i, content: 'x'.repeat(1500), status: 'done', source: 'y'.repeat(2000), steps: Array.from({ length: 8 }, (_, k) => ({ id: `s${i}${k}`, name: 'read_message', result: 'z'.repeat(5000) })) });
    }
    const entry = await archiveChat(api, big, { id: 'big', at: 1 });
    expect(entry).not.toBeNull();
    expect(entry.size).toBeLessThanOrEqual(MAX_HISTORY_CHARS);
    const kept = await loadHistoryChat(api, 'big');
    expect(kept).toHaveLength(40);
    expect(kept[1].steps[0].result).toHaveLength(300);
    expect(kept[1].content).toHaveLength(1500);
  });

  it('makes room by dropping the oldest chats when the storage is full, and fails without changing anything when it can\'t', async () => {
    const api = fakeApi();
    const set = api.storage.set;
    await archiveChat(api, exchange('o', 'Oldest', 1), { id: 'o', at: 1 });
    await archiveChat(api, exchange('p', 'Older', 2), { id: 'p', at: 2 });
    // Room for one chat more only after the oldest went.
    let room = 0;
    api.storage.set = async (k, v) => {
      if (k === historyKey('n') && !(await api.storage.get(historyKey('o')) === null)) throw new Error('Plugin storage is full');
      room += 1;
      return set(k, v);
    };
    await archiveChat(api, exchange('n', 'New', 3), { id: 'n', at: 3 });
    expect((await loadIndex(api)).map((e) => e.id)).toEqual(['n', 'p']);
    expect(room).toBeGreaterThan(0);

    // Nothing can be written: the running chat stays as it was.
    await api.storage.set(KEY, { id: 'c1', started: 1, turns: exchange('r', 'Running', 5), at: 5 });
    await openRunning(api, KEY, { now: 6 });
    api.storage.set = async (k, v) => { if (String(k).startsWith('history:')) throw new Error('Plugin storage is full'); return set(k, v); };
    await expect(archiveRunning(api, KEY, exchange('r', 'Running', 5), 7)).rejects.toThrow(/full/);
    expect((await api.storage.get(KEY)).turns.map((t) => t.id)).toEqual(['ru', 'ra']);
    expect(chatState(api, KEY).chatId).toBe('c1');
  });
});
