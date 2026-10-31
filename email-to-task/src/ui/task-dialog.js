// The "Create task" dialog, rendered in the plugin-dialog slot. Plain
// React.createElement so it runs in the sandbox without a JSX step.
//
// Drawn with the app's UI kit: the host gives the dialog its surface,
// title and footer, so the body is just the fields, and the Cancel and
// Create buttons go to the host's footer through DialogButtons.

import * as React from 'react';
import { Alert, Button, Checkbox, DialogButtons, Field, Input, LinkButton, Loading, Row, Select, Spinner, Stack, Text, Textarea } from '@plugin-host/ui';
import { checkExisting, connectTarget, containersFor, createTasks, prepareDialog } from '../lib/dialog-model.js';
import { errorText, RECONNECT_CODES, toTaskError } from '../lib/errors.js';
import { PRIORITIES } from '../lib/priority.js';
import { AFTER_CHOICES } from '../lib/mark-done.js';
import { savePrefs } from '../lib/task-store.js';

const h = React.createElement;
const { useEffect, useMemo, useRef, useState } = React;

const CONTAINER_LABEL = { vikunja: 'container.project', todoist: 'container.project', caldav: 'container.list' };
const LOADING_LABEL = { vikunja: 'dialog.loading_lists', todoist: 'dialog.loading_lists', caldav: 'dialog.loading_task_lists' };

export function TaskDialog({ api, emailIds, onResult }) {
  const t = (key, vars) => api.i18n.t(key, vars);
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [items, setItems] = useState([]);
  const [target, setTarget] = useState(null);
  const [containers, setContainers] = useState({ status: 'idle', list: [], error: null });
  const [containerId, setContainerId] = useState('');
  const [after, setAfter] = useState('keyword');
  const [bulkPriority, setBulkPriority] = useState('auto');
  const [manualUrl, setManualUrl] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [failures, setFailures] = useState({});
  const firstField = useRef(null);
  const errorRef = useRef(null);
  const single = items.length === 1;

  // Load the messages, services and last choices.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await prepareDialog(api, { emailIds });
        if (cancelled) return;
        setState(s);
        setItems(s.items.map((i) => ({ ...i, include: true })));
        setTarget(s.target);
        setAfter(s.after);
        setManualUrl(s.prefs.caldavUrl || '');
        const checked = await checkExisting(api, s);
        if (!cancelled) setItems((now) => now.map((i) => ({ ...i, existing: checked.find((c) => c.emailId === i.emailId)?.existing ?? i.existing })));
      } catch (err) {
        if (!cancelled) setLoadError(toTaskError(err));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const targetInfo = useMemo(() => state?.targets.find((x) => x.id === target) ?? null, [state, target]);

  // Projects or task lists of the chosen service.
  const loadContainers = async (s = state, id = target) => {
    if (!s || !id || id === 'bulwark') {
      setContainers({ status: 'ready', list: [], error: null });
      return;
    }
    if (!s.targets.find((x) => x.id === id)?.connected) {
      setContainers({ status: 'idle', list: [], error: null });
      return;
    }
    setContainers({ status: 'loading', list: [], error: null });
    try {
      const list = await containersFor(api, s, id);
      setContainers({ status: 'ready', list, error: null });
      const remembered = s.prefs.containers?.[id];
      setContainerId(list.some((c) => c.id === remembered) ? remembered : list[0]?.id ?? '');
    } catch (err) {
      setContainers({ status: 'error', list: [], error: toTaskError(err) });
      setContainerId('');
    }
  };

  useEffect(() => {
    if (state && target) void loadContainers(state, target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, target]);

  useEffect(() => {
    if (state && firstField.current) firstField.current.focus();
  }, [state]);

  // The error sits at the end of the form, next to the footer's buttons;
  // bring it into view when the form is scrolled up. After a moment: the
  // host first grows the frame to fit it.
  useEffect(() => {
    if (!error) return undefined;
    const timer = setTimeout(() => errorRef.current?.scrollIntoView?.({ block: 'center' }), 150);
    return () => clearTimeout(timer);
  }, [error]);

  const serviceName = targetInfo?.name ?? '';

  const connect = async () => {
    setError(null);
    try {
      const accounts = await connectTarget(api, state, target);
      const next = {
        ...state,
        accounts,
        targets: state.targets.map((x) => (x.id === target ? { ...x, connected: x.id === 'bulwark' || !!accounts[target] } : x)),
      };
      setState(next);
    } catch (err) {
      setError(toTaskError(err));
    }
  };

  const searchAgain = async () => {
    const prefs = await savePrefs(api, { caldavUrl: manualUrl.trim() });
    const next = { ...state, prefs };
    setState(next);
  };

  const update = (emailId, patch) => setItems((now) => now.map((i) => (i.emailId === emailId ? { ...i, ...patch } : i)));

  const chosen = items.filter((i) => i.include);
  const needsContainer = target === 'vikunja';
  const canCreate = !!state && !!targetInfo?.connected && !busy && chosen.length > 0
    && containers.status !== 'loading' && (!needsContainer || !!containerId)
    && !(target === 'caldav' && !containerId);

  const create = async () => {
    setError(null);
    setFailures({});
    const form = {
      target,
      containerId,
      after,
      items: chosen.map((i) => ({ ...i, priority: single || bulkPriority === 'auto' ? i.priority : bulkPriority })),
    };
    setBusy({ done: 0, total: form.items.length });
    let result;
    try {
      result = await createTasks(api, state, form, (done, total) => setBusy({ done, total }));
    } catch (err) {
      setBusy(null);
      setError(toTaskError(err));
      return;
    }
    setBusy(null);
    const { created, failed } = result;
    if (created.length) {
      api.toast.success(created.length === 1
        ? t('created.one', { service: serviceName })
        : t('created.many', { count: created.length, service: serviceName }));
      if (created.some((c) => c.markFailed)) api.toast.warning(t('created.mark_failed'));
    }
    if (!failed.length) {
      onResult?.({ created: created.map((c) => c.emailId) });
      return;
    }
    // Keep the messages that failed, with what went wrong.
    const createdIds = new Set(created.map((c) => c.emailId));
    setItems((now) => now.filter((i) => !createdIds.has(i.emailId)));
    setFailures(Object.fromEntries(failed.map((f) => [f.emailId, f.error])));
    setError(failed[0].error);
  };

  // The host's footer: Cancel, then Create. Declared while loading too, so
  // the footer doesn't pop in once the messages are read.
  const createLabel = busy
    ? (busy.total > 1 ? t('dialog.creating_many', { done: busy.done, total: busy.total }) : t('dialog.creating'))
    : (chosen.length > 1 ? t('dialog.create_many', { count: chosen.length }) : t('dialog.create'));
  const footer = h(DialogButtons, {
    buttons: [
      { id: 'cancel', label: t('dialog.cancel'), variant: 'secondary', disabled: !!busy },
      { id: 'create', label: createLabel, variant: 'primary', disabled: !canCreate, busy: !!busy },
    ],
    onClick: (id) => {
      if (id === 'cancel') onResult?.(null);
      else if (id === 'create' && canCreate) void create();
    },
  });
  const closeOnly = h(DialogButtons, {
    buttons: [{ id: 'close', label: t('dialog.close'), variant: 'secondary' }],
    onClick: () => onResult?.(null),
  });

  if (loadError) {
    return h(Stack, { gap: 4 }, h(Alert, { tone: 'danger' }, errorText(t, loadError, '')), closeOnly);
  }
  if (!state) {
    return h(Stack, { gap: 4 }, h(Loading, { label: t('dialog.loading') }), footer);
  }
  if (!state.items.length) {
    return h(Stack, { gap: 4 }, h(Alert, { tone: 'danger' }, t('dialog.no_message')), closeOnly);
  }

  const existing = items.flatMap((i) => i.existing.map((ref) => ({ ...ref, emailId: i.emailId })));

  // Enter in a one-line field creates. Not a <form>: the sandbox frame has
  // no allow-forms, so a submit would be dropped before any handler runs.
  const onEnter = (e) => {
    if (e.key === 'Enter' && canCreate) {
      e.preventDefault();
      void create();
    }
  };

  const targetField = h(Field, { label: t('dialog.service') },
    h(Select, {
      block: true,
      value: target ?? '',
      disabled: !!busy,
      // Drop the last service's projects at once, not after they reload.
      onChange: (value) => {
        setError(null);
        if (value === target) return;
        setTarget(value);
        setContainers({ status: 'idle', list: [], error: null });
        setContainerId('');
      },
      options: state.targets.map((x) => ({ value: x.id, label: x.connected ? x.name : t('dialog.service_not_connected', { service: x.name }) })),
    }));

  const connectBox = targetInfo && !targetInfo.connected && h(Alert, {
    tone: 'info',
    action: h(Button, { size: 'sm', onClick: connect }, t('connect.button', { service: serviceName })),
  }, t(`connect.needed.${target}`, { service: serviceName }));

  let containerField = null;
  if (targetInfo?.connected && target !== 'bulwark') {
    if (containers.status === 'loading') {
      containerField = h(Spinner, { label: t(LOADING_LABEL[target] ?? 'dialog.loading_lists') });
    } else if (containers.status === 'error') {
      const reconnect = RECONNECT_CODES.has(containers.error?.code);
      containerField = h(Alert, {
        tone: 'danger',
        action: reconnect
          ? h(LinkButton, { onClick: connect }, t('connect.again'))
          : h(LinkButton, { onClick: () => loadContainers() }, t('dialog.retry')),
      }, errorText(t, containers.error, serviceName));
    } else if (containers.list.length) {
      containerField = h(Field, { label: t(CONTAINER_LABEL[target]) },
        h(Select, {
          block: true,
          value: containerId,
          disabled: !!busy,
          onChange: (value) => setContainerId(value),
          options: containers.list.map((c) => ({ value: c.id, label: c.name })),
        }));
    } else if (target === 'caldav' && containers.status === 'ready') {
      containerField = h(Stack, { gap: 3 },
        h(Alert, { tone: 'warning' }, t('caldav.none_found')),
        h(Field, { label: t('caldav.address') },
          h(Input, { type: 'url', value: manualUrl, placeholder: 'https://', onChange: (e) => setManualUrl(e.target.value) })),
        h(Row, null, h(Button, { variant: 'secondary', size: 'sm', onClick: searchAgain }, t('caldav.search_again'))));
    }
  }

  const existingNote = existing.length > 0 && h(Alert, {
    tone: 'warning',
    action: existing[0].url && single
      ? h(LinkButton, { onClick: () => api.ui.openExternalUrl(existing[0].url) }, t('existing.open'))
      : undefined,
  }, single
    ? t('existing.single', { service: state.targets.find((x) => x.id === existing[0].target)?.name ?? existing[0].target, title: existing[0].title })
    : t('existing.many', { count: new Set(existing.map((e) => e.emailId)).size }));

  // Hidden for services that don't keep a priority.
  const withPriority = targetInfo?.priority !== false;
  const priorityOptions = (withAuto) => [
    ...(withAuto ? [{ value: 'auto', label: t('priority.auto') }] : []),
    ...PRIORITIES.map((p) => ({ value: p, label: t(`priority.${p}`) })),
  ];

  const fields = single ? (() => {
    const item = items[0];
    return [
      h(Field, { key: 'title', label: t('dialog.title') },
        h(Input, { type: 'text', ref: firstField, value: item.title, maxLength: 500, onKeyDown: onEnter, onChange: (e) => update(item.emailId, { title: e.target.value }) })),
      h(Field, { key: 'description', label: t('dialog.description'), hint: t('dialog.description_hint', { service: serviceName }) },
        h(Textarea, { value: item.description, rows: 4, maxLength: 10000, onChange: (e) => update(item.emailId, { description: e.target.value }) })),
      h(Field, { key: 'due', label: t('dialog.due'), hint: item.dueMatch ? t('dialog.due_found', { words: item.dueMatch }) : undefined },
        h(Input, { type: 'date', value: item.due, onChange: (e) => update(item.emailId, { due: e.target.value, dueMatch: '' }) })),
      withPriority && h(Field, { key: 'priority', label: t('dialog.priority') },
        h(Select, { block: true, value: item.priority, onChange: (value) => update(item.emailId, { priority: value }), options: priorityOptions(false) })),
    ];
  })() : [
    h(Text, { key: 'count', tone: 'muted' }, t('dialog.bulk_intro', { count: items.length })),
    ...items.map((item, index) => h(Stack, { key: item.emailId, gap: 2 },
      h(Checkbox, {
        checked: item.include,
        label: t('dialog.include', { title: item.subject || item.title }),
        onChange: (include) => update(item.emailId, { include }),
      }),
      item.include && h(Row, { gap: 2, wrap: false },
        h(Input, {
          type: 'text',
          ref: index === 0 ? firstField : undefined,
          value: item.title,
          maxLength: 500,
          'aria-label': t('dialog.title_for', { subject: item.subject || item.title }),
          onKeyDown: onEnter,
          onChange: (e) => update(item.emailId, { title: e.target.value }),
        }),
        h(Input, {
          type: 'date',
          value: item.due,
          'aria-label': t('dialog.due_for', { subject: item.subject || item.title }),
          title: item.dueMatch ? t('dialog.due_found', { words: item.dueMatch }) : undefined,
          onChange: (e) => update(item.emailId, { due: e.target.value }),
        })),
      failures[item.emailId] ? h(Text, { tone: 'danger', size: 'xs' }, errorText(t, failures[item.emailId], serviceName)) : null)),
    withPriority && h(Field, { key: 'priority', label: t('dialog.priority') },
      h(Select, { block: true, value: bulkPriority, onChange: (value) => setBulkPriority(value), options: priorityOptions(true) })),
  ];

  const reconnect = error && RECONNECT_CODES.has(error.code);

  return h(Stack, { gap: 4 },
    targetField,
    connectBox,
    containerField,
    existingNote,
    state.missing.length > 0 && h(Alert, { tone: 'warning' }, t('dialog.missing', { count: state.missing.length })),
    state.skipped > 0 && h(Alert, { tone: 'warning' }, t('dialog.too_many', { count: state.skipped })),
    ...fields,
    h(Field, { label: t('after.label') },
      h(Select, { block: true, value: after, onChange: (value) => setAfter(value), options: AFTER_CHOICES.map((c) => ({ value: c, label: t(`after.${c}`) })) })),
    error && h(Alert, {
      tone: 'danger',
      action: reconnect ? h(LinkButton, { onClick: connect }, t('connect.again')) : undefined,
    }, h('span', { ref: errorRef }, errorText(t, error, serviceName))),
    footer);
}
