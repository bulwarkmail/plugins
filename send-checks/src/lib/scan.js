/**
 * Runs the admin's rules over a message on its way out (onBeforeEmailSend's
 * OutgoingEmail) and lists what matched.
 *
 * Scanned: the subject, the user's own text (`authoredText`, without the
 * quoted original and the signature; `textBody` on hosts that don't send
 * it), attachment names, and the text of text attachments when the host
 * passes it (`textExcerpt`, the first 1 MB). Matches carry only a masked
 * form of what was found.
 */

import { findIbans, maskIban } from './iban.js';
import { cardLastFour, findCards } from './cards.js';
import { findKeywords, findPatterns, maskMatch, parseKeywords, parsePatterns, PATTERN_BUDGET_MS } from './text-rules.js';
import { attachmentProblems, isTextAttachment, maxBytes, parseTypeList } from './attachments.js';

/**
 * Whether the message goes outside the organisation. The host lists those
 * recipients (`externalRecipients`); a host that doesn't is treated as if
 * every recipient were outside, so an "outside only" rule still runs.
 */
export function goesOutside(email) {
  if (Array.isArray(email?.externalRecipients)) return email.externalRecipients.length > 0;
  return ['to', 'cc', 'bcc'].some((f) => Array.isArray(email?.[f]) && email[f].some((r) => String(r ?? '').trim()));
}

/** The texts to scan, each with where it came from (null = the message itself). */
export function textsOf(email) {
  const own = typeof email?.authoredText === 'string' ? email.authoredText : String(email?.textBody ?? '');
  const out = [
    { where: null, text: String(email?.subject ?? '') },
    { where: null, text: own },
  ];
  for (const file of Array.isArray(email?.attachments) ? email.attachments : []) {
    if (file && typeof file.textExcerpt === 'string' && file.textExcerpt && isTextAttachment(file)) {
      out.push({ where: String(file.name || 'attachment'), text: file.textExcerpt });
    }
    if (file && file.name) out.push({ where: null, text: String(file.name), isName: true });
  }
  return out;
}

/** Compiled rules for a config, so a send doesn't parse the lists again. */
export function compileRules(config) {
  const patterns = parsePatterns(config.patterns);
  return {
    config,
    keywords: parseKeywords(config.keywords),
    patterns: patterns.rules,
    skippedPatterns: patterns.skipped,
    blocked: parseTypeList(config.blockedTypes),
    allowed: parseTypeList(config.allowedTypes),
    limit: maxBytes(config.maxSizeMb),
  };
}

function applies(actionValue, externalOnly, outside) {
  return actionValue && actionValue !== 'off' && (!externalOnly || outside);
}

/**
 * What matched, as [{ rule, action, externalOnly, where, ...details }]:
 * rule iban { masked }, card { last4 }, keyword { keyword }, pattern
 * { name, masked }, type { name, type, reason }, size { name, maxMb }.
 * Each match is listed once.
 */
export function evaluate(email, compiled, { now = Date.now } = {}) {
  const { config } = compiled;
  const outside = goesOutside(email);
  const found = [];
  const seen = new Set();
  const push = (key, finding) => {
    if (seen.has(key)) return;
    seen.add(key);
    found.push(finding);
  };

  const doIban = applies(config.ibanAction, config.ibanExternalOnly, outside);
  const doCard = applies(config.cardAction, config.cardExternalOnly, outside);
  const doKeyword = compiled.keywords.length > 0 && applies(config.keywordAction, config.keywordExternalOnly, outside);
  const doPattern = compiled.patterns.length > 0 && applies(config.patternAction, config.patternExternalOnly, outside);
  const deadline = now() + PATTERN_BUDGET_MS;
  let timedOut = false;

  for (const { where, text, isName } of textsOf(email)) {
    if (!text) continue;
    const ibans = doIban || doCard ? findIbans(text) : [];
    if (doIban) {
      for (const iban of ibans) {
        push(`iban|${iban.value}`, { rule: 'iban', action: config.ibanAction, externalOnly: config.ibanExternalOnly, where, masked: maskIban(iban.value) });
      }
    }
    if (doCard && !isName) {
      for (const card of findCards(text, ibans)) {
        push(`card|${card.digits}`, { rule: 'card', action: config.cardAction, externalOnly: config.cardExternalOnly, where, last4: cardLastFour(card.digits) });
      }
    }
    if (doKeyword) {
      for (const keyword of findKeywords(text, compiled.keywords)) {
        push(`keyword|${keyword.toLowerCase()}`, { rule: 'keyword', action: config.keywordAction, externalOnly: config.keywordExternalOnly, where, keyword });
      }
    }
    if (doPattern && !timedOut) {
      const result = findPatterns(text, compiled.patterns, deadline);
      timedOut = result.timedOut;
      for (const hit of result.found) {
        push(`pattern|${hit.name}|${hit.match}`, { rule: 'pattern', action: config.patternAction, externalOnly: config.patternExternalOnly, where, name: hit.name, masked: maskMatch(hit.match) });
      }
    }
  }

  if (applies(config.attachmentAction, config.attachmentExternalOnly, outside)) {
    for (const problem of attachmentProblems(email?.attachments, compiled)) {
      const base = { action: config.attachmentAction, externalOnly: config.attachmentExternalOnly, where: null, name: problem.name };
      if (problem.kind === 'type') push(`type|${problem.name}`, { ...base, rule: 'type', type: problem.type, reason: problem.reason });
      else push(`size|${problem.name}`, { ...base, rule: 'size', maxMb: config.maxSizeMb });
    }
  }
  return { found, outside, timedOut };
}

/**
 * The attachment problem of one file at upload time, or null. Only for a
 * blocking rule that doesn't depend on the recipients: those aren't known
 * yet, so the rest waits for Send.
 */
export function uploadProblem(file, compiled) {
  const { config } = compiled;
  if (config.attachmentAction !== 'block' || config.attachmentExternalOnly) return null;
  const [problem] = attachmentProblems([{ ...file, inline: !!file?.inline }], compiled);
  return problem ?? null;
}
