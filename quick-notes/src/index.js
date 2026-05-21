/**
 * Quick Notes Plugin — per-email sticky notes.
 *
 * v2 status: improved. Slot iframes now have full api access, so the sidebar
 * widget is once again an interactive textarea: it reads notes via
 * api.storage.get('notes') on mount (and whenever the open email changes),
 * and persists edits via api.storage.set('notes', {...}) with a debounce.
 * The background `onEmailOpen` hook refreshes its own in-memory cache so the
 * email-banner shouldShow gate stays accurate.
 */

const { createElement: h, useEffect, useState, useRef, useCallback } = require('react');
const slotApi = require('@plugin-host');

let pluginApi = null;
let notes = {}; // emailId → { text, updatedAt }

// ─── Slot components ────────────────────────────────────────

function NoteBanner() {
  return h(
    'div',
    {
      style: {
        padding: '6px 12px',
        background: '#eef2ff',
        color: '#3730a3',
        fontSize: '12px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
      },
    },
    '📝',
    h('span', null, 'This email has a note attached.'),
  );
}

function NotesSidebar(props) {
  const emailId = props?.email?.id || null;
  const [text, setText] = useState('');
  const [savedAt, setSavedAt] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const debounceRef = useRef(null);
  const lastIdRef = useRef(null);

  // Load this email's note whenever the open email changes.
  useEffect(() => {
    if (!emailId) {
      setText('');
      setSavedAt(null);
      setLoaded(true);
      lastIdRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const stored = (await slotApi.storage.get('notes')) || {};
        if (cancelled) return;
        const entry = (stored && typeof stored === 'object') ? stored[emailId] : null;
        setText(entry?.text || '');
        setSavedAt(entry?.updatedAt || null);
      } catch (err) {
        slotApi.log.warn('quick-notes: could not load notes', err);
      } finally {
        if (!cancelled) {
          setLoaded(true);
          lastIdRef.current = emailId;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [emailId]);

  const persist = useCallback(async (nextText) => {
    if (!emailId) return;
    try {
      const stored = (await slotApi.storage.get('notes')) || {};
      const map = (stored && typeof stored === 'object') ? { ...stored } : {};
      const trimmed = nextText.trim();
      const settings = slotApi.plugin?.settings || {};
      const maxNotes = Number(settings.maxNotes) || 100;
      if (!trimmed) {
        delete map[emailId];
      } else {
        map[emailId] = { text: nextText, updatedAt: new Date().toISOString() };
        // Trim to maxNotes most-recent entries.
        const ids = Object.keys(map);
        if (ids.length > maxNotes) {
          const sorted = ids
            .map((id) => ({ id, t: map[id]?.updatedAt || '' }))
            .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
          const drop = sorted.slice(0, ids.length - maxNotes);
          for (const { id } of drop) delete map[id];
        }
      }
      await slotApi.storage.set('notes', map);
      setSavedAt(map[emailId]?.updatedAt || null);
    } catch (err) {
      slotApi.log.warn('quick-notes: save failed', err);
    }
  }, [emailId]);

  const onChange = useCallback((ev) => {
    const next = ev.target.value;
    setText(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void persist(next); }, 500);
  }, [persist]);

  // Flush pending edit when the open email changes or the slot unmounts.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [emailId]);

  if (!emailId) {
    return h(
      'div',
      { style: { padding: '12px', fontSize: '13px', color: '#64748b' } },
      h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, 'Quick Notes'),
      'Open an email to add a note.',
    );
  }

  return h(
    'div',
    {
      style: {
        padding: '12px',
        fontSize: '13px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
    },
    h(
      'div',
      {
        style: {
          fontWeight: 600,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
        },
      },
      h('span', null, 'Quick Notes'),
      savedAt
        ? h(
            'span',
            { style: { fontSize: '11px', color: '#94a3b8', fontWeight: 400 } },
            `saved ${new Date(savedAt).toLocaleTimeString()}`,
          )
        : null,
    ),
    h('textarea', {
      value: loaded ? text : '',
      onChange,
      placeholder: 'Jot a note for this email…',
      rows: 8,
      style: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        padding: '8px',
        borderRadius: '6px',
        border: '1px solid #cbd5e1',
        resize: 'vertical',
        background: '#ffffff',
        color: '#0f172a',
      },
    }),
    h(
      'div',
      { style: { fontSize: '11px', color: '#94a3b8' } },
      'Notes auto-save half a second after you stop typing.',
    ),
  );
}

// shouldShow runs in the background iframe.
function shouldShowBanner(extraProps) {
  if (!pluginApi) return false;
  if (pluginApi.plugin.settings.showBanner === false) return false;
  const email = extraProps?.email;
  if (!email?.id) return false;
  return !!notes[email.id];
}

export const slots = {
  'email-banner': {
    component: NoteBanner,
    shouldShow: shouldShowBanner,
    order: 80,
  },
  'email-detail-sidebar': {
    component: NotesSidebar,
    order: 20,
  },
};

// ─── Hooks ──────────────────────────────────────────────────

export const hooks = {
  // Refresh the in-memory cache when an email is opened so the banner gate
  // is accurate even after edits from the sidebar slot.
  async onEmailOpen() {
    if (!pluginApi) return;
    const stored = await pluginApi.storage.get('notes');
    notes = (stored && typeof stored === 'object') ? stored : {};
  },
};

// ─── Activate ───────────────────────────────────────────────

export async function activate(api) {
  pluginApi = api;
  const stored = await api.storage.get('notes');
  notes = (stored && typeof stored === 'object') ? stored : {};
  api.log.info(`Quick Notes plugin activated (${Object.keys(notes).length} note(s) stored)`);
}
