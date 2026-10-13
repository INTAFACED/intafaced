import { copy, t as copyText, Text } from './copy';
import { useEffect, useLayoutEffect, useState } from 'react';
import { Page, Button } from '../../shared/ui';
import {
  usePreferences,
  useResolvedTheme,
  savePreferences,
  useDailyPreferenceEpoch,
  currentDailyPreferenceEpoch,
  type Preferences,
  type PreferencePersistence,
  currentPreferences,
  currentPreferenceObservation,
  usePreferenceObservation,
} from '../../shared/preferences';
import { canonicalDailyZone } from '../trade/zoned-daily-history';
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
  useCopyRevision();
  const rows = customerCopyCoverage(preferences.language);
  const hasWritten = rows.some((row) => row.translated > 0);
  const hasFallback = rows.some((row) => row.missing.length > 0);
  const epoch = useDailyPreferenceEpoch();
  const [zoneDraft, setZoneDraft] = useState(preferences.dailyZone);
  const [zoneInvalid, setZoneInvalid] = useState(false);
  useEffect(() => {
    setZoneDraft(preferences.dailyZone);
    setZoneInvalid(false);
  }, [preferences.dailyZone, epoch]);
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
              <Text k="view.appearance" />
            </h2>
            <label className="field">
              <span>
                <Text k="view.theme" />
              </span>
              <select
                aria-label={copyText('view.theme')}
                value={preferences.theme}
                onChange={(event) => {
                  save({ theme: event.target.value as 'dark' | 'light' | 'system' });
                }}
              >
                <option value="dark" lang={copy.forLocale(preferences.language).languageFor('view.dark')}>
                  {copyText('view.dark')}
                </option>
                <option value="light" lang={copy.forLocale(preferences.language).languageFor('view.light')}>
                  {copyText('view.light')}
                </option>
                <option value="system" lang={copy.forLocale(preferences.language).languageFor('view.match.device')}>
                  {copyText('view.match.device')}
                </option>
              </select>
            </label>
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
                {uiLocales.map((language) => (
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
          </section>
          <section className="settings-section">
            <h2>
              <Text k="view.money" />
            </h2>
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
                  save({ displayCurrency: event.target.value as 'USD' | 'BTC' });
                }}
              >
                <option value="USD">USD</option>
                <option value="BTC">BTC</option>
              </select>
              <small>
                <Text k="view.a.converted.total.requires.a.complete.valuation" />
              </small>
            </label>
            <div className="notice">
              <Text k="view.hiding.small.balances.requires.a.valuation.threshold" />
            </div>
          </section>
          <section className="settings-section">
            <h2>
              <Text k="view.chart.display" />
            </h2>
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
            <label className="field">
              <span>
                <Text k="view.chart.on.phone" />
              </span>
              <select
                aria-label={copyText('view.chart.on.phone')}
                value={preferences.phoneChart}
                onChange={(event) => {
                  save({ phoneChart: event.target.value as 'top' | 'bottom' | 'hidden' });
                }}
              >
                <option value="top" lang={copy.forLocale(preferences.language).languageFor('view.top')}>
                  {copyText('view.top')}
                </option>
                <option value="bottom" lang={copy.forLocale(preferences.language).languageFor('view.bottom')}>
                  {copyText('view.bottom')}
                </option>
                <option value="hidden" lang={copy.forLocale(preferences.language).languageFor('view.hidden')}>
                  {copyText('view.hidden')}
                </option>
              </select>
            </label>
            <label className="field">
              <span>
                <Text k="view.chart.time.labels" />
              </span>
              <select
                aria-label={copyText('view.chart.time.labels')}
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
            <label className="field">
              <span>
                <Text k="view.daily.start" />
              </span>
              <select
                aria-label={copyText('view.daily.start')}
                value={preferences.dailyStart}
                onChange={(event) => {
                  if (currentDailyPreferenceEpoch() !== epoch) return;
                  save({ dailyStart: event.target.value as Preferences['dailyStart'] });
                }}
              >
                <option value="nativeUTC">{copyText('view.daily.start.native')}</option>
                <option value="utc8">{copyText('view.daily.start.utc8')}</option>
                <option value="zoned">{copyText('view.daily.start.zoned')}</option>
              </select>
              <small>
                <Text k="view.daily.history.settings" />
              </small>
            </label>
            {preferences.dailyStart === 'zoned' && (
              <form
                className="daily-zone-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (currentDailyPreferenceEpoch() !== epoch) return;
                  try {
                    const dailyZone = canonicalDailyZone(zoneDraft);
                    save({ dailyZone, dailyStart: 'zoned' });
                    setZoneDraft(dailyZone);
                    setZoneInvalid(false);
                  } catch {
                    setZoneInvalid(true);
                  }
                }}
              >
                <label className="field">
                  <span>
                    <Text k="view.daily.zone" />
                  </span>
                  <input
                    aria-label={copyText('view.daily.zone')}
                    value={zoneDraft}
                    maxLength={100}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={zoneInvalid}
                    aria-describedby={zoneInvalid ? 'daily-zone-error' : 'daily-zone-current'}
                    onChange={(event) => {
                      setZoneDraft(event.target.value);
                      setZoneInvalid(false);
                    }}
                  />
                </label>
                {zoneInvalid && (
                  <p id="daily-zone-error" role="alert">
                    <Text k="view.daily.zone.invalid" />
                  </p>
                )}
                <div className="daily-zone-actions">
                  <Button type="submit">
                    <Text k="view.daily.zone.apply" />
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (currentDailyPreferenceEpoch() !== epoch) return;
                      setZoneDraft(preferences.dailyZone);
                      setZoneInvalid(false);
                    }}
                  >
                    <Text k="view.daily.zone.cancel" />
                  </Button>
                </div>
                <p id="daily-zone-current">
                  <Text k="view.daily.zone.current" /> {preferences.dailyZone}
                </p>
                <p>
                  <Text k="view.daily.zone.explanation" />
                </p>
                <p>
                  <Text k="view.daily.zone.window" />
                </p>
              </form>
            )}
            <Toggle
              label={copyText('view.show.working.orders')}
              checked={preferences.showOrders}
              onChange={(value) => {
                save({ showOrders: value });
              }}
            />
            <Toggle
              label={copyText('view.show.old.fills')}
              checked={preferences.showFills}
              onChange={(value) => {
                save({ showFills: value });
              }}
            />
          </section>
          <section className="settings-section">
            <h2>
              <Text k="view.trading.preferences" />
            </h2>
            <Toggle
              label={copyText('view.confirm.before.send')}
              checked={preferences.confirmSend}
              onChange={(value) => {
                save({ confirmSend: value });
              }}
            />
            <Toggle
              label={copyText('view.confirm.before.cancel')}
              checked={preferences.confirmCancel}
              onChange={(value) => {
                save({ confirmCancel: value });
              }}
            />
            <p className="muted">
              <Text k="view.an.authoritative.price.fee.and.funds.review" />
            </p>
            <label className="field">
              <span>
                <Text k="view.favorites.view" />
              </span>
              <select
                aria-label={copyText('view.favorites.view')}
                value={preferences.favoritesView}
                onChange={(event) => {
                  save({ favoritesView: event.target.value as 'list' | 'cards' });
                }}
              >
                <option value="list" lang={copy.forLocale(preferences.language).languageFor('view.list')}>
                  {copyText('view.list')}
                </option>
                <option value="cards" lang={copy.forLocale(preferences.language).languageFor('view.cards')}>
                  {copyText('view.cards')}
                </option>
              </select>
            </label>
            <div className="notice">
              <Text k="view.futures.cooling.off.and.shared.drawings.require" />
            </div>
          </section>
        </div>
        <div className="actions section">
          <Button
            variant="secondary"
            onClick={() => {
              save({
                theme: 'dark',
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
                favoritesView: 'list',
              });
            }}
          >
            <Text k="view.restore.defaults" />
          </Button>
          <p role="status" className="muted">
            {!currentSave?.language && acknowledgement}
          </p>
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
