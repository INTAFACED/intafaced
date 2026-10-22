import { describe, expect, it } from 'vitest';
import {
  addDrawing,
  EMPTY_DOC,
  groupDrawings,
  isVisible,
  makeDrawing,
  nearestIndex,
  parseDoc,
  patchDrawing,
  removeDrawing,
  setHiddenAll,
  shiftPoints,
  type DrawingDoc,
} from './model';
import { commit, redo, startHistory, undo, UNDO_DEPTH } from './history';
import { drawingsKey, readDoc, writeDoc } from './store';

// TEST fixtures: bar times are epoch seconds of the bar open, one bar per 60 seconds.
const bars = Array.from({ length: 200 }, (_, i) => 1_700_000_000 + i * 60);
const at = (index: number, price: string) => ({ time: bars[index]!, price });
const LIMITS = { drawingCap: 50, brushPointCap: 2000 };

const trend = (id: string, a: [number, string], b: [number, string]) => makeDrawing(id, 'trend', [at(a[0], a[1]), at(b[0], b[1])]);

describe('adding drawings', () => {
  it('stores two points as bar times and decimal prices', () => {
    const result = addDrawing(EMPTY_DOC, trend('t1', [100, '65000.00'], [120, '65100.50']), LIMITS);
    expect('doc' in result).toBe(true);
    if (!('doc' in result)) return;
    expect(result.doc.drawings[0]!.points).toEqual([at(100, '65000.00'), at(120, '65100.50')]);
  });

  it('refuses while the drawing limit is blank, and at the limit', () => {
    expect(addDrawing(EMPTY_DOC, trend('t1', [1, '1'], [2, '2']), { ...LIMITS, drawingCap: null })).toEqual({ refused: 'cap-unset' });
    const full = { ...EMPTY_DOC, drawings: [trend('a', [1, '1'], [2, '2'])] };
    expect(addDrawing(full, trend('b', [3, '1'], [4, '2']), { ...LIMITS, drawingCap: 1 })).toEqual({ refused: 'cap-reached' });
  });

  it('refuses two identical points as degenerate, and three collinear pitchfork points', () => {
    expect(addDrawing(EMPTY_DOC, trend('t', [5, '10'], [5, '10']), LIMITS)).toEqual({ refused: 'degenerate' });
    const fork = makeDrawing('f', 'pitchfork', [at(0, '100'), at(10, '110'), at(20, '120')]);
    expect(addDrawing(EMPTY_DOC, fork, LIMITS)).toEqual({ refused: 'collinear' });
  });
});

describe('moving by a delta', () => {
  it('moves both points of a line by the same bar and price delta, on the tick', () => {
    const moved = shiftPoints([at(100, '65000.00'), at(120, '65100.50')], bars, 5, '12.25', '0.25');
    expect(typeof moved).toBe('object');
    if (typeof moved === 'string') return;
    expect(moved.points).toEqual([
      { time: bars[105], price: '65012.25' },
      { time: bars[125], price: '65112.75' },
    ]);
    expect(moved.clamped).toBe(false);
  });

  it('clamps a move past the loaded bars and says so', () => {
    const moved = shiftPoints([at(190, '1.00')], bars, 50, '0.00', '0.01');
    expect(typeof moved === 'object' && moved.clamped).toBe(true);
    if (typeof moved === 'object') expect(moved.points[0]!.time).toBe(bars[199]);
  });

  it('refuses a blank price delta', () => {
    expect(shiftPoints([at(1, '1')], bars, 1, '', '0.01')).toBe('bad-price');
  });

  it('finds the nearest loaded bar for a time', () => {
    expect(nearestIndex(bars, bars[30]! + 20)).toBe(30);
    expect(nearestIndex(bars, bars[30]! + 40)).toBe(31);
    expect(nearestIndex(bars, 0)).toBe(0);
  });
});

describe('lock, hide, groups and removal', () => {
  const base: DrawingDoc = { ...EMPTY_DOC, drawings: [trend('t1', [1, '1'], [2, '2'])] };

  it('refuses to move or delete a locked drawing, and lets it be unlocked', () => {
    const locked = patchDrawing(base, 't1', { locked: true });
    expect('doc' in locked).toBe(true);
    if (!('doc' in locked)) return;
    expect(patchDrawing(locked.doc, 't1', { points: [at(3, '3'), at(4, '4')] })).toEqual({ refused: 'locked' });
    expect(removeDrawing(locked.doc, 't1')).toEqual({ refused: 'locked' });
    expect('doc' in patchDrawing(locked.doc, 't1', { locked: false })).toBe(true);
  });

  it('hides a group together and keeps its members', () => {
    const grouped = groupDrawings(base, ['t1'], { id: 'g1', name: 'Group 1', hidden: false });
    expect('doc' in grouped).toBe(true);
    if (!('doc' in grouped)) return;
    const hidden = { ...grouped.doc, groups: grouped.doc.groups.map((g) => ({ ...g, hidden: true })) };
    expect(isVisible(hidden, hidden.drawings[0]!)).toBe(false);
    expect(hidden.drawings).toHaveLength(1);
  });

  it('hides all without deleting anything', () => {
    const hiddenAll = setHiddenAll(base, true);
    expect(isVisible(hiddenAll, hiddenAll.drawings[0]!)).toBe(false);
    expect(hiddenAll.drawings).toHaveLength(1);
  });
});

describe('undo and redo', () => {
  const one: DrawingDoc = { ...EMPTY_DOC, drawings: [trend('t1', [100, '65000.00'], [120, '65100.50'])] };
  it('brings a deleted line back with its original points', () => {
    let h = startHistory(one);
    const deleted = removeDrawing(h.present, 't1');
    expect('doc' in deleted).toBe(true);
    if (!('doc' in deleted)) return;
    h = commit(h, deleted.doc);
    expect(h.present.drawings).toHaveLength(0);
    h = undo(h);
    expect(h.present.drawings[0]!.points).toEqual([at(100, '65000.00'), at(120, '65100.50')]);
    h = redo(h);
    expect(h.present.drawings).toHaveLength(0);
  });

  it('keeps at most the UI depth of steps', () => {
    let h = startHistory(0);
    for (let i = 1; i <= UNDO_DEPTH + 10; i += 1) h = commit(h, i);
    expect(h.past).toHaveLength(UNDO_DEPTH);
    expect(h.present).toBe(UNDO_DEPTH + 10);
  });

  it('ignores a commit of the same document', () => {
    const h = startHistory(one);
    expect(commit(h, one)).toBe(h);
  });
});

describe('the stored document', () => {
  it('parses a valid document and drops invalid drawings', () => {
    const parsed = parseDoc({
      version: 1,
      hiddenAll: false,
      groups: [],
      drawings: [
        {
          id: 'ok',
          kind: 'trend',
          points: [
            { time: 1, price: '1.00' },
            { time: 2, price: '2.00' },
          ],
          tone: 'accent',
          locked: false,
          hidden: false,
        },
        { id: 'bad', kind: 'nope', points: [], tone: 'accent', locked: false, hidden: false },
        { id: 'bad-price', kind: 'trend', points: [{ time: 1, price: 'NaN' }], tone: 'accent', locked: false, hidden: false },
      ],
    });
    expect(parsed?.drawings.map((d) => d.id)).toEqual(['ok']);
  });

  it('refuses a document of another version', () => {
    expect(parseDoc({ version: 2, drawings: [], groups: [] })).toBeNull();
    expect(parseDoc('nope')).toBeNull();
  });
});

describe('device storage', () => {
  it('keys a document per person, workbench and symbol', () => {
    expect(drawingsKey('u1', 'main', 'BTC/USDT')).toBe('charts-drawings:u1:main:BTC/USDT');
    expect(drawingsKey(null, 'w2', 'ETH/USDT')).toBe('charts-drawings:guest:w2:ETH/USDT');
  });

  it('round-trips a document, and reads an empty one when nothing is stored or the value is broken', () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) };
    const doc: DrawingDoc = { ...EMPTY_DOC, drawings: [trend('t1', [1, '1'], [2, '2'])] };
    expect(writeDoc(storage, 'k', doc)).toBe(true);
    expect(readDoc(storage, 'k').drawings[0]!.id).toBe('t1');
    expect(readDoc(storage, 'missing')).toEqual(EMPTY_DOC);
    memory.set('broken', '{not json');
    expect(readDoc(storage, 'broken')).toEqual(EMPTY_DOC);
  });

  it('reports a failed write rather than dropping the drawings', () => {
    const blocked = {
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(writeDoc(blocked, 'k', EMPTY_DOC)).toBe(false);
    expect(writeDoc(null, 'k', EMPTY_DOC)).toBe(false);
  });
});
