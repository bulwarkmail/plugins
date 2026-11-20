// The mail accounts the assistant can look into: the user's own, team
// mailboxes (group accounts) and mailboxes other people shared. The webmail
// names the folders and calendars of another account "<accountId>:<id>".
// Message ids repeat across accounts, so a message of another account goes
// to the model as "<accountId>:<id>" too, and back to the webmail with its
// account.

const SEP = ':';

/** Whether a folder or calendar id is one of another account's. */
export const inOtherAccount = (id) => String(id ?? '').includes(SEP);

/** The account in front of another account's folder or calendar id. */
export const accountOfId = (id) => (inOtherAccount(id) ? String(id).slice(0, String(id).indexOf(SEP)) : undefined);

/** The folders of another account, or the user's own when accountId is not given. */
export function foldersOf(mailboxes, accountId) {
  return (mailboxes ?? []).filter((m) => (accountId ? accountOfId(m.id) === accountId : !inOtherAccount(m.id)));
}

/**
 * The account a message is in when that is not the user's own, else
 * undefined. The webmail stamps every message with its account; one of
 * another account's folders carries the same id.
 */
export function otherAccountOf(email, mailboxes) {
  const accountId = email?.accountId;
  return accountId && foldersOf(mailboxes, accountId).length ? String(accountId) : undefined;
}

/** How the model names a message: its id, with the account in front in another account. */
export const messageRef = (id, accountId) => (accountId ? `${accountId}${SEP}${id}` : String(id ?? ''));

/** A message reference back to { id, accountId? }. */
export function parseMessageRef(ref) {
  const value = String(ref ?? '').trim();
  const at = value.indexOf(SEP);
  return at > 0 ? { id: value.slice(at + 1), accountId: value.slice(0, at) } : { id: value };
}

/**
 * The login's mail accounts ([{ accountId, name, kind, isOpen }]), or []
 * where the webmail can't list them (before Bulwark 1.19).
 */
export async function mailAccounts(api) {
  try {
    if (typeof api.user?.getMailAccounts !== 'function') return [];
    const list = await api.user.getMailAccounts();
    return Array.isArray(list) ? list.filter((a) => a && typeof a.accountId === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * One of the accounts by its name or address, as the user says it ("info",
 * "info@example.com"): the exact name first, then the one name that fits.
 */
export function findAccount(accounts, wanted) {
  const want = String(wanted ?? '').trim().toLowerCase();
  if (!want) return null;
  const name = (a) => String(a.name ?? '').toLowerCase();
  const exact = accounts.find((a) => name(a) === want || a.accountId === String(wanted).trim());
  if (exact) return exact;
  const local = (value) => value.split('@')[0];
  const partial = accounts.filter((a) => name(a) && (name(a).includes(want) || local(want) === local(name(a))));
  return partial.length === 1 ? partial[0] : null;
}
