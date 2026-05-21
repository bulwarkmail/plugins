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
        setState({ status: 'error', error: 'No translatable text in this message' });
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

  return h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '10px 12px',
        margin: '8px 0',
        border: '1px solid #e2e8f0',
        borderRadius: '8px',
        background: '#f8fafc',
        fontSize: '13px',
        lineHeight: 1.5,
      },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
      h('span', { 'aria-hidden': 'true' }, '🌐'),
      h(
        'div',
        { style: { flex: 1, minWidth: 0 } },
        state.status === 'idle' && `Translate this message into ${target.toUpperCase()}?`,
        state.status === 'loading' && 'Translating…',
        state.status === 'skipped' && `Already in ${target.toUpperCase()}`,
        state.status === 'done' &&
          h(
            'span',
            { style: { fontSize: '12px', opacity: 0.75 } },
            `Translated from ${state.detected ? String(state.detected).toUpperCase() : 'auto'} to ${target.toUpperCase()}`,
            state.truncated ? ' · long message truncated' : '',
          ),
        state.status === 'error' &&
          h('span', { style: { color: '#b91c1c', fontSize: '12px' } }, state.error),
      ),
      state.status === 'idle' &&
        h(
          'button',
          {
            type: 'button',
            onClick: run,
            style: {
              font: 'inherit',
              padding: '5px 12px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              border: '1px solid transparent',
              background: '#3b82f6',
              color: '#ffffff',
            },
          },
          'Translate',
        ),
      state.status === 'loading' &&
        h(
          'button',
          {
            type: 'button',
            disabled: true,
            style: {
              font: 'inherit',
              padding: '5px 12px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'progress',
              border: '1px solid transparent',
              background: '#3b82f6',
              color: '#ffffff',
              opacity: 0.6,
            },
          },
          'Translating…',
        ),
      showRetry &&
        h(
          'button',
          {
            type: 'button',
            onClick: run,
            style: {
              font: 'inherit',
              padding: '5px 12px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              border: '1px solid #e2e8f0',
              background: '#ffffff',
            },
          },
          'Translate again',
        ),
    ),
    state.status === 'done' &&
      h(
        'div',
        {
          style: {
            borderTop: '1px dashed #e2e8f0',
            paddingTop: '8px',
            whiteSpace: 'pre-wrap',
            wordWrap: 'break-word',
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
