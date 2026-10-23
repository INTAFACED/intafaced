import { describe, expect, it } from 'vitest';
import { DESKS, PAY_TRANSFER_DETAIL, allReads } from './catalog';
import { cellOfRow, displayCell, formatCell, inputFor, readData } from './model';

/**
 * The Personal Pay reads, each fed what svc-bank's own output schema says it returns (services/svc-bank/src/ops/transfer-health.ts,
 * failed-transfers.ts, transfer-detail.ts and personal-pay/router.ts), and then what the desk must never trust or print as a number.
 */

const read = (id: string) => allReads(DESKS.pay).find((r) => r.id === id)!;
const AT = '2026-10-18T03:00:00.000Z';
const EXEC = '5a3b9c10-1111-4222-8333-444455556666';

const HEALTH = {
  asOf: AT,
  standingOrders: { pending: 1, settled: 8, rejected: 3, skipped: 0, total: 12, failureRate: '0.25', oldestPendingAgeSeconds: 90 },
  oneOff: {
    available: true,
    reserved: 1,
    posted: 4,
    total: 5,
    failureRate: null,
    failureRateReason: 'failures_not_recorded',
    oldestPendingAgeSeconds: null,
  },
  p2p: { available: false, reason: 'served_by_p2p_ops' },
  bills: {
    available: true,
    submitted: 0,
    accepted: 1,
    paid: 2,
    failed: 1,
    returned: 1,
    total: 5,
    failureRate: '1/5',
    oldestPendingAgeSeconds: null,
  },
};

const record = (id: string, raw: unknown) => {
  const data = readData(read(id), raw);
  if (data?.shape !== 'record') throw new Error(`${id} did not read as a record`);
  return (key: string) => data.cells.find((c) => c.key === key)!;
};

describe('transfer health', () => {
  it('sends the window svc-bank requires, from the read, and nothing else', () => {
    const now = new Date(AT);
    expect(inputFor(read('pay.standing-24h'), now)).toEqual({ windowHours: 24 });
    expect(inputFor(read('pay.bills-7d'), now)).toEqual({ windowHours: 168 });
  });
  it('standing orders: reads the counts and the service’s own ratio exactly as written', () => {
    const cell = record('pay.standing-24h', HEALTH);
    expect(cell('standingOrders.total').value).toBe(12);
    expect(cell('standingOrders.failureRate').value).toBe('0.25');
    expect(cell('asOf').kind).toBe('time');
    expect(displayCell(cell('asOf'))).toBe('18 Oct 2026, 03:00:00 UTC');
  });
  it('a window with no rows has no ratio: a dash, never 0', () => {
    const cell = record('pay.standing-24h', {
      ...HEALTH,
      standingOrders: { ...HEALTH.standingOrders, total: 0, rejected: 0, failureRate: null, oldestPendingAgeSeconds: null },
    });
    expect(cell('standingOrders.failureRate').value).toBeNull();
    expect(formatCell(cell('standingOrders.failureRate'))).toBe('—');
    expect(formatCell(cell('standingOrders.oldestPendingAgeSeconds'))).toBe('—');
  });
  it('an age is a human duration, and the number is the service’s', () => {
    const cell = record('pay.standing-24h', { ...HEALTH, standingOrders: { ...HEALTH.standingOrders, oldestPendingAgeSeconds: 11_520 } });
    expect(cell('standingOrders.oldestPendingAgeSeconds').value).toBe(11_520);
    expect(displayCell(cell('standingOrders.oldestPendingAgeSeconds'))).toBe('3 h 12 min');
  });
  it('the age labels say the figure covers only the window', () => {
    expect(record('pay.oneoff-7d', HEALTH)('oneOff.oldestPendingAgeSeconds').label).toContain('among sends created in this window');
  });
  it('a non-terminating ratio stays the fraction svc-bank gave, not a float', () => {
    const cell = record('pay.bills-24h', HEALTH);
    expect(displayCell(cell('bills.failureRate'))).toBe('1/5');
    expect(cell('bills.returned').value).toBe(1);
  });
  it('one-off sends: no failure figure, and the reason is printed in words beside the dash', () => {
    const cell = record('pay.oneoff-24h', HEALTH);
    expect(displayCell(cell('oneOff.failureRate'))).toBe('—');
    expect(displayCell(cell('oneOff.failureRateReason'))).toBe(
      'svc-bank does not record a refused one-off send, so it has no failure figure',
    );
  });
  it('one-off sends: an answer that claims a failure rate or another reason is unreadable, never shown', () => {
    expect(readData(read('pay.oneoff-24h'), { ...HEALTH, oneOff: { ...HEALTH.oneOff, failureRate: '0' } })).toBeNull();
    expect(readData(read('pay.oneoff-24h'), { ...HEALTH, oneOff: { ...HEALTH.oneOff, failureRateReason: 'none' } })).toBeNull();
    expect(readData(read('pay.oneoff-24h'), { ...HEALTH, oneOff: { ...HEALTH.oneOff, available: false } })).toBeNull();
  });
  it('P2P: reads as a pointer to the P2P desk with no number; a service that starts counting P2P is refused as unreadable', () => {
    const cell = record('pay.p2p-pointer', HEALTH);
    expect(displayCell(cell('p2p.available'))).toBe('no');
    expect(displayCell(cell('p2p.reason'))).toBe('Counted on the P2P desk; svc-bank gives no P2P figure');
    expect(readData(read('pay.p2p-pointer'), { ...HEALTH, p2p: { available: true, reason: 'served_by_p2p_ops' } })).toBeNull();
    expect(readData(read('pay.p2p-pointer'), { ...HEALTH, p2p: { available: false, reason: 'other' } })).toBeNull();
  });
  it('a block missing from the answer, or a count that is not a whole number, makes that block unreadable', () => {
    const { bills: _bills, ...noBills } = HEALTH;
    expect(readData(read('pay.bills-24h'), noBills)).toBeNull();
    expect(readData(read('pay.standing-7d'), { ...HEALTH, standingOrders: { ...HEALTH.standingOrders, total: '12' } })).toBeNull();
    expect(readData(read('pay.standing-7d'), { ...HEALTH, asOf: 'now' })).toBeNull();
  });
});

describe('rejected standing-order transfers', () => {
  const ITEM = {
    id: EXEC,
    kind: 'standing_order',
    amount: '25.50',
    assetId: 'USDC',
    status: 'rejected',
    rejectionCode: 'bank.recipient_cannot_receive',
    reason: 'This recipient cannot receive payments',
    attemptedAt: AT,
    sender: { handle: 'alice', reason: null },
    receiver: { handle: null, reason: 'handle_unresolved' },
  };
  it('reads the rows, keeps the amount as the service wrote it, and ids rows by execution id', () => {
    const data = readData(read('pay.failed-standing'), { items: [ITEM], nextCursor: null });
    if (data?.shape !== 'list') throw new Error('list expected');
    expect(data.rows.map((r) => r.id)).toEqual([EXEC]);
    expect(cellOfRow(data.rows[0]!, 'amount')).toBe('25.50');
    expect(cellOfRow(data.rows[0]!, 'reason')).toBe('This recipient cannot receive payments');
    expect(data.pageFull).toBe(false);
  });
  it('a name the directory could not give is a dash with its reason in the column beside it', () => {
    const data = readData(read('pay.failed-standing'), { items: [ITEM], nextCursor: null });
    if (data?.shape !== 'list') throw new Error('list expected');
    const row = data.rows[0]!;
    const cell = (key: string) => row.cells.find((c) => c.key === key)!;
    expect(formatCell(cell('receiver.handle'))).toBe('—');
    expect(displayCell(cell('receiver.reason'))).toBe('The directory could not name this person');
    expect(formatCell(cell('sender.reason'))).toBe('—');
  });
  it('exactly 50 rows with a next page means more exist; exactly 50 with none means that is all', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ ...ITEM, id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
    expect(readData(read('pay.failed-standing'), { items, nextCursor: 'abc' })).toMatchObject({ pageFull: true, nextCursor: 'abc' });
    expect(readData(read('pay.failed-standing'), { items, nextCursor: null })).toMatchObject({ pageFull: false, nextCursor: null });
    expect(readData(read('pay.failed-standing'), { items })).toBeNull();
  });
  it('an item that is not a rejected standing order is unreadable, and so is a repeated id', () => {
    expect(readData(read('pay.failed-standing'), { items: [{ ...ITEM, status: 'settled' }], nextCursor: null })).toBeNull();
    expect(readData(read('pay.failed-standing'), { items: [{ ...ITEM, kind: 'one_off' }], nextCursor: null })).toBeNull();
    expect(readData(read('pay.failed-standing'), { items: [ITEM, ITEM], nextCursor: null })).toBeNull();
    expect(readData(read('pay.failed-standing'), { items: [{ ...ITEM, sender: null }], nextCursor: null })).toBeNull();
  });
});

describe('transfer record', () => {
  const STANDING = {
    id: EXEC,
    kind: 'standing_order',
    senderUserId: '9f8e7d6c-1111-4222-8333-444455556666',
    receiverUserId: '1a2b3c4d-1111-4222-8333-444455556666',
    amount: '25.5',
    assetId: 'USDC',
    status: 'rejected',
    rejectionCode: 'ledger.insufficient_funds',
    reason: 'ledger.insufficient_funds',
    ledgerTxId: null,
    scheduleId: '7c6b5a49-1111-4222-8333-444455556666',
    occurrence: 3,
    attemptedAt: AT,
    settledAt: null,
  };
  const ONE_OFF = {
    ...STANDING,
    id: 'send-0001-abcd',
    kind: 'one_off',
    status: 'posted',
    rejectionCode: null,
    reason: null,
    ledgerTxId: 'tx-1',
    scheduleId: null,
    occurrence: null,
  };
  const cells = (raw: unknown) => {
    const data = readData(PAY_TRANSFER_DETAIL, raw);
    if (data?.shape !== 'record') throw new Error('record expected');
    return (key: string) => data.cells.find((c) => c.key === key)!;
  };
  it('reads a standing-order execution, with the empty fields shown as dashes', () => {
    const cell = cells(STANDING);
    expect(displayCell(cell('kind'))).toBe('Standing order');
    expect(formatCell(cell('settledAt'))).toBe('—');
    expect(formatCell(cell('ledgerTxId'))).toBe('—');
    expect(cell('occurrence').value).toBe(3);
  });
  it('reads a one-off send, which has no schedule, occurrence, rejection code or settle time', () => {
    const cell = cells(ONE_OFF);
    expect(displayCell(cell('kind'))).toBe('One-off send');
    for (const key of ['scheduleId', 'occurrence', 'rejectionCode', 'reason', 'settledAt']) expect(formatCell(cell(key)), key).toBe('—');
    expect(formatCell(cell('ledgerTxId'))).toBe('tx-1');
  });
  it('a record missing a field is unreadable', () => {
    const { amount: _amount, ...rest } = STANDING;
    expect(readData(PAY_TRANSFER_DETAIL, rest)).toBeNull();
  });
});

describe('bill payments and global sends', () => {
  const BILL = {
    id: EXEC,
    userId: '9f8e7d6c-1111-4222-8333-444455556666',
    billerId: 'biller-1',
    reference: 'INV-7',
    amount: '40',
    assetId: 'USDC',
    fromSpaceId: 'space-1',
    status: 'failed',
    failureCode: 'bank.bills_psp_unset',
    failureBlocker: 'socket.psp-partners',
    providerRef: null,
    ledgerTxId: null,
    createdAt: AT,
    updatedAt: AT,
  };
  it('bills summary: counts, and rails that are unset stay "unset"', () => {
    const data = readData(read('pay.bills-summary'), {
      asOf: AT,
      counts: { submitted: 0, accepted: 0, paid: 2, failed: 1, returned: 0 },
      volumes: [{ status: 'paid', assetId: 'USDC', count: 2, amount: '80' }],
      rails: { billerDirectory: 'unset', lookup: 'unset', payRail: 'unset', blocker: 'socket.psp-partners' },
    });
    if (data?.shape !== 'record') throw new Error('record expected');
    expect(data.cells.find((c) => c.key === 'rails.payRail')!.value).toBe('unset');
    expect(displayCell(data.cells.find((c) => c.key === 'rails.blocker')!)).toBe('A payment-service partner is not connected');
    expect(data.cells.find((c) => c.key === 'counts.paid')!.value).toBe(2);
  });
  it('bills volumes: rows have no id and show the service’s own sums', () => {
    const data = readData(read('pay.bills-volumes'), {
      asOf: AT,
      counts: {},
      volumes: [
        { status: 'paid', assetId: 'USDC', count: 2, amount: '80.00' },
        { status: 'failed', assetId: 'USDC', count: 1, amount: '40' },
      ],
      rails: {},
    });
    if (data?.shape !== 'list') throw new Error('list expected');
    expect(data.rows.map((r) => r.id)).toEqual(['0', '1']);
    expect(cellOfRow(data.rows[0]!, 'amount')).toBe('80.00');
  });
  it('failed bills: reads the page, and a payment that is not failed is unreadable', () => {
    const data = readData(read('pay.bills-failed'), { items: [BILL], nextCursor: null });
    if (data?.shape !== 'list') throw new Error('list expected');
    expect(data.rows[0]!.id).toBe(EXEC);
    expect(displayCell(data.rows[0]!.cells.find((c) => c.key === 'failureCode')!)).toBe('Bills psp unset');
    expect(readData(read('pay.bills-failed'), { items: [{ ...BILL, status: 'paid' }], nextCursor: null })).toBeNull();
  });
  it('failed global sends: svc-bank answers a bare array, not an object', () => {
    const SEND = {
      id: EXEC,
      userId: '9f8e7d6c-1111-4222-8333-444455556666',
      fromSpaceId: 'space-1',
      assetId: 'USDC',
      amount: '100',
      toCurrency: 'EUR',
      recipientId: 'rcp-1',
      country: 'DE',
      deliveryMethod: 'bank_transfer',
      status: 'failed',
      failureCode: 'bank.global_payout_unset',
      failureBlocker: 'socket.psp-partners',
      providerRef: null,
      quoteRate: null,
      quoteFee: null,
      quoteFeeAsset: null,
      quoteReceive: null,
      quoteValidUntil: null,
      quoteEta: null,
      ledgerTxId: null,
      createdAt: AT,
      updatedAt: AT,
    };
    expect(readData(read('pay.global-failed'), [SEND])).toMatchObject({ shape: 'list', rows: [{ id: EXEC }] });
    expect(readData(read('pay.global-failed'), { items: [SEND] })).toBeNull();
    // A send its sender asked back, returned by the rail and waiting for a second person to refund it.
    const ASKED = {
      ...SEND,
      status: 'returned',
      failureCode: null,
      failureBlocker: null,
      providerRef: 'TEST-payout',
      ledgerTxId: 'tx-1',
      returnRef: 'TEST-RETURN-1',
      recallReason: 'Wrong person',
      recallRequestedAt: AT,
    };
    expect(readData(read('pay.global-recalls'), [ASKED])).toMatchObject({ shape: 'list', rows: [{ id: EXEC }] });
  });
  it('global summary: reads the counts and the travel-rule decision', () => {
    const data = readData(read('pay.global-summary'), {
      asOf: AT,
      counts: { submitted: 0, sent: 1, on_the_way: 2, arrived: 3, failed: 4, held: 0, cancelled: 0, returned: 5, refunded: 6 },
      volumes: [],
      rails: { corridors: 'unset', fx: 'unset', payout: 'unset', bic: 'unset', travelRule: 'undecided', blocker: 'socket.psp-partners' },
    });
    if (data?.shape !== 'record') throw new Error('record expected');
    expect(data.cells.find((c) => c.key === 'counts.on_the_way')!.value).toBe(2);
    expect(data.cells.find((c) => c.key === 'rails.travelRule')!.value).toBe('undecided');
    expect(data.cells.find((c) => c.key === 'counts.refunded')!.value).toBe(6);
  });
});
