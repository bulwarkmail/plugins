// Which link checks run for a click, and what they say together.

/** The time a click waits for the checks before it counts as "couldn't check". */
export const LOOKUP_BUDGET_MS = 3000;

export const LOOKUP_MODES = ['off', 'endpoint', 'safebrowsing', 'both'];

/**
 * The checks to run. Safe Browsing is off while the host's no-third-party
 * mode is on: Google is a third party, and the admin turned those off. That
 * is not a failure, so fail-closed doesn't block links because of it.
 */
export function plannedChecks(config, features) {
  const mode = LOOKUP_MODES.includes(config?.lookup) ? config.lookup : 'off';
  const endpoint = mode === 'endpoint' || mode === 'both';
  const google = (mode === 'safebrowsing' || mode === 'both') && features?.noThirdPartyTraffic !== true;
  return { endpoint, google };
}

/** `promise`, or a rejection once `ms` have passed (and `onTimeout` was called). */
function withDeadline(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        try { onTimeout?.(); } catch { /* ignore */ }
        reject(new Error('timeout'));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Run the planned checks side by side, within one budget, and combine them:
 * unsafe when either says so, else "failed" when one couldn't check, else
 * safe when one says safe, else unknown. `verdict: 'off'` when no check is
 * planned.
 *
 * services: {
 *   endpoint: { check(endpointUrl, href, host, { signal }) },
 *   google:   { check(href, { signal }) },
 *   ready:    async () => ({ endpoint: boolean, google: boolean }),  // set up by the admin?
 * }
 */
export async function runChecks({ href, host, config, features, services, budgetMs = LOOKUP_BUDGET_MS, log }) {
  const plan = plannedChecks(config, features);
  if (!plan.endpoint && !plan.google) return { verdict: 'off' };

  let ready = { endpoint: false, google: false };
  try { ready = await services.ready(); } catch (err) { log?.('Could not read which link checks are set up', err); }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const signal = controller?.signal;
  const run = (name, start) => withDeadline(Promise.resolve().then(start), budgetMs, () => controller?.abort())
    .then((value) => ({ name, ok: true, value }), (error) => {
      log?.(`The ${name} link check failed`, error);
      return { name, ok: false, error };
    });

  const jobs = [];
  if (plan.endpoint) {
    jobs.push(run('endpoint', () => {
      if (!config.endpointUrl || !ready.endpoint) throw new Error('The link check service is not set up');
      return services.endpoint.check(config.endpointUrl, href, host, { signal });
    }));
  }
  if (plan.google) {
    jobs.push(run('google', () => {
      if (!ready.google) throw new Error('Safe Browsing has no API key');
      return services.google.check(href, { signal });
    }));
  }
  const results = await Promise.all(jobs);
  const endpoint = results.find((r) => r.name === 'endpoint');
  const google = results.find((r) => r.name === 'google');

  const out = {
    endpoint: endpoint ? (endpoint.ok ? endpoint.value : { verdict: 'failed' }) : undefined,
    google: google ? (google.ok ? google.value : { verdict: 'failed' }) : undefined,
  };
  const verdicts = [out.endpoint?.verdict, out.google?.verdict].filter(Boolean);
  let verdict = 'unknown';
  if (verdicts.includes('unsafe')) verdict = 'unsafe';
  else if (verdicts.includes('failed')) verdict = 'failed';
  else if (verdicts.includes('safe')) verdict = 'safe';
  return { verdict, ...out };
}
