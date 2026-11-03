// Shared pieces of the assistant's UI, drawn with the app's UI kit.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, BarButton, Button, Row, Stack, Text } from '@plugin-host/ui';
import { privacyMessage, runTask } from '../lib/assistant.js';
import { AiError, messageFor } from '../lib/errors.js';
import { withStrings } from '../lib/i18n.js';

export const host = () => require('@plugin-host');

/** The api a slot component works with: its `api` prop (tests), else the sandbox's; with the assistant's texts. */
export const useApi = (props) => withStrings(props?.api ?? host());

/** Copy text from inside the sandbox. The async clipboard API needs a
 *  permission the plugin frame doesn't have, so fall back to a selection. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall back */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export async function copyWithToast(api, text, okKey = 'common.copied') {
  const ok = await copyText(text);
  if (ok) api.toast.success(api.i18n.t(okKey));
  else api.toast.error(api.i18n.t('common.copy_failed'));
  return ok;
}

/**
 * Run tasks one at a time, with streaming text, Stop and errors.
 * status: idle | running | done | stopped | error
 *
 * `inlineConsent`: ask for the privacy notice in the plugin's own UI
 * (`consent` is set while it waits). Needed inside a plugin dialog, where
 * the host's confirm can't open; elsewhere the host's confirm asks.
 */
export function useTask(api, { inlineConsent = false } = {}) {
  const [state, setState] = useState({ status: 'idle', text: '', error: null, task: null });
  const [consent, setConsent] = useState(null);
  const current = useRef(null);

  const askConsent = useCallback((endpoint) => new Promise((resolve) => {
    setConsent({
      endpoint,
      answer: (ok) => { setConsent(null); resolve(ok); },
    });
  }), []);

  const run = useCallback(async (task, input) => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setState({ status: 'running', text: '', error: null, task });
    try {
      const text = await runTask(api, task, input, {
        signal: controller.signal,
        ...(inlineConsent ? { askConsent } : {}),
        onText: (full) => { if (current.current === controller) setState((s) => ({ ...s, text: full })); },
      });
      if (current.current === controller) setState({ status: 'done', text, error: null, task });
      return text;
    } catch (err) {
      if (current.current !== controller) return null;
      if (!(err instanceof AiError) || err.detail) api.log?.warn?.(`${task} failed`, err?.message ?? err);
      const error = err instanceof AiError ? err : new AiError('unreachable', { detail: err?.message });
      if (error.code === 'cancelled') setState((s) => ({ status: 'stopped', text: error.partial || s.text, error: null, task }));
      else if (error.code === 'declined') setState({ status: 'idle', text: '', error: null, task: null });
      else setState({ status: 'error', text: error.partial || '', error, task });
      return null;
    }
  }, [api, inlineConsent, askConsent]);

  const cancel = useCallback(() => current.current?.abort(), []);
  const reset = useCallback(() => {
    current.current?.abort();
    current.current = null;
    setState({ status: 'idle', text: '', error: null, task: null });
  }, []);

  useEffect(() => () => current.current?.abort(), []);
  const stopConsent = () => consent?.answer(false);
  return { ...state, consent, run, cancel: () => { stopConsent(); cancel(); }, reset: () => { stopConsent(); reset(); } };
}

/** The privacy notice before the first request to a service, in a dialog body. */
export function ConsentNotice({ api, consent }) {
  if (!consent) return null;
  const t = api.i18n.t;
  return (
    <Alert tone="info" icon="shield">
      <Stack gap={1}>
        <Text weight="medium">{t('privacy.title')}</Text>
        <Text>{privacyMessage(t, consent.endpoint, consent.scope)}</Text>
      </Stack>
    </Alert>
  );
}

/** Counts down a rate limit's wait. */
function useWait(error) {
  const [wait, setWait] = useState(error?.retryAfter ?? 0);
  useEffect(() => { setWait(error?.retryAfter ?? 0); }, [error]);
  useEffect(() => {
    if (wait <= 0) return undefined;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);
  return wait;
}

/**
 * The error in plain words, with a retry button that waits out a rate
 * limit. `bar`: for a reader info bar (text and a BarButton) instead of
 * the dialog's Alert.
 */
export function ErrorMessage({ api, error, onRetry, bar = false }) {
  const wait = useWait(error);
  if (!error) return null;
  const t = api.i18n.t;
  const shown = error.code === 'rate_limit' && error.retryAfter
    ? (wait > 0 ? t('error.rate_limit_wait', { seconds: wait }) : t('error.rate_limit_now'))
    : messageFor(t, error);
  if (bar) {
    return (
      <Stack gap={2}>
        <Text tone="danger">{shown}</Text>
        {onRetry && (
          <Row>
            <BarButton icon="refresh" onClick={onRetry} disabled={wait > 0}>{t('common.retry')}</BarButton>
          </Row>
        )}
      </Stack>
    );
  }
  return (
    <Alert
      tone="danger"
      action={onRetry ? <Button variant="secondary" size="sm" onClick={onRetry} disabled={wait > 0}>{t('common.retry')}</Button> : null}
    >
      {shown}
    </Alert>
  );
}

/** A multi-line answer as body text, one paragraph per line. */
export function Lines({ text, tone }) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (
    <Stack gap={1}>
      {lines.map((line, i) => <Text key={i} tone={tone}>{line}</Text>)}
    </Stack>
  );
}
