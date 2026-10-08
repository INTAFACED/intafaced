import { useEffect, useState } from 'react';
import { Page, Button } from '../../shared/ui';
import { usePreferences, savePreferences } from '../../shared/preferences';

export function ApplyView() {
  const preferences = usePreferences();
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      document.documentElement.dataset.theme = preferences.theme === 'system' ? (media.matches ? 'light' : 'dark') : preferences.theme;
      document.documentElement.dataset.upColor = preferences.upColor;
      document.documentElement.dataset.phoneChart = preferences.phoneChart;
      document.documentElement.lang = 'en';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preferences]);
  return null;
}
export function View() {
  const preferences = usePreferences();
  const [note, setNote] = useState('');
  function saved() {
    setNote('Preferences saved on this device.');
  }
  return (
    <Page title="View" description="Choose how the product feels on this device. Account-wide preference sync is not connected.">
      <div className="settings-grid">
        <section className="settings-section">
          <h2>Appearance</h2>
          <label className="field">
            <span>Theme</span>
            <select
              aria-label="Theme"
              value={preferences.theme}
              onChange={(event) => {
                savePreferences({ theme: event.target.value as 'dark' | 'light' | 'system' });
                saved();
              }}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">Match device</option>
            </select>
          </label>
          <label className="field">
            <span>Language</span>
            <select
              aria-label="Language"
              value={preferences.language}
              onChange={(event) => {
                savePreferences({ language: event.target.value as 'en' | 'es' | 'fr' });
                saved();
              }}
            >
              <option value="en">English</option>
              <option value="es">Español — partial</option>
              <option value="fr">Français — partial</option>
            </select>
            <small>Published translations are used where available. New interface copy currently uses English.</small>
          </label>
        </section>
        <section className="settings-section">
          <h2>Money</h2>
          <Toggle
            label="Hide balance values"
            checked={preferences.hideBalances}
            onChange={(value) => {
              savePreferences({ hideBalances: value });
              saved();
            }}
          />
          <label className="field">
            <span>Display currency</span>
            <select
              aria-label="Display currency"
              value={preferences.displayCurrency}
              onChange={(event) => {
                savePreferences({ displayCurrency: event.target.value as 'USD' | 'BTC' });
                saved();
              }}
            >
              <option value="USD">USD</option>
              <option value="BTC">BTC</option>
            </select>
            <small>A converted total requires a complete valuation source. Asset quantities retain their own units.</small>
          </label>
          <div className="notice">
            Hiding small balances requires a valuation threshold. That control is unavailable while valuation coverage is missing.
          </div>
        </section>
        <section className="settings-section">
          <h2>Chart display</h2>
          <label className="field">
            <span>Up and down colors</span>
            <select
              aria-label="Up and down colors"
              value={preferences.upColor}
              onChange={(event) => {
                savePreferences({ upColor: event.target.value as 'green' | 'red' });
                saved();
              }}
            >
              <option value="green">Green up · red down</option>
              <option value="red">Red up · green down</option>
            </select>
          </label>
          <label className="field">
            <span>Chart on phone</span>
            <select
              aria-label="Chart on phone"
              value={preferences.phoneChart}
              onChange={(event) => {
                savePreferences({ phoneChart: event.target.value as 'top' | 'bottom' | 'hidden' });
                saved();
              }}
            >
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
              <option value="hidden">Hidden</option>
            </select>
          </label>
          <label className="field">
            <span>Chart time labels</span>
            <select
              aria-label="Chart time labels"
              value={preferences.timeZone}
              onChange={(event) => {
                savePreferences({ timeZone: event.target.value as 'UTC' | 'UTC+8' | 'device' });
                saved();
              }}
            >
              <option value="UTC">UTC</option>
              <option value="UTC+8">UTC+8</option>
              <option value="device">Device time zone</option>
            </select>
            <small>Daily candle boundaries follow the history service. Changing their start is not supported by that contract.</small>
          </label>
          <Toggle
            label="Show working orders"
            checked={preferences.showOrders}
            onChange={(value) => {
              savePreferences({ showOrders: value });
              saved();
            }}
          />
          <Toggle
            label="Show old fills"
            checked={preferences.showFills}
            onChange={(value) => {
              savePreferences({ showFills: value });
              saved();
            }}
          />
        </section>
        <section className="settings-section">
          <h2>Trading preferences</h2>
          <Toggle
            label="Confirm before send"
            checked={preferences.confirmSend}
            onChange={(value) => {
              savePreferences({ confirmSend: value });
              saved();
            }}
          />
          <Toggle
            label="Confirm before cancel"
            checked={preferences.confirmCancel}
            onChange={(value) => {
              savePreferences({ confirmCancel: value });
              saved();
            }}
          />
          <p className="muted">
            An authoritative price, fee and funds review is still required. An uncertain request stays locked until its outcome is checked.
          </p>
          <label className="field">
            <span>Favorites view</span>
            <select
              aria-label="Favorites view"
              value={preferences.favoritesView}
              onChange={(event) => {
                savePreferences({ favoritesView: event.target.value as 'list' | 'cards' });
                saved();
              }}
            >
              <option value="list">List</option>
              <option value="cards">Cards</option>
            </select>
          </label>
          <div className="notice">
            Futures cooling-off and shared drawings require authoritative account contracts. They cannot be enforced by a device preference.
          </div>
        </section>
      </div>
      <div className="actions section">
        <Button
          variant="secondary"
          onClick={() => {
            savePreferences({
              theme: 'dark',
              language: 'en',
              hideBalances: false,
              displayCurrency: 'USD',
              phoneChart: 'top',
              upColor: 'green',
              timeZone: 'UTC',
              showOrders: true,
              showFills: false,
              confirmSend: true,
              confirmCancel: true,
              favoritesView: 'list',
            });
            saved();
          }}
        >
          Restore defaults
        </Button>
        <p role="status" className="muted">
          {note}
        </p>
      </div>
    </Page>
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
