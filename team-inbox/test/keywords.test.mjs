import { describe, expect, it } from 'vitest';
import {
  assignChanges, assignedKeyword, assigneeOf, assigneesOf, doneChanges, isAssigneeId, isDone, keywordList,
  recentAssignees, reopenChanges, unassignChanges,
} from '../src/lib/keywords.js';

describe('keywords', () => {
  it('names the assignee by principal id, in a form both Stalwart versions and the plugin API take', () => {
    expect(assignedKeyword('cj')).toBe('$assigned:cj');
    expect(assignedKeyword('C2')).toBe('$assigned:c2');
    // The plugin API refuses "@" in keywords, so no address goes in.
    expect(() => assignedKeyword('bob@example.org')).toThrow();
    expect(() => assignedKeyword('')).toThrow();
    expect(isAssigneeId('a b')).toBe(false);
  });

  it('reads the assignee and done state from a keyword list or map, in any case', () => {
    expect(assigneeOf(['$seen', '$Assigned:CJ'])).toBe('cj');
    expect(assigneeOf({ '$assigned:ck': true, '$assigned:cj': false })).toBe('ck');
    expect(assigneeOf(['$seen'])).toBeNull();
    expect(isDone(['$DONE'])).toBe(true);
    expect(isDone({ $done: false })).toBe(false);
    expect(keywordList(null)).toEqual([]);
  });

  it('assigns to one person at a time, replacing whoever had it', () => {
    expect(assignChanges(['$seen'], 'cj')).toEqual({ '$assigned:cj': true });
    expect(assignChanges(['$assigned:ci'], 'cj')).toEqual({ '$assigned:ci': false, '$assigned:cj': true });
    // Two at once (two clients raced): both others go.
    expect(assignChanges(['$assigned:ci', '$assigned:ck', '$assigned:cj'], 'cj')).toEqual({ '$assigned:ci': false, '$assigned:ck': false });
    expect(assignChanges(['$assigned:cj'], 'cj')).toEqual({});
  });

  it('unassigns everyone', () => {
    expect(unassignChanges(['$assigned:ci', '$assigned:cj', '$seen'])).toEqual({ '$assigned:ci': false, '$assigned:cj': false });
    expect(unassignChanges(['$seen'])).toEqual({});
    expect(assigneesOf(['$assigned:ci', '$assigned:', '$seen'])).toEqual(['ci']);
  });

  it('marks done and reopens, without touching $seen', () => {
    expect(doneChanges(['$seen'])).toEqual({ $done: true });
    expect(doneChanges(['$done'])).toEqual({});
    expect(reopenChanges(['$done', '$seen'])).toEqual({ $done: false });
    expect(reopenChanges([])).toEqual({});
  });

  it('lists recent assignees, most often first, without the user', () => {
    const seen = new Map([['ck', 1], ['cj', 3], ['ci', 5]]);
    expect(recentAssignees(seen, { exclude: ['ci'] })).toEqual(['cj', 'ck']);
    expect(recentAssignees(seen, { limit: 1 })).toEqual(['ci']);
  });
});
