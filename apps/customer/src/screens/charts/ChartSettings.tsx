/**
 * Chart settings: one dialog with six sections (Symbol, Status line, Scales, Canvas, Trading, Alerts). The options are
 * saved on this device as they change. Trading and Alerts only link to the controls that place orders and set alerts:
 * the chart itself places no order and sets no alert.
 */
import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from './deps';
import { chartsCopy } from './copy';
import type { ChartSettings as Settings } from './chart-settings';
import { pairOf } from '../trade/desk/market';

type Section = 'symbol' | 'status' | 'scales' | 'canvas' | 'trading' | 'alerts';
const SECTIONS: readonly Section[] = ['symbol', 'status', 'scales', 'canvas', 'trading', 'alerts'];
const SECTION_KEY = {
  symbol: 'Settings tab symbol',
  status: 'Settings tab status',
  scales: 'Settings tab scales',
  canvas: 'Settings tab canvas',
  trading: 'Settings tab trading',
  alerts: 'Settings tab alerts',
} as const;

/** Each boolean option: the section it sits in, its key and the copy that names it. */
const OPTIONS: readonly {
  section: Section;
  key: keyof Settings;
  label:
    | 'Settings show name'
    | 'Settings show time'
    | 'Settings show change'
    | 'Settings show price scale'
    | 'Settings show time scale'
    | 'Settings log scale'
    | 'Settings grid';
}[] = [
  { section: 'symbol', key: 'showName', label: 'Settings show name' },
  { section: 'status', key: 'showTime', label: 'Settings show time' },
  { section: 'status', key: 'showChange', label: 'Settings show change' },
  { section: 'scales', key: 'priceScale', label: 'Settings show price scale' },
  { section: 'scales', key: 'timeScale', label: 'Settings show time scale' },
  { section: 'scales', key: 'logScale', label: 'Settings log scale' },
  { section: 'canvas', key: 'gridLines', label: 'Settings grid' },
];

export function ChartSettingsDialog({
  open,
  onOpenChange,
  settings,
  onChange,
  symbol,
  tick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  onChange: (next: Settings) => void;
  symbol: string;
  tick: string;
}) {
  const { t } = chartsCopy.useCopy();
  const [section, setSection] = useState<Section>('symbol');
  const pair = pairOf(symbol);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="cw-settings" closeLabel={t('Close settings')}>
        <DialogTitle>{t('Chart settings')}</DialogTitle>
        <div className="cw-settings-tabs" role="tablist" aria-label={t('Settings sections')}>
          {SECTIONS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`cw-settings-tab-${id}`}
              aria-selected={section === id}
              aria-controls="cw-settings-panel"
              onClick={() => setSection(id)}
            >
              {t(SECTION_KEY[id])}
            </button>
          ))}
        </div>
        <div
          className="cw-settings-panel"
          role="tabpanel"
          id="cw-settings-panel"
          aria-labelledby={`cw-settings-tab-${section}`}
          data-section={section}
        >
          {section === 'symbol' && <p>{t('Settings market', { symbol, tick })}</p>}
          {section === 'trading' && (
            <>
              <p>{t('Settings trading text')}</p>
              <a data-testid="cw-link" className="cw-link" href={`/trade/spot/${pair}`}>
                {t('Settings trading link', { symbol })}
              </a>
            </>
          )}
          {section === 'alerts' && (
            <>
              <p>{t('Settings alerts text')}</p>
              <a data-testid="cw-link" className="cw-link" href="/notifications?view=alerts">
                {t('Settings alerts link')}
              </a>
            </>
          )}
          {OPTIONS.filter((option) => option.section === section).map((option) => (
            <label key={option.key} className="cw-check">
              <input
                type="checkbox"
                checked={settings[option.key]}
                onChange={(event) => onChange({ ...settings, [option.key]: event.target.checked })}
              />
              <span>{t(option.label)}</span>
            </label>
          ))}
          {section !== 'trading' && section !== 'alerts' && <p className="cw-settings-note">{t('Settings saved here')}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
