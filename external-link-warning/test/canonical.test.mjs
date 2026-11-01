// Google's own canonicalisation and expression examples
// (https://developers.google.com/safe-browsing/reference/URLs.and.Hashing).
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalize, canonicalizeHref, expressions, normaliseIpv4, normaliseIpv6 } from '../src/lib/canonical.js';
import { latin1Bytes, sha256, toBase64, fromBase64 } from '../src/lib/sha256.js';

const GOOGLE_EXAMPLES = [
  ['http://host/%25%32%35', 'http://host/%25'],
  ['http://host/%25%32%35%25%32%35', 'http://host/%25%25'],
  ['http://host/%2525252525252525', 'http://host/%25'],
  ['http://host/asdf%25%32%35asd', 'http://host/asdf%25asd'],
  ['http://host/%%%25%32%35asd%%', 'http://host/%25%25%25asd%25%25'],
  ['http://www.google.com/', 'http://www.google.com/'],
  ['http://%31%36%38%2e%31%38%38%2e%39%39%2e%32%36/%2E%73%65%63%75%72%65/%77%77%77%2E%65%62%61%79%2E%63%6F%6D/', 'http://168.188.99.26/.secure/www.ebay.com/'],
  ['http://195.127.0.11/uploads/%20%20%20%20/.verify/.eBaysecure=updateuserdataxplimnbqmn-xplmvalidateinfoswqpcmlx=hgplmcx/', 'http://195.127.0.11/uploads/%20%20%20%20/.verify/.eBaysecure=updateuserdataxplimnbqmn-xplmvalidateinfoswqpcmlx=hgplmcx/'],
  ['http://host%23.com/%257Ea%2521b%2540c%2523d%2524e%25f%255E00%252611%252A22%252833%252944_55%252B', 'http://host%23.com/~a!b@c%23d$e%25f^00&11*22(33)44_55+'],
  ['http://3279880203/blah', 'http://195.127.0.11/blah'],
  ['http://www.google.com/blah/..', 'http://www.google.com/'],
  ['www.google.com/', 'http://www.google.com/'],
  ['www.google.com', 'http://www.google.com/'],
  ['http://www.evil.com/blah#frag', 'http://www.evil.com/blah'],
  ['http://www.GOOgle.com/', 'http://www.google.com/'],
  ['http://www.google.com.../', 'http://www.google.com/'],
  ['http://www.google.com/foo\tbar\rbaz\n2', 'http://www.google.com/foobarbaz2'],
  ['http://www.google.com/q?', 'http://www.google.com/q?'],
  ['http://www.google.com/q?r?', 'http://www.google.com/q?r?'],
  ['http://www.google.com/q?r?s', 'http://www.google.com/q?r?s'],
  ['http://evil.com/foo#bar#baz', 'http://evil.com/foo'],
  ['http://evil.com/foo;', 'http://evil.com/foo;'],
  ['http://evil.com/foo?bar;', 'http://evil.com/foo?bar;'],
  ['http://\x01\x80.com/', 'http://%01%80.com/'],
  ['http://notrailingslash.com', 'http://notrailingslash.com/'],
  ['http://www.gotaport.com:1234/', 'http://www.gotaport.com/'],
  ['  http://www.google.com/  ', 'http://www.google.com/'],
  ['http:// leadingspace.com/', 'http://%20leadingspace.com/'],
  ['http://%20leadingspace.com/', 'http://%20leadingspace.com/'],
  ['%20leadingspace.com/', 'http://%20leadingspace.com/'],
  ['https://www.securesite.com/', 'https://www.securesite.com/'],
  ['http://host.com/ab%23cd', 'http://host.com/ab%23cd'],
  ['http://host.com//twoslashes?more//slashes', 'http://host.com/twoslashes?more//slashes'],
];

describe('canonicalize', () => {
  it.each(GOOGLE_EXAMPLES)('%j', (input, expected) => {
    expect(canonicalize(input).url).toBe(expected);
  });

  it('drops user info and keeps IPv6 hosts in their short form', () => {
    expect(canonicalize('https://user:pw@Example.COM./a').url).toBe('https://example.com/a');
    expect(canonicalize('http://[2001:0DB8:0000:0000:0000:0000:0000:0001]:8080/x').url).toBe('http://[2001:db8::1]/x');
  });

  it('encodes characters beyond Latin-1 as UTF-8 bytes', () => {
    expect(canonicalize('http://example.com/€').url).toBe('http://example.com/%E2%82%AC');
    expect(canonicalize('http://example.com/%E2%82%AC').url).toBe('http://example.com/%E2%82%AC');
  });

  it('has no host for an empty input', () => {
    expect(canonicalize('')).toBeNull();
  });
});

// What is checked must be what the browser opens. Browsers parse links with
// the WHATWG URL parser, which reads some addresses differently from
// Google's rules alone.
describe('canonicalizeHref: the address the browser opens', () => {
  it('still gives Google\'s results for all of Google\'s examples', () => {
    for (const [input, expected] of GOOGLE_EXAMPLES) expect(canonicalizeHref(input).url, input).toBe(expected);
  });

  it('takes a backslash as the path separator browsers make of it', () => {
    const link = 'http://evil.example\\@good.example/login';
    expect(canonicalizeHref(link).host).toBe('evil.example');
    expect(expressions(link)[0]).toBe('evil.example/@good.example/login');
    expect(expressions(link).some((e) => e.startsWith('good.example'))).toBe(false);
  });

  it('drops user info the way the browser does', () => {
    expect(canonicalizeHref('https://good.example:pw@evil.example/x').host).toBe('evil.example');
    expect(expressions('https://good.example@evil.example/x')[0]).toBe('evil.example/x');
  });

  it('hashes an international domain in its punycode form', () => {
    expect(canonicalizeHref('https://bücher.example/a').host).toBe('xn--bcher-kva.example');
    expect(expressions('https://BÜCHER.example/a')[0]).toBe('xn--bcher-kva.example/a');
  });

  it('reads full-width dots as dots', () => {
    expect(canonicalizeHref('http://www\uFF0Eevil\uFF0Eexample/').host).toBe('www.evil.example');
    expect(expressions('http://www\u3002evil\uFF0Eexample/x')).toContain('evil.example/x');
  });
});

describe('IP forms', () => {
  it('reads every IPv4 form inet_aton takes', () => {
    expect(normaliseIpv4('3279880203')).toBe('195.127.0.11');
    expect(normaliseIpv4('0xC3.0177.0.11')).toBe('195.127.0.11');
    expect(normaliseIpv4('195.8323083')).toBe('195.127.0.11');
    expect(normaliseIpv4('1.2.3.256')).toBeNull();
    expect(normaliseIpv4('example.com')).toBeNull();
  });

  it('compresses IPv6', () => {
    expect(normaliseIpv6('[::ffff:1.2.3.4]')).toBe('[::ffff:102:304]');
    expect(normaliseIpv6('[1:0:0:2:0:0:0:3]')).toBe('[1:0:0:2::3]');
    expect(normaliseIpv6('[not-v6]')).toBeNull();
  });
});

describe('expressions', () => {
  it('combines host suffixes and path prefixes as in Google\'s examples', () => {
    expect(expressions('http://a.b.com/1/2.html?param=1')).toEqual([
      'a.b.com/1/2.html?param=1', 'a.b.com/1/2.html', 'a.b.com/', 'a.b.com/1/',
      'b.com/1/2.html?param=1', 'b.com/1/2.html', 'b.com/', 'b.com/1/',
    ]);
    expect(expressions('http://a.b.c.d.e.f.com/1.html')).toEqual([
      'a.b.c.d.e.f.com/1.html', 'a.b.c.d.e.f.com/',
      'c.d.e.f.com/1.html', 'c.d.e.f.com/',
      'd.e.f.com/1.html', 'd.e.f.com/',
      'e.f.com/1.html', 'e.f.com/',
      'f.com/1.html', 'f.com/',
    ]);
    expect(expressions('http://1.2.3.4/1/')).toEqual(['1.2.3.4/1/', '1.2.3.4/']);
    expect(expressions('http://example.co.uk/')).toEqual(['example.co.uk/', 'co.uk/']);
  });

  it('stops at 30 for a long link', () => {
    const list = expressions('http://a.b.c.d.e.f.g.h.example.com/1/2/3/4/5/6/7.html?q=1');
    expect(list.length).toBe(30);
    expect(list[0]).toBe('a.b.c.d.e.f.g.h.example.com/1/2/3/4/5/6/7.html?q=1');
  });
});

describe('sha256 and base64', () => {
  it('matches node:crypto', () => {
    for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'malware.testing.google.test/testing/malware/', 'x'.repeat(1000)]) {
      const expected = createHash('sha256').update(text).digest('base64');
      expect(toBase64(sha256(latin1Bytes(text)))).toBe(expected);
    }
  });

  it('reads base64 back, URL-safe too', () => {
    const bytes = new Uint8Array([0, 251, 255, 1, 2]);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
    expect([...fromBase64('-_8')]).toEqual([251, 255]);
    expect(fromBase64('not base64!')).toBeNull();
  });
});
