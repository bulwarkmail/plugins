import { describe, expect, it } from 'vitest';
import {
  MAX_SHARED_PEOPLE, findByEmail, looksLikeAddress, mergeShared, readShared, shortName, writeShared,
} from '../src/lib/names.js';

describe('the shared name map', () => {
  it('reads what it wrote, and nothing else', () => {
    const people = { cj: { name: 'Org Bob', email: 'org-bob@example.org' } };
    expect(readShared(writeShared(people))).toEqual(people);
    expect(readShared(null)).toEqual({});
    expect(readShared({ people: { 'a b': { n: 'X' }, ok: { n: '\u0007Eve', e: 'EVE@EXAMPLE.ORG' }, empty: {} } }))
      .toEqual({ ok: { name: 'Eve', email: 'eve@example.org' } });
  });

  it('says when merging changes nothing, so the map isn\'t written again', () => {
    const map = { cj: { name: 'Org Bob', email: 'org-bob@example.org' } };
    expect(mergeShared(map, { cj: { name: 'Org Bob', email: 'org-bob@example.org' } })).toBeNull();
    expect(mergeShared(map, { ck: { name: 'Carol', email: 'carol@example.org' } })).toEqual({
      ...map, ck: { name: 'Carol', email: 'carol@example.org' },
    });
  });

  it('keeps the newest people when there are too many for 8 KB', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_SHARED_PEOPLE + 5 }, (_, i) => [`p${i}`, { name: `Person ${i}`, email: `p${i}@example.org` }]));
    const value = writeShared(many);
    expect(Object.keys(value.people)).toHaveLength(MAX_SHARED_PEOPLE);
    expect(value.people.p0).toBeUndefined();
    expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThan(8192);
  });
});

describe('names on badges and in the dialog', () => {
  it('shows a first name, or the local part of an address', () => {
    expect(shortName({ name: 'Org Bob', email: 'org-bob@example.org' })).toBe('Org');
    expect(shortName({ name: 'org-bob@example.org', email: '' })).toBe('org-bob');
    expect(shortName(null)).toBe('');
  });

  it('finds a person by address and checks typed addresses', () => {
    expect(findByEmail({ cj: { name: 'Bob', email: 'bob@example.org' } }, ' BOB@example.org ')).toEqual({ id: 'cj', name: 'Bob', email: 'bob@example.org' });
    expect(findByEmail({}, 'x@y.z')).toBeNull();
    expect(looksLikeAddress('bob@example.org')).toBe(true);
    expect(looksLikeAddress('bob')).toBe(false);
  });
});
