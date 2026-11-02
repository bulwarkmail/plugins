// A stand-in for LanguageTool's /v2/check, shared by the unit tests and the
// end-to-end mock server.
//
// It reads the form body like LanguageTool does: `text`, or `data` with
// text and markup parts. Offsets are counted in the whole string with the
// markup in it, in UTF-16 code units, as the real server does (checked
// against api.languagetool.org on 2026-11-01). Each rule is a word or
// phrase; every occurrence becomes a match.

export const RULES = {
  // German: "Ich habe gestern dem Brief geschrieben." → den
  dem: { text: 'dem Brief', length: 3, language: 'de', message: 'Möglicherweise passen das Nomen und die Wörter, die das Nomen beschreiben, grammatisch nicht zusammen.', shortMessage: 'Möglicherweise fehlende grammatische Übereinstimmung', replacements: ['den'], rule: { id: 'DE_AGREEMENT', description: 'Kongruenz von Nominalphrasen', issueType: 'grammar', category: { id: 'GRAMMAR', name: 'Grammatik' } } },
  Brieff: { text: 'Brieff', language: 'de', message: 'Möglicher Tippfehler gefunden.', shortMessage: 'Rechtschreibfehler', replacements: ['Brief', 'Briefe'], rule: { id: 'GERMAN_SPELLER_RULE', description: 'Möglicher Rechtschreibfehler', issueType: 'misspelling', category: { id: 'TYPOS', name: 'Mögliche Tippfehler' } } },
  // English: "I has two question about teh offer."
  has: { text: 'I has', offsetInText: 2, length: 3, language: 'en', message: 'The pronoun “I” must be used with a non-third-person form of a verb.', shortMessage: 'Grammatical problem', replacements: ['have', 'had'], rule: { id: 'NON3PRS_VERB', description: 'Agreement error: Third person verb with plural or first person', issueType: 'grammar', category: { id: 'GRAMMAR', name: 'Grammar' } } },
  question: { text: 'two question', offsetInText: 4, length: 8, language: 'en', message: 'The noun "question" is singular; use the plural after "two".', shortMessage: 'Plural needed', replacements: ['questions'], rule: { id: 'CD_NN', description: 'Agreement of number and noun', issueType: 'grammar', category: { id: 'GRAMMAR', name: 'Grammar' } } },
  teh: { text: 'teh', language: 'en', message: 'Possible spelling mistake found.', shortMessage: 'Spelling mistake', replacements: ['the', 'ten', 'tea'], rule: { id: 'MORFOLOGIK_RULE_EN_US', description: 'Possible spelling mistake', issueType: 'misspelling', category: { id: 'TYPOS', name: 'Possible Typo' } } },
  Bulwark: { text: 'Bulwark', language: 'en', message: 'Possible spelling mistake found.', replacements: ['Bulwarks'], rule: { id: 'MORFOLOGIK_RULE_EN_US', description: 'Possible spelling mistake', issueType: 'misspelling', category: { id: 'TYPOS', name: 'Possible Typo' } } },
  very: { text: 'very unique', length: 4, language: 'en', message: 'Unique means one of a kind; it needs no intensifier.', replacements: [], rule: { id: 'VERY_UNIQUE', description: 'very unique (unique)', issueType: 'style', category: { id: 'REDUNDANCY', name: 'Redundant Phrases' } } },
  doubleSpace: { text: '  ', language: '*', message: 'Possible typo: you repeated a whitespace', replacements: [' '], rule: { id: 'WHITESPACE_RULE', description: 'Whitespace repetition (bad formatting)', issueType: 'whitespace', category: { id: 'TYPOGRAPHY', name: 'Typography' } } },
};

/** The text LanguageTool counts offsets in, and the form's parameters. */
export function readForm(body) {
  const form = new URLSearchParams(typeof body === 'string' ? body : '');
  const params = Object.fromEntries(form);
  let full = params.text ?? '';
  if (params.data) {
    const { annotation } = JSON.parse(params.data);
    full = annotation.map((a) => (typeof a.text === 'string' ? a.text : a.markup)).join('');
  }
  return { params, full };
}

/** LanguageTool's JSON answer for a form body. */
export function answer(body, rules = RULES) {
  const { params, full } = readForm(body);
  const lang = params.language === 'auto' ? 'auto' : String(params.language ?? '').split('-')[0];
  const matches = [];
  for (const r of Object.values(rules)) {
    if (lang !== 'auto' && r.language !== '*' && r.language !== lang) continue;
    if (String(params.disabledRules ?? '').split(',').includes(r.rule.id)) continue;
    if (String(params.disabledCategories ?? '').split(',').includes(r.rule.category.id)) continue;
    for (let at = full.indexOf(r.text); at >= 0; at = full.indexOf(r.text, at + 1)) {
      const offset = at + (r.offsetInText ?? 0);
      matches.push({
        message: r.message, shortMessage: r.shortMessage ?? '', offset, length: r.length ?? r.text.length,
        replacements: r.replacements.map((value) => ({ value })),
        context: { text: full, offset, length: r.length ?? r.text.length },
        rule: r.rule, type: { typeName: 'Other' },
      });
    }
  }
  matches.sort((a, b) => a.offset - b.offset);
  const code = params.language === 'auto' ? (/\b(Ich|habe|dem)\b/.test(full) ? 'de-DE' : 'en-US') : params.language;
  return {
    software: { name: 'LanguageTool', version: '6.6' },
    language: { name: code, code, detectedLanguage: { name: code, code, confidence: 0.9 } },
    matches,
    warnings: { incompleteResults: false },
  };
}

/** An api.proxy.fetch handler answering like LanguageTool; `requests` records each call. */
export function proxyHandler({ rules = RULES, requests = [], respond } = {}) {
  return async (credentialId, url, init = {}) => {
    requests.push({ credentialId, url, init, ...readForm(init.body) });
    if (respond) {
      const custom = await respond({ credentialId, url, init, ...readForm(init.body) });
      if (custom) return custom;
    }
    return { status: 200, ok: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(answer(init.body, rules)) };
  };
}

export const LANGUAGES = [
  { name: 'German (Germany)', code: 'de', longCode: 'de-DE' },
  { name: 'English (US)', code: 'en', longCode: 'en-US' },
  { name: 'English (GB)', code: 'en', longCode: 'en-GB' },
];
