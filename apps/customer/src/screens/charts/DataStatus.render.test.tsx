// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { StatusBanner, StatusChip } from './DataStatus';
import type { DataStatus } from './data-status';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// TEST ages and boundary, not published values.
const status = (delayedBy: 'class' | 'age'): DataStatus => ({
  chip: 'delayed',
  feed: 'connected',
  ageSeconds: 95,
  feedAgeSeconds: 1,
  lastTradeMs: 0,
  state: 'OPEN',
  stateSinceMs: null,
  thresholdSeconds: 30,
  delayedBy,
  staleBy: null,
  staleAgeSeconds: 35,
  orderEntry: 'open',
  test: false,
});

const render = (s: DataStatus) => {
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() =>
    root.render(
      <>
        <StatusChip status={s} />
        <StatusBanner status={s} format={() => 'T'} />
      </>,
    ),
  );
  const out = {
    chip: host.querySelector('[data-testid="chart-status"]')?.textContent,
    banner: host.querySelector('[data-testid="chart-banner"]'),
  };
  act(() => root.unmount());
  return out;
};

describe('the Delayed chip and banner', () => {
  it('a real-time market past the boundary reads Delayed with the age and names the boundary', () => {
    const { chip, banner } = render(status('age'));
    expect(chip).toBe('Delayed · Last trade 95 s ago');
    expect(banner?.getAttribute('data-kind')).toBe('delayed');
    expect(banner?.textContent).toBe('Delayed — last trade was 95 s ago (updates pause after 30 s without a trade). Last trade: T.');
  });

  it('a delayed data class reads Delayed with the age and names the class, not a boundary', () => {
    const { chip, banner } = render(status('class'));
    expect(chip).toBe('Delayed · Last trade 95 s ago');
    expect(banner?.textContent).toBe('Delayed market data — last trade was 95 s ago. Last trade: T.');
  });

  it('a delayed data class whose newest trade is not read still has its banner, with no age guessed', () => {
    const { chip, banner } = render({ ...status('class'), ageSeconds: null, lastTradeMs: null });
    expect(chip).toBe('Delayed · No trade time');
    expect(banner?.textContent).toBe('Delayed market data — last trade time is unavailable.');
  });
});

describe('the Stale chip and banner', () => {
  it("a stream past the owner's stale age reads Stale with the age, names the stale age and the last trade time", () => {
    const { chip, banner } = render({ ...status('age'), chip: 'stale', delayedBy: null, staleBy: 'age', ageSeconds: 40 });
    expect(chip).toBe('Stale · Last trade 40 s ago');
    expect(banner?.getAttribute('data-kind')).toBe('stale');
    expect(banner?.textContent).toBe('Chart data is out of date — last trade was 40 s ago (over 35 s old). Last trade: T.');
  });

  it('candle reads that stopped still name how long ago they were read', () => {
    const { banner } = render({ ...status('age'), chip: 'stale', feed: 'stale', delayedBy: null, staleBy: 'feed', feedAgeSeconds: 21 });
    expect(banner?.textContent).toBe('Chart data is out of date — last updated 21 s ago. Last trade: T.');
  });
});
