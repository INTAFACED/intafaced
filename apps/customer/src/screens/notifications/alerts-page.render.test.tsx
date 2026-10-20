import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

// Each test chooses what the two reads answered.
const reads = vi.hoisted(() => ({
  alerts: { status: 'loading' } as unknown,
  markets: { status: 'loading' } as unknown,
  mode: 'Personal' as 'Personal' | 'Business',
}));
vi.mock('./use-alerts', () => ({
  useAlerts: () => ({ state: reads.alerts, reload: () => undefined }),
  useAlertMarkets: () => reads.markets,
}));
vi.mock('../../features/session/session', async (original) => {
  const real = await original<typeof import('../../features/session/session')>();
  return { ...real, useSession: () => ({ ...real.useSession(), mode: reads.mode, userId: 'u1' }) };
});

import { SessionProvider } from '../../features/session/session';
import AlertsPage from './AlertsPage';
import type { PriceAlert } from './notify-api';

const render = () =>
  renderToString(
    <SessionProvider>
      <AlertsPage />
    </SessionProvider>,
  );
const alert = (patch: Partial<PriceAlert> = {}): PriceAlert => ({
  id: '11111111-1111-4111-8111-111111111111',
  userId: 'u1',
  marketId: 'm1',
  kind: 'price',
  direction: 'above',
  targetPrice: '65000.50',
  status: 'active',
  firedAt: null,
  createdAt: '2026-10-17T08:00:00.000Z',
  ...patch,
});
const ready = (items: PriceAlert[], canFire = false) => ({
  status: 'ready',
  items,
  evaluation: canFire
    ? { markSource: 'live', canFire: true, code: null }
    : { markSource: 'dark', canFire: false, code: 'alert.price_unavailable' },
});
const markets = { status: 'ready', markets: [{ id: 'm1', label: 'BTC/USDT', quote: 'USDT' }] };
const buttons = (page: string) => page.match(/<button\b[^>]*>/g) ?? [];
// The kit puts "data-disabled:" in every button's class list, so look for the attribute itself.
const switchedOff = (tag: string) => /\sdisabled(=|\s|>)/.test(tag);

beforeEach(() => {
  reads.alerts = { status: 'loading' };
  reads.markets = { status: 'loading' };
  reads.mode = 'Personal';
});

describe('price alerts page', () => {
  it('is a tab of the centre and says the lists are loading, with the form switched off and why', () => {
    const page = render();
    expect(page).toContain('Price alerts');
    expect(page).toContain('/notifications?view=alerts');
    expect(page).toContain('Switched off: the list of markets is still loading.');
    const submit = buttons(page).filter((tag) => tag.includes('type="submit"'));
    expect(submit).toHaveLength(1);
    for (const button of submit) expect(switchedOff(button)).toBe(true);
    expect(page).toMatch(/<select[^>]*disabled/);
  });

  it('lists each alert with market, side, exact price, status and a cancel button for an active one', () => {
    reads.markets = markets;
    reads.alerts = ready([
      alert(),
      alert({ id: '22222222-2222-4222-8222-222222222222', direction: 'below', targetPrice: '0.000000000000000001', status: 'cancelled' }),
      alert({ id: '33333333-3333-4333-8333-333333333333', status: 'fired', firedAt: '2026-10-17T09:00:00.000Z' }),
    ]);
    const page = render();
    expect(page.match(/data-testid="alert-row"/g)).toHaveLength(3);
    expect(page).toContain('BTC/USDT');
    expect(page).toContain('At or above 65000.50 USDT');
    expect(page).toContain('At or below 0.000000000000000001 USDT');
    expect(page).toContain('Active');
    expect(page).toContain('Triggered');
    expect(page).toContain('Cancelled');
    // Only the active one can be cancelled.
    expect(page.match(/Cancel the alert on BTC\/USDT/g)).toHaveLength(1);
  });

  it('shows an expired alert with the person’s own name, message and expiry, and gives it no cancel button', () => {
    reads.markets = markets;
    reads.alerts = ready([
      alert({
        status: 'expired',
        name: 'Breakout watch',
        message: 'Check the order book',
        expiresAt: '2026-10-18T08:00:00.000Z',
        condition: 'crossing_up',
      }),
    ]);
    const page = render();
    expect(page).toContain('Breakout watch');
    expect(page).toContain('Check the order book');
    expect(page).toContain('Expired');
    expect(page).toContain('· Expired ');
    expect(page).not.toContain('Cancel the alert on');
  });

  it('states that nothing can trigger yet instead of promising delivery', () => {
    reads.markets = markets;
    reads.alerts = ready([]);
    const page = render();
    expect(page).toContain('Price checks are not connected on this platform.');
    expect(page).toContain('No alerts yet');
    expect(page).toContain('data-testid="alerts-form"');
    // With markets and alerts loaded the form is usable.
    expect(
      buttons(page)
        .filter((tag) => tag.includes('type="submit"'))
        .some(switchedOff),
    ).toBe(false);
  });

  it('says price checks are connected when they are', () => {
    reads.markets = markets;
    reads.alerts = ready([], true);
    expect(render()).toContain('Price checks are connected.');
  });

  it('says the list could not be loaded, and does not enable saving', () => {
    reads.markets = markets;
    reads.alerts = { status: 'failed', failure: { ok: false, reason: 'unreachable', message: 'x' } };
    const page = render();
    expect(page).toContain('We could not load your alerts.');
    expect(page).toContain('Switched off: your alerts could not be loaded');
    expect(
      buttons(page)
        .filter((tag) => tag.includes('type="submit"'))
        .every(switchedOff),
    ).toBe(true);
    expect(page).not.toContain('No alerts yet');
  });

  it('says why when no market list is available', () => {
    reads.markets = { status: 'failed' };
    reads.alerts = ready([]);
    expect(render()).toContain('Switched off: the list of markets could not be loaded.');
    reads.markets = { status: 'ready', markets: [] };
    expect(render()).toContain('Switched off: there are no markets to watch.');
  });

  it('leaves a company account with a plain note, not a form', () => {
    reads.mode = 'Business';
    const page = render();
    expect(page).toContain('Price alerts belong to your personal account.');
    expect(page).not.toContain('data-testid="alerts-form"');
  });

  it('offers every condition and the optional name, message and expiry on the form', () => {
    reads.markets = markets;
    reads.alerts = ready([]);
    const page = render();
    for (const words of ['At or above', 'At or below', 'Crossing up through', 'Crossing down through', 'Crossing, either way,']) {
      expect(page).toContain(`>${words}</option>`);
    }
    expect(page).toContain('Name (optional)');
    expect(page).toContain('Message (optional)');
    expect(page).toContain('type="datetime-local"');
    expect(page).toContain('{market}, {price}, {condition} and {time}');
  });

  it('offers adding a condition and shows added conditions on a listed alert', () => {
    reads.markets = markets;
    reads.alerts = ready([alert({ condition: 'greater_than', extras: [{ condition: 'less_than', targetPrice: '70000' }] })]);
    const page = render();
    expect(page).toContain('Add a condition');
    expect(page).toContain('and At or below 70000 USDT');
  });

  it('shows a stopped alert as Stopped, with no cancel button, instead of failing the whole list', () => {
    reads.markets = markets;
    reads.alerts = ready([alert({ status: 'stopped' }), alert({ id: '22222222-2222-4222-8222-222222222222' })]);
    const page = render();
    expect(page.match(/data-testid="alert-row"/g)).toHaveLength(2);
    expect(page).toContain('Stopped');
    // Only the active one can be cancelled here.
    expect(page.match(/Cancel the alert on BTC\/USDT/g)).toHaveLength(1);
  });
});
