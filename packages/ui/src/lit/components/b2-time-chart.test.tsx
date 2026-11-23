// TimeLine: time sets x, so a gap keeps its real width; a missing figure breaks the line, never a zero; the zero line;
// the readout by pointer and by key; the honest empty line. J-portfolio-05 #4 and #7 read these exact positions.
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { nearestPoint, stepPoint, TimeLine, timeLinePlaces, type TimePoint } from './b2-time-chart.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const at = (minute: number) => new Date(Date.UTC(2026, 10, 23, 0, minute)).toISOString();
const p = (minute: number, value: string | null): TimePoint => ({ at: at(minute), value });
const say = (point: TimePoint) => `${point.at}: ${point.value ?? 'missing'}`;

describe('TimeLine places', () => {
  it('sets x by time, 0 to 1000, so a missing stretch is a gap of its real width', () => {
    // Moments at 0, 1, 2, then nothing until 9: the last run starts at 900, not at the fourth quarter.
    const chart = timeLinePlaces([p(0, '0'), p(1, '2'), p(2, '4'), p(9, '4'), p(10, '8')])!;
    expect(chart.xs).toEqual([0, 100, 200, 900, 1000]);
    expect(chart.runs).toEqual([
      [
        { x: 0, y: 240 },
        { x: 100, y: 180 },
        { x: 200, y: 120 },
        { x: 900, y: 120 },
        { x: 1000, y: 0 },
      ],
    ]);
  });

  it('rounds x down, as the room did (the first at 0, the last at 1000)', () => {
    expect(timeLinePlaces([p(0, '1'), p(1, '1'), p(3, '1')])!.xs).toEqual([0, 333, 1000]);
  });

  it('breaks the line at a moment with no figure, never drawing it as zero, and keeps a lone moment as its own run', () => {
    const chart = timeLinePlaces([p(0, '1'), p(1, '3'), p(2, null), p(3, '2'), p(4, null)])!;
    expect(chart.runs.map((run) => run.map((q) => q.x))).toEqual([[0, 250], [750]]);
    expect(chart.runs[1]![0]!.y).toBe(120);
  });

  it('draws the zero line only when zero is inside the range', () => {
    expect(timeLinePlaces([p(0, '-2'), p(1, '2')])!.zeroY).toBe(120);
    expect(timeLinePlaces([p(0, '1'), p(1, '2')])!.zeroY).toBeNull();
    // A flat line sits in the middle; at zero, the zero line is under it.
    expect(timeLinePlaces([p(0, '0'), p(1, '0')])).toMatchObject({ zeroY: 120, runs: [[{ y: 120 }, { y: 120 }]] });
  });

  it('has nothing to draw from no moments, one moment, or no figure at all', () => {
    expect(timeLinePlaces([])).toBeNull();
    expect(timeLinePlaces([p(0, '1')])).toBeNull();
    expect(timeLinePlaces([p(0, null), p(1, null)])).toBeNull();
  });
});

describe('TimeLine readout', () => {
  it('picks the moment nearest the pointer by time, not by index', () => {
    const points = [p(0, '1'), p(1, '1'), p(9, '1'), p(10, '1')];
    expect(nearestPoint(points, 0)).toBe(0);
    expect(nearestPoint(points, 0.5)).toBe(1);
    expect(nearestPoint(points, 0.6)).toBe(2);
    expect(nearestPoint(points, 1)).toBe(3);
  });

  it('steps by arrow key, jumps with Home and End, clears with Escape, and ignores other keys', () => {
    expect(stepPoint('ArrowLeft', null, 5)).toBe(4);
    expect(stepPoint('ArrowLeft', 2, 5)).toBe(1);
    expect(stepPoint('ArrowLeft', 0, 5)).toBe(0);
    expect(stepPoint('ArrowRight', 4, 5)).toBe(4);
    expect(stepPoint('ArrowRight', 1, 5)).toBe(2);
    expect(stepPoint('Home', 3, 5)).toBe(0);
    expect(stepPoint('End', 0, 5)).toBe(4);
    expect(stepPoint('Escape', 3, 5)).toBeNull();
    expect(stepPoint('Tab', 3, 5)).toBeUndefined();
  });
});

describe('TimeLine', () => {
  it('draws a named plot the keyboard can reach, its marks and each run on the svg, and the caption', () => {
    const out = html(
      <TimeLine
        label="Profit and loss over time"
        keys="Use the arrow keys to read each point"
        points={[p(0, '-1'), p(1, '1'), p(2, null), p(3, '2')]}
        readout={say}
        empty="No points"
        caption="Low −1 · high 2"
        marks={{ 'data-chart': 'pnl-cumulative' }}
      />,
    );
    expect(out).toContain('<figure class="lt-chart lt-timeline" data-tone="neutral">');
    expect(out).toContain('<div class="lt-timeline-plot" role="group" aria-label="Use the arrow keys to read each point" tabindex="0">');
    expect(out).toContain(
      '<svg viewBox="0 0 1000 240" preserveAspectRatio="none" role="img" aria-label="Profit and loss over time" data-chart="pnl-cumulative">',
    );
    // Low −1, high 2: zero is a third of the way up.
    expect(out).toContain('<line class="lt-timeline-zero" x1="0" x2="1000" y1="160" y2="160"');
    expect(out).toContain('<polyline class="lt-chart-line" points="0,240 333,80" vector-effect="non-scaling-stroke" data-run="0">');
    expect(out).toContain('<line class="lt-chart-line lt-timeline-dot" x1="1000" x2="1000" y1="0" y2="0"');
    // The readout is a live region from the start, empty until a moment is chosen; no cursor yet.
    expect(out).toContain('<p class="lt-timeline-readout" role="status"></p>');
    expect(out).not.toContain('lt-timeline-cursor');
    expect(out).toContain('<figcaption>Low −1 · high 2</figcaption>');
    expect(out).not.toContain('No points');
    expect(out).not.toContain('style=');
  });

  it('shows the empty line in place of a made-up line, the figure still named', () => {
    const out = html(<TimeLine label="Value over time" keys="k" points={[p(0, null)]} readout={say} empty="No points in this range." />);
    expect(out).toBe(
      '<figure class="lt-chart lt-timeline" aria-label="Value over time" data-empty="true"><p class="lt-timeline-empty" role="status">No points in this range.</p></figure>',
    );
  });

  it('colours by tone', () => {
    expect(html(<TimeLine label="x" keys="k" points={[p(0, '1'), p(1, '2')]} readout={say} empty="none" tone="up" />)).toContain(
      'data-tone="up"',
    );
  });
});
