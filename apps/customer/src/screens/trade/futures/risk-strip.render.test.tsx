// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VenueOrder, VenuePosition } from '../../../features/trade/venue-api';
import { RiskStrip } from './RiskStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const position = {
  symbol: 'BTC-PERP',
  side: 'long',
  size: '0.5',
  entryPrice: '96000',
  markPrice: '97000',
  unrealisedPnl: '500',
} as VenuePosition;
const stop = {
  symbol: 'BTC-PERP',
  side: 'sell',
  type: 'trigger',
  reduceOnly: true,
  remaining: '0.5',
  trigger: { price: '95000', source: 'mark', role: 'stop_loss', state: 'waiting', triggeredAt: null, failure: null },
} as VenueOrder;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent;

describe('RiskStrip', () => {
  it('with nothing resting, the stop and target totals say none is set, never the open result passed off as one', () => {
    act(() => root.render(<RiskStrip positions={[position]} orders={[]} quote="USDC" />));
    expect(text('venue-risk-open')).toBe('+500.00 USDC');
    expect(text('venue-risk-stops')).toBe('None set');
    expect(text('venue-risk-targets')).toBe('None set');
  });

  it('a resting stop is totalled at its trigger: 0.5 long from 96,000 stopped at 95,000 loses 500', () => {
    act(() => root.render(<RiskStrip positions={[position]} orders={[stop]} quote="USDC" />));
    expect(text('venue-risk-stops')).toBe('-500.00 USDC');
    expect(text('venue-risk-targets')).toBe('None set');
  });
});
