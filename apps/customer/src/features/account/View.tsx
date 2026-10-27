import { copy, t as copyText, Text } from './copy';
import { useLayoutEffect, useMemo, useState } from 'react';
import { SegmentedControl } from '@intafaced/ui';
import { UI_DISPLAY_CURRENCIES, type UiDisplayCurrency } from '@intafaced/contracts/ui-view-preferences';
import { Page, Button } from '../../shared/ui';
import {
  usePreferences,
  useResolvedTheme,
  savePreferences,
  type Preferences,
  type PreferencePersistence,
  currentPreferences,
  currentPreferenceObservation,
  usePreferenceObservation,
} from '../../shared/preferences';
import { TradingSettings } from './TradingSettings';
import { useAccountViewStatus } from './ViewSync';
import { customerCopyCoverage, renderedUiLanguage, useCopyRevision } from '../../shared/i18n';
import { canonicalUiLocale, uiLocales, uiLocaleDescriptor, uiDirection } from '../../shared/locale';

export function ApplyView() {
  const preferences = usePreferences();
  const theme = useResolvedTheme(preferences.theme);
  const copyRevision = useCopyRevision();
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.upColor = preferences.upColor;
    document.documentElement.dataset.phoneChart = preferences.phoneChart;
    const rendered = renderedUiLanguage(preferences.language);
    document.documentElement.lang = rendered;
    document.documentElement.dir = uiDirection(rendered);
  }, [preferences, theme, copyRevision]);
  return null;
}
export function View() {
  const preferences = usePreferences();
  const accountStatus = useAccountViewStatus();
  const observation = usePreferenceObservation();
  const [saved, setSaved] = useState<{
    persistence: PreferencePersistence;
    snapshot: Preferences;
    observation: number;
    language: boolean;
  } | null>(null);
  const currentSave = saved?.snapshot === preferences && saved.observation === observation ? saved : null;
  const current = copy.forLocale(preferences.language);
  const descriptor = uiLocaleDescriptor(preferences.language);
  // Only languages with written copy are a real choice; the rest would show English under a foreign name.
  const offeredLocales = useMemo(
    () =>
      uiLocales.filter(
        (language) =>
          language.code === 'en' ||
          language.code === preferences.language ||
          customerCopyCoverage(language.code).some((row) => row.translated > 0),
      ),
    [preferences.language],
  );
  useCopyRevision();
  const rows = customerCopyCoverage(preferences.language);
  const hasWritten = rows.some((row) => row.translated > 0);
  const hasFallback = rows.some((row) => row.missing.length > 0);
  function save(patch: Partial<Preferences>) {
    const persistence = savePreferences(patch);
    setSaved({
      persistence,
      snapshot: currentPreferences(),
      observation: currentPreferenceObservation(),
      language: Object.keys(patch).length === 1 && patch.language !== undefined,
    });
  }
  const acknowledgement =
    currentSave?.persistence === 'device' ? (
      <Text k="view.preferences.saved.on.this.device" />
    ) : currentSave?.persistence === 'visit' ? (
      <Text k="view.language.visit.only" />
    ) : null;
  return (
    <div lang={current.renderedLocale} dir={uiDirection(current.renderedLocale)} style={{ display: 'contents' }}>
      <Page title={copyText('view.view')} description={copyText('view.choose.how.the.product.feels.on.this')}>
        <div className="settings-grid">
          <section className="settings-section">
            <h2>
              <Text k="view.display" />
            </h2>
            <label className="field">
              <span>
                <Text k="view.language" />
              </span>
              <select
                aria-label={copyText('view.language')}
                value={preferences.language}
                onChange={(event) => {
                  const language = canonicalUiLocale(event.target.value);
                  if (language) save({ language });
                }}
              >
                {offeredLocales.map((language) => (
                  <option key={language.code} value={language.code} lang={language.code} dir={uiDirection(language.code)}>
                    {language.nativeName}
                  </option>
                ))}
              </select>
              <small>
                {!hasWritten ? (
                  <Text k="view.language.fallback" params={{ language: descriptor.englishName }} />
                ) : hasFallback ? (
                  <Text k="view.language.partial" params={{ language: descriptor.englishName }} />
                ) : (
                  <Text k="view.published.translations.are.used.where.available.new" />
                )}
              </small>
              {currentSave?.language && (
                <p role="status" className="muted">
                  {acknowledgement}
                </p>
              )}
            </label>
            <label className="field">
              <span>
                <Text k="view.up.and.down.colors" />
              </span>
              <select
                aria-label={copyText('view.up.and.down.colors')}
                value={preferences.upColor}
                onChange={(event) => {
                  save({ upColor: event.target.value as 'green' | 'red' });
                }}
              >
                <option value="green" lang={copy.forLocale(preferences.language).languageFor('view.green.up.red.down')}>
                  {copyText('view.green.up.red.down')}
                </option>
                <option value="red" lang={copy.forLocale(preferences.language).languageFor('view.red.up.green.down')}>
                  {copyText('view.red.up.green.down')}
                </option>
              </select>
            </label>
            <div className="field">
              <span>
                <Text k="view.default.view" />
              </span>
              <SegmentedControl
                aria-label={copyText('view.default.view')}
                size={32}
                value={preferences.layoutMode}
                items={[
                  { value: 'simple', label: copyText('view.simple') },
                  { value: 'pro', label: copyText('view.pro') },
                ]}
                onValueChange={(value) => {
                  if (value === 'simple' || value === 'pro') save({ layoutMode: value });
                }}
              />
              <small>
                <Text k="view.default.view.hint" />
              </small>
            </div>
            <Toggle
              label={copyText('view.hide.balance.values')}
              checked={preferences.hideBalances}
              onChange={(value) => {
                save({ hideBalances: value });
              }}
            />
            <label className="field">
              <span>
                <Text k="view.display.currency" />
              </span>
              <select
                aria-label={copyText('view.display.currency')}
                value={preferences.displayCurrency}
                onChange={(event) => {
                  save({ displayCurrency: event.target.value as UiDisplayCurrency });
                }}
              >
                {UI_DISPLAY_CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
              <small>
                <Text k="view.display.currency.hint" />
              </small>
            </label>
            <label className="field">
              <span>
                <Text k="view.time.zone" />
              </span>
              <select
                aria-label={copyText('view.time.zone')}
                value={preferences.timeZone}
                onChange={(event) => {
                  save({ timeZone: event.target.value as 'UTC' | 'UTC+8' | 'device' });
                }}
              >
                <option value="UTC">UTC</option>
                <option value="UTC+8">UTC+8</option>
                <option value="device" lang={copy.forLocale(preferences.language).languageFor('view.device.time.zone')}>
                  {copyText('view.device.time.zone')}
                </option>
              </select>
              <small>
                <Text k="view.daily.labels.independent" />
              </small>
            </label>
          </section>
        </div>
        <TradingSettings />
        <div className="actions section">
          <Button
            variant="secondary"
            onClick={() => {
              save({
                theme: 'dark',
                layoutMode: 'simple',
                language: 'en',
                hideBalances: false,
                displayCurrency: 'USD',
                phoneChart: 'top',
                upColor: 'green',
                timeZone: 'device',
                dailyStart: 'nativeUTC',
                dailyZone: 'America/New_York',
                showOrders: true,
                showFills: false,
                confirmSend: true,
                confirmCancel: true,
                resetSizeOnSubmit: true,
                quickSizes: [],
                favoritesView: 'list',
              });
            }}
          >
            <Text k="view.restore.defaults" />
          </Button>
          <p role="status" className="muted">
            {!currentSave?.language && acknowledgement}
          </p>
          {accountStatus === 'not-saved' && (
            <p role="status" className="muted" data-view-sync="not-saved">
              <Text k="view.account.sync.not.saved" />
            </p>
          )}
        </div>
      </Page>
    </div>
  );
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}
