/**
 * The texts of the dialogs. English here as the fallback; the manifest's
 * locales carry every language the plugin ships.
 */

export const FALLBACK = {
  'warn.title': 'Check before sending',
  'warn.message': 'Your organisation asks you to check this before the message goes out:\n\n{list}',
  'warn.confirm': 'Send anyway',
  'warn.cancel': 'Go back',
  'warn.cancelled': 'Message not sent',
  'block.title': "This message can't be sent",
  'block.message': "Your organisation doesn't allow sending this:\n\n{list}\n\nRemove it and try again.",
  'block.alsoCheck': 'Also check:\n\n{list}',
  'outside.note': 'Some of these only count because the message goes outside your organisation.',
  'unchecked.title': "This message couldn't be checked",
  'unchecked.message': "Your organisation's checks couldn't finish, so the message wasn't sent:\n\n{list}\n\nTry again in a moment. If this keeps happening, tell your administrator.",
  'unchecked.config': "Your organisation's send checks couldn't load their settings, so the message wasn't sent. Try again in a moment.",
  'incomplete.note': "Some checks couldn't finish:\n\n{list}",
  'incomplete.warnOnly': "Some of your organisation's checks couldn't finish:\n\n{list}\n\nSend it only if you're sure it's fine.",
  'incomplete.patterns': "Your organisation's patterns couldn't be checked in time",
  'incomplete.invalidPattern': 'The pattern “{name}” is set up wrongly. Ask your administrator to fix it.',
  'incomplete.unreadable': "{name} couldn't be read",
  'upload.title': "This file can't be attached",
  'upload.type': "Your organisation doesn't allow attaching {name} ({type}).",
  'upload.size': '{name} is larger than {max} MB, the most your organisation allows.',
  'upload.unreadable': "{name} couldn't be checked, so it can't be attached. Try again in a moment.",
  'item.iban': 'IBAN {masked}',
  'item.card': 'Card number ending {last4}',
  'item.keyword': 'The word “{keyword}”',
  'item.pattern': '{name}: {masked}',
  'item.type': '{name}: file type not allowed ({type})',
  'item.size': '{name}: larger than {max} MB',
  'item.inFile': '{item} (in {file})',
  'item.more': 'and {count} more',
};

export const MAX_LISTED = 10;

/** One line of the list for a finding or for something that couldn't be checked. */
export function itemText(finding, tr) {
  let text;
  switch (finding.rule ?? finding.kind) {
    case 'iban': text = tr('item.iban', { masked: finding.masked }); break;
    case 'card': text = tr('item.card', { last4: finding.last4 }); break;
    case 'keyword': text = tr('item.keyword', { keyword: finding.keyword }); break;
    case 'pattern': text = tr('item.pattern', { name: finding.name, masked: finding.masked }); break;
    case 'type': text = tr('item.type', { name: finding.name, type: finding.type }); break;
    case 'size': text = tr('item.size', { name: finding.name, max: formatMb(finding.maxMb) }); break;
    case 'patterns': text = tr('incomplete.patterns'); break;
    case 'invalid-pattern': text = tr('incomplete.invalidPattern', { name: finding.name }); break;
    case 'unreadable': text = tr('incomplete.unreadable', { name: finding.name }); break;
    default: text = String(finding.rule ?? finding.kind);
  }
  return finding.where ? tr('item.inFile', { item: text, file: finding.where }) : text;
}

export function formatMb(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return String(Math.round(n * 10) / 10);
}

/** "• a\n• b", at most MAX_LISTED lines and a count of the rest. */
export function listText(findings, tr) {
  const lines = findings.slice(0, MAX_LISTED).map((f) => `• ${itemText(f, tr)}`);
  if (findings.length > MAX_LISTED) lines.push(tr('item.more', { count: findings.length - MAX_LISTED }));
  return lines.join('\n');
}

/**
 * The dialog for what matched and what couldn't be checked:
 * { kind: 'alert'|'confirm', title, message, ... }, or null for nothing.
 * A blocking match stops the send; so does a blocking rule that couldn't be
 * checked (fail closed). Warnings, and warning rules that couldn't finish,
 * ask once.
 */
export function dialogFor(found, tr, incomplete = []) {
  const blocks = found.filter((f) => f.action === 'block');
  const warns = found.filter((f) => f.action === 'warn');
  const unBlocks = incomplete.filter((f) => f.action === 'block');
  const unWarns = incomplete.filter((f) => f.action === 'warn');
  if (!blocks.length && !warns.length && !unBlocks.length && !unWarns.length) return null;
  const note = [...found, ...incomplete].some((f) => f.externalOnly) ? `\n\n${tr('outside.note')}` : '';
  const also = warns.length > 0 ? `\n\n${tr('block.alsoCheck', { list: listText(warns, tr) })}` : '';

  if (blocks.length > 0) {
    const unfinished = incomplete.length > 0 ? `\n\n${tr('incomplete.note', { list: listText(incomplete, tr) })}` : '';
    return { kind: 'alert', title: tr('block.title'), message: tr('block.message', { list: listText(blocks, tr) }) + also + unfinished + note };
  }
  if (unBlocks.length > 0) {
    return { kind: 'alert', title: tr('unchecked.title'), message: tr('unchecked.message', { list: listText(incomplete, tr) }) + also + note };
  }
  const message = warns.length > 0
    ? tr('warn.message', { list: listText(warns, tr) }) + (unWarns.length ? `\n\n${tr('incomplete.note', { list: listText(unWarns, tr) })}` : '')
    : tr('incomplete.warnOnly', { list: listText(unWarns, tr) });
  return {
    kind: 'confirm',
    title: tr('warn.title'),
    message: message + note,
    confirmLabel: tr('warn.confirm'),
    cancelLabel: tr('warn.cancel'),
    danger: true,
  };
}
