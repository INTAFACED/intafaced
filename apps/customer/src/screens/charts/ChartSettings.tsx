/**
 * Chart settings: one dialog with six sections (Symbol, Status line, Scales, Canvas, Trading, Alerts). The options are
 * saved on this device as they change. Trading and Alerts keep what the chart shows (the order button on the price scale,
 * the alert levels) and link to the controls that place orders and set alerts: the dialog itself places no order and sets
 * no alert.
 */
import { useState } from 'react';
import { Checkbox } from '@intafaced/ui/lit';
import { Sheet, TabPanel, Tabs } from '@intafaced/ui/lit/templates';
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
    | 'Settings grid'
    | 'Settings order button'
    | 'Settings alert levels';
}[] = [
  { section: 'symbol', key: 'showName', label: 'Settings show name' },
  { section: 'status', key: 'showTime', label: 'Settings show time' },
  { section: 'status', key: 'showChange', label: 'Settings show change' },
  { section: 'scales', key: 'priceScale', label: 'Settings show price scale' },
  { section: 'scales', key: 'timeScale', label: 'Settings show time scale' },
  { section: 'scales', key: 'logScale', label: 'Settings log scale' },
  { section: 'canvas', key: 'gridLines', label: 'Settings grid' },
  { section: 'trading', key: 'orderButton', label: 'Settings order button' },
  { section: 'alerts', key: 'alertLevels', label: 'Settings alert levels' },
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
  // Drawn only while open, as the dialog always was: nothing of it is in the page while it is shut.
  if (!open) return null;
  return (
    <Sheet open onClose={() => onOpenChange(false)} title={t('Chart settings')} closeLabel={t('Close settings')}>
      <Tabs
        id="cw-settings"
        label={t('Settings sections')}
        value={section}
        onChange={(next) => setSection(next as Section)}
        items={SECTIONS.map((id) => ({ value: id, label: t(SECTION_KEY[id]) }))}
      />
      <TabPanel id="cw-settings" value={section} current={section} className="lt-stack">
        <div className="lt-stack" data-section={section}>
          {section === 'symbol' && <p>{t('Settings market', { symbol, tick })}</p>}
          {section === 'trading' && (
            <>
              <p>{t('Settings trading text')}</p>
              <a data-testid="cw-link" className="lt-link" href={`/trade/spot/${pair}`}>
                {t('Settings trading link', { symbol })}
              </a>
            </>
          )}
          {section === 'alerts' && (
            <>
              <p>{t('Settings alerts text')}</p>
              <a data-testid="cw-link" className="lt-link" href="/notifications?view=alerts">
                {t('Settings alerts link')}
              </a>
            </>
          )}
          {OPTIONS.filter((option) => option.section === section).map((option) => (
            <Checkbox
              key={option.key}
              checked={settings[option.key]}
              onCheckedChange={(checked) => onChange({ ...settings, [option.key]: checked })}
            >
              {t(option.label)}
            </Checkbox>
          ))}
          <p className="lt-note">{t('Settings saved here')}</p>
        </div>
      </TabPanel>
    </Sheet>
  );
}
