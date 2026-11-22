import { useState } from 'react';
import { Button } from '../../shared/ui';
import { savePreferences, usePreferences } from '../../shared/preferences';
import { parseQuickSizes, quickSizesText } from './trading-settings';
import { tradingSettingsCopy } from './trading-settings-copy';

/** The order form's own settings (SP-desk-account-01): what is wired is a control; what has no source says so beside its row. */
export function TradingSettings() {
  const { t } = tradingSettingsCopy.useCopy();
  const preferences = usePreferences();
  const [text, setText] = useState(() => quickSizesText(preferences.quickSizes));
  const [note, setNote] = useState<'saved' | 'invalid' | 'tooMany' | null>(null);
  return (
    <section className="section" aria-label={t('title')}>
      <h2>{t('title')}</h2>
      <p className="muted">{t('lead')}</p>
      <label className="toggle">
        <input type="checkbox" checked disabled aria-describedby="trading-summary-note" readOnly />
        <span>{t('summary')}</span>
      </label>
      <small id="trading-summary-note">{t('summaryLocked')}</small>
      <label className="toggle">
        <input
          type="checkbox"
          checked={preferences.resetSizeOnSubmit}
          onChange={(event) => savePreferences({ resetSizeOnSubmit: event.target.checked })}
          aria-describedby="trading-reset-note"
        />
        <span>{t('reset')}</span>
      </label>
      <small id="trading-reset-note">{t('resetHint')}</small>
      <form
        className="field"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = parseQuickSizes(text);
          if (!parsed.ok) {
            setNote(parsed.reason);
            return;
          }
          savePreferences({ quickSizes: parsed.sizes });
          setText(quickSizesText(parsed.sizes));
          setNote('saved');
        }}
      >
        <label className="field">
          <span>{t('quickSizes')}</span>
          <input
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setNote(null);
            }}
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="trading-sizes-note"
            aria-invalid={note === 'invalid' || note === 'tooMany'}
          />
        </label>
        <small id="trading-sizes-note">{note === 'invalid' || note === 'tooMany' ? t(note) : t('quickSizesHint')}</small>
        <Button type="submit" variant="secondary">
          {t('save')}
        </Button>
        {note === 'saved' ? (
          <p role="status" className="muted">
            {t('saved')}
          </p>
        ) : null}
      </form>
      <p>
        <strong>{t('share')}</strong> <span className="muted">{t('shareOff')}</span>
      </p>
    </section>
  );
}
