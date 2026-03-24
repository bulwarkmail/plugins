/**
 * Email Stats Plugin — sidebar widget example.
 *
 * Demonstrates:
 * - Registering a sidebar widget with React
 * - Tracking email events with hooks
 * - Using plugin storage for persistence
 * - Using plugin settings
 * - Creating React components without JSX (no build step needed for React.createElement)
 */

// React is provided by the host app — access lazily to ensure externals are set
function getReact() { return globalThis.__PLUGIN_EXTERNALS__?.React; }
const h = (...args) => getReact().createElement(...args);
const useState = (...args) => getReact().useState(...args);
const useEffect = (...args) => getReact().useEffect(...args);

// In-memory session counters (reset on reload)
let sessionStats = { opened: 0, sent: 0, received: 0 };

// Listeners for state updates
const listeners = new Set();
function notifyListeners() {
  listeners.forEach((fn) => fn({ ...sessionStats }));
}

function StatsWidget() {
  const [stats, setStats] = useState({ ...sessionStats });

  useEffect(() => {
    listeners.add(setStats);
    return () => listeners.delete(setStats);
  }, []);

  const today = new Date().toLocaleDateString();

  return h('div', { style: { padding: '12px', fontSize: '13px' } },
    h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, `Session Stats — ${today}`),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
        h('span', null, '📖 Opened'),
        h('span', { style: { fontWeight: 600 } }, stats.opened),
      ),
      h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
        h('span', null, '📤 Sent'),
        h('span', { style: { fontWeight: 600 } }, stats.sent),
      ),
      h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
        h('span', null, '📥 Received'),
        h('span', { style: { fontWeight: 600 } }, stats.received),
      ),
    ),
  );
}

export function activate(api) {
  const disposables = [];

  // Reset session stats
  sessionStats = { opened: 0, sent: 0, received: 0 };

  // Load lifetime totals from storage
  const lifetime = api.storage.get('lifetime') || { opened: 0, sent: 0, received: 0 };

  // Track email opens
  if (api.plugin.settings.trackOpens !== false) {
    disposables.push(
      api.hooks.onEmailOpen(() => {
        sessionStats.opened++;
        lifetime.opened++;
        api.storage.set('lifetime', lifetime);
        notifyListeners();
      })
    );
  }

  // Track sent emails
  if (api.plugin.settings.trackSent !== false) {
    disposables.push(
      api.hooks.onAfterEmailSend(() => {
        sessionStats.sent++;
        lifetime.sent++;
        api.storage.set('lifetime', lifetime);
        notifyListeners();
      })
    );
  }

  // Track received emails
  disposables.push(
    api.hooks.onNewEmailReceived(() => {
      sessionStats.received++;
      lifetime.received++;
      api.storage.set('lifetime', lifetime);
      notifyListeners();
    })
  );

  // Register sidebar widget
  disposables.push(
    api.ui.registerSidebarWidget({
      id: 'email-stats-widget',
      label: 'Email Stats',
      render: StatsWidget,
      order: 10,
    })
  );

  api.log.info('Email Stats plugin activated');

  return {
    dispose: () => {
      disposables.forEach((d) => d.dispose());
      listeners.clear();
    },
  };
}
