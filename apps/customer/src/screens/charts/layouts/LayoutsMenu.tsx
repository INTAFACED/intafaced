/**
 * The desk's Layouts menu, on the chart workbench: the Classic and Advanced presets, the widget positions, the reset, the saved
 * layouts (save, open, copy, export, delete, recover, empty the recovery list, autosave to the account) and chart templates
 * (save, apply to a market). A layout or template is a view record: it never places an order and never changes a price or a
 * balance. Choosing a preset writes the desk into the open layout as well: the desk is part of the layout.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { layoutSnapshotSchema, type DeskSetting, type LayoutSnapshot, type SavedLayout } from '@intafaced/contracts/layouts-preferences';
import { useSession } from '../../../features/session/session';
import { useDeviceSetting } from '../../../features/trade/hooks';
import { navigate } from '../../../app/location';
import { fmtPrice, useTickers } from '../../../data';
import type { ChartInterval } from '../../trade/chart/candles';
import { pairOf, type DeskMarket } from '../../trade/desk/market';
import { chartsHref, intervalLabel, settingKey, type WorkbenchSetting } from '../workbench';
import { DEFAULT_GRID, gridKey } from '../grid';
import { drawingsKey } from '../drawings/store';
import {
  activeLayoutKey,
  applyWrites,
  captureSnapshot,
  deskKey,
  planWrites,
  studiesKey,
  workbenchHasContent,
  type StorageWrite,
} from './capture';
import { layoutsCopy } from './copy';
import {
  cleanName,
  copyLayout,
  deleteLayout,
  deskForPreset,
  emptyRecentlyDeleted,
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
import { drawingLimitRefusal, newRecordId, removeTemplate, saveTemplate, type DrawingLimitRefusal } from './templates';
import { refusalWords, useChartTemplates, useLayoutRecord, type RefusalWords } from './store';
import './layouts.css';

/** How often the open layout is compared with the account copy. A change is written on the first tick after it lands. */
export const AUTOSAVE_MS = 2000;
/** The notice a re-opened account copy leaves for the next mount of the page (this viewer's tab only). */
const NOTICE_KEY = (workbench: string) => `charts-layout-notice:${workbench}`;

const REFUSAL_COPY = {
  'layout-unset': 'Refused layout limit unset',
  'layout-full': 'Refused layout limit reached',
  'template-unset': 'Refused template unset',
  'template-full': 'Refused template reached',
  'too-large': 'Refused too large',
  version: 'Refused version',
  'not-saved': 'Refused not saved',
} as const satisfies Record<RefusalWords, string>;

const LIMIT_COPY = {
  'drawing-unset': 'Refused drawing unset',
  'drawing-full': 'Refused drawing full',
  'brush-unset': 'Refused brush unset',
  'brush-full': 'Refused brush full',
} as const satisfies Record<DrawingLimitRefusal, string>;

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
  /** The owner's drawing caps for the market on this page. A blank cap refuses a template that holds drawings of that kind. */
  limits: { drawingCap: number | null; brushPointCap: number | null };
  /** The page re-reads browser storage: the layout, template or reset has written what it shows. */
  onRemount: () => void;
}

const isActiveId = (value: unknown): value is string | null => value === null || typeof value === 'string';

function readNotice(workbench: string): string | null {
  try {
    return sessionStorage.getItem(NOTICE_KEY(workbench));
  } catch {
    return null;
  }
}
function writeNotice(workbench: string, text: string | null): void {
  try {
    if (text === null) sessionStorage.removeItem(NOTICE_KEY(workbench));
    else sessionStorage.setItem(NOTICE_KEY(workbench), text);
  } catch {
    /* A blocked storage shows the notice for this render only. */
  }
}

export function LayoutsMenu({ workbench, symbol, markets, setting, desk, setDesk, limits, onRemount }: LayoutsMenuProps) {
  const { t, requestedLocale, languageFor } = layoutsCopy.useCopy();
  const { userId } = useSession();
  const layouts = useLayoutRecord();
  const templates = useChartTemplates();
  const tickers = useTickers();
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useDeviceSetting<string | null>(activeLayoutKey(userId, workbench), null, isActiveId);
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState<string | null>(() => readNotice(workbench));
  const [name, setName] = useState('');
  const [taken, setTaken] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateTaken, setTemplateTaken] = useState<string | null>(null);
  const [templateMarket, setTemplateMarket] = useState(symbol);
  const [pendingApply, setPendingApply] = useState<{ id: string; target: string } | null>(null);
  const [autosave, setAutosave] = useState<'idle' | 'saving' | 'saved' | 'failed' | 'conflict'>('idle');

  const locale = requestedLocale;
  // The words on this screen that have no translation in this language are shown in English, and the menu says so.
  const shownInEnglish =
    locale !== 'en' && (['Layout count', 'Autosave failed', 'Recently deleted note'] as const).some((key) => languageFor(key) === 'en');
  const formatWhen = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
    return (iso: string) => formatter.format(new Date(iso));
  }, [locale]);
  const count = (n: number) => new Intl.NumberFormat(locale).format(n);
  const lastPrice = (() => {
    const row = tickers.status === 'ready' ? tickers.data[symbol] : undefined;
    const tickSize = markets.find((market) => market.symbol === symbol)?.tickSize ?? null;
    return row?.last ? fmtPrice(row.last, tickSize, { locale }) : null;
  })();

  /** The snapshot of the open workbench, read now from this device. */
  const shoot = (): LayoutSnapshot | null => {
    const parsed = layoutSnapshotSchema.safeParse(captureSnapshot({ userId, workbench, symbol, setting, desk }));
    return parsed.success ? parsed.data : null;
  };

  const refusal = (code: string | undefined) => ({ text: t(REFUSAL_COPY[refusalWords(code ?? '')]), code });

  // Autosave. A timer compares the open layout's device snapshot with the last one it wrote, every AUTOSAVE_MS. It writes only
  // when nothing is queued or in flight, so one write is never sent over another. A version conflict re-reads the account copy
  // (the store reloads it), and the menu then re-opens the account's layout on this device and says so.
  const latest = useRef({ userId, workbench, symbol, setting, desk, layouts, activeId, onRemount });
  latest.current = { userId, workbench, symbol, setting, desk, layouts, activeId, onRemount };
  const baseline = useRef<string | null>(null);
  const flight = useRef(false);
  const resync = useRef(false);
  useEffect(() => {
    baseline.current = null;
    if (!activeId) return undefined;
    const timer = window.setInterval(() => {
      const now = latest.current;
      if (!now.activeId || flight.current || now.layouts.busy || now.layouts.status !== 'ready' || !now.layouts.value) return;
      if (resync.current) {
        resync.current = false;
        const account = findLayout(now.layouts.value, now.activeId);
        if (account && applyWrites(planWrites(account.snapshot, now.userId, now.workbench))) {
          baseline.current = null;
          writeNotice(now.workbench, 'updated');
          now.onRemount();
        }
        return;
      }
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
      const id = now.activeId;
      const at = new Date().toISOString();
      if (!findLayout(now.layouts.value, id)) return;
      baseline.current = json;
      flight.current = true;
      setAutosave('saving');
      // An updater: it runs on the record as it stands when the write is sent, so a write queued behind another keeps its change.
      void now.layouts
        .commit((latest) => withSnapshot(latest, id, snapshot.data, at) ?? latest)
        .then((result) => {
          flight.current = false;
          if (result.ok) setAutosave('saved');
          else if (result.code === 'preferences.version_conflict') {
            resync.current = true;
            setAutosave('conflict');
          } else setAutosave('failed');
        });
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
    const id = newRecordId('layout');
    const outcome = replace ? replaceNamed(record, name, snapshot, now) : saveNamed(record, name, snapshot, now, id);
    if (!outcome.ok) {
      if (outcome.why === 'name-taken') {
        setTaken(cleanName(name));
        return undefined;
      }
      return setStatus({ text: t('Name needed') });
    }
    const saved = outcome.layout;
    void layouts
      .commit((latest) => {
        const next = replace ? replaceNamed(latest, name, snapshot, now) : saveNamed(latest, name, snapshot, now, id);
        return next.ok ? next.record : latest;
      })
      .then((result) => {
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
    setAutosave('idle');
    setStatus({ text: t('Layout opened', { name: layout.name }) });
    if (layout.snapshot.symbol === symbol) onRemount();
    else navigate(chartsHref(pairOf(layout.snapshot.symbol), { workbench, interval: layout.snapshot.interval as ChartInterval }));
    return undefined;
  };

  const copy = (layout: SavedLayout) => {
    const id = newRecordId('layout');
    const at = new Date().toISOString();
    const outcome = copyLayout(record, layout.id, id, at);
    if (!outcome || !outcome.ok) return;
    void layouts
      .commit((latest) => {
        const next = copyLayout(latest, layout.id, id, at);
        return next && next.ok ? next.record : latest;
      })
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
      // The link has started the download; the object URL is released once the click has run.
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus({ text: t('Layout exported', { file }) });
    } catch {
      setStatus({ text: t(REFUSAL_COPY['not-saved']) });
    }
  };

  const remove = (layout: SavedLayout) => {
    if (!findLayout(record, layout.id)) return;
    void layouts
      .commit((latest) => deleteLayout(latest, layout.id, new Date().toISOString()) ?? latest)
      .then((result) => {
        if (!result.ok) return setStatus(refusal(result.code));
        if (activeId === layout.id) setActiveId(null);
        return setStatus({ text: t('Layout deleted', { name: layout.name }) });
      });
  };

  const recover = (id: string) => {
    const outcome = recoverLayout(record, id);
    if (!outcome.ok) {
      setStatus(outcome.why === 'name-taken' ? { text: t('Recover name taken') } : { text: t(REFUSAL_COPY['not-saved']) });
      return;
    }
    void layouts
      .commit((latest) => {
        const next = recoverLayout(latest, id);
        return next.ok ? next.record : latest;
      })
      .then((result) => setStatus(result.ok ? { text: t('Layout recovered', { name: outcome.layout.name }) } : refusal(result.code)));
  };

  const emptyList = () => {
    void layouts
      .commit((latest) => emptyRecentlyDeleted(latest))
      .then((result) => setStatus(result.ok ? { text: t('Emptied recently deleted') } : refusal(result.code)));
  };

  // The desk is part of the layout: a preset or a side chosen while a layout is open is saved into it by the autosave.
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

  // Templates: the study set and drawings of this chart, with its market, interval and style.
  const saveTpl = (replace: boolean) => {
    const snapshot = shoot();
    if (!snapshot) return setStatus(refusal('not-saved'));
    const first = snapshot.studies[0];
    const body = {
      symbol: snapshot.symbol,
      interval: snapshot.interval,
      mode: snapshot.mode,
      studies: first === null || first === undefined ? [] : [first],
      drawings: snapshot.drawings,
    };
    const at = new Date().toISOString();
    const id = newRecordId('template');
    const outcome = saveTemplate(templates.value, templateName, body, at, id, replace);
    if (!outcome.ok) {
      if (outcome.why === 'name-taken') setTemplateTaken(cleanName(templateName));
      else setStatus({ text: t('Name needed') });
      return;
    }
    void templates
      .commit((latest) => {
        const next = saveTemplate(latest, templateName, body, at, id, replace);
        return next.ok ? next.templates : latest;
      })
      .then((result) => {
        if (!result.ok) return setStatus(refusal(result.code));
        setTemplateName('');
        setTemplateTaken(null);
        return setStatus({ text: t('Template saved', { name: outcome.template.name }) });
      });
  };

  /**
   * Apply a template to a market. Its drawings are applied only on the market they were drawn on; elsewhere they are dropped with
   * a notice. The owner's drawing caps are checked first, and nothing is written when one refuses. Applying over studies or
   * drawings that are already there asks first.
   */
  const applyTemplate = (id: string, target: string, confirmed = false) => {
    const template = templates.value.find((entry) => entry.id === id);
    if (!template) return;
    const sameMarket = target === template.symbol;
    if (sameMarket) {
      const why = drawingLimitRefusal(template.drawings, limits);
      if (why) return setStatus({ text: t(LIMIT_COPY[why]) });
    }
    if (!confirmed && workbenchHasContent(userId, workbench, target)) {
      setPendingApply({ id, target });
      return;
    }
    setPendingApply(null);
    const studies = template.studies[0] ?? null;
    const writes: StorageWrite[] = [
      {
        key: settingKey(userId, workbench),
        value: JSON.stringify({ interval: template.interval, mode: template.mode, scheme: setting.scheme ?? 'standard' }),
      },
      { key: studiesKey(userId, workbench, 0), value: studies === null ? null : JSON.stringify(studies) },
      {
        key: drawingsKey(userId, workbench, target),
        value: sameMarket && template.drawings !== null ? JSON.stringify(template.drawings) : null,
      },
    ];
    if (!applyWrites(writes)) return setStatus({ text: t(REFUSAL_COPY['not-saved']) });
    if (!sameMarket) {
      // The page moves to the market; the notice says the drawings were left behind.
      writeNotice(workbench, t('Template drawings skipped', { source: template.symbol, symbol: target }));
    }
    setStatus({ text: t('Template applied', { name: template.name, symbol: target }) });
    if (target === symbol) return onRemount();
    return navigate(chartsHref(pairOf(target), { workbench, interval: template.interval as ChartInterval }));
  };

  const studiesOff = templates.value.some((entry) => entry.studies.length > 0) && !desk.studies;
  const presetWords = PRESET_LABEL[desk.preset];
  const noticeText = notice === 'updated' ? t('Updated from account') : notice;
  const acknowledge = () => {
    writeNotice(workbench, null);
    setNotice(null);
  };

  return (
    <div className="ly">
      <button type="button" className="cw-option" aria-expanded={open} aria-controls="ly-panel" onClick={() => setOpen((now) => !now)}>
        {t('Layouts')}
      </button>
      {open && (
        <section id="ly-panel" className="ly-panel" aria-label={t('Layouts')}>
          <p className="ly-lead">{t('Layouts lead')}</p>
          {shownInEnglish && <p className="ly-hint">{t('Locale fallback')}</p>}
          {lastPrice !== null && <p className="ly-hint">{t('Last price', { price: lastPrice, symbol })}</p>}
          {noticeText && (
            <p role="status" className="ly-status" onClick={acknowledge}>
              {noticeText}
            </p>
          )}
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
                      <div className="ly-row">
                        <button
                          type="button"
                          className="cw-option"
                          aria-label={t('Recover layout', { name: entry.layout.name })}
                          onClick={() => recover(entry.layout.id)}
                        >
                          {t('Recover')}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
                <button type="button" className="cw-option" onClick={emptyList}>
                  {t('Empty recently deleted')}
                </button>
              </>
            )}
            {active && autosave === 'idle' && (
              <p className="ly-hint">
                {t('Open now')}: {active.name}
              </p>
            )}
            {autosave === 'saving' && <p role="status">{t('Autosave saving')}</p>}
            {autosave === 'saved' && <p role="status">{t('Autosave saved')}</p>}
            {autosave === 'conflict' && <p role="status">{t('Updated from account')}</p>}
            {autosave === 'failed' && (
              <p role="status" className="ly-error">
                {t('Autosave failed')}
              </p>
            )}
          </fieldset>

          <fieldset className="ly-section">
            <legend>{t('Chart templates')}</legend>
            {templates.status === 'signed-out' && <p role="status">{t('Signed out layouts')}</p>}
            {templates.status === 'ready' && templates.value.length === 0 && <p className="ly-empty">{t('No templates')}</p>}
            {studiesOff && <p className="ly-hint">{t('Template studies off')}</p>}
            <ul className="ly-list">
              {templates.value.map((entry) => (
                <li key={entry.id} className="ly-item" data-template-id={entry.id}>
                  <div>
                    <b>{entry.name}</b>{' '}
                    <span className="ly-hint">
                      {t('Template summary', { interval: intervalLabel(entry.interval as ChartInterval), style: entry.mode })}
                    </span>
                    <span className="ly-hint"> {entry.symbol}</span>
                  </div>
                  {pendingApply?.id === entry.id ? (
                    <div className="ly-row" role="group">
                      <p role="status">{t('Confirm replace chart', { symbol: pendingApply.target })}</p>
                      <button type="button" className="cw-option" onClick={() => applyTemplate(entry.id, pendingApply.target, true)}>
                        {t('Confirm')}
                      </button>
                      <button type="button" className="cw-option" onClick={() => setPendingApply(null)}>
                        {t('Cancel')}
                      </button>
                    </div>
                  ) : (
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
                        aria-label={t('Delete template', { name: entry.name })}
                        onClick={() => {
                          void templates
                            .commit((latest) => removeTemplate(latest, entry.id))
                            .then((result) => {
                              if (!result.ok) setStatus(refusal(result.code));
                            });
                        }}
                      >
                        {t('Delete')}
                      </button>
                    </div>
                  )}
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
