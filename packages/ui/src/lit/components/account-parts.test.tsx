import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActionButton, ActionRow, ActivityList, ActivityRow, PanelSection, ProgressSegments } from '../index.js';
import { AreaChart, Parts } from '../templates/index.js';

const html = (n: React.ReactElement) => renderToStaticMarkup(n);

describe('account parts', () => {
  it('draws one lit key in a row, a link when it has somewhere to go and a button otherwise', () => {
    const out = html(
      <ActionRow>
        <ActionButton primary icon={<svg />} label="Deposit" href="/deposit" />
        <ActionButton icon={<svg />} label="Convert" onClick={() => undefined} />
      </ActionRow>,
    );
    expect(out).toContain('<a class="lt-action" data-primary="true" href="/deposit">');
    expect(out).toContain('<button class="lt-action" type="button">');
    expect(out.match(/data-primary/g)).toHaveLength(1);
  });

  it('heads a panel section with its title and aside', () => {
    const out = html(<PanelSection title="Recent" aside={<a href="/a">All activity</a>} />);
    expect(out).toContain('<h3 class="lt-panel-section-title">Recent</h3>');
    expect(out).toContain('All activity');
  });

  it('lights the done segments and says the progress in words', () => {
    const out = html(<ProgressSegments total={3} done={2} label="2 of 3 done" />);
    expect(out).toContain('aria-label="2 of 3 done"');
    expect(out.match(/data-done/g)).toHaveLength(2);
  });

  it('draws an activity line with its signed amount, masked when balances are hidden, a dash when unknown', () => {
    const shown = html(
      <ActivityList label="Recent">
        <ActivityRow initials="MK" title="Sent to Maya" time="Today" amount="−$40.00" direction="out" hidden={false} />
      </ActivityList>,
    );
    expect(shown).toContain('aria-label="Recent"');
    expect(shown).toContain('−$40.00');
    expect(shown).toContain('data-direction="out"');
    expect(html(<ActivityRow title="In" time="Now" amount="+$1.00" direction="in" hidden />)).not.toContain('+$1.00');
    expect(html(<ActivityRow title="In" time="Now" amount={null} direction="in" hidden={false} />)).toContain('—');
  });
});

describe('ActivityRow marks', () => {
  it("puts a room's marks on the row link and on its title, time and amount", () => {
    const out = html(
      <ActivityRow
        title="Sent"
        time="Today"
        amount="−$1.00"
        direction="out"
        href="/a"
        hidden={false}
        marks={{
          row: { 'data-testid': 'home-activity__row' },
          title: { 'data-testid': 'home-activity__kind' },
          time: { 'data-testid': 'home-activity__when' },
          amount: { 'data-testid': 'home-activity__amount' },
        }}
      />,
    );
    expect(out).toContain('<a data-testid="home-activity__row" href="/a">');
    expect(out).toContain('data-testid="home-activity__kind" class="lt-activity-title">Sent');
    expect(out).toContain('data-testid="home-activity__when" class="lt-activity-time">Today');
    expect(out).toMatch(/data-testid="home-activity__amount" class="lt-num"[^>]*>−\$1\.00/);
  });
});

describe('hero chart and parts', () => {
  const points = [
    { at: '2026-11-01', value: '10.00' },
    { at: '2026-11-02', value: '12.00' },
  ];
  it('marks the last point with its value and draws guide lines only when asked', () => {
    const out = html(<AreaChart soft grid tone="ink" marker="$12.00" label="Net worth" asset="USD" points={points} />);
    expect(out).toContain('data-tone="ink"');
    expect(out).toContain('class="lt-chart-marker-pill">$12.00</span>');
    expect(out.match(/lt-chart-grid/g)).toHaveLength(3);
    expect(html(<AreaChart label="x" asset="USD" points={points} />)).not.toMatch(/lt-chart-(grid|marker)/);
  });

  it('draws no marker and no line from a single point', () => {
    expect(html(<AreaChart marker="$1" label="x" asset="USD" points={points.slice(0, 1)} />)).toBe('');
  });

  it('masks the parts amounts when hidden and lays the legend on a row when asked', () => {
    const parts = [
      { label: 'Cash', value: '4.00' },
      { label: 'Crypto', value: '6.00' },
    ];
    const out = html(<Parts legend="row" hidden label="Mix" total="10.00" asset="USD" parts={parts} />);
    expect(out).toContain('data-legend="row"');
    expect(out).not.toContain('4.00');
  });
});
