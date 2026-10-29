import { describe, expect, it } from 'vitest';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { inflate, inflateRaw } from '../src/lib/inflate.js';

// toEqual on large byte arrays takes seconds; compare the bytes instead.
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

function randomText(n, seed = 1) {
  let x = seed;
  const words = ['Rechnung', 'Betrag', '<ram:ID>', '</ram:ID>', 'EUR', '19.00', ' ', '\n', 'Musterlieferant', 'ä', 'ß'];
  let s = '';
  while (s.length < n) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += words[x % words.length];
  }
  return s;
}

describe('inflate', () => {
  it('reads what zlib writes, at every level', () => {
    const text = new TextEncoder().encode(randomText(200_000));
    for (const level of [0, 1, 6, 9]) {
      expect(same(inflate(new Uint8Array(deflateSync(text, { level }))), text)).toBe(true);
    }
  });

  it('reads raw deflate and binary data', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 7919) % 251);
    expect(same(inflateRaw(new Uint8Array(deflateRawSync(bytes))), bytes)).toBe(true);
    expect(same(inflate(new Uint8Array(deflateRawSync(bytes))), bytes)).toBe(true);
  });

  it('stops at the last block and ignores what follows', () => {
    const text = new TextEncoder().encode('<?xml version="1.0"?><x/>');
    const withJunk = new Uint8Array([...deflateSync(text), 13, 10, 13, 10, 0x65, 0x6e, 0x64]);
    expect(new TextDecoder().decode(inflate(withJunk))).toBe('<?xml version="1.0"?><x/>');
  });

  it('throws on cut-off or corrupt data and on too much output', () => {
    const data = new Uint8Array(deflateSync(new TextEncoder().encode(randomText(5000))));
    expect(() => inflate(data.subarray(0, data.length / 2))).toThrow(/unexpected end/);
    expect(() => inflateRaw(new Uint8Array([0xff, 0xff, 0xff]))).toThrow(/inflate/);
    const bomb = new Uint8Array(deflateSync(new Uint8Array(5_000_000)));
    expect(() => inflate(bomb, 1_000_000)).toThrow(/too large/);
  });
});
