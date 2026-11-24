// multipart/form-data bodies built by hand: the proxy takes bytes, not FormData.

function quote(value) {
  // Quotes and line breaks would end the header.
  return String(value).replace(/[\r\n]+/g, ' ').replace(/(["\\])/g, '\\$1');
}

function randomBoundary() {
  let out = '----BulwarkImmich';
  for (let i = 0; i < 24; i++) out += Math.floor(Math.random() * 36).toString(36);
  return out;
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextEncoder().encode(String(data));
}

/**
 * @param {Array<[string, string|number|{ filename: string, type?: string, data: Uint8Array|ArrayBuffer }]>} fields
 * @returns {{ body: Uint8Array, contentType: string }}
 */
export function buildMultipart(fields, boundary = randomBoundary()) {
  const enc = new TextEncoder();
  const chunks = [];
  for (const [name, value] of fields) {
    if (value === undefined || value === null) continue;
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"`;
    if (typeof value === 'object' && 'data' in value) {
      head += `; filename="${quote(value.filename || 'file')}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`;
      chunks.push(enc.encode(head), toBytes(value.data), enc.encode('\r\n'));
    } else {
      head += '\r\n\r\n';
      chunks.push(enc.encode(head), enc.encode(String(value)), enc.encode('\r\n'));
    }
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const size = chunks.reduce((n, c) => n + c.byteLength, 0);
  const body = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { body.set(c, offset); offset += c.byteLength; }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
