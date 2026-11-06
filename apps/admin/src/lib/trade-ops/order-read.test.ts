import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  customerStatusOf,
  orderIdsIn,
  parseOrderRead,
  parseReconcileStatus,
  parseSweepResult,
  parseTradeAudit,
  rejectText,
  statusLabel,
  sweepLine,
} from './order-read';

const ORDER = '0b6c3d0e-9f1a-4c2b-8d3e-112233445566';
const raw = (over: Record<string, unknown> = {}) => ({
  order: {
    id: ORDER,
    user_id: '11111111-1111-4111-8111-111111111111',
    market_id: '22222222-2222-4222-8222-222222222222',
    status: 'filled',
    side: 'buy',
    type: 'limit',
    price: '100.5',
    qty: '0.001',
    filled_qty: '0.001',
    hold_asset: 'USDT',
    hold_amount: '0',
    seeded: false,
    reject_code: null,
    created_at: '2026-11-06T08:00:00.000Z',
    holdReference: { ownerId: 'x', assetId: 'USDT', purpose: 'order' },
    ...over,
  },
  fills: [{ id: 'f-1', price: '100.5', qty: '0.001', quoteAmount: '0.1005', feeAmount: '0.0002' }],
});

describe('order read (J-cex-spot-18 #1, #2)', () => {
  it('reads any state, its fills and its reject code', () => {
    const read = parseOrderRead(raw());
    expect(read).toMatchObject({ id: ORDER, status: 'filled', filled: '0.001', rejectCode: null });
    expect(read?.fills).toHaveLength(1);
    expect(parseOrderRead(raw({ status: 'cancelled', reject_code: 'ioc_remainder' }))?.rejectCode).toBe('ioc_remainder');
  });

  it('refuses an answer of another shape rather than guessing', () => {
    expect(parseOrderRead(raw({ status: 'mystery' }))).toBeNull();
    expect(parseOrderRead(raw({ filled_qty: 1 }))).toBeNull();
    expect(parseOrderRead({ order: raw().order, fills: [{ id: 'f', price: 1 }] })).toBeNull();
    expect(parseOrderRead(null)).toBeNull();
  });

  it('gives the customer’s own status word for every service status, as svc-trade’s customer API does', () => {
    const src = readFileSync(resolve(__dirname, '../../../../../services/svc-trade/src/private-rest.ts'), 'utf8');
    const body = /export function toCcxtOrderStatus[\s\S]*?\n}\n/.exec(src)?.[0] ?? '';
    expect(body).not.toBe('');
    // Each `case 'x': ... return 'y'` group in the service, checked against this mapping.
    const groups = body.split('return ').slice(1);
    let cases: string[] = [];
    for (const chunk of body.split('\n')) {
      const c = /case '([a-z_]+)':/.exec(chunk);
      if (c) cases.push(c[1]!);
      const r = /return '([a-z]+)';/.exec(chunk);
      if (r) {
        for (const s of cases) expect(customerStatusOf(s as never), s).toBe(r[1]);
        cases = [];
      }
    }
    expect(groups.length).toBeGreaterThanOrEqual(5);
  });

  it('labels a status in the customer page’s words, and an empty reject as none recorded', () => {
    expect(statusLabel('filled')).toBe('Filled');
    expect(statusLabel('cancelled')).toBe('Cancelled');
    expect(rejectText(null)).toBe('None recorded');
    expect(rejectText(' ')).toBe('None recorded');
    expect(rejectText('ioc_remainder')).toBe('ioc_remainder');
  });

  it('finds each order id a customer wrote, once, in order', () => {
    expect(orderIdsIn(`TEST my order ${ORDER}`, `wrong: ${ORDER.toUpperCase()} and 0b6c3d0e-9f1a-4c2b-8d3e-aaaaaaaaaaaa`)).toEqual([
      ORDER,
      '0b6c3d0e-9f1a-4c2b-8d3e-aaaaaaaaaaaa',
    ]);
    expect(orderIdsIn(null, 'no id here')).toEqual([]);
  });
});

describe('sweep result and audit rows (J-cex-spot-18 #3, #5)', () => {
  it('reads the sweep counts and refuses counts that disagree with their ids', () => {
    const empty = {
      firstSightedOrderIds: [],
      waitingOrderIds: [],
      failedClosedOrderIds: [],
      terminalizedNoHoldOrderIds: [],
      otherActionOrderIds: [],
      unreadableOrderIds: [],
      erroredAfterActingOrderIds: [],
    };
    const r = parseSweepResult({ checked: 3, released: 1, releasedOrderIds: [ORDER], ...empty, ranAt: 'x' });
    expect(r && sweepLine(r)).toBe('3 orders checked · 1 holds released');
    expect(parseSweepResult({ checked: 3, released: 2, releasedOrderIds: [ORDER], ...empty, ranAt: 'x' })).toBeNull();
    expect(parseSweepResult({ checked: -1, released: 0, releasedOrderIds: [], ...empty, ranAt: 'x' })).toBeNull();
    // A list the service did not send is not read as "none".
    expect(parseSweepResult({ checked: 1, released: 0, releasedOrderIds: [], ranAt: 'x' })).toBeNull();
  });

  it('reads the last sweep for the Health tile: none ever, a sweep, or nothing of another shape (J-cex-spot-20 #2)', () => {
    const empty = {
      firstSightedOrderIds: [],
      waitingOrderIds: [],
      failedClosedOrderIds: [],
      terminalizedNoHoldOrderIds: [],
      otherActionOrderIds: [],
      unreadableOrderIds: [],
      erroredAfterActingOrderIds: [],
    };
    expect(parseReconcileStatus({ lastSweepAt: null, result: null })).toEqual({ kind: 'none' });
    const result = { checked: 4, released: 0, releasedOrderIds: [], ...empty, ranAt: '2026-11-06T10:00:00.000Z' };
    expect(parseReconcileStatus({ lastSweepAt: '2026-11-06T10:00:00.000Z', result })).toMatchObject({
      kind: 'swept',
      at: '2026-11-06T10:00:00.000Z',
      result: { checked: 4, released: 0 },
    });
    // A time with no readable result is not "no sweep".
    expect(parseReconcileStatus({ lastSweepAt: '2026-11-06T10:00:00.000Z', result: { checked: 4 } })).toBeNull();
    expect(parseReconcileStatus({ lastSweepAt: null, result })).toBeNull();
  });

  it('reads audit rows and refuses a row of another shape', () => {
    const row = {
      id: 'a',
      kind: 'orders.get',
      operatorId: 'op',
      accountId: 'u',
      objectId: ORDER,
      approverId: null,
      reason: null,
      occurredAt: 't',
    };
    expect(parseTradeAudit({ rows: [row], nextCursor: null })?.rows).toEqual([row]);
    expect(parseTradeAudit({ rows: [{ ...row, operatorId: 1 }], nextCursor: null })).toBeNull();
  });
});
