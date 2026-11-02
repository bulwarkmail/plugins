// The background part: the buttons the host draws for the assistant (the
// Assistant button in the composer's bottom bar with Alt+A, the entries in
// the right-click menus on selected text), opening the assistant's panel
// for them (or the dialog where there is no panel: phones), what the
// composer is about for the chat, and whether a service is set up, so the
// buttons only show when they can work.

import { loadSetup } from './assistant.js';
import { withStrings } from './i18n.js';

export const DRAFT_KEY = 'draft';
/** What the open composer is: { mode, inReplyToId, originalSubject, at } (onComposerOpen). */
export const COMPOSER_CONTEXT_KEY = 'composer:context';
export const COMPOSER_SURFACE = 'composer-toolbar-actions';
export const READER_SURFACE = 'reader-actions';
export const COMPOSER_MENU_SURFACE = 'composer-selection-menu';
export const READER_MENU_SURFACE = 'reader-selection-menu';
export const COMPOSER_PANEL = 'composer-sidebar-right';
export const READER_PANEL = 'email-detail-sidebar';
export const ACTION_ID = 'assistant';
export const SHORTCUT = 'Alt+A';
const REFRESH_EVERY_MS = 30_000;

/** The saved transcript of a chat. */
export const chatKey = (mode, id) => `chat:${mode === 'composer' ? 'composer' : 'email'}:${id}`;
/** The reader's conversation: one for all messages, the panel stays while the user reads on. */
export const READER_CHAT_KEY = 'chat:reader';
/** A request from a button or menu entry for the panel to run when it shows: { action, text, at }. */
export const pendingKey = (mode, id) => `pending:${mode === 'composer' ? 'composer' : 'email'}:${id}`;

/** The right-click entries on selected text in the composer, in order. */
export const COMPOSER_MENU_ACTIONS = ['improve', 'grammar', 'shorter', 'translate', 'ask'];
/** The right-click entries on selected text in a message, in order. */
export const READER_MENU_ACTIONS = ['explain', 'translate', 'reply', 'ask'];
const MENU_ICONS = { improve: 'sparkles', grammar: 'text-spellcheck', shorter: 'text-decrease', translate: 'language', ask: 'message-circle', explain: 'help-circle', reply: 'arrow-back-up' };

export function createBackground(api, { now = () => Date.now() } = {}) {
  withStrings(api);
  const state = { configured: false, showInReader: true, checkedAt: 0 };
  let shownActions = null;
  let dialogOpen = false;
  const t = (key, vars) => api.i18n.t(key, vars);

  async function syncActions() {
    // Only offered while a service is set up; only sent when that changes.
    const want = `${state.configured}:${state.showInReader}`;
    if (shownActions === want) return;
    shownActions = want;
    try {
      await Promise.all([
        api.ui.setActions(COMPOSER_SURFACE, state.configured
          ? [{ id: ACTION_ID, label: t('composer.open'), icon: 'sparkles', shortcut: SHORTCUT }]
          : []),
        api.ui.setActions(COMPOSER_MENU_SURFACE, state.configured
          ? COMPOSER_MENU_ACTIONS.map((action, i) => ({ id: action, label: t(`menu.${action}`), icon: MENU_ICONS[action], order: 10 + i }))
          : []),
        api.ui.setActions(READER_MENU_SURFACE, state.configured && state.showInReader
          ? READER_MENU_ACTIONS.map((action, i) => ({ id: action, label: t(`menu.${action}`), icon: MENU_ICONS[action], order: 10 + i }))
          : []),
        api.ui.setActions(READER_SURFACE, state.configured && state.showInReader
          ? [{ id: ACTION_ID, label: t('composer.open'), icon: 'sparkles' }]
          : []),
      ]);
    } catch (err) {
      shownActions = null;
      api.log?.warn?.('setActions failed', err?.message ?? err);
    }
  }

  async function refresh(force = false) {
    // Look again at once while nothing is set up (or the last look failed);
    // once a service is known, at most every 30 s.
    if (!force && state.configured && now() - state.checkedAt < REFRESH_EVERY_MS) return state;
    state.checkedAt = now();
    try {
      const setup = await loadSetup(api);
      state.configured = !!setup.endpoint;
      state.showInReader = setup.prefs.showInReader !== false;
    } catch {
      state.configured = false;
    }
    await syncActions();
    return state;
  }

  /** The assistant dialog for one composer, where there is no panel. Not awaited by hooks: it waits for the user. */
  async function openDialog(composerId) {
    if (typeof composerId !== 'string' || !composerId || dialogOpen) return null;
    dialogOpen = true;
    try {
      return await api.ui.openDialog({
        title: t('composer.title'),
        slot: 'plugin-dialog',
        width: 680,
        extraProps: { composerId },
      });
    } catch (err) {
      api.log?.warn?.('assistant dialog failed', err?.message ?? err);
      return null;
    } finally {
      dialogOpen = false;
    }
  }

  /**
   * Bring the panel up with a request for it: a quick action on `text`
   * (from a right-click), or just the focus ('ask'). Where there is no
   * panel (a phone), the composer falls back to the dialog.
   */
  async function openPanel(mode, id, request) {
    if (typeof id !== 'string' || !id) return false;
    try {
      await api.storage.set(pendingKey(mode, id), { ...request, at: now() });
    } catch { /* the panel then just opens */ }
    let open = null;
    try {
      open = mode === 'composer'
        ? await api.ui.openPanel(COMPOSER_PANEL, { composerId: id })
        : await api.ui.openPanel(READER_PANEL);
    } catch (err) {
      api.log?.warn?.('openPanel failed', err?.message ?? err);
    }
    if (open === true) return true;
    await api.storage.remove(pendingKey(mode, id)).catch(() => {});
    if (mode === 'composer') void openDialog(id);
    return false;
  }

  /** The Assistant button in the reader's toolbar: the panel next to the message (phones have the bar). */
  async function toggleReaderPanel() {
    try {
      await api.ui.togglePanel(READER_PANEL);
    } catch (err) {
      api.log?.warn?.('togglePanel failed', err?.message ?? err);
    }
  }

  /** The Assistant button and Alt+A: the panel, closed when it is open and nothing is asked. */
  async function toggleComposerPanel(composerId) {
    if (typeof composerId !== 'string' || !composerId) return;
    let open = null;
    try {
      open = await api.ui.togglePanel(COMPOSER_PANEL, { composerId });
    } catch (err) {
      api.log?.warn?.('togglePanel failed', err?.message ?? err);
    }
    if (open === null) void openDialog(composerId);
  }

  const forgetDraft = async () => {
    await api.storage.remove(DRAFT_KEY);
  };

  /** Chats of closed composers are not kept. */
  async function forgetComposerChats() {
    try {
      const keys = await api.storage.keys();
      await Promise.all(keys.filter((k) => k.startsWith('chat:composer:') || k.startsWith('pending:composer:')).map((k) => api.storage.remove(k)));
    } catch { /* nothing to forget */ }
  }

  /** The per-message chats of versions before the one reader chat (chat:email:*), never read any more. */
  async function forgetOldReaderChats() {
    try {
      const keys = await api.storage.keys();
      await Promise.all(keys.filter((k) => k.startsWith('chat:email:')).map((k) => api.storage.remove(k)));
    } catch { /* nothing to forget */ }
  }

  return {
    state,
    refresh,
    openPanel,
    openDialog,
    async activate() {
      // Drafts and chats left over from a closed tab are not kept.
      await forgetDraft();
      await forgetComposerChats();
      await forgetOldReaderChats();
      await api.storage.remove(COMPOSER_CONTEXT_KEY).catch(() => {});
      await refresh(true);
    },
    hooks: {
      onAction({ surface, actionId, context } = {}) {
        if (surface === COMPOSER_SURFACE && actionId === ACTION_ID) {
          void toggleComposerPanel(context?.composerId);
        } else if (surface === READER_SURFACE && actionId === ACTION_ID) {
          void toggleReaderPanel();
        } else if (surface === COMPOSER_MENU_SURFACE) {
          void openPanel('composer', context?.composerId, { action: actionId, text: context?.selection?.text ?? '' });
        } else if (surface === READER_MENU_SURFACE) {
          void openPanel('reader', context?.emailId, { action: actionId, text: context?.selection?.text ?? '' });
        }
      },
      // Only the subject: the panel reads the text itself from the composer.
      async onDraftChange(draft) {
        await api.storage.set(DRAFT_KEY, {
          subject: typeof draft?.subject === 'string' ? draft.subject : '',
          at: now(),
        });
      },
      // What the composer is about, for the chat (a reply knows its original).
      async onComposerOpen(ctx) {
        await api.storage.set(COMPOSER_CONTEXT_KEY, {
          mode: typeof ctx?.mode === 'string' ? ctx.mode : 'new',
          ...(typeof ctx?.inReplyToId === 'string' ? { inReplyToId: ctx.inReplyToId } : {}),
          ...(typeof ctx?.originalSubject === 'string' ? { originalSubject: ctx.originalSubject } : {}),
          at: now(),
        }).catch(() => {});
        await refresh();
      },
      async onComposerClose() {
        await forgetDraft();
        await forgetComposerChats();
        await api.storage.remove(COMPOSER_CONTEXT_KEY).catch(() => {});
      },
      async onEmailOpen() {
        await refresh();
      },
    },
    shouldShow: {
      reader: () => state.configured && state.showInReader,
      thread: (ctx) => state.configured && state.showInReader && Array.isArray(ctx?.emailIds) && ctx.emailIds.length > 1,
      composer: () => state.configured,
    },
  };
}
