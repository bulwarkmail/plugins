// Inflate (RFC 1951) for the compressed streams in a PDF. The browser's
// DecompressionStream rejects data that has bytes after the end of the
// compressed stream, which PDFs with a sloppy /Length have, and Node's
// zlib accepts them; this one stops at the last block in both places.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const FAST_BITS = 9;
const FAST_MASK = (1 << FAST_BITS) - 1;

/**
 * A canonical Huffman code from code lengths: counts per length and symbols
 * in code order for the slow path, and a table of the codes up to 9 bits
 * (indexed by the next 9 input bits) for the fast one.
 */
function huffman(lengths) {
  const counts = new Uint16Array(16);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offsets[lengths[s]]++] = s;

  const next = new Uint16Array(16);
  for (let len = 1, code = 0; len < 16; len++) {
    code = (code + counts[len - 1]) << 1;
    next[len] = code;
  }
  const fast = new Int32Array(1 << FAST_BITS);
  for (let s = 0; s < lengths.length; s++) {
    const len = lengths[s];
    if (!len) continue;
    const code = next[len]++;
    if (len > FAST_BITS) continue;
    // Deflate sends codes most significant bit first; the bit buffer is LSB first.
    let reversed = 0;
    for (let i = 0; i < len; i++) reversed |= ((code >> i) & 1) << (len - 1 - i);
    for (let k = reversed; k <= FAST_MASK; k += 1 << len) fast[k] = (len << 16) | s;
  }
  return { counts, symbols, fast };
}

let FIXED = null;
function fixedTables() {
  if (!FIXED) {
    const lit = new Uint8Array(288);
    lit.fill(8, 0, 144); lit.fill(9, 144, 256); lit.fill(7, 256, 280); lit.fill(8, 280, 288);
    FIXED = { lit: huffman(lit), dist: huffman(new Uint8Array(30).fill(5)) };
  }
  return FIXED;
}

/**
 * Inflate raw deflate data. `maxOutput` stops a decompression bomb.
 * Throws on corrupt data; ignores whatever follows the final block.
 */
export function inflateRaw(input, maxOutput = 64 * 1024 * 1024) {
  let pos = 0;
  let bitBuf = 0;
  let bitCount = 0;
  let out = new Uint8Array(Math.min(Math.max(input.length * 4, 1024), maxOutput));
  let outLen = 0;

  const bits = (n) => {
    while (bitCount < n) {
      if (pos >= input.length) throw new Error('inflate: unexpected end of data');
      bitBuf |= input[pos++] << bitCount;
      bitCount += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return v;
  };
  const decode = ({ counts, symbols, fast }) => {
    while (bitCount < FAST_BITS && pos < input.length) {
      bitBuf |= input[pos++] << bitCount;
      bitCount += 8;
    }
    const entry = fast[bitBuf & FAST_MASK];
    if (entry && entry >>> 16 <= bitCount) {
      const len = entry >>> 16;
      bitBuf >>>= len;
      bitCount -= len;
      return entry & 0xffff;
    }
    let code = 0; let first = 0; let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = counts[len];
      if (code - first < count) return symbols[index + code - first];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('inflate: bad code');
  };
  const ensure = (extra) => {
    if (outLen + extra <= out.length) return;
    if (outLen + extra > maxOutput) throw new Error('inflate: output too large');
    const next = new Uint8Array(Math.min(Math.max(out.length * 2, outLen + extra), maxOutput));
    next.set(out.subarray(0, outLen));
    out = next;
  };

  let final = 0;
  while (!final) {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCount = 0;
      if (pos + 4 > input.length) throw new Error('inflate: unexpected end of data');
      const len = input[pos] | (input[pos + 1] << 8);
      const nlen = input[pos + 2] | (input[pos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error('inflate: bad stored block');
      pos += 4;
      if (pos + len > input.length) throw new Error('inflate: unexpected end of data');
      ensure(len);
      out.set(input.subarray(pos, pos + len), outLen);
      outLen += len; pos += len;
      continue;
    }
    let lit; let dist;
    if (type === 1) {
      ({ lit, dist } = fixedTables());
    } else if (type === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const clens = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) clens[CLEN_ORDER[i]] = bits(3);
      const clen = huffman(clens);
      const lengths = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        const sym = decode(clen);
        if (sym < 16) { lengths[i++] = sym; continue; }
        let repeat; let value = 0;
        if (sym === 16) {
          if (i === 0) throw new Error('inflate: bad lengths');
          value = lengths[i - 1]; repeat = 3 + bits(2);
        } else if (sym === 17) repeat = 3 + bits(3);
        else repeat = 11 + bits(7);
        if (i + repeat > lengths.length) throw new Error('inflate: bad lengths');
        lengths.fill(value, i, i + repeat);
        i += repeat;
      }
      lit = huffman(lengths.subarray(0, hlit));
      dist = huffman(lengths.subarray(hlit));
    } else {
      throw new Error('inflate: bad block type');
    }
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        ensure(1);
        out[outLen++] = sym;
      } else if (sym === 256) {
        break;
      } else {
        const li = sym - 257;
        if (li >= 29) throw new Error('inflate: bad length');
        const length = LENGTH_BASE[li] + bits(LENGTH_EXTRA[li]);
        const di = decode(dist);
        if (di >= 30) throw new Error('inflate: bad distance');
        const distance = DIST_BASE[di] + bits(DIST_EXTRA[di]);
        if (distance > outLen) throw new Error('inflate: distance too far back');
        ensure(length);
        for (let k = 0; k < length; k++, outLen++) out[outLen] = out[outLen - distance];
      }
    }
  }
  return out.slice(0, outLen);
}

/** Inflate zlib-wrapped data (what /FlateDecode holds); raw deflate too. */
export function inflate(input, maxOutput) {
  const zlib = input.length > 2 && (input[0] & 0x0f) === 8 && ((input[0] << 8) | input[1]) % 31 === 0;
  return inflateRaw(zlib ? input.subarray(2) : input, maxOutput);
}
