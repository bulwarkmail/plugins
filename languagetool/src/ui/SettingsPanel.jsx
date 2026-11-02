// The plugin's section in Settings: where text goes, language, mother
// tongue, picky mode, the send warning, the personal dictionary and the
// rules the user turned off. Whether proofreading runs at all is the
// webmail's own setting (Settings > Composing), not this plugin's.

import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Chip, Input, Link, Loading, Row, Section, Select, SettingRow, Stack, Switch, Text } from '@plugin-host/ui';
import { effectiveLevel, endpointFor, readAdmin } from '../lib/config.js';
import { PICKER_LANGUAGES, VARIANT_DEFAULTS, VARIANTS, baseOf, normalizeTag } from '../lib/languages.js';
import { addToDictionary, enableRule, loadAll, removeFromDictionary, savePrefs } from '../lib/prefs.js';
import { cleanWord } from '../lib/words.js';

const host = () => require('@plugin-host');
const useApi = (props) => props?.api ?? host();

/** A language's name in the user's language, or its code. */
export function languageName(code, locale) {
  try {
    return new Intl.DisplayNames([locale || 'en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

/** The variant shown for a language: the user's, else the admin's, else the default. */
export function variantFor(base, prefs, admin) {
  const own = admin.userMayChange ? prefs.variants.find((v) => baseOf(v) === base) : undefined;
  return own ?? admin.variants.find((v) => baseOf(v) === base) ?? VARIANT_DEFAULTS[base];
}

const VARIANT_LANGUAGES = ['en', 'de', 'pt'];

export function SettingsPanel(props) {
  const api = useApi(props);
  const t = api.i18n.t;
  const locale = api.i18n.locale;
  const [state, setState] = useState(null);
  const [word, setWord] = useState('');

  const reload = useCallback(async () => {
    const [config, stored] = await Promise.all([
      Promise.resolve().then(() => api.config.get()).catch(() => ({})),
      loadAll(api),
    ]);
    setState({ admin: readAdmin(config ?? {}), ...stored });
  }, [api]);

  useEffect(() => { void reload(); }, [reload]);

  if (!state) return <Loading label={t('settings.loading')} />;

  const { admin, prefs, dictionary } = state;
  const locked = !admin.userMayChange;
  const endpoint = endpointFor(admin, { noThirdPartyTraffic: api.host?.features?.noThirdPartyTraffic === true });
  const save = async (patch) => { await savePrefs(api, patch); await reload(); };

  const status = endpoint.off === 'third_party'
    ? t('settings.status_third_party')
    : endpoint.off
      ? t('settings.status_not_set_up')
      : endpoint.isPublic
        ? t('settings.status_public', { host: endpoint.host })
        : t('settings.status_server', { host: endpoint.host });

  // Language: the user's choice, or the admin's when locked.
  const language = locked
    ? (admin.language === 'auto' ? 'follow' : admin.language)
    : prefs.language;
  const languageOptions = [
    { value: 'follow', label: t('settings.language_follow') },
    ...PICKER_LANGUAGES.map((code) => ({ value: code, label: languageName(code, locale) }))
      .sort((a, b) => a.label.localeCompare(b.label, locale)),
  ];
  if (!languageOptions.some((o) => o.value === language)) languageOptions.push({ value: language, label: languageName(language, locale) });
  const languageBase = language === 'follow' ? null : baseOf(normalizeTag(language));
  const variantRows = language === 'follow' ? VARIANT_LANGUAGES : VARIANT_LANGUAGES.filter((b) => b === languageBase);

  const setVariant = (base, value) => {
    const current = VARIANT_LANGUAGES.map((b) => variantFor(b, prefs, admin)).filter((v) => baseOf(v) !== base);
    void save({ variants: [...current, value] });
  };

  const addWord = async () => {
    const clean = cleanWord(word);
    if (!clean) return;
    await addToDictionary(api, clean);
    setWord('');
    await reload();
  };

  const picky = effectiveLevel(admin, prefs) === 'picky';

  return (
    <Stack gap={6}>
      <Section title={t('settings.title')} description={<span data-testid="lt-status">{status}</span>}>
        <Stack gap={2}>
          <Text tone="muted" size="xs">{t('settings.privacy')}</Text>
          <Text tone="muted" size="xs">{t('settings.switch_hint')}</Text>
          {endpoint.isPublic && (
            <Text tone="muted" size="xs">
              {t('settings.public_credit')} <Link href="https://languagetool.org">languagetool.org</Link>
            </Text>
          )}
        </Stack>
        {locked && <Alert tone="info" icon="lock">{t('settings.locked')}</Alert>}
        <Stack gap={0}>
          <SettingRow label={t('settings.language')} description={t('settings.language_hint')} htmlFor="lt-language">
            <Select
              id="lt-language"
              aria-label={t('settings.language')}
              value={language}
              disabled={locked}
              options={languageOptions}
              onChange={(value) => void save({ language: value })}
            />
          </SettingRow>
          {variantRows.map((base) => (
            <SettingRow key={base} label={t('settings.variant', { language: languageName(base, locale) })} htmlFor={`lt-variant-${base}`}>
              <Select
                id={`lt-variant-${base}`}
                aria-label={t('settings.variant', { language: languageName(base, locale) })}
                value={variantFor(base, prefs, admin)}
                disabled={locked}
                options={VARIANTS[base].map((code) => ({ value: code, label: languageName(code, locale) }))}
                onChange={(value) => setVariant(base, value)}
              />
            </SettingRow>
          ))}
          <SettingRow label={t('settings.mother_tongue')} description={t('settings.mother_tongue_hint')} htmlFor="lt-mother-tongue">
            <Select
              id="lt-mother-tongue"
              aria-label={t('settings.mother_tongue')}
              value={prefs.motherTongue || ''}
              options={[
                { value: '', label: t('settings.mother_tongue_none') },
                ...PICKER_LANGUAGES.map((code) => ({ value: code, label: languageName(code, locale) }))
                  .sort((a, b) => a.label.localeCompare(b.label, locale)),
              ]}
              onChange={(value) => void save({ motherTongue: value })}
            />
          </SettingRow>
          <SettingRow label={t('settings.picky')} description={t('settings.picky_hint')} htmlFor="lt-picky">
            <Switch id="lt-picky" label={t('settings.picky')} checked={picky} disabled={locked} onChange={(on) => void save({ picky: on })} />
          </SettingRow>
          <SettingRow label={t('settings.warn')} description={t('settings.warn_hint')} htmlFor="lt-warn">
            <Switch id="lt-warn" label={t('settings.warn')} checked={prefs.warnBeforeSend} onChange={(on) => void save({ warnBeforeSend: on })} />
          </SettingRow>
        </Stack>
      </Section>

      <Section title={t('settings.dictionary')} description={t('settings.dictionary_hint')}>
        <Stack gap={3}>
          <Row wrap={false}>
            <Input
              value={word}
              aria-label={t('settings.dictionary_placeholder')}
              placeholder={t('settings.dictionary_placeholder')}
              maxLength={100}
              onChange={(e) => setWord(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addWord(); } }}
            />
            <Button variant="secondary" disabled={!cleanWord(word)} onClick={() => void addWord()}>{t('settings.dictionary_add')}</Button>
          </Row>
          {dictionary.length ? (
            <Row>
              {dictionary.map((w) => (
                <Chip
                  key={w}
                  label={w}
                  onRemove={() => void removeFromDictionary(api, w).then(reload)}
                  removeLabel={t('settings.dictionary_remove', { word: w })}
                />
              ))}
            </Row>
          ) : (
            <Text tone="muted">{t('settings.dictionary_empty')}</Text>
          )}
          {admin.words.length > 0 && <Text tone="muted" size="xs">{t('settings.dictionary_org', { count: admin.words.length })}</Text>}
        </Stack>
      </Section>

      <Section title={t('settings.rules')} description={t('settings.rules_hint')}>
        <Stack gap={3}>
          {locked && prefs.disabledRules.length > 0 && <Text tone="muted" size="xs">{t('settings.rules_locked')}</Text>}
          {prefs.disabledRules.length ? (
            <Row>
              {prefs.disabledRules.map((r) => (
                <Chip
                  key={r.id}
                  label={r.label || r.id}
                  title={r.id}
                  {...(locked ? {} : {
                    onRemove: () => void enableRule(api, r.id).then(reload),
                    removeLabel: t('settings.rule_remove', { rule: r.label || r.id }),
                  })}
                />
              ))}
            </Row>
          ) : (
            <Text tone="muted">{t('settings.rules_empty')}</Text>
          )}
          {(admin.disabledRules.length + admin.disabledCategories.length) > 0 && (
            <Text tone="muted" size="xs">{t('settings.rules_admin', { count: admin.disabledRules.length + admin.disabledCategories.length })}</Text>
          )}
        </Stack>
      </Section>
    </Stack>
  );
}
