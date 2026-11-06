import { useCallback, useId, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { deskCopy } from './copy';
import { useDeviceSetting } from '../../../features/trade/hooks';
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

/**
 * The desk layout of this person on this device. A stored value that is not a layout the desk can draw is replaced by
 * the Classic preset, and `recovered` says so once (C-workspace-01 recovery state).
 */
export function useDeskLayout(userId: string | null) {
  const key = `${KEY_PREFIX}:${userId ?? 'signed-out'}`;
  const [recovered] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null && !isDeskLayout(JSON.parse(raw));
    } catch {
      return false;
    }
  });
  const [layout, setLayout] = useDeviceSetting<DeskLayout>(key, DEFAULT_LAYOUT, isDeskLayout);
  const [arranging, setArranging] = useState(false);
  const choosePreset = useCallback((id: PresetId) => setLayout(presetLayout(id)), [setLayout]);
  const reset = useCallback(() => setLayout((current) => presetLayout(current.preset)), [setLayout]);
  const swap = useCallback((moved: WidgetId, target: WidgetId) => setLayout((current) => swapWidgets(current, moved, target)), [setLayout]);
  const resize = useCallback(
    (id: SizedWidget, deltaRem: number) => setLayout((current) => resizeWidget(current, id, deltaRem)),
    [setLayout],
  );
  return { layout, recovered, arranging, setArranging, choosePreset, reset, swap, resize };
}

export type DeskLayoutState = ReturnType<typeof useDeskLayout>;

/** The Layouts button in the ticker strip: the preset, arrange mode and reset. */
export function DeskLayoutMenu({ desk }: { desk: DeskLayoutState }) {
  const { t } = deskCopy.useCopy();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const id = useId();
  const presetName = (preset: PresetId) => (preset === 'classic' ? t('Classic') : t('Advanced'));
  return (
    <div className="dk-layouts">
      <button
        type="button"
        className="dk-layouts-btn"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen((value) => !value);
          setConfirming(false);
        }}
      >
        {t('Layouts')}
      </button>
      {open ? (
        <div
          id={id}
          role="dialog"
          aria-label={t('Desk layout')}
          className="dk-layouts-pop"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        >
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
        </div>
      ) : null}
    </div>
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
  const drag = useRef<{ x: number; applied: number; perRem: number } | null>(null);
  if (!desk.arranging) return null;
  const order = desk.layout.order;
  const at = order.indexOf(id);
  const width = id === 'chart' ? undefined : desk.layout.widths[id];
  const onMoveKey = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
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
    drag.current = { x: event.clientX, applied: 0, perRem: drawn / width };
  };
  const onEdgeMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || id === 'chart') return;
    // Whole quarter-rems only, so the stored width matches what was drawn.
    const total = Math.round(((event.clientX - drag.current.x) / drag.current.perRem) * 4) / 4;
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
      <button
        type="button"
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
      </button>
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
            const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
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
