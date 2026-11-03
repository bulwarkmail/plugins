// What api.keystore does in the desktop app, backed by Node crypto with real keys.
// It keeps the native helper's rules (repos/desktop/native/README.md): errors are
// bare codes, SHA-1 signatures are refused, digests must fit the hash, v1.5 answers
// only 16, 24 or 32 bytes, OAEP at most 64, and every failed unwrap reads the same.
//
//   const ks = fakeKeystore([{ certificate: pem, key: pem }]);
//   fakeApi({ hostFeatures: { keystore: true }, handlers: ks.handlers });
//   ks.calls.sign, ks.refuse('sign', 'keystore:cancelled')
import {
  constants, createHash, createPrivateKey, createPublicKey, diffieHellman, privateDecrypt, privateEncrypt, randomBytes, X509Certificate,
} from 'node:crypto';
import elliptic from 'elliptic';

const HASH_LENGTH = { 'SHA-1': 20, 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 };
const NODE_HASH = { 'SHA-1': 'sha1', 'SHA-256': 'sha256', 'SHA-384': 'sha384', 'SHA-512': 'sha512' };
const DIGEST_INFO = {
  'SHA-256': '3031300d060960864801650304020105000420',
  'SHA-384': '3041300d060960864801650304020205000430',
  'SHA-512': '3051300d060960864801650304020305000440',
};
const CURVES = { 'P-256': 'p256', 'P-384': 'p384', 'P-521': 'p521' };

function mgf1(seed, length, hash) {
  const out = [];
  for (let counter = 0; Buffer.concat(out).length < length; counter++) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    out.push(createHash(hash).update(seed).update(c).digest());
  }
  return Buffer.concat(out).subarray(0, length);
}

// Node signs a message, not a digest, so PSS over a digest is put together by hand (RFC 8017 §9.1.1).
function pssEncode(digest, hash, modulusBits) {
  const emBits = modulusBits - 1;
  const emLen = Math.ceil(emBits / 8);
  const salt = randomBytes(digest.length);
  const h = createHash(hash).update(Buffer.alloc(8)).update(digest).update(salt).digest();
  const db = Buffer.concat([Buffer.alloc(emLen - salt.length - h.length - 2), Buffer.from([1]), salt]);
  const masked = Buffer.from(db.map((b, i) => b ^ mgf1(h, db.length, hash)[i]));
  masked[0] &= 0xff >> (8 * emLen - emBits);
  return Buffer.concat([masked, h, Buffer.from([0xbc])]);
}

function pkcs1Unpad(block) {
  const at = block.indexOf(0, 2);
  if (block[0] !== 0 || block[1] !== 2 || at < 10) throw new Error('bad padding');
  return block.subarray(at + 1);
}

function entryFor({ certificate, key, chain = [], source = 'software', signSchemes, decryptSchemes, canAgree }) {
  const x509 = new X509Certificate(certificate);
  const privateKey = createPrivateKey(key);
  const isEc = privateKey.asymmetricKeyType === 'ec';
  const curve = isEc ? { prime256v1: 'P-256', secp384r1: 'P-384', secp521r1: 'P-521' }[privateKey.asymmetricKeyDetails.namedCurve] : undefined;
  return {
    privateKey,
    curve,
    wire: {
      id: createHash('sha256').update(x509.raw).digest('hex'),
      certificate: new Uint8Array(x509.raw),
      chain: chain.map((der) => new Uint8Array(der)),
      subject: x509.subject,
      issuer: x509.issuer,
      serial: x509.serialNumber,
      notBefore: new Date(x509.validFrom).getTime(),
      notAfter: new Date(x509.validTo).getTime(),
      usages: [],
      extendedUsages: [],
      algorithm: isEc ? '1.2.840.10045.2.1' : '1.2.840.113549.1.1.1',
      keyType: isEc ? 'ec' : 'rsa',
      ...(curve ? { curve } : {}),
      keyBits: isEc ? 0 : privateKey.asymmetricKeyDetails.modulusLength,
      source,
      signSchemes: signSchemes ?? (isEc ? ['ecdsa'] : ['rsa-pkcs1', 'rsa-pss']),
      decryptSchemes: decryptSchemes ?? (isEc ? [] : ['rsa-pkcs1', 'rsa-oaep']),
      canAgree: canAgree ?? isEc,
      askEachUse: false,
    },
  };
}

export function fakeKeystore(specs) {
  const entries = specs.map(entryFor);
  const calls = { list: [], sign: [], decrypt: [], agree: [] };
  const refusals = {};
  const entry = (id) => {
    const found = entries.find((e) => e.wire.id === id);
    if (!found) throw new Error('keystore:not-found');
    return found;
  };
  // Refuse a method from now on, with this code or by running this function.
  const gate = (method) => {
    const refusal = refusals[method];
    if (typeof refusal === 'string') throw new Error(refusal);
    return refusal?.();
  };

  const api = {
    list: async () => {
      calls.list.push([]);
      await gate('list');
      return entries.map((e) => e.wire);
    },
    sign: async (id, digest, { scheme, hash }) => {
      calls.sign.push({ id, digest, scheme: { scheme, hash } });
      await gate('sign');
      const { privateKey, curve, wire } = entry(id);
      if (hash === 'SHA-1') throw new Error('keystore:unsupported');
      if (digest.length !== HASH_LENGTH[hash]) throw new Error('keystore:invalid');
      if (!wire.signSchemes.includes(scheme)) throw new Error('keystore:unsupported');
      if (scheme === 'rsa-pkcs1') {
        const info = Buffer.concat([Buffer.from(DIGEST_INFO[hash], 'hex'), digest]);
        return new Uint8Array(privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, info));
      }
      if (scheme === 'rsa-pss') {
        const encoded = pssEncode(Buffer.from(digest), NODE_HASH[hash], wire.keyBits);
        return new Uint8Array(privateEncrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, encoded));
      }
      // As the helper answers: an ASN.1 DER ECDSA-Sig-Value.
      const d = privateKey.export({ format: 'jwk' }).d;
      const ec = new elliptic.ec(CURVES[curve]);
      return new Uint8Array(ec.keyFromPrivate(Buffer.from(d, 'base64url')).sign(Buffer.from(digest)).toDER());
    },
    decrypt: async (id, data, scheme) => {
      calls.decrypt.push({ id, data, scheme });
      await gate('decrypt');
      const { privateKey } = entry(id);
      let plain;
      try {
        if (scheme.scheme === 'rsa-oaep') {
          plain = privateDecrypt({
            key: privateKey,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: NODE_HASH[scheme.hash],
            ...(scheme.label ? { oaepLabel: scheme.label } : {}),
          }, data);
          if (plain.length > 64) throw new Error('too long');
        } else {
          plain = pkcs1Unpad(privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, data));
          if (![16, 24, 32].includes(plain.length)) throw new Error('wrong size');
        }
      } catch {
        throw new Error('keystore:failed');
      }
      return new Uint8Array(plain);
    },
    agree: async (id, peerSpki) => {
      calls.agree.push({ id, peerSpki });
      await gate('agree');
      const { privateKey, wire } = entry(id);
      if (!wire.canAgree) throw new Error('keystore:unsupported');
      const publicKey = createPublicKey({ key: Buffer.from(peerSpki), format: 'der', type: 'spki' });
      return new Uint8Array(diffieHellman({ privateKey, publicKey }));
    },
  };

  const handlers = Object.fromEntries(Object.entries(api).map(([name, fn]) => [`keystore.${name}`, fn]));
  return {
    api,
    handlers,
    calls,
    id: (index = 0) => entries[index].wire.id,
    refuse: (method, refusal) => { refusals[method] = refusal; },
    allow: (method) => { delete refusals[method]; },
  };
}
