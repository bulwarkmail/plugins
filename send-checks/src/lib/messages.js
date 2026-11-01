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
  'upload.title': "This file can't be attached",
  'upload.type': "Your organisation doesn't allow attaching {name} ({type}).",
  'upload.size': '{name} is larger than {max} MB, the most your organisation allows.',
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

/** One line of the list for a finding. */
export function itemText(finding, tr) {
  let text;
  switch (finding.rule) {
    case 'iban': text = tr('item.iban', { masked: finding.masked }); break;
    case 'card': text = tr('item.card', { last4: finding.last4 }); break;
    case 'keyword': text = tr('item.keyword', { keyword: finding.keyword }); break;
    case 'pattern': text = tr('item.pattern', { name: finding.name, masked: finding.masked }); break;
    case 'type': text = tr('item.type', { name: finding.name, type: finding.type }); break;
    case 'size': text = tr('item.size', { name: finding.name, max: formatMb(finding.maxMb) }); break;
    default: text = String(finding.rule);
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
 * The dialog for what matched: { kind: 'alert'|'confirm', title, message, ... }.
 * Any blocking match stops the send; warnings alone ask once.
 */
export function dialogFor(found, tr) {
  const blocks = found.filter((f) => f.action === 'block');
  const warns = found.filter((f) => f.action === 'warn');
  const note = found.some((f) => f.externalOnly) ? `\n\n${tr('outside.note')}` : '';
  if (blocks.length > 0) {
    let message = tr('block.message', { list: listText(blocks, tr) });
    if (warns.length > 0) message += `\n\n${tr('block.alsoCheck', { list: listText(warns, tr) })}`;
    return { kind: 'alert', title: tr('block.title'), message: message + note };
  }
  return {
    kind: 'confirm',
    title: tr('warn.title'),
    message: tr('warn.message', { list: listText(warns, tr) }) + note,
    confirmLabel: tr('warn.confirm'),
    cancelLabel: tr('warn.cancel'),
    danger: true,
  };
}
