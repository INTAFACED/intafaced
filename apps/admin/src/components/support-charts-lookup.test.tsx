import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SupportChartsLookup } from '@intafaced/contracts/support-charts-lookup';
import type { SupportChartsLookupView } from '@/lib/support/types';
import { alertsWords, historyWords, layoutsWords } from '@/lib/support/charts-lookup';
import { ChartsLookupPanel, ChartsLookupResult } from './support-charts-lookup';

const T = '22222222-2222-4222-8222-222222222222';
const OP = '33333333-3333-4333-8333-333333333333';
const USER = '11111111-1111-4111-8111-111111111111';
const ALERT = '44444444-4444-4444-8444-444444444444';
const AT = '2026-11-18T10:00:00.000Z';

const full: SupportChartsLookup = {
  ticketId: T,
  audit: { sequence: 4, agentId: OP, customerId: USER, at: AT },
  alerts: {
    status: 'read',
    more: false,
    items: [
      {
        id: ALERT,
        marketId: 'BTC-USDT',
        kind: 'price',
        condition: 'greater_than',
        targetPrice: '50000',
        status: 'fired',
        name: 'TEST breakout',
        source: 'mark',
        frequency: 'once',
        fireCount: 0,
        createdAt: AT,
        firedAt: AT,
        lastFiredAt: null,
        expiresAt: null,
      },
    ],
    history: {
      status: 'read',
      retentionDays: 7,
      more: false,
      items: [
        { alertId: ALERT, seq: 1, marketId: 'BTC-USDT', condition: 'greater_than', targetPrice: '50000', markPrice: '50010', firedAt: AT },
      ],
    },
  },
  layouts: {
    status: 'read',
    active: 'scalp',
    items: [
      {
        id: 'scalp',
        name: 'TEST scalp',
        symbol: 'BTC/USDT',
        interval: '1m',
        desk: { v: 1, preset: 'classic', order: ['markets', 'chart', 'book', 'trades'], widths: {} },
        savedAt: AT,
      },
    ],
  },
};
const ok = (lookup: SupportChartsLookup): SupportChartsLookupView => ({ asOf: AT, lookup: { kind: 'ok', data: lookup } });
const html = (v: SupportChartsLookupView | null) => renderToStaticMarkup(<ChartsLookupResult view={v} />);

describe('charts lookup panel (J-charts-desk-19 #1)', () => {
  it('reads nothing until the agent asks, and says the lookup is recorded', () => {
    const out = renderToStaticMarkup(<ChartsLookupPanel ticketId={T} />);
    expect(out).toContain('Look up alerts and layouts');
    expect(out).toContain('records your name, this customer and the time');
    expect(out).not.toContain('charts-lookup-result');
  });

  it('shows the alerts, their history, the layouts and the audit row with the agent, the customer and the time', () => {
    const out = html(ok(full));
    expect(out).toContain('TEST breakout');
    expect(out).toContain('above 50000');
    expect(out).toContain('50010');
    expect(out).toContain('TEST scalp');
    expect(out).toContain(`data-testid="charts-audit-agent">${OP}`);
    expect(out).toContain(`data-testid="charts-audit-customer">${USER}`);
    expect(out).toContain(`data-at="${AT}"`);
    expect(out).toContain('History row #4');
    expect(out).not.toMatch(/<(input|select|textarea)\b/);
  });

  it('no alerts and no saved layouts read as empty states, not errors', () => {
    const none: SupportChartsLookup = {
      ...full,
      alerts: { status: 'read', more: false, items: [], history: { status: 'read', retentionDays: 7, more: false, items: [] } },
      layouts: { status: 'read', active: null, items: [] },
    };
    expect(alertsWords(none)).toMatchObject({ state: 'empty', text: 'No price alerts.' });
    expect(historyWords(none)).toMatchObject({ state: 'empty' });
    expect(layoutsWords(none)).toMatchObject({ state: 'empty', text: 'No saved layouts.' });
    const out = html(ok(none));
    expect(out).toContain('No saved layouts.');
    expect(out).not.toContain('role="alert"');
  });

  it('a part that was not read says why, never "none"', () => {
    const dark: SupportChartsLookup = {
      ...full,
      alerts: { status: 'unread', reason: 'plane_dark' },
      layouts: { status: 'unread', reason: 'unwired' },
    };
    expect(alertsWords(dark)).toMatchObject({ state: 'unread', code: 'plane_dark' });
    expect(layoutsWords(dark)).toMatchObject({ state: 'unread', code: 'unwired' });
    const unkept: SupportChartsLookup = {
      ...full,
      alerts: { ...full.alerts, history: { status: 'unread', reason: 'retention_unset' } } as SupportChartsLookup['alerts'],
    };
    expect(historyWords(unkept)).toMatchObject({ state: 'unread', code: 'retention_unset' });
    expect(html(ok(dark))).not.toContain('No saved layouts');
  });

  it('a refused lookup (its audit row did not land) shows the refusal and no data; no answer shows an error', () => {
    const refused = html({
      asOf: AT,
      lookup: {
        kind: 'failed',
        message: 'svc-support could not record this lookup',
        code: 'support.charts_lookup_unaudited',
        notBuilt: false,
        forbidden: false,
      },
    });
    expect(refused).toContain('The lookup was refused');
    expect(refused).toContain('support.charts_lookup_unaudited');
    expect(refused).not.toContain('charts-lookup-result');
    expect(html(null)).toContain('charts-lookup-error');
  });
});
