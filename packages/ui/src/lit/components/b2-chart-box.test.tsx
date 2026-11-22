// ChartBox and ChartCanvas: the kit's sized box for a charting library, its marks where a room's tests find them.
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChartBox, ChartCanvas } from './b2-chart-box.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('ChartBox', () => {
  it('holds a named picture with the element the library draws into, each with its own marks, and no style of its own', () => {
    const out = html(
      <ChartBox marks={{ 'data-testid': 'chart-area' }}>
        <ChartCanvas
          label="Bitcoin price, past day"
          host={React.createRef<HTMLDivElement>()}
          marks={{ 'data-testid': 'coin-chart' }}
          hostMarks={{ 'data-testid': 'coin-chart__host' }}
        />
      </ChartBox>,
    );
    expect(out).toBe(
      '<div class="lt-chart-box" data-testid="chart-area"><div class="lt-chart-canvas" role="img" aria-label="Bitcoin price, past day" data-testid="coin-chart"><div class="lt-chart-canvas-host" data-testid="coin-chart__host"></div></div></div>',
    );
  });

  it('holds a state in the chart’s place, at the same size', () => {
    expect(html(<ChartBox>{<p role="status">No trades yet</p>}</ChartBox>)).toBe(
      '<div class="lt-chart-box"><p role="status">No trades yet</p></div>',
    );
  });
});
