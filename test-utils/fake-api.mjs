// A stand-in for the `api` object the webmail hands a plugin, for unit tests.
//
//   const api = fakeApi({
//     permissions: ['http:proxy'],
//     settings: { folder: '/Mail' },
//     handlers: { 'proxy.fetch': async (credentialId, url, init) => ({ status: 200, ok: true, headers: {}, body: '...' }) },
//   });
//   await plugin.activate(api);
//   expect(api.calls('ui.setActions')).toHaveLength(1);
//
// Every method of every namespace exists: `api.anything.method(...)` records
// the call and returns what `handlers['anything.method']` returns (undefined
// without a handler). storage, i18n and plugin.settings work for real.
//
// `hostFeatures: { externalMailWarnings: true }` adds api.host as Bulwark
// 1.19 and later have it; `api.setHostFeatures(next)` changes it like the
// host does. Without the option api.host is missing, as on older hosts.

export function fakeApi({
  id = 'test-plugin',
  version = '1.0.0',
  settings = {},
  locale = 'en',
  dateLocale,
  timeFormat,
  timeZone,
  firstDayOfWeek = 1,
  translations = {},
  handlers = {},
  hostFeatures,
} = {}) {
  const log = [];
  const store = new Map();
  const settingsListeners = [];
  const localeListeners = [];
  const hostListeners = [];
  let currentLocale = locale;
  let currentDateLocale = dateLocale;
  let currentTimeFormat = timeFormat;
  let currentTimeZone = timeZone;
  let currentFirstDayOfWeek = firstDayOfWeek;

  const call = (method, args) => {
    log.push({ method, args });
    const handler = handlers[method];
    return handler ? handler(...args) : undefined;
  };

  const lookup = (key) => {
    const chain = [currentLocale, currentLocale.split('-')[0], 'en'];
    for (const l of chain) {
      const v = translations[l]?.[key];
      if (typeof v === 'string') return v;
    }
    return undefined;
  };

  const formatIntl = (date, options = {}) => {
    try {
      const d = date instanceof Date ? date : new Date(date);
      if (isNaN(d.getTime())) return '';
      const opts = {
        ...(currentTimeZone ? { timeZone: currentTimeZone } : {}),
        ...options,
      };
      return new Intl.DateTimeFormat(currentDateLocale ?? currentLocale, opts).format(d);
    } catch {
      return '';
    }
  };

  const known = {
    plugin: {
      // Same shape as the real api.plugin: no permission list.
      id,
      version,
      settings: { ...settings },
      onSettingsChange(fn) { settingsListeners.push(fn); return () => {}; },
    },
    storage: {
      get: async (key) => (store.has(key) ? structuredClone(store.get(key)) : null),
      set: async (key, value) => { store.set(key, structuredClone(value)); },
      remove: async (key) => { store.delete(key); },
      keys: async () => [...store.keys()],
    },
    i18n: {
      get locale() { return currentLocale; },
      get dateLocale() { return currentDateLocale ?? currentLocale; },
      get timeFormat() { return currentTimeFormat ?? (new Intl.DateTimeFormat(currentDateLocale ?? currentLocale, { hour: 'numeric' }).resolvedOptions().hour12 ? '12h' : '24h'); },
      get hour12() { return currentTimeFormat ? currentTimeFormat === '12h' : (new Intl.DateTimeFormat(currentDateLocale ?? currentLocale, { hour: 'numeric' }).resolvedOptions().hour12 ?? false); },
      get timeZone() { return currentTimeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'); },
      get firstDayOfWeek() { return currentFirstDayOfWeek; },
      formatTime: (date, options = {}) => formatIntl(date, {
        hour: '2-digit',
        minute: '2-digit',
        ...(currentTimeFormat ? { hour12: currentTimeFormat === '12h' } : {}),
        ...options,
      }),
      formatDate: (date, options = {}) => formatIntl(date, options),
      t(key, vars) {
        const text = lookup(key) ?? key;
        return text.replace(/\{(\w+)\}/g, (m, name) => (vars && name in vars ? String(vars[name]) : m));
      },
      has: (key) => lookup(key) !== undefined,
      getLocale: () => currentLocale,
      addTranslations(l, table) { translations[l] = { ...(translations[l] ?? {}), ...table }; },
      onLocaleChange(fn) { localeListeners.push(fn); return () => {}; },
    },
  };

  if (hostFeatures) {
    known.host = {
      features: { ...hostFeatures },
      onFeaturesChange(fn) { hostListeners.push(fn); return () => {}; },
    };
  }

  const namespace = (name) => new Proxy({}, {
    get(_t, method) {
      if (typeof method !== 'string') return undefined;
      return (...args) => call(`${name}.${method}`, args);
    },
  });

  const api = new Proxy(known, {
    get(target, name) {
      if (name === 'calls') return (method) => (method ? log.filter((c) => c.method === method) : [...log]);
      if (name === 'setLocale') return (l, regional = {}) => {
        currentLocale = l;
        if (regional.dateLocale !== undefined) currentDateLocale = regional.dateLocale;
        if (regional.hour12 !== undefined) currentTimeFormat = regional.hour12 ? '12h' : '24h';
        if (regional.timeFormat !== undefined) currentTimeFormat = regional.timeFormat;
        if (regional.timeZone !== undefined) currentTimeZone = regional.timeZone;
        if (regional.firstDayOfWeek !== undefined) currentFirstDayOfWeek = regional.firstDayOfWeek;
        for (const fn of localeListeners) fn(l);
      };
      if (name === 'changeSettings') return (next) => { Object.assign(target.plugin.settings, next); for (const fn of settingsListeners) fn({ ...target.plugin.settings }); };
      if (name === 'storageSnapshot') return () => Object.fromEntries(store);
      if (name === 'setHostFeatures') return (next) => { Object.assign(target.host.features, next); for (const fn of hostListeners) fn(target.host.features); };
      if (typeof name !== 'string') return undefined;
      if (name in target) return target[name];
      const ns = namespace(name);
      target[name] = ns;
      return ns;
    },
  });
  return api;
}

/** A proxy.fetch answer, for handlers. */
export function proxyResponse(body, { status = 200, headers = {} } = {}) {
  return { status, ok: status >= 200 && status < 300, headers, body };
}
