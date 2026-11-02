// One check: the host's new paragraphs in, underlines out.
//
// 1. Work out the settings (server, language, level, rules).
// 2. Take what the cache knows; send the rest in as few requests as the
//    size limit allows (one, nearly always, for a self-hosted server).
// 3. Drop what the user doesn't want to see: dictionary and organisation
//    words, issues ignored in this composer, rules turned off.
// Failures come back as a status for the host, never as a thrown error.

import { effectiveLevel, userDisabledRules } from './config.js';
import { resolveLanguage, cleanMotherTongue } from './languages.js';
import { settingsKey } from './cache.js';
import { buildData, buildForm, byteLength, mapMatches, toBatches, toUnits, OBJECT_CHAR } from './request.js';
import { classifyResponse, parseCheckBody } from './errors.js';
import { wordMatcher } from './words.js';

/** Request size limits (UTF-8 bytes of text). The public API takes 20 KB per request. */
export const PUBLIC_MAX_BYTES = 19_000;
export const SERVER_MAX_BYTES = 100_000;
/** The public API's limits per IP and minute (dev.languagetool.org/public-http-api, 2026-11-01). */
export const PUBLIC_REQUESTS_PER_MINUTE = 20;
export const PUBLIC_BYTES_PER_MINUTE = 75_000;
/** The host gives up after 15 s; finish before that. */
export const CHECK_BUDGET_MS = 13_000;

/**
 * The settings of a check, or { unsupported } for a language LanguageTool
 * doesn't check.
 */
export function checkSettings({ admin, prefs, endpoint, writing }) {
  const lang = resolveLanguage({ writing, admin, prefs, userMayChange: admin.userMayChange });
  if (lang.unsupported) return { unsupported: lang.unsupported };
  return {
    credentialId: endpoint.credentialId,
    base: endpoint.base,
    isPublic: endpoint.isPublic,
    language: lang.language,
    preferredVariants: lang.preferredVariants ?? [],
    motherTongue: cleanMotherTongue(prefs.motherTongue),
    level: effectiveLevel(admin, prefs),
    disabledRules: admin.disabledRules,
    disabledCategories: admin.disabledCategories,
  };
}

/** Key for an issue ignored in one composer: the rule and the text it covers. */
export const ignoreKey = (ruleId, text) => `${ruleId ?? ''}\u0000${text}`;

/** The matches the user wants to see. */
export function filterMatches(matches, { words, ignored, userRules = [], adminRules = [], adminCategories = [] }) {
  const rules = new Set([...userRules, ...adminRules]);
  const categories = new Set(adminCategories.map((c) => c.toUpperCase()));
  return matches.filter((m) => {
    if (m.ruleId && rules.has(m.ruleId)) return false;
    if (m.categoryId && categories.has(m.categoryId)) return false;
    if (m.kind === 'spelling' && words?.has(m.text)) return false;
    if (ignored?.has(ignoreKey(m.ruleId, m.text))) return false;
    return true;
  });
}

export function toAnnotation(segmentId, m) {
  const a = { segmentId, offset: m.offset, length: m.length, kind: m.kind, message: m.message, replacements: m.replacements };
  if (m.shortMessage) a.shortMessage = m.shortMessage;
  if (m.ruleId) a.ruleId = m.ruleId;
  if (m.ruleLabel) a.ruleLabel = m.ruleLabel;
  return a;
}

/** A per-minute budget for the public API, counted in this browser. */
export function createBudget({ requests = PUBLIC_REQUESTS_PER_MINUTE, bytes = PUBLIC_BYTES_PER_MINUTE, windowMs = 60_000 } = {}) {
  const sent = [];
  const prune = (now) => { while (sent.length && now - sent[0].at >= windowMs) sent.shift(); };
  return {
    /** 0 when `size` bytes may go now, else how long to wait. */
    wait(size, now) {
      prune(now);
      let used = sent.reduce((n, s) => n + s.size, 0);
      if (sent.length < requests && used + size <= bytes) return 0;
      // Wait until enough old requests have left the window.
      let count = sent.length;
      for (const s of sent) {
        count--;
        used -= s.size;
        if (count < requests && used + size <= bytes) return Math.max(1000, s.at + windowMs - now);
      }
      return windowMs;
    },
    record(size, now) { sent.push({ at: now, size }); },
  };
}

function withTimeout(promise, ms, controller) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(Object.assign(new Error('timeout'), { timeout: true }));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Check a request from the host. `ctx`:
 *   api, admin, prefs, dictionary, endpoint (from endpointFor), cache,
 *   ignored (Set for this composer), budget (public API), now(), t (i18n),
 *   checkBudgetMs (tests).
 * Resolves to { status, annotations } or { status, message, retryAfterMs }.
 */
export async function runCheck(request, ctx) {
  const { api, admin, prefs, endpoint, cache, budget, now = () => Date.now() } = ctx;
  const t = ctx.t ?? ((key) => key);
  const fail = (status, key, vars, retry) => ({
    status, message: t(key, vars), ...(retry ? { retryAfterMs: retry } : {}),
  });
  if (!endpoint || endpoint.off) return fail('unavailable', endpoint?.off === 'third_party' ? 'error.third_party' : 'error.not_set_up');
  const segments = Array.isArray(request?.segments) ? request.segments.filter((s) => s && typeof s.id === 'string' && typeof s.text === 'string') : [];
  const objectChar = typeof request?.objectReplacement === 'string' && request.objectReplacement ? request.objectReplacement : OBJECT_CHAR;
  const settings = checkSettings({ admin, prefs, endpoint, writing: request?.language });
  if (settings.unsupported) return fail('unavailable', 'error.language');
  const key = settingsKey(settings);

  const found = new Map();
  const missing = [];
  for (const seg of segments) {
    const hit = cache.get(key, seg.text);
    if (hit) found.set(seg.id, hit);
    else if (!missing.some((m) => m.text === seg.text)) missing.push(seg);
  }

  if (missing.length) {
    const maxBytes = settings.isPublic ? PUBLIC_MAX_BYTES : SERVER_MAX_BYTES;
    const texts = new Map(missing.map((s) => [s.id, s.text]));
    const batches = toBatches(toUnits(missing, maxBytes), maxBytes);
    const started = now();
    const results = new Map(missing.map((s) => [s.id, []]));
    const url = `${settings.base}/v2/check`;
    for (const batch of batches) {
      const { data, layout } = buildData(batch, objectChar);
      const size = byteLength(batch.map((u) => u.text).join('\n\n'));
      if (settings.isPublic && budget) {
        const wait = budget.wait(size, now());
        if (wait > 0) return fail('paused', 'error.public_limit', undefined, wait);
      }
      const left = (ctx.checkBudgetMs ?? CHECK_BUDGET_MS) - (now() - started);
      if (left <= 500) return fail('unavailable', 'error.timeout');
      const body = buildForm({ ...settings, data });
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let res;
      try {
        if (settings.isPublic && budget) budget.record(size, now());
        res = await withTimeout(api.proxy.fetch(settings.credentialId, url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body,
          responseType: 'text',
          ...(controller ? { signal: controller.signal } : {}),
        }), left, controller);
      } catch (err) {
        return fail('unavailable', err?.timeout ? 'error.timeout' : 'error.network');
      }
      const problem = classifyResponse(res, { now: now() });
      if (problem) return fail(problem.status, problem.key, problem.vars, problem.retryAfterMs);
      const json = parseCheckBody(res.body);
      if (!json) return fail('unavailable', 'error.wrong_url');
      for (const [id, list] of mapMatches(json.matches, layout, texts, objectChar)) results.get(id).push(...list);
    }
    for (const seg of missing) {
      const list = results.get(seg.id) ?? [];
      list.sort((a, b) => a.offset - b.offset);
      cache.set(key, seg.text, list);
    }
    for (const seg of segments) if (!found.has(seg.id)) found.set(seg.id, cache.get(key, seg.text) ?? []);
  }

  const words = ctx.words ?? wordMatcher(ctx.dictionary ?? [], admin.words);
  const filter = {
    words,
    ignored: ctx.ignored,
    userRules: userDisabledRules(admin, prefs),
    adminRules: admin.disabledRules,
    adminCategories: admin.disabledCategories,
  };
  const annotations = [];
  for (const seg of segments) {
    for (const m of filterMatches(found.get(seg.id) ?? [], filter)) annotations.push(toAnnotation(seg.id, m));
  }
  return { status: 'ok', annotations };
}
