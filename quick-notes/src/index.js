/**
 * Quick Notes Plugin — per-email sticky notes in the sidebar.
 *
 * Demonstrates:
 * - Sidebar widget with interactive React UI
 * - Email banner showing note indicators
 * - Combining hooks with UI components
 * - Using storage for data persistence
 * - React state management with useState/useEffect
 * - Number-type settings (maxNotes)
 */

// React is provided by the host app — access lazily to ensure externals are set
function getReact() { return globalThis.__PLUGIN_EXTERNALS__?.React; }
const h = (...args) => getReact().createElement(...args);
const useState = (...args) => getReact().useState(...args);
const useEffect = (...args) => getReact().useEffect(...args);
const useCallback = (...args) => getReact().useCallback(...args);

// Shared state between widget and hooks
let currentEmailId = null;
let pluginApi = null;
const stateListeners = new Set();

function notifyStateChange() {
  stateListeners.forEach((fn) => fn());
}

function getNotes() {
  if (!pluginApi) return {};
  return pluginApi.storage.get('notes') || {};
}

function saveNote(emailId, text) {
  if (!pluginApi) return;
  const notes = getNotes();
  const maxNotes = pluginApi.plugin.settings.maxNotes || 100;

  if (text.trim()) {
    notes[emailId] = {
      text: text.trim(),
      updatedAt: new Date().toISOString(),
    };
  } else {
    delete notes[emailId];
  }

  // Enforce max notes limit — remove oldest
  const entries = Object.entries(notes);
  if (entries.length > maxNotes) {
    entries.sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt));
    const toRemove = entries.slice(0, entries.length - maxNotes);
    for (const [key] of toRemove) {
      delete notes[key];
    }
  }

  pluginApi.storage.set('notes', notes);
  notifyStateChange();
}

// ─── Sidebar Widget Component ──────────────────────────────

function NotesWidget() {
  const [noteText, setNoteText] = useState('');
  const [emailId, setEmailId] = useState(currentEmailId);

  useEffect(() => {
    const update = () => {
      setEmailId(currentEmailId);
      if (currentEmailId) {
        const notes = getNotes();
        setNoteText(notes[currentEmailId]?.text || '');
      } else {
        setNoteText('');
      }
    };

    stateListeners.add(update);
    update();
    return () => stateListeners.delete(update);
  }, []);

  const handleSave = useCallback(() => {
    if (emailId) {
      saveNote(emailId, noteText);
      pluginApi?.toast.success('Note saved');
    }
  }, [emailId, noteText]);

  if (!emailId) {
    return h('div', {
      style: { padding: '16px', color: '#888', textAlign: 'center', fontSize: '13px' },
    }, 'Open an email to add notes');
  }

  const noteCount = Object.keys(getNotes()).length;

  return h('div', { style: { padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' } },
    h('div', { style: { fontSize: '12px', color: '#888' } }, `${noteCount} note(s) stored`),
    h('textarea', {
      value: noteText,
      onChange: (e) => setNoteText(e.target.value),
      placeholder: 'Add a note about this email...',
      rows: 4,
      style: {
        width: '100%',
        padding: '8px',
        borderRadius: '6px',
        border: '1px solid var(--color-border, #e2e8f0)',
        background: 'var(--color-background, #fff)',
        color: 'var(--color-foreground, #000)',
        fontSize: '13px',
        resize: 'vertical',
        fontFamily: 'inherit',
      },
    }),
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('button', {
        onClick: handleSave,
        style: {
          flex: 1,
          padding: '6px 12px',
          borderRadius: '6px',
          border: 'none',
          background: 'var(--color-primary, #3b82f6)',
          color: 'var(--color-primary-foreground, #fff)',
          cursor: 'pointer',
          fontSize: '13px',
        },
      }, 'Save'),
      noteText.trim() && h('button', {
        onClick: () => {
          setNoteText('');
          if (emailId) saveNote(emailId, '');
          pluginApi?.toast.info('Note removed');
        },
        style: {
          padding: '6px 12px',
          borderRadius: '6px',
          border: '1px solid var(--color-border, #e2e8f0)',
          background: 'transparent',
          color: 'var(--color-destructive, #ef4444)',
          cursor: 'pointer',
          fontSize: '13px',
        },
      }, 'Delete'),
    ),
  );
}

// ─── Email Banner Component ────────────────────────────────

function NoteBanner({ email }) {
  const notes = getNotes();
  const note = notes[email.id];
  if (!note) return null;

  return h('div', {
    style: {
      padding: '6px 12px',
      background: 'var(--color-accent, #eef)',
      color: 'var(--color-accent-foreground, #333)',
      fontSize: '12px',
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
    },
  },
    '📝',
    h('span', null, `Note: ${note.text.slice(0, 80)}${note.text.length > 80 ? '...' : ''}`),
  );
}

// ─── Plugin Activation ─────────────────────────────────────

export function activate(api) {
  pluginApi = api;
  const disposables = [];

  // Track current email
  disposables.push(
    api.hooks.onEmailOpen((email) => {
      currentEmailId = email.id;
      notifyStateChange();
    })
  );

  disposables.push(
    api.hooks.onEmailClose(() => {
      currentEmailId = null;
      notifyStateChange();
    })
  );

  // Register sidebar widget
  disposables.push(
    api.ui.registerSidebarWidget({
      id: 'quick-notes',
      label: 'Quick Notes',
      render: NotesWidget,
      order: 20,
    })
  );

  // Register email banner (if enabled)
  if (api.plugin.settings.showBanner !== false) {
    disposables.push(
      api.ui.registerEmailBanner({
        shouldShow: (email) => {
          const notes = getNotes();
          return !!notes[email.id];
        },
        render: NoteBanner,
      })
    );
  }

  api.log.info('Quick Notes plugin activated');

  return {
    dispose: () => {
      disposables.forEach((d) => d.dispose());
      stateListeners.clear();
      pluginApi = null;
      currentEmailId = null;
    },
  };
}
