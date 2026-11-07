import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { deskCopy } from './copy';
import { Popover, PopoverContent, PopoverTrigger } from './deps';
import { useDeviceSetting } from '../../../features/trade/hooks';
import { currentChartInterval } from './chart-setting';
import { layoutsCopy, refusalKey } from './saved-layouts-copy';
import {
  autosave,
  copyLayout,
  deleteLayout,
  exportFile,
  findByName,
  markInUse,
  restoreLayout,
  saveAs,
  useSavedLayouts,
  type DeskLayoutsValue,
  type LayoutWrite,
  type SavedDeskLayout,
} from './saved-layouts';
import {
  DEFAULT_LAYOUT,
  isDeskLayout,
  isUntouched,
  presetLayout,
  resizeWidget,
  swapWidgets,
  type DeskLayout,
  type PresetId,
  type SizedWidget,
  type WidgetId,
} from './workspace';

const DRAG_TYPE = 'text/x-intafaced-desk-widget';
const KEY_PREFIX = 'intafaced.desk.layout.v1';
/** A drag or a run of key presses is written to the layout in use once it settles, not on every step. */
const AUTOSAVE_SETTLE_MS = 500;
const NAME_MAX = 40;

/** What the Layouts menu says about the layout in use: being saved, saved, or a write the account refused. */
export type LayoutNote = null | { kind: 'saving' | 'saved'; name: string } | { kind: 'refused'; code: string };

const activeOf = (value: DeskLayoutsValue): SavedDeskLayout | undefined => value.layouts.find((layout) => layout.id === value.active);

/**
 * The desk layout of this person on this device. A stored value that is not a layout the desk can draw is replaced by
 * the Classic preset, and `recovered` says so once (C-workspace-01 recovery state).
 *
 * The account keeps named layouts too (C-workspace-02): when one is in use, the desk opens with it on every device (the
 * account's copy wins over this device's), and each change the person makes is saved into it.
 */
export function useDeskLayout(userId: string | null) {
  const key = `${KEY_PREFIX}:${userId ?? 'signed-out'}`;
  // Whether this person's stored layout on this device was one the desk could not draw. Read again when the person
  // changes, and cleared once they choose or arrange a layout.
  const unreadable = useMemo(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null && !isDeskLayout(JSON.parse(raw));
    } catch {
      return false;
    }
  }, [key]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const recovered = unreadable && dismissed !== key;
  const [layout, setLayout] = useDeviceSetting<DeskLayout>(key, DEFAULT_LAYOUT, isDeskLayout);
  const latest = useRef(layout);
  latest.current = layout;
  // Set by the person's own changes only, so a layout applied from the account is never written back.
  const edited = useRef(false);
  const change = useCallback(
    (next: (current: DeskLayout) => DeskLayout) => {
      setDismissed(key);
      edited.current = true;
      setLayout(next);
    },
    [key, setLayout],
  );
  const apply = useCallback(
    (next: DeskLayout) => {
      setDismissed(key);
      setLayout(next);
    },
    [key, setLayout],
  );
  const [arranging, setArranging] = useState(false);
  const choosePreset = useCallback((id: PresetId) => change(() => presetLayout(id)), [change]);
  const reset = useCallback(() => change((current) => presetLayout(current.preset)), [change]);
  const swap = useCallback((moved: WidgetId, target: WidgetId) => change((current) => swapWidgets(current, moved, target)), [change]);
  const resize = useCallback((id: SizedWidget, deltaRem: number) => change((current) => resizeWidget(current, id, deltaRem)), [change]);

  const { layouts: saved, change: changeSaved } = useSavedLayouts();
  const [note, setNote] = useState<LayoutNote>(null);

  // The layout in use on the account wins when the desk opens: once per person per page.
  const appliedFor = useRef<string | null>(null);
  useEffect(() => {
    if (saved.status !== 'ready' || !userId || appliedFor.current === userId) return;
    appliedFor.current = userId;
    const active = activeOf(saved.value);
    if (active && isDeskLayout(active.desk)) apply(active.desk);
  }, [saved, userId, apply]);

  // Autosave: the person's change goes into the layout in use once it settles.
  const activeName = saved.status === 'ready' ? (activeOf(saved.value)?.name ?? null) : null;
  useEffect(() => {
    if (!edited.current) return;
    edited.current = false;
    if (activeName === null) return;
    setNote({ kind: 'saving', name: activeName });
    const timer = setTimeout(() => {
      void changeSaved((value) => autosave(value, latest.current, new Date())).then((result) =>
        setNote(result.ok ? { kind: 'saved', name: activeName } : { kind: 'refused', code: result.code }),
      );
    }, AUTOSAVE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveDesk = useCallback(
    (name: string, symbol: string) =>
      changeSaved((value) => saveAs(value, { name, symbol, interval: currentChartInterval(), desk: latest.current }, new Date())),
    [changeSaved],
  );
  const openLayout = useCallback(
    async (target: SavedDeskLayout): Promise<LayoutWrite> => {
      const result = await changeSaved((value) => markInUse(value, target.id));
      if (result.ok && isDeskLayout(target.desk)) apply(target.desk);
      return result;
    },
    [changeSaved, apply],
  );
  const copy = useCallback((id: string) => changeSaved((value) => copyLayout(value, id, new Date())), [changeSaved]);
  const remove = useCallback((id: string) => changeSaved((value) => deleteLayout(value, id, new Date())), [changeSaved]);
  const restore = useCallback((id: string) => changeSaved((value) => restoreLayout(value, id)), [changeSaved]);

  return {
    layout,
    recovered,
    arranging,
    setArranging,
    choosePreset,
    reset,
    swap,
    resize,
    saved,
    note,
    saveDesk,
    openLayout,
    copy,
    remove,
    restore,
  };
}

export type DeskLayoutState = ReturnType<typeof useDeskLayout>;

/** Hand the person a file: a link inside the menu, so the click never counts as a click outside it. */
function download(near: HTMLElement, file: { name: string; text: string }) {
  const url = URL.createObjectURL(new Blob([file.text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.hidden = true;
  near.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

type SaveForm = { name: string; replacing: boolean; problem: string | null };

/**
 * The Layouts button in the ticker strip: the preset, arrange mode and reset, and the layouts the account keeps (save,
 * open, copy, export, delete and restore).
 */
export function DeskLayoutMenu({
  desk,
  symbol,
  onOpenLayout,
}: {
  desk: DeskLayoutState;
  symbol: string;
  onOpenLayout: (layout: SavedDeskLayout) => void;
}) {
  const { t } = deskCopy.useCopy();
  const { t: l } = layoutsCopy.useCopy();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [form, setForm] = useState<SaveForm | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const presetName = (preset: PresetId) => (preset === 'classic' ? t('Classic') : t('Advanced'));
  const saved = desk.saved;

  const act = async (write: () => Promise<LayoutWrite>): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    const result = await write();
    setBusy(false);
    if (!result.ok) setProblem(l(refusalKey(result.code)));
    return result.ok;
  };

  const submit = async (replace: boolean) => {
    if (!form) return;
    const name = form.name.trim();
    if (name === '') return setForm({ ...form, problem: l('Name needed') });
    if (name.length > NAME_MAX) return setForm({ ...form, problem: l('Name too long') });
    if (!replace && saved.status === 'ready' && findByName(saved.value, name)) return setForm({ ...form, replacing: true, problem: null });
    setBusy(true);
    const result = await desk.saveDesk(name, symbol);
    setBusy(false);
    if (result.ok) {
      setForm(null);
      setOpen(false);
    } else setForm({ ...form, replacing: false, problem: l(refusalKey(result.code)) });
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit(false);
  };

  const noteText =
    desk.note === null
      ? null
      : desk.note.kind === 'refused'
        ? l(refusalKey(desk.note.code))
        : desk.note.kind === 'saving'
          ? l('Saving', { name: desk.note.name })
          : l('Saved', { name: desk.note.name });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setConfirming(false);
          setForm(null);
          setShowDeleted(false);
          setProblem(null);
        }
      }}
    >
      <PopoverTrigger className="dk-layouts-btn">{t('Layouts')}</PopoverTrigger>
      {/* A portal above the page, so the ticker strip never clips it. */}
      <PopoverContent align="end" aria-label={t('Desk layout')} className="dk-layouts-pop">
        <fieldset className="dk-layouts-presets">
          <legend>{t('Desk preset')}</legend>
          {(['classic', 'advanced'] as const).map((preset) => (
            <label key={preset} className="dk-layouts-preset">
              <input
                type="radio"
                name={`${id}-preset`}
                checked={desk.layout.preset === preset}
                onChange={() => desk.choosePreset(preset)}
              />
              {presetName(preset)}
            </label>
          ))}
        </fieldset>
        {isUntouched(desk.layout) ? null : <p className="dk-layouts-note">{t('Arranged on this device')}</p>}
        <div className="dk-layouts-actions">
          <button
            type="button"
            onClick={() => {
              desk.setArranging(true);
              setOpen(false);
            }}
          >
            {t('Arrange widgets')}
          </button>
          <button type="button" onClick={() => setConfirming(true)}>
            {t('Reset desk')}
          </button>
        </div>
        {confirming ? (
          <div role="alertdialog" aria-label={t('Reset the desk?')} className="dk-layouts-confirm">
            <p>
              {t('Reset the desk to the {preset} preset? The arrangement on this device is replaced.', {
                preset: presetName(desk.layout.preset),
              })}
            </p>
            <div className="dk-layouts-actions">
              <button
                type="button"
                onClick={() => {
                  desk.reset();
                  desk.setArranging(false);
                  setConfirming(false);
                  setOpen(false);
                }}
              >
                {t('Reset')}
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                {t('Cancel')}
              </button>
            </div>
          </div>
        ) : null}

        <section className="dk-saved" aria-labelledby={`${id}-saved`}>
          <h3 id={`${id}-saved`} className="dk-saved-title">
            {l('My layouts')}
          </h3>
          {saved.status === 'signed-out' ? (
            <p className="dk-layouts-note">{l('Layouts signed out')}</p>
          ) : saved.status === 'loading' ? (
            <p className="dk-layouts-note">{l('Layouts loading')}</p>
          ) : saved.status === 'failed' ? (
            <p className="dk-layouts-note">
              {l('Layouts failed')}{' '}
              <button type="button" className="dk-saved-link" onClick={saved.reload}>
                {l('Try again')}
              </button>
            </p>
          ) : (
            <>
              {saved.value.layouts.length === 0 ? (
                <p className="dk-layouts-note">{l('No layouts')}</p>
              ) : (
                <ul className="dk-saved-list">
                  {saved.value.layouts.map((layout) => (
                    <li key={layout.id} className="dk-saved-row" data-layout-id={layout.id}>
                      <span className="dk-saved-name">{layout.name}</span>
                      {layout.id === saved.value.active ? <span className="dk-saved-tag">{l('In use')}</span> : null}
                      <span className="dk-saved-facts">{l('Layout facts', { symbol: layout.symbol, interval: layout.interval })}</span>
                      <span className="dk-saved-actions">
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={l('Open name', { name: layout.name })}
                          onClick={() =>
                            void act(() => desk.openLayout(layout)).then((ok) => {
                              if (!ok) return;
                              setOpen(false);
                              onOpenLayout(layout);
                            })
                          }
                        >
                          {l('Open')}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={l('Copy name', { name: layout.name })}
                          onClick={() => void act(() => desk.copy(layout.id))}
                        >
                          {l('Copy')}
                        </button>
                        <button
                          type="button"
                          aria-label={l('Export name', { name: layout.name })}
                          onClick={(event) => download(event.currentTarget, exportFile(layout))}
                        >
                          {l('Export')}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={l('Delete name', { name: layout.name })}
                          onClick={() => void act(() => desk.remove(layout.id))}
                        >
                          {l('Delete')}
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {form ? (
                <div role="dialog" aria-label={l('Save layout')} className="dk-saved-form">
                  {form.replacing ? (
                    <div role="alertdialog" aria-label={l('Replace title', { name: form.name.trim() })} className="dk-layouts-confirm">
                      <p>{l('Replace body', { name: form.name.trim() })}</p>
                      <div className="dk-layouts-actions">
                        <button type="button" disabled={busy} onClick={() => void submit(true)}>
                          {l('Replace')}
                        </button>
                        <button type="button" onClick={() => setForm({ ...form, replacing: false })}>
                          {l('Cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={onSubmit} className="dk-saved-fields">
                      <label className="dk-saved-field">
                        {l('Layout name')}
                        <input
                          value={form.name}
                          maxLength={NAME_MAX}
                          autoFocus
                          onChange={(event) => setForm({ ...form, name: event.target.value, problem: null })}
                        />
                      </label>
                      <div className="dk-layouts-actions">
                        <button type="submit" disabled={busy}>
                          {l('Save')}
                        </button>
                        <button type="button" onClick={() => setForm(null)}>
                          {l('Cancel')}
                        </button>
                      </div>
                    </form>
                  )}
                  {form.problem ? (
                    <p role="alert" className="dk-saved-problem">
                      {form.problem}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="dk-layouts-actions">
                {form ? null : (
                  <button type="button" onClick={() => setForm({ name: '', replacing: false, problem: null })}>
                    {l('Save layout')}
                  </button>
                )}
                <button type="button" aria-expanded={showDeleted} onClick={() => setShowDeleted((shown) => !shown)}>
                  {l('Recently deleted')}
                </button>
              </div>
              {showDeleted ? (
                saved.value.deleted.length === 0 ? (
                  <p className="dk-layouts-note">{l('Nothing deleted')}</p>
                ) : (
                  <ul className="dk-saved-list" aria-label={l('Recently deleted')}>
                    {saved.value.deleted.map((layout) => (
                      <li key={layout.id} className="dk-saved-row" data-deleted-id={layout.id}>
                        <span className="dk-saved-name">{layout.name}</span>
                        <span className="dk-saved-facts">{l('Layout facts', { symbol: layout.symbol, interval: layout.interval })}</span>
                        <span className="dk-saved-actions">
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={l('Restore name', { name: layout.name })}
                            onClick={() => void act(() => desk.restore(layout.id))}
                          >
                            {l('Restore')}
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )
              ) : null}
            </>
          )}
          {problem ? (
            <p role="alert" className="dk-saved-problem">
              {problem}
            </p>
          ) : null}
          {noteText ? (
            <p role="status" className="dk-layouts-note">
              {noteText}
            </p>
          ) : null}
        </section>
      </PopoverContent>
    </Popover>
  );
}

/** Drag-and-drop on a widget: a widget dropped on another swaps with it. Only while arranging. */
export function dropTarget(desk: DeskLayoutState, id: WidgetId) {
  if (!desk.arranging) return {};
  return {
    onDragOver: (event: DragEvent) => {
      if (event.dataTransfer.types.includes(DRAG_TYPE)) event.preventDefault();
    },
    onDrop: (event: DragEvent) => {
      const moved = event.dataTransfer.getData(DRAG_TYPE);
      if (!moved) return;
      event.preventDefault();
      desk.swap(moved as WidgetId, id);
    },
  };
}

/** The move handle and, for widgets with a width, the resize edge. Drawn only while arranging. */
export function ArrangeChrome({ desk, id, name }: { desk: DeskLayoutState; id: WidgetId; name: string }) {
  const { t } = deskCopy.useCopy();
  const drag = useRef<{ x: number; applied: number; perRem: number; sign: number } | null>(null);
  if (!desk.arranging) return null;
  const order = desk.layout.order;
  const at = order.indexOf(id);
  const width = id === 'chart' ? undefined : desk.layout.widths[id];
  // Arrow keys and drags follow the page's writing direction: in a right-to-left page "towards the end" is leftwards.
  const forward = (element: Element) => (getComputedStyle(element).direction === 'rtl' ? -1 : 1);
  const keyStep = (event: KeyboardEvent) =>
    (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0) * forward(event.currentTarget);
  const onMoveKey = (event: KeyboardEvent) => {
    const step = keyStep(event);
    const neighbour = order[at + step];
    if (step === 0 || !neighbour) return;
    event.preventDefault();
    desk.swap(id, neighbour);
  };
  const onEdgeDown = (event: PointerEvent<HTMLDivElement>) => {
    // Pixels per rem from the widget's own drawn width, so a person's own font size scales the drag.
    const drawn = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
    if (!width || drawn <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, applied: 0, perRem: drawn / width, sign: forward(event.currentTarget) };
  };
  const onEdgeMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || id === 'chart') return;
    // Whole quarter-rems only, so the stored width matches what was drawn.
    const total = Math.round((((event.clientX - drag.current.x) * drag.current.sign) / drag.current.perRem) * 4) / 4;
    const delta = total - drag.current.applied;
    if (delta === 0) return;
    drag.current.applied = total;
    desk.resize(id, delta);
  };
  const onEdgeUp = () => {
    drag.current = null;
  };
  return (
    <>
      {/* A div, not a <button>: some browsers never start a drag from a button element. */}
      <div
        role="button"
        tabIndex={0}
        className="dk-arrange-move"
        draggable
        aria-label={t('Move {widget}', { widget: name })}
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, id);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onKeyDown={onMoveKey}
      >
        {t('Move')}
      </div>
      {id === 'chart' || width === undefined ? null : (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={t('Resize {widget}', { widget: name })}
          aria-valuenow={width}
          className="dk-arrange-edge"
          onPointerDown={onEdgeDown}
          onPointerMove={onEdgeMove}
          onPointerUp={onEdgeUp}
          onPointerCancel={onEdgeUp}
          onKeyDown={(event) => {
            const step = keyStep(event);
            if (step === 0) return;
            event.preventDefault();
            desk.resize(id, step);
          }}
        />
      )}
    </>
  );
}

/** The bar shown while arranging, with the way out. */
export function ArrangeBar({ desk }: { desk: DeskLayoutState }) {
  const { t } = deskCopy.useCopy();
  if (!desk.arranging) return null;
  return (
    <div className="dk-arrange-bar" role="status">
      <span>{t('Drag a widget onto another to swap them, or drag an edge to resize it.')}</span>
      <button type="button" onClick={() => desk.setArranging(false)}>
        {t('Done')}
      </button>
    </div>
  );
}
