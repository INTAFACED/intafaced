/**
 * The desk's Layouts menu, on the chart workbench: the Classic and Advanced presets, the widget positions, the reset, the saved
 * layouts (save, open, copy, export, delete, recover, autosave to the account) and chart templates (save, apply to a market).
 * A layout or template is a view record: it never places an order and never changes a price or a balance.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { layoutSnapshotSchema, type DeskSetting, type LayoutSnapshot, type SavedLayout } from '@intafaced/contracts/layouts-preferences';
import { useSession } from '../../../features/session/session';
import { useDeviceSetting } from '../../../features/trade/hooks';
import { navigate } from '../../../app/location';
import type { ChartInterval } from '../../trade/chart/candles';
import { pairOf, type DeskMarket } from '../../trade/desk/market';
import { chartsHref, intervalLabel, settingKey, type WorkbenchSetting } from '../workbench';
import { DEFAULT_GRID, gridKey } from '../grid';
import { deskKey, activeLayoutKey, applyWrites, captureSnapshot, planWrites, studiesKey, type StorageWrite } from './capture';
import { drawingsKey } from '../drawings/store';
import { layoutsCopy } from './copy';
import {
  cleanName,
  copyLayout,
  deleteLayout,
  deskForPreset,
  exportFileName,
  exportText,
  findLayout,
  PRESET_DESK,
  recoverLayout,
  replaceNamed,
  saveNamed,
  withSnapshot,
  type DeskPreset,
} from './model';
import { newRecordId, removeTemplate, saveTemplate } from './templates';
import { refusalWords, useChartTemplates, useLayoutRecord, type RefusalWords } from './store';
import './layouts.css';

/** How often a change to the open layout is saved to the account: a debounce, so a run of changes is one write. */
export const AUTOSAVE_MS = 2000;

const REFUSAL_COPY = {
  'layout-unset': 'Refused layout limit unset',
  'layout-full': 'Refused layout limit reached',
  'restore-unset': 'Refused restore unset',
  'restore-full': 'Refused restore full',
  'template-unset': 'Refused template unset',
  'template-full': 'Refused template reached',
  'too-large': 'Refused too large',
  version: 'Refused version',
  'not-saved': 'Refused not saved',
} as const satisfies Record<RefusalWords, string>;

const PRESET_LABEL: Record<DeskPreset, 'Classic' | 'Advanced'> = { classic: 'Classic', advanced: 'Advanced' };

interface Status {
  text: string;
  code?: string;
}

export interface LayoutsMenuProps {
  workbench: string;
  symbol: string;
  markets: readonly DeskMarket[];
  setting: WorkbenchSetting;
  desk: DeskSetting;
  setDesk: (next: DeskSetting) => void;
  /** The page re-reads browser storage: the layout, template or reset has written what it shows. */
  onRemount: () => void;
}

const isActiveId = (value: unknown): value is string | null => value === null || typeof value === 'string';

export function LayoutsMenu({ workbench, symbol, markets, setting, desk, setDesk, onRemount }: LayoutsMenuProps) {
  const { t, requestedLocale, languageFor } = layoutsCopy.useCopy();
  const { userId } = useSession();
  const layouts = useLayoutRecord();
  const templates = useChartTemplates();
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useDeviceSetting<string | null>(activeLayoutKey(userId, workbench), null, isActiveId);
  const [status, setStatus] = useState<Status | null>(null);
  const [name, setName] = useState('');
  const [taken, setTaken] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateTaken, setTemplateTaken] = useState<string | null>(null);
  const [templateMarket, setTemplateMarket] = useState(symbol);
  const [autosave, setAutosave] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  const locale = requestedLocale;
  // The words on this screen that have no translation in this language are shown in English, and the menu says so.
  const shownInEnglish =
    locale !== 'en' && (['Layout count', 'Autosave failed', 'Recently deleted note'] as const).some((key) => languageFor(key) === 'en');
  const formatWhen = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
    return (iso: string) => formatter.format(new Date(iso));
  }, [locale]);
  const count = (n: number) => new Intl.NumberFormat(locale).format(n);

  /** The snapshot of the open workbench, read now from this device. */
  const shoot = (): LayoutSnapshot | null => {
    const parsed = layoutSnapshotSchema.safeParse(captureSnapshot({ userId, workbench, symbol, setting, desk }));
    return parsed.success ? parsed.data : null;
  };

  const refusal = (code: string | undefined) => ({ text: t(REFUSAL_COPY[refusalWords(code ?? '')]), code });

  // The autosave: a change to the open layout is written to the account after a short pause. Each tick compares the device's
  // snapshot with the last one written, so a run of changes is one write, and a failed write keeps the device copy.
  const latest = useRef({ userId, workbench, symbol, setting, desk, layouts, activeId });
  latest.current = { userId, workbench, symbol, setting, desk, layouts, activeId };
  const baseline = useRef<string | null>(null);
  useEffect(() => {
    baseline.current = null;
    if (!activeId) return undefined;
    const timer = window.setInterval(() => {
      const now = latest.current;
      if (!now.activeId || now.layouts.status !== 'ready' || !now.layouts.value) return;
      const snapshot = layoutSnapshotSchema.safeParse(
        captureSnapshot({ userId: now.userId, workbench: now.workbench, symbol: now.symbol, setting: now.setting, desk: now.desk }),
      );
      if (!snapshot.success) return;
      const json = JSON.stringify(snapshot.data);
      if (baseline.current === null) {
        baseline.current = json;
        return;
      }
      if (json === baseline.current) return;
      baseline.current = json;
      const next = withSnapshot(now.layouts.value, now.activeId, snapshot.data, new Date().toISOString());
      if (!next) return;
      setAutosave('saving');
      void now.layouts.commit(next).then((result) => setAutosave(result.ok ? 'saved' : 'failed'));
    }, AUTOSAVE_MS);
    return () => window.clearInterval(timer);
  }, [activeId]);

  const record = layouts.value;
  const active = activeId ? findLayout(record, activeId) : undefined;

  /** Save the current desk under a name. A name already taken asks first, then replaces the layout it holds. */
  const saveAs = (replace: boolean) => {
    const snapshot = shoot();
    if (!snapshot) return setStatus(refusal('not-saved'));
    const now = new Date().toISOString();
    const outcome = replace ? replaceNamed(record, name, snapshot, now) : saveNamed(record, name, snapshot, now, newRecordId('layout'));
    if (!outcome.ok) {
      if (outcome.why === 'name-taken') {
        setTaken(cleanName(name));
        return undefined;
      }
      return setStatus({ text: t('Name needed') });
    }
    const saved = outcome.layout;
    void layouts.commit(outcome.record).then((result) => {
      if (!result.ok) return setStatus(refusal(result.code));
      setActiveId(saved.id);
      setName('');
      setTaken(null);
      setAutosave('idle');
      setStatus({ text: t(replace ? 'Layout replaced' : 'Layout saved', { name: saved.name }) });
      return undefined;
    });
  };

  const openLayout = (layout: SavedLayout) => {
    const writes: StorageWrite[] = [
      ...planWrites(layout.snapshot, userId, workbench),
      { key: activeLayoutKey(userId, workbench), value: JSON.stringify(layout.id) },
    ];
    if (!applyWrites(writes)) return setStatus({ text: t('Open not saved') });
    setActiveId(layout.id);
    setStatus({ text: t('Layout opened', { name: layout.name }) });
    if (layout.snapshot.symbol === symbol) onRemount();
    else navigate(chartsHref(pairOf(layout.snapshot.symbol), { workbench, interval: layout.snapshot.interval as ChartInterval }));
    return undefined;
  };

  const copy = (layout: SavedLayout) => {
    const outcome = copyLayout(record, layout.id, newRecordId('layout'), new Date().toISOString());
    if (!outcome || !outcome.ok) return;
    void layouts
      .commit(outcome.record)
      .then((result) => setStatus(result.ok ? { text: t('Layout copied', { name: outcome.layout.name }) } : refusal(result.code)));
  };

  const exportOne = (layout: SavedLayout) => {
    const file = exportFileName(layout);
    try {
      const url = URL.createObjectURL(new Blob([exportText(layout)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = file;
      link.click();
      URL.revokeObjectURL(url);
      setStatus({ text: t('Layout exported', { file }) });
    } catch {
      setStatus({ text: t(REFUSAL_COPY['not-saved']) });
    }
  };

  const remove = (layout: SavedLayout) => {
    const next = deleteLayout(record, layout.id, new Date().toISOString());
    if (!next) return;
    void layouts.commit(next).then((result) => {
      if (!result.ok) return setStatus(refusal(result.code));
      if (activeId === layout.id) setActiveId(null);
      return setStatus({ text: t('Layout deleted', { name: layout.name }) });
    });
  };

  const recover = (id: string) => {
    const next = recoverLayout(record, id);
    if (!next) return;
    const entry = record.deleted.find((item) => item.layout.id === id);
    void layouts
      .commit(next)
      .then((result) => setStatus(result.ok ? { text: t('Layout recovered', { name: entry?.layout.name ?? '' }) } : refusal(result.code)));
  };

  const choosePreset = (preset: DeskPreset) => setDesk(deskForPreset(preset, desk.side));
  const chooseSide = (side: DeskSetting['side']) => setDesk({ ...desk, side });

  /** Reset: the grid goes back to one chart, and the widgets go back to the desk's preset with the watchlist on the right. */
  const reset = () => {
    const writes: StorageWrite[] = [
      { key: gridKey(userId, workbench), value: JSON.stringify(DEFAULT_GRID) },
      { key: deskKey(userId, workbench), value: JSON.stringify(PRESET_DESK[desk.preset]) },
    ];
    setConfirmReset(false);
    if (!applyWrites(writes)) return setStatus({ text: t(REFUSAL_COPY['not-saved']) });
    setStatus({ text: t('Reset desk') });
    return onRemount();
  };

  // Templates: the study set and drawings of this chart, with its interval and style.
  const saveTpl = (replace: boolean) => {
    const snapshot = shoot();
    if (!snapshot) return setStatus(refusal('not-saved'));
    const first = snapshot.studies[0];
    const outcome = saveTemplate(
      templates.value ?? [],
      templateName,
      {
        interval: snapshot.interval,
        mode: snapshot.mode,
        studies: first === null || first === undefined ? [] : [first],
        drawings: snapshot.drawings,
      },
      new Date().toISOString(),
      newRecordId('template'),
      replace,
    );
    if (!outcome.ok) {
      if (outcome.why === 'name-taken') setTemplateTaken(cleanName(templateName));
      else setStatus({ text: t('Name needed') });
      return;
    }
    void templates.commit(outcome.templates).then((result) => {
      if (!result.ok) return setStatus(refusal(result.code));
      setTemplateName('');
      setTemplateTaken(null);
      return setStatus({ text: t('Template saved', { name: outcome.template.name }) });
    });
  };

  /** Apply a template to a market: its studies go to the main chart, its drawings to that market's drawings. */
  const applyTemplate = (id: string, target: string) => {
    const template = (templates.value ?? []).find((entry) => entry.id === id);
    if (!template) return;
    const studies = template.studies[0] ?? null;
    const writes: StorageWrite[] = [
      {
        key: settingKey(userId, workbench),
        value: JSON.stringify({ interval: template.interval, mode: template.mode, scheme: setting.scheme ?? 'standard' }),
      },
      { key: studiesKey(userId, workbench, 0), value: studies === null ? null : JSON.stringify(studies) },
      { key: drawingsKey(userId, workbench, target), value: template.drawings === null ? null : JSON.stringify(template.drawings) },
    ];
    if (!applyWrites(writes)) return setStatus({ text: t(REFUSAL_COPY['not-saved']) });
    setStatus({ text: t('Template applied', { name: template.name, symbol: target }) });
    if (target === symbol) return onRemount();
    return navigate(chartsHref(pairOf(target), { workbench, interval: template.interval as ChartInterval }));
  };

  const studiesOff = (templates.value ?? []).some((entry) => entry.studies.length > 0) && !desk.studies;
  const presetWords = PRESET_LABEL[desk.preset];

  return (
    <div className="ly">
      <button type="button" className="cw-option" aria-expanded={open} aria-controls="ly-panel" onClick={() => setOpen((now) => !now)}>
        {t('Layouts')}
      </button>
      {open && (
        <section id="ly-panel" className="ly-panel" aria-label={t('Layouts')}>
          <p className="ly-lead">{t('Layouts lead')}</p>
          {shownInEnglish && <p className="ly-hint">{t('Locale fallback')}</p>}
          {!layouts.value && layouts.status === 'loading' && <p role="status">{t('Loading layouts')}</p>}

          <fieldset className="ly-section">
            <legend>{t('Desk preset')}</legend>
            <div className="ly-row">
              {(['classic', 'advanced'] as const).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="cw-option"
                  aria-pressed={desk.preset === preset}
                  data-preset={preset}
                  onClick={() => choosePreset(preset)}
                >
                  {t(PRESET_LABEL[preset])}
                </button>
              ))}
            </div>
            <p className="ly-hint" data-preset-note={desk.preset}>
              {t(desk.preset === 'advanced' ? 'Advanced desk' : 'Classic desk')}
            </p>
            <div className="ly-row">
              <button type="button" className="cw-option" aria-pressed={desk.side === 'left'} onClick={() => chooseSide('left')}>
                {t('Watchlist on left')}
              </button>
              <button type="button" className="cw-option" aria-pressed={desk.side === 'right'} onClick={() => chooseSide('right')}>
                {t('Watchlist on right')}
              </button>
            </div>
            <p className="ly-hint">{t('Drag widget')}</p>
            {confirmReset ? (
              <div className="ly-row" role="group" aria-label={t('Reset desk')}>
                <p>{t('Reset confirm', { preset: presetWords })}</p>
                <button type="button" className="cw-option" onClick={reset}>
                  {t('Confirm')}
                </button>
                <button type="button" className="cw-option" onClick={() => setConfirmReset(false)}>
                  {t('Cancel')}
                </button>
              </div>
            ) : (
              <button type="button" className="cw-option" onClick={() => setConfirmReset(true)}>
                {t('Reset desk')}
              </button>
            )}
          </fieldset>

          <fieldset className="ly-section">
            <legend>{t('Saved layouts')}</legend>
            {layouts.status === 'signed-out' && <p role="status">{t('Signed out layouts')}</p>}
            {layouts.status === 'error' && (
              <p role="status" className="ly-error">
                {t('Layouts load error')}{' '}
                <button type="button" className="cw-option" onClick={() => layouts.reload()}>
                  {t('Try again')}
                </button>
              </p>
            )}
            {layouts.status === 'ready' && record.layouts.length === 0 && <p className="ly-empty">{t('No layouts')}</p>}
            {layouts.status === 'ready' && record.layouts.length > 0 && (
              <p className="ly-hint">{t('Layout count', { count: count(record.layouts.length) })}</p>
            )}
            <ul className="ly-list">
              {record.layouts.map((layout) => (
                <li
                  key={layout.id}
                  className="ly-item"
                  data-layout-id={layout.id}
                  aria-current={layout.id === activeId ? 'true' : undefined}
                >
                  <div>
                    <b>{layout.name}</b>
                    <span className="ly-hint">
                      {' '}
                      {t('Layout row', {
                        name: layout.name,
                        symbol: layout.snapshot.symbol,
                        interval: intervalLabel(layout.snapshot.interval as ChartInterval),
                        saved: formatWhen(layout.savedAt),
                      })}
                    </span>
                    {layout.id === activeId && <span className="ly-tag">{t('Open now')}</span>}
                  </div>
                  <div className="ly-row">
                    <button
                      type="button"
                      className="cw-option"
                      aria-label={t('Open layout', { name: layout.name })}
                      onClick={() => openLayout(layout)}
                    >
                      {t('Open')}
                    </button>
                    <button
                      type="button"
                      className="cw-option"
                      aria-label={t('Copy layout', { name: layout.name })}
                      onClick={() => copy(layout)}
                    >
                      {t('Copy')}
                    </button>
                    <button
                      type="button"
                      className="cw-option"
                      aria-label={t('Export layout', { name: layout.name })}
                      onClick={() => exportOne(layout)}
                    >
                      {t('Export')}
                    </button>
                    <button
                      type="button"
                      className="cw-option"
                      aria-label={t('Delete layout', { name: layout.name })}
                      onClick={() => remove(layout)}
                    >
                      {t('Delete')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="ly-row">
              <label className="cw-select">
                <span>{t('Layout name')}</span>
                <input
                  value={name}
                  maxLength={60}
                  onChange={(event) => {
                    setName(event.target.value);
                    setTaken(null);
                  }}
                />
              </label>
              <button type="button" className="cw-option" disabled={layouts.status !== 'ready'} onClick={() => saveAs(false)}>
                {t('Save layout')}
              </button>
            </div>
            {taken !== null && (
              <div className="ly-row" role="group">
                <p role="status">{t('Name taken', { name: taken })}</p>
                <button type="button" className="cw-option" onClick={() => saveAs(true)}>
                  {t('Replace')}
                </button>
                <button type="button" className="cw-option" onClick={() => setTaken(null)}>
                  {t('Cancel')}
                </button>
              </div>
            )}
            {layouts.status === 'ready' && record.deleted.length > 0 && (
              <>
                <h3 className="ly-sub">{t('Recently deleted')}</h3>
                <p className="ly-hint">{t('Recently deleted note')}</p>
                <ul className="ly-list">
                  {record.deleted.map((entry) => (
                    <li key={entry.layout.id} className="ly-item">
                      <span>{entry.layout.name}</span>
                      <button
                        type="button"
                        className="cw-option"
                        aria-label={t('Recover layout', { name: entry.layout.name })}
                        onClick={() => recover(entry.layout.id)}
                      >
                        {t('Recover')}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {autosave === 'saving' && <p role="status">{t('Autosave saving')}</p>}
            {autosave === 'saved' && <p role="status">{t('Autosave saved')}</p>}
            {autosave === 'failed' && (
              <p role="status" className="ly-error">
                {t('Autosave failed')}
              </p>
            )}
          </fieldset>

          <fieldset className="ly-section">
            <legend>{t('Chart templates')}</legend>
            {templates.status === 'signed-out' && <p role="status">{t('Signed out layouts')}</p>}
            {templates.status === 'ready' && (templates.value ?? []).length === 0 && <p className="ly-empty">{t('No templates')}</p>}
            {studiesOff && <p className="ly-hint">{t('Template studies off')}</p>}
            <ul className="ly-list">
              {(templates.value ?? []).map((entry) => (
                <li key={entry.id} className="ly-item" data-template-id={entry.id}>
                  <div>
                    <b>{entry.name}</b>{' '}
                    <span className="ly-hint">
                      {t('Template summary', { interval: intervalLabel(entry.interval as ChartInterval), style: entry.mode })}
                    </span>
                  </div>
                  <div className="ly-row">
                    <label className="cw-select">
                      <span>{t('Apply to market')}</span>
                      <select value={templateMarket} onChange={(event) => setTemplateMarket(event.target.value)}>
                        {markets.map((market) => (
                          <option key={market.symbol} value={market.symbol}>
                            {market.symbol}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="button" className="cw-option" onClick={() => applyTemplate(entry.id, templateMarket)}>
                      {t('Apply template')}
                    </button>
                    <button
                      type="button"
                      className="cw-option"
                      aria-label={t('Delete layout', { name: entry.name })}
                      onClick={() => {
                        void templates.commit(removeTemplate(templates.value ?? [], entry.id)).then((result) => {
                          if (!result.ok) setStatus(refusal(result.code));
                        });
                      }}
                    >
                      {t('Delete')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="ly-row">
              <label className="cw-select">
                <span>{t('Template name')}</span>
                <input
                  value={templateName}
                  maxLength={60}
                  onChange={(event) => {
                    setTemplateName(event.target.value);
                    setTemplateTaken(null);
                  }}
                />
              </label>
              <button type="button" className="cw-option" disabled={templates.status !== 'ready'} onClick={() => saveTpl(false)}>
                {t('Save template')}
              </button>
            </div>
            {templateTaken !== null && (
              <div className="ly-row" role="group">
                <p role="status">{t('Name taken', { name: templateTaken })}</p>
                <button type="button" className="cw-option" onClick={() => saveTpl(true)}>
                  {t('Replace')}
                </button>
                <button type="button" className="cw-option" onClick={() => setTemplateTaken(null)}>
                  {t('Cancel')}
                </button>
              </div>
            )}
          </fieldset>

          {status && (
            <p role="status" className="ly-status" data-code={status.code}>
              {status.text}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
