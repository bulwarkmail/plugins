// These run on the bytes of a mail the moment it is opened, on the app's own thread.
// Their cost has to grow with the size of the input, not with its square.
//
// No millisecond bound anywhere. Two kinds of check:
// - Where the work is done by many string and pattern calls, the test counts the
//   characters those calls walk over (same count on every machine and every run) and
//   compares the count for an input with the count for one twice as long.
// - Where the work is hidden inside a single pattern call, nothing can be counted from
//   outside, so the test compares the CPU time of an input with one eight times as long.
//   Linear work gives a factor near 8, quadratic work near 64; the limit is 24.
import { describe, expect, it } from 'vitest';
import { normalizeCmsBytes } from '../src/smime-decrypt.js';
import { parseMime, extractDetachedSigned } from '../src/mime-parse.js';

const enc = new TextEncoder();

/** Characters walked by string and pattern calls while `run` executes. A refusal (throw) is fine. */
function walked(run) {
  let steps = 0;
  const S = String.prototype;
  const R = RegExp.prototype;
  const saved = { exec: R.exec, indexOf: S.indexOf, lastIndexOf: S.lastIndexOf, includes: S.includes, split: S.split };
  R.exec = function (subject) {
    const from = this.global || this.sticky ? this.lastIndex : 0;
    const m = saved.exec.call(this, subject);
    if (m) steps += 1 + m.index + m[0].length - Math.min(from, m.index);
    else steps += this.sticky ? 1 : 1 + Math.max(0, String(subject).length - from);
    return m;
  };
  S.indexOf = function (needle, from = 0) {
    const at = saved.indexOf.call(this, needle, from);
    steps += 1 + (at < 0 ? Math.max(0, this.length - from) : at - from);
    return at;
  };
  S.lastIndexOf = function (needle, from = Infinity) {
    const at = saved.lastIndexOf.call(this, needle, from);
    const start = Math.min(from, this.length);
    steps += 1 + (at < 0 ? start : start - at);
    return at;
  };
  S.includes = function (needle, from = 0) {
    steps += 1 + Math.max(0, this.length - from);
    return saved.includes.call(this, needle, from);
  };
  S.split = function (separator, limit) {
    if (typeof separator === 'string') steps += 1 + this.length;
    return saved.split.call(this, separator, limit);
  };
  try {
    run();
  } catch { /* a refusal is fine */ } finally {
    R.exec = saved.exec;
    S.indexOf = saved.indexOf;
    S.lastIndexOf = saved.lastIndexOf;
    S.includes = saved.includes;
    S.split = saved.split;
  }
  return steps;
}

/** CPU milliseconds of `run`, the better of two goes. A refusal (throw) is fine. */
function cpuMs(run) {
  let best = Infinity;
  for (let i = 0; i < 2; i++) {
    const t0 = process.cpuUsage();
    try { run(); } catch { /* a refusal is fine */ }
    const d = process.cpuUsage(t0);
    best = Math.min(best, (d.user + d.system) / 1000);
  }
  return best;
}

/** How much more CPU the long input took. Below 5 ms the small one counts as 5 ms, so noise can't blow the factor up. */
const cpuFactor = (run, small, large) => {
  const a = cpuMs(() => run(small));
  const b = cpuMs(() => run(large));
  return b / Math.max(a, 5);
};

// Boundaries have one width, so none is the beginning of another.
const boundary = (i) => `b${String(i).padStart(6, '0')}`;

function nested(depth) {
  let head = '';
  let tail = '';
  for (let i = 0; i < depth; i++) {
    head += `Content-Type: multipart/mixed; boundary=${boundary(i)}\r\n\r\n--${boundary(i)}\r\n`;
    tail = `\r\n--${boundary(i)}--\r\n` + tail;
  }
  return enc.encode(`${head}Content-Type: text/plain\r\n\r\nhi${tail}`);
}

function siblings(count) {
  let body = 'Content-Type: multipart/mixed; boundary=outer\r\n\r\n';
  for (let i = 0; i < count; i++) body += `--outer\r\nContent-Type: text/plain\r\n\r\npart ${i}\r\n`;
  return enc.encode(`${body}--outer--\r\n`);
}

describe('the MIME reader on hostile structure', () => {
  it('walks a deeply nested multipart once, not once per level', () => {
    const small = walked(() => parseMime(nested(1500)));
    const large = walked(() => parseMime(nested(3000)));
    expect(small).toBeGreaterThan(0);
    expect(large / small).toBeLessThan(3);
  });

  it('walks a multipart with many parts once (control)', () => {
    const small = walked(() => parseMime(siblings(1500)));
    const large = walked(() => parseMime(siblings(3000)));
    expect(large / small).toBeLessThan(3);
  });

  it('still reads an ordinary nested mail (control)', () => {
    const out = parseMime(nested(3));
    expect(out.text).toContain('hi');
  });
});

describe('normalizeCmsBytes on text where a CMS blob should be', () => {
  const lines = (n) => enc.encode(`x: y\n${'Content-Transfer-Encoding: base64 !\n'.repeat(n)}`).buffer;
  const headersOnly = (n) => enc.encode(`${'Content-Type: application/pkcs7-mime\nContent-Transfer-Encoding: base64\nX-Pad: 1\n'.repeat(n)}`).buffer;

  it('grows linearly on "Content-Transfer-Encoding: base64" lines with no body after them', { timeout: 120_000 }, () => {
    expect(cpuFactor(normalizeCmsBytes, lines(2500), lines(20000))).toBeLessThan(24);
  });

  it('grows linearly on repeated header blocks that never end in an empty line', { timeout: 120_000 }, () => {
    expect(cpuFactor(normalizeCmsBytes, headersOnly(1200), headersOnly(9600))).toBeLessThan(24);
  });

  it('still unwraps a base64 body after MIME headers (control)', () => {
    const der = new Uint8Array(300).fill(7);
    der[0] = 0x30;
    const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\r\n');
    const out = new Uint8Array(normalizeCmsBytes(enc.encode(`Content-Type: application/pkcs7-mime\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n`).buffer));
    expect(out[0]).toBe(0x30);
    expect(out.length).toBe(300);
  });
});

describe('what the MIME reader and normalizeCmsBytes read', () => {
  const part = (headers, body) => `${headers.join('\r\n')}\r\n\r\n${body}`;
  const der = new Uint8Array(300).fill(7);
  der[0] = 0x30;
  const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\r\n');

  it('splits at whole delimiter lines, not at a longer boundary that begins the same way', () => {
    const out = parseMime(enc.encode([
      'Content-Type: multipart/mixed; boundary=b1', '',
      '--b1', 'Content-Type: multipart/alternative; boundary=b10', '',
      '--b10', 'Content-Type: text/plain', '', 'plain',
      '--b10', 'Content-Type: text/html', '', '<p>html</p>',
      '--b10--',
      '--b1', 'Content-Type: text/plain; name="notes.txt"', 'Content-Disposition: attachment; filename="notes.txt"', '', 'attached',
      '--b1--', '',
    ].join('\r\n')));
    expect(out).toMatchObject({ text: 'plain', html: '<p>html</p>' });
    expect(out.attachments.map((a) => [a.name, a.size])).toEqual([['notes.txt', 8]]);
  });

  it('reads a multipart whose closing delimiter is missing (control)', () => {
    const out = parseMime(enc.encode(part(['Content-Type: multipart/mixed; boundary=b'], [
      '--b', 'Content-Type: text/plain', '', 'first',
      '--b', 'Content-Type: text/plain; name="x.txt"', 'Content-Disposition: attachment; filename="x.txt"', '', 'second', '',
    ].join('\r\n'))));
    expect(out.text).toBe('first');
    expect(out.attachments.map((a) => [a.name, a.size])).toEqual([['x.txt', 6]]);
  });

  it('reads 32 levels of nesting and keeps the 33rd level whole, as one opaque part', () => {
    expect(parseMime(nested(32))).toMatchObject({ text: 'hi', attachments: [] });
    const deep = parseMime(nested(33));
    expect(deep.attachments.map((a) => a.type)).toEqual(['multipart/mixed']);
  });

  it('refuses what is neither DER nor one base64 block', () => {
    const multipart = part(['Content-Type: multipart/mixed; boundary=b'], [
      '--b', 'Content-Type: text/plain', '', 'hello',
      '--b', 'Content-Type: application/pkcs7-mime', 'Content-Transfer-Encoding: base64', '', b64,
      '--b--', '',
    ].join('\r\n'));
    expect(() => normalizeCmsBytes(enc.encode(multipart).buffer)).toThrow();
    const withFooter = part(['Content-Type: application/pkcs7-mime', 'Content-Transfer-Encoding: base64'], `${b64}\r\n-- \r\nSent from a mailing list\r\n`);
    expect(() => normalizeCmsBytes(enc.encode(withFooter).buffer)).toThrow();
  });

  it('still unwraps PEM, and a base64 body after long MIME headers (control)', () => {
    const pem = `-----BEGIN PKCS7-----\r\n${b64}\r\n-----END PKCS7-----\r\n`;
    expect(new Uint8Array(normalizeCmsBytes(enc.encode(pem).buffer)).length).toBe(300);
    const received = Array.from({ length: 200 }, (_, i) => `Received: from relay${i}.example.org by mx.example.org; Tue, 1 Jan 2030 00:00:00 +0000`);
    const message = part([...received, 'Content-Type: application/pkcs7-mime; smime-type=enveloped-data', 'Content-Transfer-Encoding: base64'], b64);
    expect(message.indexOf('Content-Type')).toBeGreaterThan(8192);
    expect(new Uint8Array(normalizeCmsBytes(enc.encode(message).buffer)).length).toBe(300);
  });
});

describe('the strings the MIME reader builds from a large mail', () => {
  /** How often `run` calls String.fromCharCode. */
  function fromCharCodeCalls(run) {
    const saved = String.fromCharCode;
    let calls = 0;
    String.fromCharCode = function (...codes) {
      calls++;
      return saved.apply(String, codes);
    };
    try {
      run();
    } finally {
      String.fromCharCode = saved;
    }
    return calls;
  }

  it('are built in chunks, not one character at a time', () => {
    const size = 1 << 20;
    const mail = enc.encode('Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n'
      + `--b\r\nContent-Type: application/octet-stream; name="a.bin"\r\nContent-Disposition: attachment; filename="a.bin"\r\n\r\n${'x'.repeat(size)}\r\n--b--\r\n`);
    let out;
    const calls = fromCharCodeCalls(() => {
      out = parseMime(mail);
      extractDetachedSigned(mail);
    });
    expect(out.text).toBe('hello');
    expect(out.attachments.map((a) => [a.name, a.size])).toEqual([['a.bin', size]]);
    expect(atob(out.attachments[0].dataUrl.split(',')[1])).toBe('x'.repeat(size));
    expect(calls).toBeLessThan(size / 1000);
  });
});
