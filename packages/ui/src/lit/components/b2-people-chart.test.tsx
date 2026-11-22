// The two Volt kit blocks intafaced issue 9302 adds: the soft balance chart and the quick-send row. Static markup.
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AreaChart } from './b2-charts.js';
import { QuickSend } from './b2-people.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const points = [
  { at: '2026-11-01', value: '100.00' },
  { at: '2026-11-02', value: '120.50' },
  { at: '2026-11-03', value: '110.25' },
];

describe('AreaChart soft', () => {
  it('without soft it draws exactly as before: a flat fill, no gradient', () => {
    const out = html(<AreaChart label="Balance" asset="USD" points={points} />);
    expect(out).toContain('class="lt-chart-area"');
    expect(out).not.toContain('linearGradient');
    expect(out).not.toContain('data-soft');
    expect(out).not.toContain('style=');
  });

  it('with soft the fill is its own gradient, fading from the line to nothing', () => {
    const out = html(<AreaChart soft label="Balance" asset="USD" points={points} />);
    const id = /<linearGradient id="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`style="fill:url(#${id})"`);
    expect(out).toContain('class="lt-chart-soft-top"');
    expect(out).toContain('class="lt-chart-soft-bottom"');
    // the data stays readable as a table, as every chart's does
    expect(out).toContain('<caption>Balance</caption>');
  });

  it('two soft charts on one page never share a gradient', () => {
    const out = html(
      <>
        <AreaChart soft label="A" asset="USD" points={points} />
        <AreaChart soft label="B" asset="USD" points={points} />
      </>,
    );
    const ids = [...out.matchAll(/<linearGradient id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('QuickSend', () => {
  it('draws the add key first, then each person as initials and a name, each opening its own link', () => {
    const out = html(
      <QuickSend
        label="Quick send"
        add={{ label: 'Add new', href: '/pay/send' }}
        people={[
          { id: 'a', name: 'Mika Tan', href: '/pay/send?to=a' },
          { id: 'b', name: 'Óla', href: '/pay/send?to=b' },
        ]}
      />,
    );
    expect(out).toContain('aria-label="Quick send"');
    const links = [...out.matchAll(/<a class="lt-person"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(links).toEqual(['/pay/send', '/pay/send?to=a', '/pay/send?to=b']);
    expect(out).toMatch(/data-add=""[^>]*href="\/pay\/send"/);
    expect(out).toContain('>MT<');
    expect(out).toContain('>Ó<');
    expect(out).toContain('>Mika Tan<');
  });

  it('draws no add key when none is given', () => {
    expect(html(<QuickSend label="Quick send" people={[]} />)).not.toContain('data-add');
  });
});
