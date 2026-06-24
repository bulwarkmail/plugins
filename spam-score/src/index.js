/**
 * Spam Score — surfaces the spam-filter verdict inside a message's
 * "More details" panel.
 *
 * This plugin is a showcase for two extension points:
 *
 *   1. The `email-details-section` slot. The host mounts this slot under each
 *      category of the expanded "More details" panel (and once more as a
 *      brand-new bottom category). Each mount passes a `category` string —
 *      'recipients_routing', 'authentication_security', 'identifiers_threading',
 *      'message_properties', 'mailing_list', or `null` for the new bottom
 *      section. Our `shouldShow` picks exactly one of those so the section
 *      appears in a single place.
 *
 *   2. Reading raw headers. The `EmailReadView` handed to email slots now
 *      carries `headers` (the parsed header map) and `source` (the full
 *      message source). We read the spam-filter headers straight off
 *      `email.headers` — no host-side parsing of spam scores required.
 *
 * The slot component is a pure renderer: everything it needs arrives in
 * `props` (the email view + the category). It never calls the plugin API.
 */

const { createElement: h } = require('react');

// ─── Header access ────────────────────────────────────────────

// Headers arrive as Record<string, string | string[]>. Names can be
// canonical-cased ("X-Spam-Status"); look them up case-insensitively and
// collapse multi-valued headers to their first occurrence.
function getHeader(headers, name) {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) {
      const v = headers[key];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

function toNumber(raw) {
  if (raw == null) return undefined;
  const m = String(raw).match(/-?\d+(?:\.\d+)?/);
  if (!m) return undefined;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

// ─── Spam parsing ─────────────────────────────────────────────
//
// Understands the common emitters: SpamAssassin (X-Spam-Status / -Score /
// -Level / -Flag) and Rspamd (X-Rspamd-Score / X-Spamd-Result), plus this
// server's own AI verdict header (X-Spam-LLM).

function parseSpam(headers) {
  if (!headers) return null;

  const status = getHeader(headers, 'X-Spam-Status');
  const scoreH = getHeader(headers, 'X-Spam-Score');
  const level = getHeader(headers, 'X-Spam-Level');
  const flag = getHeader(headers, 'X-Spam-Flag');
  const rspamdScore = getHeader(headers, 'X-Rspamd-Score');
  const spamdResult = getHeader(headers, 'X-Spamd-Result');
  const rspamdAction =
    getHeader(headers, 'X-Rspamd-Action') || getHeader(headers, 'X-Spam-Action');
  const llmH = getHeader(headers, 'X-Spam-LLM');

  // Nothing recognisable → don't render.
  if (!status && scoreH == null && level == null && flag == null &&
      rspamdScore == null && spamdResult == null && rspamdAction == null && !llmH) {
    return null;
  }

  // Score + threshold. SpamAssassin's X-Spam-Status looks like
  //   "No, score=-0.25 required=5.0 tests=..." ; Rspamd's X-Spamd-Result like
  //   "default: False [1.50 / 15.00]".
  let score;
  let required;
  if (status) {
    const sm = status.match(/score=\s*(-?\d+(?:\.\d+)?)/i);
    if (sm) score = parseFloat(sm[1]);
    const rm = status.match(/required=\s*(-?\d+(?:\.\d+)?)/i);
    if (rm) required = parseFloat(rm[1]);
  }
  if (score == null && scoreH != null) score = toNumber(scoreH);
  if (score == null && rspamdScore != null) score = toNumber(rspamdScore);
  if ((score == null || required == null) && spamdResult) {
    const br = spamdResult.match(/\[\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)\s*\]/);
    if (br) {
      if (score == null) score = parseFloat(br[1]);
      if (required == null) required = parseFloat(br[2]);
    }
  }

  // Star level: SpamAssassin emits one '*' per whole point of score.
  let stars;
  if (level != null) {
    const s = String(level).replace(/[^*]/g, '');
    if (s.length > 0) stars = s.length;
  }
  if (stars == null && typeof score === 'number' && score > 0) {
    stars = Math.min(15, Math.floor(score));
  }

  // AI verdict header: "LEGITIMATE (reason)" / "SPAM (reason)" / "SUSPICIOUS (...)".
  let llm = null;
  if (llmH) {
    const m = String(llmH).trim().match(/^(LEGITIMATE|SPAM|SUSPICIOUS)\s*(?:\((.+)\))?\s*$/i);
    if (m) llm = { verdict: m[1].toUpperCase(), explanation: (m[2] || '').trim() };
  }

  // Overall verdict. Explicit flags win; then score-vs-threshold; then the AI
  // header; otherwise treat as clean.
  let verdict = 'clean';
  const flagYes = /^(yes|true)/i.test(String(flag || '')) ||
    /^\s*yes\b/i.test(String(status || ''));
  const actionBad = /reject|add header|rewrite subject|quarantine|spam/i.test(
    String(rspamdAction || ''),
  );
  if (flagYes || actionBad) {
    verdict = 'spam';
  } else if (typeof score === 'number' && typeof required === 'number') {
    if (score >= required) verdict = 'spam';
    else if (score >= required * 0.6) verdict = 'suspicious';
  }
  if (verdict === 'clean' && llm) {
    if (llm.verdict === 'SPAM') verdict = 'spam';
    else if (llm.verdict === 'SUSPICIOUS') verdict = 'suspicious';
  }

  return {
    score,
    required,
    stars,
    verdict,
    action: rspamdAction ? String(rspamdAction).trim() : undefined,
    llm,
    // Keep the raw status line so we can show users the exact header we read.
    raw: status || spamdResult || (scoreH != null ? `X-Spam-Score: ${scoreH}` : undefined),
  };
}

// ─── Presentation helpers ─────────────────────────────────────

const VERDICT_COLOR = {
  clean: 'var(--color-success, #16a34a)',
  suspicious: 'var(--color-warning, #f59e0b)',
  spam: 'var(--color-destructive, #dc2626)',
};
const VERDICT_LABEL = { clean: 'Clean', suspicious: 'Suspicious', spam: 'Spam' };

function Row(label, value, opts) {
  const mono = opts && opts.mono;
  return h(
    'div',
    {
      style: {
        display: 'grid',
        gridTemplateColumns: '7rem 1fr',
        columnGap: '1rem',
        rowGap: 0,
        alignItems: 'baseline',
      },
    },
    h(
      'dt',
      { style: { fontSize: '12px', color: 'var(--color-muted-foreground)', paddingTop: '2px' } },
      label,
    ),
    h(
      'dd',
      {
        style: {
          margin: 0,
          minWidth: 0,
          fontSize: mono ? '12px' : '14px',
          fontFamily: mono ? 'var(--font-mono, ui-monospace, monospace)' : 'inherit',
          color: 'var(--color-foreground)',
          wordBreak: 'break-word',
        },
      },
      value,
    ),
  );
}

function SpamSection(props) {
  const email = props && props.email;
  const spam = email ? parseSpam(email.headers) : null;
  if (!spam) return null;

  const color = VERDICT_COLOR[spam.verdict] || VERDICT_COLOR.clean;
  const rows = [];

  // Verdict chip.
  rows.push(
    Row(
      'Verdict',
      h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '2px 8px',
            borderRadius: '6px',
            border: `1px solid ${color}`,
            color,
            fontSize: '12px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          },
        },
        VERDICT_LABEL[spam.verdict] || spam.verdict,
      ),
    ),
  );

  // Score / threshold.
  if (typeof spam.score === 'number') {
    rows.push(
      Row(
        'Score',
        h(
          'span',
          null,
          h('span', { style: { fontWeight: 600, color } }, spam.score.toFixed(2)),
          typeof spam.required === 'number'
            ? h(
                'span',
                { style: { color: 'var(--color-muted-foreground)' } },
                ` / ${spam.required.toFixed(2)} threshold`,
              )
            : null,
        ),
      ),
    );
  }

  // Star level as a small bar.
  if (typeof spam.stars === 'number' && spam.stars > 0) {
    rows.push(Row('Level', '★'.repeat(spam.stars)));
  }

  // Rspamd action, if any.
  if (spam.action) {
    rows.push(Row('Action', spam.action));
  }

  // AI verdict.
  if (spam.llm) {
    rows.push(
      Row(
        'AI verdict',
        h(
          'span',
          null,
          h('span', { style: { fontWeight: 600 } }, spam.llm.verdict),
          spam.llm.explanation
            ? h(
                'span',
                { style: { color: 'var(--color-muted-foreground)' } },
                ` · ${spam.llm.explanation}`,
              )
            : null,
        ),
      ),
    );
  }

  // The exact header we parsed — proof we're reading raw source.
  if (spam.raw) {
    rows.push(Row('Header', spam.raw, { mono: true }));
  }

  return h(
    'section',
    { style: { minWidth: 0, paddingTop: '4px' } },
    h(
      'div',
      {
        style: {
          fontSize: '10px',
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--color-muted-foreground)',
          marginBottom: '6px',
        },
      },
      'Spam Analysis',
    ),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, ...rows),
  );
}

// ─── Slot wiring ──────────────────────────────────────────────

// Background-side settings snapshot, captured in activate(). shouldShow runs
// in the background iframe, so it can read these synchronously.
let settings = {};

// Decide the single category this section renders under. The host mounts the
// slot once per category; we return true for exactly one of them so we don't
// show up six times.
function shouldShow(extraProps) {
  const email = extraProps && extraProps.email;
  if (!email) return false;

  const spam = parseSpam(email.headers);
  if (!spam) return false;
  if (settings.showWhenClean === false && spam.verdict === 'clean') return false;

  // `category` is null for the dedicated bottom section, or one of the named
  // categories. Prefer the Authentication & Security category when the user
  // asked for it AND that category exists on this message — its mount only
  // renders when the message has auth results, so fall back to our own bottom
  // section otherwise. Returning true for exactly one category avoids
  // rendering the section twice.
  const category = extraProps.category == null ? null : String(extraProps.category);
  const auth = email.auth;
  const authPresent = !!(auth && (auth.spf || auth.dkim || auth.dmarc || auth.iprev));
  const target = settings.placeUnderSecurity && authPresent ? 'authentication_security' : null;
  return category === target;
}

export const slots = {
  'email-details-section': {
    component: SpamSection,
    shouldShow,
    order: 60,
  },
};

// ─── Activate (one-shot init) ─────────────────────────────────

export async function activate(api) {
  settings = api.plugin.settings || {};
  api.log.info('Spam Score plugin activated');
}
