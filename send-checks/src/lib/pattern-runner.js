/**
 * Runs the admin's patterns away from the page. A regular expression can
 * take seconds or minutes on a short text (catastrophic backtracking), and
 * JavaScript can't stop one exec() from the outside. So the patterns run in
 * a Worker made from a blob URL, and the Worker is terminated when the time
 * budget is over. Nothing the admin wrote runs on the plugin's own thread.
 *
 * Without a Worker (an old host whose sandbox forbids blob workers, a test
 * environment) the patterns aren't run at all and the result says so
 * (`complete: false`): the caller treats that as "couldn't check".
 */

export const PATTERN_BUDGET_MS = 250;

/**
 * The worker's code, as a string so no bundler step can change it. It gets
 * { rules: [{ name, source, flags }], texts: [string] } and answers
 * { found: [{ text, name, match }] }: the first match of each rule in each
 * text.
 */
export const WORKER_SOURCE = `
self.onmessage = function (event) {
  var data = event.data || {};
  var rules = data.rules || [];
  var texts = data.texts || [];
  var found = [];
  for (var t = 0; t < texts.length; t++) {
    var text = String(texts[t] || '');
    if (!text) continue;
    for (var r = 0; r < rules.length; r++) {
      var re;
      try { re = new RegExp(rules[r].source, rules[r].flags); } catch (e) { continue; }
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(text))) {
        if (m[0]) { found.push({ text: t, name: rules[r].name, match: m[0] }); break; }
        re.lastIndex += 1;
      }
    }
  }
  self.postMessage({ found: found });
};
`;

/** A Worker running WORKER_SOURCE, or null when this environment can't make one. */
export function defaultCreateWorker() {
  try {
    if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return null;
    }
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    const worker = new Worker(url);
    // The worker has its own copy of the code; the URL isn't needed any more.
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    return worker;
  } catch {
    return null;
  }
}

/**
 * Every rule over every text, within `budgetMs`. Resolves to
 * { found: [{ text (index), name, match }], complete } where complete is
 * false when the budget ran out, no Worker could be made, or it failed.
 */
export function runPatterns(texts, rules, { budgetMs = PATTERN_BUDGET_MS, createWorker = defaultCreateWorker } = {}) {
  const work = texts.map((t) => String(t ?? ''));
  if (rules.length === 0 || !work.some(Boolean)) return Promise.resolve({ found: [], complete: true });
  let worker = null;
  try {
    worker = createWorker();
  } catch {
    worker = null;
  }
  if (!worker) return Promise.resolve({ found: [], complete: false, reason: 'no-worker' });

  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { worker.terminate(); } catch { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ found: [], complete: false, reason: 'timeout' }), budgetMs);
    worker.onmessage = (event) => {
      const found = Array.isArray(event?.data?.found) ? event.data.found : null;
      finish(found ? { found, complete: true } : { found: [], complete: false, reason: 'error' });
    };
    worker.onerror = () => finish({ found: [], complete: false, reason: 'error' });
    try {
      worker.postMessage({ rules: rules.map(({ name, source, flags }) => ({ name, source, flags })), texts: work });
    } catch {
      finish({ found: [], complete: false, reason: 'error' });
    }
  });
}
