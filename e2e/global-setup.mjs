// Before a run against a shared test server (BULWARK_JMAP_URL): check once
// that the accounts exist, and stop the run if one doesn't. Test servers are
// reset by other people now and then; a run that keeps signing in to a
// deleted account gets the machine banned by the server's fail2ban.
//
//   BULWARK_JMAP_URL, BULWARK_USER, BULWARK_PEER_USER, BULWARK_PASSWORD

export default async function globalSetup() {
  const base = (process.env.BULWARK_JMAP_URL || '').replace(/\/+$/, '');
  if (!base) return;
  const password = process.env.BULWARK_PASSWORD;
  if (!password) throw new Error('BULWARK_JMAP_URL is set: set BULWARK_PASSWORD too');
  const users = [process.env.BULWARK_USER, process.env.BULWARK_PEER_USER].filter(Boolean);
  if (!users.length) throw new Error('BULWARK_JMAP_URL is set: set BULWARK_USER (and BULWARK_PEER_USER)');
  const missing = [];
  for (const user of users) {
    const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    let status;
    try {
      status = (await fetch(`${base}/jmap/session`, { headers: { authorization: auth } })).status;
    } catch (err) {
      status = `unreachable (${err.message})`;
    }
    if (status !== 200) missing.push(`${user}: ${status}`);
  }
  if (missing.length) {
    throw new Error(`Test accounts not usable on ${base}, not running (create them first): ${missing.join(', ')}`);
  }
}
