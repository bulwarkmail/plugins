// JMAP access for the assistant's end-to-end tests: seed mail by Email/import
// (no SMTP) and read what an action changed. Accounts and the server come from
// the environment, so the tests run against any Stalwart:
//
//   BULWARK_JMAP_URL     the JMAP server, e.g. https://stalwart-1.internal.bulwarkmail.org
//                        (default: the Docker test-env at http://localhost:18025)
//   BULWARK_USER         the assistant's user (default alice@example.org)
//   BULWARK_PASSWORD     their password (default test-pass-123)
//   BULWARK_PEER_USER    a second account on the same server, e.g. the organiser
//                        of an invitation (default bob@example.org); same password
//
// Nothing here prints a password.

export const JMAP_URL = (process.env.BULWARK_JMAP_URL || 'http://localhost:18025').replace(/\/+$/, '');
export const USER = process.env.BULWARK_USER || 'alice@example.org';
export const PEER = process.env.BULWARK_PEER_USER || 'bob@example.org';
const PASSWORD = process.env.BULWARK_PASSWORD || 'test-pass-123';

const MAIL = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
const clients = new Map();

/** A small JMAP client for `user` (cached per user). */
export async function jmap(user = USER) {
  if (clients.has(user)) return clients.get(user);
  const auth = `Basic ${Buffer.from(`${user}:${PASSWORD}`).toString('base64')}`;
  const res = await fetch(`${JMAP_URL}/jmap/session`, { headers: { authorization: auth } });
  if (!res.ok) throw new Error(`JMAP session for ${user}: HTTP ${res.status}`);
  const session = await res.json();
  const abs = (u) => (u.startsWith('http') ? u : JMAP_URL + u);
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
  const client = {
    user,
    session,
    accountId,
    async call(methodCalls, using = MAIL) {
      const r = await fetch(abs(session.apiUrl), {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        // Each call gets an id when it has none ([name, args] -> [name, args, 'c<i>']).
        body: JSON.stringify({ using, methodCalls: methodCalls.map((m, i) => (m.length > 2 ? m : [...m, `c${i}`])) }),
      });
      if (!r.ok) throw new Error(`JMAP ${methodCalls.map((m) => m[0]).join(', ')}: HTTP ${r.status} ${await r.text()}`);
      return (await r.json()).methodResponses;
    },
    async upload(bytes, type) {
      const r = await fetch(abs(session.uploadUrl).replace('{accountId}', accountId), {
        method: 'POST', headers: { authorization: auth, 'content-type': type }, body: bytes,
      });
      if (!r.ok) throw new Error(`JMAP upload: HTTP ${r.status}`);
      return (await r.json()).blobId;
    },
  };
  clients.set(user, client);
  return client;
}

/** Whether the run's accounts exist (a 200 for each session). Never polls. */
export async function checkAccounts(users = [USER, PEER]) {
  const out = {};
  for (const user of users) {
    const auth = `Basic ${Buffer.from(`${user}:${PASSWORD}`).toString('base64')}`;
    try {
      out[user] = (await fetch(`${JMAP_URL}/jmap/session`, { headers: { authorization: auth } })).status;
    } catch (err) {
      out[user] = `unreachable (${err.message})`;
    }
  }
  return out;
}

/** The id of the mailbox with `role` (inbox, sent, archive, ...). */
export async function mailboxId(client, role) {
  const [[, res]] = await client.call([['Mailbox/get', { accountId: client.accountId, properties: ['id', 'role', 'name'] }]]);
  const box = res.list.find((m) => m.role === role);
  if (!box) throw new Error(`no ${role} mailbox for ${client.user}`);
  return box.id;
}

const b64 = (s) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');

/**
 * A raw message. `attachments`: [{ name, type, data: Buffer, cid? }]; with
 * `html`, a text/html alternative (cid images become related parts).
 */
export function rawMessage({ messageId, from, to, subject, date = new Date(), text, html, attachments = [], inReplyTo, references, headers = {} }) {
  const head = [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${new Date(date).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${messageId}>`, 'MIME-Version: 1.0',
    ...(inReplyTo ? [`In-Reply-To: <${inReplyTo}>`] : []),
    ...(references?.length ? [`References: ${references.map((r) => `<${r}>`).join(' ')}`] : []),
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  const textPart = `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(text ?? '')}`;
  let body = textPart;
  if (html) {
    const alt = `alt-${messageId}`;
    const htmlPart = `Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(html)}`;
    body = `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n--${alt}\r\n${textPart}\r\n--${alt}\r\n${htmlPart}\r\n--${alt}--`;
    const inline = attachments.filter((a) => a.cid);
    if (inline.length) {
      const rel = `rel-${messageId}`;
      body = `Content-Type: multipart/related; boundary="${rel}"\r\n\r\n--${rel}\r\n${body}\r\n`
        + inline.map((a) => `--${rel}\r\nContent-Type: ${a.type}; name="${a.name}"\r\nContent-ID: <${a.cid}>\r\nContent-Disposition: inline; filename="${a.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${a.data.toString('base64').replace(/.{76}/g, '$&\r\n')}\r\n`).join('')
        + `--${rel}--`;
    }
  }
  const files = attachments.filter((a) => !a.cid);
  if (files.length) {
    const mix = `mix-${messageId}`;
    body = `Content-Type: multipart/mixed; boundary="${mix}"\r\n\r\n--${mix}\r\n${body}\r\n`
      + files.map((a) => `--${mix}\r\nContent-Type: ${a.type}; name="${a.name}"\r\nContent-Disposition: attachment; filename="${a.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${a.data.toString('base64').replace(/.{76}/g, '$&\r\n')}\r\n`).join('')
      + `--${mix}--`;
  }
  // A single text part keeps its headers in the message head.
  const [partHead, ...rest] = body.split('\r\n\r\n');
  return `${head.join('\r\n')}\r\n${partHead}\r\n\r\n${rest.join('\r\n\r\n')}\r\n`;
}

/** Put messages into the user's mailbox (inbox by default) unless their Message-ID is there already. Resolves to their ids. */
export async function importMessages(messages, { user = USER, role = 'inbox' } = {}) {
  const client = await jmap(user);
  const box = await mailboxId(client, role);
  const ids = [];
  for (const msg of messages) {
    const [[, found]] = await client.call([['Email/query', { accountId: client.accountId, filter: { header: ['Message-ID', `<${msg.messageId}>`] } }]]);
    if (found.ids.length) { ids.push(found.ids[0]); continue; }
    const blobId = await client.upload(Buffer.from(rawMessage(msg)), 'message/rfc822');
    const [[, res]] = await client.call([['Email/import', { accountId: client.accountId, emails: { m: { blobId, mailboxIds: { [box]: true }, keywords: msg.seen ? { $seen: true } : {}, receivedAt: new Date(msg.date ?? Date.now()).toISOString() } } }]]);
    if (!res.created?.m) throw new Error(`import of "${msg.subject}" failed: ${JSON.stringify(res.notCreated)}`);
    ids.push(res.created.m.id);
  }
  return ids;
}

/** The mail the reader tests open: a question with a highlighted line, and a three-message thread. */
export async function seedReaderMail() {
  const now = Date.now();
  const thread = 'offsite-1@e2e.bulwark.test';
  await importMessages([
    { messageId: 'thursday@e2e.bulwark.test', from: 'Carol <carol@example.org>', to: USER, subject: 'Can we meet on Thursday?', date: now - 3600_000,
      text: 'Hi,\n\ncould we meet Thursday at 15:00 to go through the draft? Please send me the slides by Wednesday.\n\nCarol' },
    { messageId: thread, from: 'Bob <bob@example.org>', to: USER, subject: 'Team offsite in November', date: now - 7200_000,
      text: 'Hi all,\n\nshall we do the offsite on 12 November in Hamburg? Budget is 2000 EUR.\n\nBob' },
    { messageId: 'offsite-2@e2e.bulwark.test', from: 'Carol <carol@example.org>', to: USER, subject: 'Re: Team offsite in November', date: now - 7000_000, inReplyTo: thread, references: [thread],
      text: 'Hamburg works for me, but 12 November clashes with a customer visit. Could we do 19 November?\n\nCarol' },
    { messageId: 'offsite-3@e2e.bulwark.test', from: 'Bob <bob@example.org>', to: USER, subject: 'Re: Team offsite in November', date: now - 6800_000, inReplyTo: 'offsite-2@e2e.bulwark.test', references: [thread, 'offsite-2@e2e.bulwark.test'],
      text: 'OK, 19 November then. Alice, can you book the room by Friday?\n\nBob' },
  ]);
}
