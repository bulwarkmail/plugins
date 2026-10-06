/**
 * Translate Plugin — translate received emails via the host's /api/translate
 * proxy.
 *
 * v2 status: improved. Slot iframes now have full api access, so:
 *   - Settings (targetLanguage, provider, maxChars, autoTranslateForeign)
 *     are read via api.plugin.settings — no more baked-in defaults.
 *   - Translation requests go through api.http.post('/api/translate', body),
 *     which routes via the host with proper Authorization / X-JMAP-Username
 *     headers (the v1 null-origin fetch lost cookies and broke against the
 *     auth check).
 *   - autoTranslateForeign fires once per email when the banner mounts.
 *
 * Caveat: api.email.getBody is still not available, so the slot translates
 * whichever plain-text body is reachable via props.email (preview / text).
 *
 * Deployment note: the host route at /app/api/translate must exist for the
 * underlying request to succeed. The plugin shows a graceful error inline
 * when the endpoint is missing.
 */

const { createElement: h, useState, useCallback, useEffect, useRef } = require('react');
const slotApi = require('@plugin-host');

const t = (key, vars) => slotApi.i18n.t(key, vars);

const FALLBACK_TARGET = 'en';
const FALLBACK_PROVIDER = 'mymemory';
const FALLBACK_MAX_CHARS = 4000;

function stripHtml(html) {
  if (!html) return '';
  if (typeof DOMParser === 'undefined') {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, head').forEach((el) => el.remove());
    return (doc.body?.textContent || '').replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  } catch {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function pickPlainText(email, maxChars) {
  if (!email) return '';
  const raw =
    (typeof email.text === 'string' && email.text.trim())
      ? email.text
      : (typeof email.preview === 'string' && email.preview.trim())
        ? email.preview
        : (email.body && typeof email.body.text === 'string' && email.body.text.trim())
          ? email.body.text
          : stripHtml(email.body?.html || email.htmlBody || '');
  const trimmed = String(raw || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

async function callTranslate({ text, target, provider }) {
  const result = await slotApi.http.post('/api/translate', {
    text,
    target,
    source: 'auto',
    provider,
  });
  if (!result || !result.ok) {
    const msg = result?.data?.error || `HTTP ${result?.status ?? '???'}`;
    throw new Error(msg);
  }
  return result.data || {};
}

function TranslateBanner(props) {
  const settings = slotApi.plugin?.settings || {};
  const target = String(settings.targetLanguage || FALLBACK_TARGET).toLowerCase();
  const provider = String(settings.provider || FALLBACK_PROVIDER);
  const maxChars = Number(settings.maxChars) || FALLBACK_MAX_CHARS;
  const autoTranslate = settings.autoTranslateForeign === true;

  const [state, setState] = useState({ status: 'idle' });
  const autoFiredRef = useRef(false);

  const run = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const source = pickPlainText(props.email, maxChars);
      if (!source) {
        setState({ status: 'error', error: t('error.no_text') });
        return;
      }
      const result = await callTranslate({ text: source, target, provider });
      const detected = result && typeof result === 'object' && 'detectedSource' in result
        ? result.detectedSource
        : undefined;
      if (detected && String(detected).toLowerCase().split('-')[0] === target.split('-')[0]) {
        setState({ status: 'skipped', detected });
        return;
      }
      setState({
        status: 'done',
        translated: String(result.translatedText || ''),
        detected,
        truncated: source.length >= maxChars,
      });
    } catch (err) {
      setState({ status: 'error', error: err && err.message ? err.message : String(err) });
    }
  }, [props.email, target, provider, maxChars]);

  // Auto-translate once per banner mount if enabled.
  useEffect(() => {
    if (!autoTranslate) return;
    if (autoFiredRef.current) return;
    autoFiredRef.current = true;
    void run();
  }, [autoTranslate, run]);

  const showRetry = state.status === 'done' || state.status === 'error' || state.status === 'skipped';

  // Mirror the host's "External Content" / external-sender banner language: a
  // tinted round icon, a tiny uppercase eyebrow label, a medium body line, and
  // outline action buttons — all driven by the host theme tokens so the slot
  // matches light/dark and custom themes.
  const TINT = 'var(--color-info)';
  // Mix the info tint into the *opaque* background/card tokens — not into
  // `transparent`. A slot iframe's body is transparent, so a translucent fill
  // would reveal whatever sits behind the iframe (often the white email body),
  // which broke the banner in dark mode. Opaque mixes keep it a solid panel
  // that follows the host's light/dark/custom theme.
  const bannerStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '10px 16px',
    background: `color-mix(in srgb, ${TINT} 10%, var(--color-background))`,
    borderBottom: `1px solid color-mix(in srgb, ${TINT} 28%, var(--color-background))`,
    color: 'var(--color-foreground)',
    fontSize: '13px',
    lineHeight: 1.5,
  };

  const iconCircle = h(
    'div',
    {
      'aria-hidden': 'true',
      style: {
        width: '40px',
        height: '40px',
        borderRadius: '9999px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        fontSize: '18px',
        background: `color-mix(in srgb, ${TINT} 22%, var(--color-background))`,
        color: TINT,
      },
    },
    '🌐',
  );

  const label = h(
    'div',
    {
      style: {
        fontSize: '10px',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--color-muted-foreground)',
      },
    },
    t('label'),
  );

  let message;
  if (state.status === 'idle') {
    message = t('idle', { target: target.toUpperCase() });
  } else if (state.status === 'loading') {
    message = t('translating');
  } else if (state.status === 'skipped') {
    message = t('skipped', { target: target.toUpperCase() });
  } else if (state.status === 'done') {
    message = t('done', {
      source: state.detected ? String(state.detected).toUpperCase() : t('source_auto'),
      target: target.toUpperCase(),
    }) + (state.truncated ? t('truncated') : '');
  } else if (state.status === 'error') {
    message = state.error;
  }

  const messageEl = h(
    'div',
    {
      style: {
        fontSize: '14px',
        fontWeight: 500,
        wordBreak: 'break-word',
        color: state.status === 'error' ? 'var(--color-destructive)' : 'var(--color-foreground)',
      },
    },
    message,
  );

  // Shared outline-button style — matches the host banner's secondary actions.
  const outlineButton = (extra) => ({
    font: 'inherit',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    minHeight: '36px',
    padding: '6px 12px',
    borderRadius: '6px',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
    border: '1px solid var(--color-border)',
    background: 'transparent',
    color: 'var(--color-muted-foreground)',
    ...extra,
  });

  const actions = [];
  if (state.status === 'idle') {
    actions.push(
      h(
        'button',
        {
          key: 'go',
          type: 'button',
          onClick: run,
          style: outlineButton(),
        },
        '🌐 ' + t('action.translate'),
      ),
    );
  } else if (state.status === 'loading') {
    actions.push(
      h(
        'button',
        {
          key: 'loading',
          type: 'button',
          disabled: true,
          style: outlineButton({ cursor: 'progress', opacity: 0.6 }),
        },
        t('translating'),
      ),
    );
  } else if (showRetry) {
    actions.push(
      h(
        'button',
        {
          key: 'retry',
          type: 'button',
          onClick: run,
          style: outlineButton(),
        },
        '↻ ' + t('action.again'),
      ),
    );
  }

  return h(
    'div',
    { role: 'note', style: bannerStyle },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'flex-start', gap: '12px' } },
      iconCircle,
      h(
        'div',
        { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '8px' } },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          label,
          messageEl,
        ),
        actions.length > 0 &&
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
            actions,
          ),
      ),
    ),
    state.status === 'done' &&
      h(
        'div',
        {
          style: {
            borderTop: '1px dashed color-mix(in srgb, var(--color-foreground) 22%, var(--color-background))',
            paddingTop: '10px',
            whiteSpace: 'pre-wrap',
            wordWrap: 'break-word',
            fontSize: '14px',
            color: 'var(--color-foreground)',
          },
        },
        state.translated,
      ),
  );
}

export const slots = {
  'email-banner': {
    component: TranslateBanner,
    shouldShow: () => true,
    order: 90,
  },
};

export async function activate(api) {
  api.log.info('Translate plugin activated');
}
