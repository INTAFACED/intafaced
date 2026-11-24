import { useState } from 'react';
import { Button, Checkbox } from '@intafaced/ui/lit';
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
    <section id="view-trading" aria-label={t('title')}>
      <h2>{t('title')}</h2>
      <p className="lt-hint">{t('lead')}</p>
      <Checkbox checked disabled aria-describedby="trading-summary-note" readOnly>
        {t('summary')}
      </Checkbox>
      <small id="trading-summary-note">{t('summaryLocked')}</small>
      <Checkbox
        checked={preferences.resetSizeOnSubmit}
        onCheckedChange={(checked) => savePreferences({ resetSizeOnSubmit: checked })}
        aria-describedby="trading-reset-note"
      >
        {t('reset')}
      </Checkbox>
      <small id="trading-reset-note">{t('resetHint')}</small>
      <form
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
        <label className="lt-field">
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
        <Button type="submit" tone="secondary">
          {t('save')}
        </Button>
        {note === 'saved' ? (
          <p role="status" className="lt-hint">
            {t('saved')}
          </p>
        ) : null}
      </form>
      <p>
        <strong>{t('share')}</strong> <span className="lt-hint">{t('shareOff')}</span>
      </p>
    </section>
  );
}
