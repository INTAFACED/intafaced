/**
 * `useDrawings(host, bars, options)`: the drawing state of one chart. It places, selects, drags, erases and brushes drawings
 * on the workbench chart the host gives it, keeps the undo history, and stores the document on this device.
 *
 * Coordinates: a click or a pointer position is turned into a bar (the loaded bar nearest the logical index) and a decimal
 * price at the tick size; with magnet on, the price snaps to that bar's open, high, low or close within the sensitivity.
 * The points are stored as bar times and decimal prices; the canvas only ever sees them re-planned for the current view.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Candle } from '../../../data/types';
import type { ChartHost } from '../chart-host';
import { drawingsCopy } from './copy';
import { barPrices, magnetSnap, type Pt, type Refusal } from './geometry';
import { figureLines } from './figures';
import { OWNER_VALUE_UNSET } from '../owner-values';
import { dec, diffAtTick, priceFromNumber, type Decimal } from './decimal';
import {
  addDrawing,
  barIndexAt,
  blankCapRefusal,
  clearAll as clearDoc,
  findDrawing,
  groupDrawings,
  isRefused,
  isVisible,
  makeDrawing,
  patchDrawing,
  pointsNeeded,
  removeDrawing,
  setGroupHidden,
  setHiddenAll,
  shiftPoints,
  type Drawing,
  type DrawingDoc,
  type DrawingKind,
  type DrawingLimits,
  type ModelRefusal,
  type PatternVariant,
} from './model';
import { canRedo, canUndo, commit, redo as redoHistory, startHistory, undo as undoHistory, type History } from './history';
import { DrawingsPrimitive } from './primitive';
import { drawingsKey, readDoc, writeDoc } from './store';
import { isCursorTool, toolKind, type ToolId } from './tools';

/** Each drawing's painted lines, in pixels: [x1, y1, x2, y2]. */
type DrawnLines = Array<{ id: string; lines: Array<[number, number, number, number]> }>;

/** The magnet's sensitivity in pixels: a UI default, shown in the panel. Blank (null) turns the magnet off. */
export const MAGNET_SENSITIVITY_DEFAULT = 8;
/** Distance in pixels a brush stroke samples its next point at. */
const BRUSH_STEP_PX = 3;
/** A press that travels more than this many pixels is a pan or a drag, never a click. */
const PAN_SLOP_PX = 5;

type Translate = (key: string, vars?: Record<string, string>) => string;

export interface DrawingsOptions {
  userId: string | null;
  workbench: string;
  symbol: string;
  /** The market's tick size as a decimal string. */
  tickSize: string;
  /** Owner-set limits. Blank refuses. */
  limits: DrawingLimits;
  magnetSensitivityPx?: number | null;
  /** Defaults to this device's local storage; tests pass their own. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  newId?: () => string;
}

export interface DrawingsApi {
  /** The document as it is shown (a drag in progress is shown before it is committed). */
  doc: DrawingDoc;
  tool: ToolId;
  setTool(tool: ToolId): void;
  selectedId: string | null;
  select(id: string | null): void;
  selected: Drawing | null;
  /** The hint for the tool in use (what to click next). */
  hint: string;
  /** The last refusal, in plain words, until the next action. */
  notice: string | null;
  /** The typed code of an owner-limit note (OWNER_VALUE_UNSET, OWNER_VALUE_UNAVAILABLE), or null. */
  noticeCode: string | null;
  clearNotice(): void;
  canUndo: boolean;
  canRedo: boolean;
  undo(): void;
  redo(): void;
  deleteSelected(): void;
  remove(id: string): void;
  setLocked(id: string, locked: boolean): void;
  setHidden(id: string, hidden: boolean): void;
  setText(id: string, text: string): void;
  setTextValue(text: string): void;
  textValue: string;
  setLevels(id: string, levels: readonly string[]): void;
  magnet: boolean;
  setMagnet(on: boolean): void;
  magnetAvailable: boolean;
  checked: readonly string[];
  toggleChecked(id: string): void;
  groupChecked(): void;
  toggleGroupHidden(groupId: string): void;
  hideAll(): void;
  hiddenAll: boolean;
  clearAll(): void;
  /** False when the last write to this device failed: the drawings stay on screen and can be saved again. */
  saved: boolean;
  retrySave(): void;
  /** The drawings as the tree lists them, all of them (hidden ones too). */
  drawings: readonly Drawing[];
  /** A drawing's figures as lines: Fibonacci levels, position risk and reward, measure bars and price difference. */
  figures(drawing: Drawing): string[];
}

type Action = { type: 'commit'; doc: DrawingDoc } | { type: 'undo' } | { type: 'redo' };
const reduceHistory = (h: History<DrawingDoc>, action: Action): History<DrawingDoc> =>
  action.type === 'commit' ? commit(h, action.doc) : action.type === 'undo' ? undoHistory(h) : redoHistory(h);

const safeStorage = (): Pick<Storage, 'getItem' | 'setItem'> | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

const defaultId = () => `dr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The copy key of each refusal, and the typed code a refusal about an owner limit carries (as the grid's notes do). */
const REFUSAL_KEY = {
  'cap-unset': 'Refused cap-unset',
  'cap-loading': 'Refused cap-loading',
  'cap-unavailable': 'Refused cap-unavailable',
  'cap-reached': 'Refused cap-reached',
  degenerate: 'Refused degenerate',
  collinear: 'Refused collinear',
  locked: 'Refused locked',
  'not-found': 'Refused not-found',
  'outside-bars': 'Refused outside-bars',
  'bad-price': 'Refused bad-price',
  'bad-tick': 'Refused bad-tick',
  'bad-levels': 'Refused bad-levels',
  'brush-cap-unset': 'Refused brush-cap-unset',
  'brush-cap-loading': 'Refused brush-cap-loading',
  'brush-cap-unavailable': 'Refused brush-cap-unavailable',
  'wrong-side': 'Refused wrong-side',
  'no-risk': 'Refused no-risk',
} as const satisfies Partial<Record<ModelRefusal | Refusal, string>>;

const OWNER_VALUE_UNAVAILABLE = 'trade.chart.owner_value_unavailable' as const;

/** The typed code for a refusal caused by an owner limit: unset is the owner's blank, unavailable is a failed read. */
const REFUSAL_CODE: Partial<Record<ModelRefusal | Refusal, string>> = {
  'cap-unset': OWNER_VALUE_UNSET,
  'brush-cap-unset': OWNER_VALUE_UNSET,
  'cap-unavailable': OWNER_VALUE_UNAVAILABLE,
  'brush-cap-unavailable': OWNER_VALUE_UNAVAILABLE,
};

type Refused = { refused: ModelRefusal | Refusal };
const isPointRefusal = (value: unknown): value is Refused => typeof value === 'object' && value !== null && 'refused' in value;

export function useDrawings(host: ChartHost | null, bars: readonly Candle[], options: DrawingsOptions): DrawingsApi {
  const { t: copyT } = drawingsCopy.useCopy();
  // Keys are checked where they are written (the catalogue); the canvas labels pass computed keys through this one type.
  const t = copyT as unknown as Translate;
  const storage = options.storage !== undefined ? options.storage : safeStorage();
  const storageKey = drawingsKey(options.userId, options.workbench, options.symbol);
  const newId = options.newId ?? defaultId;
  const sensitivity = options.magnetSensitivityPx === undefined ? MAGNET_SENSITIVITY_DEFAULT : options.magnetSensitivityPx;

  const [hist, dispatch] = useReducer(reduceHistory, undefined, () => startHistory(readDoc(storage, storageKey)));
  const liveRef = useRef<DrawingDoc | null>(null);
  const [live, setLive] = useState<DrawingDoc | null>(null);
  const doc = live ?? hist.present;

  const [tool, setToolState] = useState<ToolId>('cursor');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [magnetOn, setMagnetOn] = useState(false);
  const [textValue, setTextValue] = useState('Text');
  const [notice, setNoticeText] = useState<string | null>(null);
  const [noticeCode, setNoticeCode] = useState<string | null>(null);
  /** Show a note; a note about an owner limit carries its typed code, and any other note carries none. */
  const setNotice = (text: string | null, code: string | null = null) => {
    setNoticeText(text);
    setNoticeCode(text === null ? null : code);
  };
  const [draftCount, setDraftCount] = useState(0);
  const [saved, setSaved] = useState(true);

  const primitive = useMemo(() => new DrawingsPrimitive(), []);
  const barTimes = useMemo(() => bars.map((b) => Math.floor(b.t / 1000)), [bars]);
  const draftRef = useRef<Pt[]>([]);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const magnet = magnetOn && sensitivity !== null;

  // Handlers read the latest render through this ref, so the chart subscriptions never go stale.
  const latest = useRef({
    doc,
    tool,
    selectedId,
    bars,
    barTimes,
    host,
    tickSize: options.tickSize,
    limits: options.limits,
    magnet,
    sensitivity,
    textValue,
    t,
  });
  latest.current = {
    doc,
    tool,
    selectedId,
    bars,
    barTimes,
    host,
    tickSize: options.tickSize,
    limits: options.limits,
    magnet,
    sensitivity,
    textValue,
    t,
  };

  const showRefusal = (reason: ModelRefusal | Refusal) => {
    const key = REFUSAL_KEY[reason as keyof typeof REFUSAL_KEY];
    setNotice(key ? latest.current.t(key) : latest.current.t('Refused bad-price'), REFUSAL_CODE[reason] ?? null);
  };

  /** Commit one step to the history (one placed drawing, one drag, one deletion). */
  const commitDoc = (next: DrawingDoc) => {
    liveRef.current = null;
    setLive(null);
    dispatch({ type: 'commit', doc: next });
  };

  const applyResult = (result: { doc: DrawingDoc } | { refused: ModelRefusal }): boolean => {
    if (isRefused(result)) {
      showRefusal(result.refused);
      return false;
    }
    commitDoc(result.doc);
    return true;
  };

  /** The chart point under a pixel: the nearest loaded bar and the decimal price, snapped if the magnet is on. */
  const pointAt = (x: number, y: number): Pt | Refused => {
    const L = latest.current;
    const h = L.host;
    if (!h) return { refused: 'bad-price' };
    const logical = h.chart.timeScale().coordinateToLogical(x);
    if (logical === null) return { refused: 'outside-bars' };
    const index = Math.round(logical);
    const bar = L.bars[index];
    if (!bar || index < 0) return { refused: 'outside-bars' };
    const raw = h.main.coordinateToPrice(y);
    if (raw === null) return { refused: 'bad-price' };
    let price = priceFromNumber(raw, L.tickSize);
    if (price === null) return { refused: 'bad-tick' };
    if (L.magnet && L.sensitivity !== null) {
      const snapped = magnetSnap(barPrices(bar), y, (p) => h.main.priceToCoordinate(Number(p)), L.sensitivity);
      if (snapped !== null) price = snapped;
    }
    return { time: L.barTimes[index]!, price };
  };

  const refreshPrimitive = () => {
    const L = latest.current;
    const visible = L.doc.drawings.filter((d) => isVisible(L.doc, d));
    let preview: Drawing | null = null;
    const kind = toolKind(L.tool);
    if (kind && draftRef.current.length > 0) {
      const points = [...draftRef.current];
      if (cursorRef.current) {
        const at = pointAt(cursorRef.current.x, cursorRef.current.y);
        if (!isPointRefusal(at)) points.push(at);
      }
      preview = makeDrawing('preview', kind.kind, points, { variant: kind.variant, text: L.textValue });
    }
    primitive.set({
      drawings: visible,
      selectedId: L.selectedId,
      preview,
      tick: L.tickSize,
      barTimes: L.barTimes,
      t: (key, vars) => L.t(key, vars),
    });
  };

  const setDraft = (points: Pt[]) => {
    draftRef.current = points;
    setDraftCount(points.length);
  };

  const setTool = (next: ToolId) => {
    setDraft([]);
    setToolState(next);
    setNotice(null);
  };

  // Placement: one click per point; the drawing completes when it has the points it needs.
  const finishPlacement = (kind: DrawingKind, variant: PatternVariant | undefined, points: Pt[]) => {
    const drawing = makeDrawing(newId(), kind, points, { variant, text: latest.current.textValue });
    const ok = applyResult(addDrawing(latest.current.doc, drawing, latest.current.limits));
    setDraft([]);
    if (ok) {
      setSelectedId(drawing.id);
      setToolState('cursor');
    }
  };

  const handleClick = (x: number, y: number) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const L = latest.current;
    const current = L.tool;
    if (isCursorTool(current)) {
      const hit = primitive.hit(x, y);
      if (current === 'eraser') {
        if (hit) {
          const result = removeDrawing(L.doc, hit.id);
          if (applyResult(result) && L.selectedId === hit.id) setSelectedId(null);
        }
        return;
      }
      setSelectedId(hit?.id ?? null);
      setNotice(null);
      return;
    }
    const kind = toolKind(current);
    if (!kind || kind.kind === 'brush') return;
    const at = pointAt(x, y);
    if (isPointRefusal(at)) {
      showRefusal(at.refused);
      return;
    }
    const points = [...draftRef.current, at];
    if (points.length < pointsNeeded(kind.kind, kind.variant)) {
      setDraft(points);
      refreshPrimitive();
      return;
    }
    finishPlacement(kind.kind, kind.variant, points);
    refreshPrimitive();
  };

  // Pointer work on the chart element: dragging a handle or the whole drawing, and brush strokes.
  useEffect(() => {
    const element = host?.element;
    const chart = host?.chart;
    if (!element || !chart) return;
    type Drag =
      | {
          mode: 'handle' | 'middle';
          id: string;
          index: number | 'middle';
          startTime: number;
          startPrice: Decimal;
          startPoints: Pt[];
          startDoc: DrawingDoc;
        }
      | { mode: 'brush' };
    let drag: Drag | null = null;
    let downAt: { x: number; y: number } | null = null;
    const local = (e: PointerEvent) => {
      const r = element.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const freeze = (on: boolean) => chart.applyOptions({ handleScroll: !on, handleScale: !on });

    const finishBrush = () => {
      const stroke = draftRef.current;
      setDraft([]);
      drag = null;
      freeze(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (stroke.length >= 2) {
        const L = latest.current;
        const result = addDrawing(L.doc, makeDrawing(newId(), 'brush', stroke), L.limits);
        applyResult(result);
        setSelectedId(isRefused(result) ? null : (result.doc.drawings[result.doc.drawings.length - 1]?.id ?? null));
      }
      refreshPrimitive();
    };

    function onMove(e: PointerEvent) {
      const d = drag;
      if (!d) return;
      const { x, y } = local(e);
      if (d.mode === 'brush') {
        const cap = latest.current.limits.brushPointCap;
        if (cap === null) return;
        const last = draftRef.current[draftRef.current.length - 1];
        const at = pointAt(x, y);
        if (isPointRefusal(at) || (last && last.time === at.time && last.price === at.price)) return;
        const lastPx = cursorRef.current;
        if (lastPx && Math.hypot(lastPx.x - x, lastPx.y - y) < BRUSH_STEP_PX) return;
        cursorRef.current = { x, y };
        draftRef.current = [...draftRef.current, at];
        if (draftRef.current.length >= cap) {
          setNotice(latest.current.t('Refused brush-cap-reached'));
          finishBrush();
          return;
        }
        refreshPrimitive();
        return;
      }
      const at = pointAt(x, y);
      if (isPointRefusal(at)) return;
      const L = latest.current;
      let points: Pt[];
      if (d.index === 'middle') {
        const from = barIndexAt(L.barTimes, d.startTime);
        const to = barIndexAt(L.barTimes, at.time);
        if (from === null || to === null) {
          showRefusal('outside-bars');
          return;
        }
        const deltaBars = to - from;
        const deltaPrice = diffAtTick(d.startPrice, at.price, L.tickSize);
        if (deltaPrice === null) return;
        const shifted = shiftPoints(d.startPoints, L.barTimes, deltaBars, deltaPrice, L.tickSize);
        if (typeof shifted === 'string') {
          showRefusal(shifted);
          return;
        }
        points = shifted;
      } else {
        const index = d.index;
        points = d.startPoints.map((p, i) => (i === index ? { time: at.time, price: at.price } : p));
      }
      const next = patchDrawing(d.startDoc, d.id, { points });
      if (isRefused(next)) {
        showRefusal(next.refused);
        return;
      }
      liveRef.current = next.doc;
      setLive(next.doc);
      refreshPrimitive();
    }

    // A cancelled gesture (the browser takes a touch for scrolling) ends like a release, but commits nothing: the drag or the
    // stroke is dropped, the chart is unfrozen, and the press is forgotten so no later release places a point.
    function onCancel() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      freeze(false);
      downAt = null;
      suppressClickRef.current = true;
      if (drag?.mode === 'brush') draftRef.current = [];
      drag = null;
      liveRef.current = null;
      setLive(null);
      refreshPrimitive();
    }

    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      freeze(false);
      if (!drag) return;
      if (drag.mode === 'brush') {
        finishBrush();
        return;
      }
      const moved = liveRef.current;
      drag = null;
      if (moved) commitDoc(moved);
      refreshPrimitive();
    }

    const onDown = (e: PointerEvent) => {
      // A press starts a fresh gesture: a click that follows is only a placement if the pointer did not travel.
      suppressClickRef.current = false;
      downAt = { x: e.clientX, y: e.clientY };
      if (e.button !== 0) return;
      const L = latest.current;
      const { x, y } = local(e);
      if (isCursorTool(L.tool) && L.tool !== 'eraser') {
        const hit = primitive.hit(x, y);
        if (!hit || hit.handle === undefined) return;
        const d = findDrawing(L.doc, hit.id);
        if (!d) return;
        suppressClickRef.current = true;
        setSelectedId(hit.id);
        if (d.locked) {
          showRefusal('locked');
          return;
        }
        const at = pointAt(x, y);
        if (isPointRefusal(at)) return;
        drag = {
          mode: hit.handle === 'middle' ? 'middle' : 'handle',
          id: hit.id,
          index: hit.handle,
          startTime: at.time,
          startPrice: at.price,
          startPoints: d.points,
          startDoc: L.doc,
        };
        freeze(true);
      } else if (toolKind(L.tool)?.kind === 'brush') {
        if (L.limits.brushPointCap === null) {
          showRefusal(blankCapRefusal(L.limits.brushWhy, true));
          return;
        }
        const at = pointAt(x, y);
        if (isPointRefusal(at)) return;
        suppressClickRef.current = true;
        draftRef.current = [at];
        cursorRef.current = { x, y };
        drag = { mode: 'brush' };
        freeze(true);
        refreshPrimitive();
      } else {
        return;
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    };

    // A click is taken on release, not from the chart's click event: the chart drops a click that follows another within
    // a moment, and a placed point must not depend on that. A pan or a drag is never a click.
    const onAnyUp = (e: PointerEvent) => {
      const pressed = downAt;
      downAt = null;
      if (!pressed || e.button !== 0) return;
      if (Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > PAN_SLOP_PX) suppressClickRef.current = true;
      const { x, y } = local(e);
      handleClick(x, y);
    };
    // A cancelled press is no click: nothing is left waiting for a release.
    const onAnyCancel = () => {
      downAt = null;
      suppressClickRef.current = true;
    };
    element.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onAnyUp);
    window.addEventListener('pointercancel', onAnyCancel);
    return () => {
      element.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onAnyUp);
      window.removeEventListener('pointercancel', onAnyCancel);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      freeze(false);
    };
    // The handlers read the latest render through `latest`; only the chart and element identities matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.element, host?.chart, primitive]);

  // While a drawing tool is active, the browser must not take a touch for scrolling: the drawing gets the gesture.
  useEffect(() => {
    const element = host?.element;
    if (!element) return;
    const before = element.style.touchAction;
    if (!isCursorTool(tool)) element.style.touchAction = 'none';
    return () => {
      element.style.touchAction = before;
    };
  }, [host?.element, tool]);

  // Chart clicks place and select; crosshair moves update the preview of a drawing being placed.
  useEffect(() => {
    const chart = host?.chart;
    if (!chart) return;
    const onMoveChart = (param: { point?: { x: number; y: number } }) => {
      cursorRef.current = param.point ? { x: param.point.x, y: param.point.y } : null;
      if (draftRef.current.length > 0) refreshPrimitive();
    };
    chart.subscribeCrosshairMove(onMoveChart);
    return () => {
      chart.unsubscribeCrosshairMove(onMoveChart);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.chart]);

  // The primitive is attached to the main series; a new main series (a chart style change) attaches it again.
  useEffect(() => {
    const main = host?.main;
    if (!main) return;
    primitive.bind(main);
    main.attachPrimitive(primitive);
    // The pane the drawings are drawn in, read from the library: the main series' pane, the price pane (0).
    const element = host?.element as (HTMLElement & { readDrawnLines?: () => DrawnLines }) | undefined;
    if (element) {
      element.dataset.drawingsPane = String(main.getPane().paneIndex());
      // The lines each drawing was last painted with, in pixels, read on demand (nothing is written per frame), so a check
      // can measure the drawn geometry itself: a channel's parallel lines, a pitchfork's tines.
      element.readDrawnLines = () =>
        primitive.current().map((plan) => ({
          id: plan.id,
          lines: plan.ops.flatMap((op) => (op.op === 'line' ? [[op.x1, op.y1, op.x2, op.y2] as [number, number, number, number]] : [])),
        }));
    }
    return () => {
      main.detachPrimitive(primitive);
      if (element) {
        delete element.dataset.drawingsPane;
        delete element.readDrawnLines;
      }
    };
  }, [host?.main, primitive]);

  // Paint whenever what is drawn changes.
  useEffect(() => {
    refreshPrimitive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, selectedId, tool, barTimes, options.tickSize, host?.main, magnet]);

  // Keyboard: Delete removes the selection, Ctrl+Z and Ctrl+Y or Ctrl+Shift+Z move through history, Escape cancels a placement.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && typeof target.closest === 'function' && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      // A dialog on top (the clear-all confirmation) owns the keys: nothing under it is deleted or undone.
      if (document.querySelector('[role="alertdialog"], [role="dialog"]')) return;
      const L = latest.current;
      const mod = e.ctrlKey || e.metaKey;
      if ((e.key === 'Delete' || e.key === 'Backspace') && L.selectedId) {
        e.preventDefault();
        removeById(L.selectedId);
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) dispatch({ type: 'redo' });
        else dispatch({ type: 'undo' });
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        dispatch({ type: 'redo' });
      } else if (e.key === 'Escape') {
        if (draftRef.current.length > 0) {
          setDraft([]);
          refreshPrimitive();
        } else {
          setSelectedId(null);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save each committed change to this device. A failed write is shown, never dropped.
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    setSaved(writeDoc(storage, storageKey, hist.present));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hist.present, storageKey]);

  const removeById = (id: string) => {
    const result = removeDrawing(latest.current.doc, id);
    if (applyResult(result)) setSelectedId((now) => (now === id ? null : now));
  };

  const patch = (id: string, change: Partial<Drawing>) => {
    applyResult(patchDrawing(latest.current.doc, id, change));
  };

  const selected = selectedId ? (doc.drawings.find((d) => d.id === selectedId) ?? null) : null;
  const kind = toolKind(tool);
  const needed = kind ? pointsNeeded(kind.kind, kind.variant) : 0;
  let hint = t('Hint select');
  if (tool === 'eraser') hint = t('Hint eraser');
  else if (tool === 'brush') hint = t('Hint brush');
  else if (kind && kind.kind !== 'brush')
    hint = draftCount === 0 ? t('Hint first point') : t('Hint next point', { done: String(draftCount), needed: String(needed) });

  return {
    doc,
    tool,
    setTool,
    selectedId,
    select: (id) => setSelectedId(id),
    selected,
    hint,
    notice,
    noticeCode,
    clearNotice: () => setNotice(null),
    canUndo: canUndo(hist),
    canRedo: canRedo(hist),
    undo: () => dispatch({ type: 'undo' }),
    redo: () => dispatch({ type: 'redo' }),
    deleteSelected: () => {
      if (selectedId) removeById(selectedId);
    },
    remove: removeById,
    setLocked: (id, locked) => patch(id, { locked }),
    setHidden: (id, hidden) => patch(id, { hidden }),
    setText: (id, text) => patch(id, { text: text.trim() || 'Text' }),
    setTextValue,
    textValue,
    setLevels: (id, levels) => {
      const cleaned: Decimal[] = [];
      for (const level of levels) {
        const value = level.trim();
        if (dec(value) === null) {
          showRefusal('bad-levels');
          return;
        }
        cleaned.push(value);
      }
      if (cleaned.length === 0) {
        showRefusal('bad-levels');
        return;
      }
      patch(id, { levels: cleaned });
    },
    magnet,
    setMagnet: (on) => {
      if (sensitivity === null) return;
      setMagnetOn(on);
    },
    magnetAvailable: sensitivity !== null,
    checked,
    toggleChecked: (id) => setChecked((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id])),
    groupChecked: () => {
      if (checked.length === 0) {
        setNotice(t('Refused group'));
        return;
      }
      const group = { id: newId(), name: t('Group name', { n: String(latest.current.doc.groups.length + 1) }), hidden: false };
      const result = groupDrawings(latest.current.doc, checked, group);
      if (applyResult(result)) setChecked([]);
    },
    toggleGroupHidden: (groupId) => {
      const group = latest.current.doc.groups.find((g) => g.id === groupId);
      if (group) commitDoc(setGroupHidden(latest.current.doc, groupId, !group.hidden));
    },
    hideAll: () => commitDoc(setHiddenAll(latest.current.doc, !latest.current.doc.hiddenAll)),
    hiddenAll: doc.hiddenAll,
    clearAll: () => {
      setSelectedId(null);
      setChecked([]);
      commitDoc(clearDoc(latest.current.doc));
    },
    saved,
    retrySave: () => setSaved(writeDoc(storage, storageKey, latest.current.doc)),
    drawings: doc.drawings,
    figures: (drawing) => figureLines(drawing, options.tickSize, (time) => barIndexAt(barTimes, time), t),
  };
}
