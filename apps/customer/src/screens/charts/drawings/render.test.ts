import { describe, expect, it } from 'vitest';
import { makeDrawing } from './model';
import { extendFrom, hitTest, planDrawing, type Op, type View } from './render';

// A fixed view for TEST fixtures: bar index i is x = 10 i, and price p is y = 2 (200 - p). The plot is 500 by 400.
const bars = Array.from({ length: 100 }, (_, i) => 1_700_000_000 + i * 60);
const view: View = {
  width: 500,
  height: 400,
  x: (time) => ((time - bars[0]!) / 60) * 10,
  y: (price) => (200 - Number(price)) * 2,
  indexOf: (time) => (time - bars[0]!) / 60,
  tick: '0.01',
  t: (key, vars) => `${key}${vars ? JSON.stringify(vars) : ''}`,
};
const at = (index: number, price: string) => ({ time: bars[index]!, price });
const lines = (ops: Op[]) => ops.filter((o): o is Extract<Op, { op: 'line' }> => o.op === 'line');

describe('render plan', () => {
  it('draws a horizontal line across the whole plot at its price', () => {
    const plan = planDrawing(makeDrawing('h', 'horizontal', [at(10, '150')]), view);
    expect(lines(plan.ops)[0]).toMatchObject({ x1: 0, y1: 100, x2: 500, y2: 100 });
  });

  it('draws a vertical line down the whole plot at its bar', () => {
    const plan = planDrawing(makeDrawing('v', 'vertical', [at(20, '150')]), view);
    expect(lines(plan.ops)[0]).toMatchObject({ x1: 200, y1: 0, x2: 200, y2: 400 });
  });

  it('draws a ray from its point to the edge of the plot in the direction of its second point', () => {
    const plan = planDrawing(makeDrawing('r', 'ray', [at(10, '150'), at(20, '150')]), view);
    expect(lines(plan.ops)[0]).toMatchObject({ x1: 100, y1: 100, x2: 500, y2: 100 });
  });

  it('draws a trend line between its two points', () => {
    const plan = planDrawing(makeDrawing('t', 'trend', [at(10, '150'), at(20, '160')]), view);
    expect(lines(plan.ops)[0]).toMatchObject({ x1: 100, y1: 100, x2: 200, y2: 80 });
  });

  it('draws one line per retracement level at the level price, and labels each', () => {
    const plan = planDrawing(makeDrawing('f', 'fib', [at(50, '110.00'), at(80, '140.00')]), view);
    const text = plan.ops.filter((o) => o.op === 'text');
    expect(text).toHaveLength(7);
    expect(text.map((o) => (o.op === 'text' ? o.text : ''))).toContain('0.618  121.46');
  });

  it('keeps the parallels of a channel parallel: their slopes match', () => {
    const plan = planDrawing(makeDrawing('c', 'channel', [at(10, '150'), at(30, '160'), at(20, '120')]), view);
    const [base, parallel] = lines(plan.ops);
    const slope = (l: Extract<Op, { op: 'line' }>) => (l.y2 - l.y1) / (l.x2 - l.x1);
    expect(slope(base!)).toBeCloseTo(slope(parallel!), 9);
  });

  it('draws nothing for a point that has no place on the chart', () => {
    const missing = { ...view, x: () => null };
    const plan = planDrawing(makeDrawing('t', 'trend', [at(10, '150'), at(20, '160')]), missing);
    expect(plan.ops).toHaveLength(0);
  });

  it('gives a stop on the wrong side a note and no figures', () => {
    const plan = planDrawing(makeDrawing('p', 'long', [at(10, '100'), at(20, '105'), at(30, '110')]), view);
    expect(plan.note).toContain('right side');
  });

  it('adds handles to a selected line: one per point and a middle one', () => {
    const plan = planDrawing(makeDrawing('t', 'trend', [at(10, '150'), at(20, '160')]), view, { selected: true });
    expect(plan.handles.map((h) => h.index)).toEqual([0, 1, 'middle']);
  });
});

describe('hit testing', () => {
  const plans = [planDrawing(makeDrawing('t', 'trend', [at(10, '150'), at(20, '160')]), view, { selected: true })];

  it('finds a drawing under a pointer on its line', () => {
    expect(hitTest(plans, 150, 90)?.id).toBe('t');
  });

  it('finds a handle before the body, so a point can be dragged', () => {
    expect(hitTest(plans, 100, 100)).toEqual({ id: 't', handle: 0 });
    expect(hitTest(plans, 150, 90)).toEqual({ id: 't', handle: 'middle' });
  });

  it('finds nothing away from the drawing', () => {
    expect(hitTest(plans, 400, 300)).toBeNull();
  });
});

describe('extendFrom', () => {
  it('runs a line from a point to the plot edge in its direction', () => {
    expect(extendFrom({ x: 0, y: 0 }, { x: 10, y: 10 }, 100, 100)).toEqual({ x: 100, y: 100 });
    expect(extendFrom({ x: 50, y: 50 }, { x: 50, y: 50 }, 100, 100)).toBeNull();
  });
});
