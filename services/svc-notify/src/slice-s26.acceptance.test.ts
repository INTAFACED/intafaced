/**
 * S26 acceptance — TRD-0201 market halt notice, TRD-0280 deposit credit notice.
 *
 * Seams: notifyOwnersOfMarketHalt and notifyDepositCredit. Both write inbox
 * rows through NotifyService. Neither cancels an order, unhalts a market,
 * nor books a ledger credit.
 */

import { describe, expect, it } from 'vitest';
import { MESSAGE_KEYS } from '@intafaced/i18n';
import { MemoryNotifyStore, type InsertNotificationInput, type NotifyStore } from './store.js';
import { NotifyService } from './notify-service.js';
import { renderInboxCopy } from './channels/render.js';
import {
  MARKET_HALT_BODY_KEY,
  MARKET_HALT_KIND,
  MARKET_HALT_TITLE_KEY,
  notifyOwnersOfMarketHalt,
  type HaltJournal,
  type RestingOrder,
} from './market-halt-notice.js';
import {
  DEPOSIT_CREDITED_BODY_KEY,
  DEPOSIT_CREDITED_KIND,
  DEPOSIT_CREDITED_TITLE_KEY,
  TRADE_FILL_KIND,
  notifyDepositCredit,
  type ChainWatcherReport,
  type DepositCreditBook,
  type DepositObservation,
} from './deposit-credit-notice.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ORDER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORDER_OTHER_MARKET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function service(store: NotifyStore = new MemoryNotifyStore()): NotifyService {
  return new NotifyService(store, { fanoutEnabled: true });
}

function journal(epoch = 'halt-epoch-1'): HaltJournal & { unhaltCalls: number } {
  const state = { halted: true, unhaltCalls: 0, marketId: 'BTC-USDT', epoch };
  return {
    marketId: state.marketId,
    epoch: state.epoch,
    get halted() {
      return state.halted;
    },
    unhalt() {
      state.unhaltCalls += 1;
      state.halted = false;
    },
    get unhaltCalls() {
      return state.unhaltCalls;
    },
  };
}

function order(overrides: Partial<RestingOrder> = {}): RestingOrder {
  return {
    orderId: ORDER_A,
    ownerId: OWNER,
    marketId: 'BTC-USDT',
    status: 'open',
    ...overrides,
  };
}

class TimeoutStore extends MemoryNotifyStore {
  override async insert(_input: InsertNotificationInput): Promise<{ inserted: boolean; notification: null }> {
    throw new Error('notice timeout');
  }
}

function credited(overrides: Partial<DepositObservation> = {}): DepositObservation {
  return {
    railEventId: 'rail-event-7',
    userId: OWNER,
    confirmations: 2,
    minConfirmations: 6,
    availableCredited: false,
    amount: '1.25000000',
    asset: 'USDT',
    ...overrides,
  };
}

function book(): DepositCreditBook & { calls: DepositObservation[] } {
  const calls: DepositObservation[] = [];
  return {
    calls,
    credit(observation) {
      calls.push(observation);
    },
  };
}

describe('TRD-0201 market halt notice', () => {
  it('stores one notice for the owner and leaves the open order open', async () => {
    const notify = service();
    const halt = journal();
    const resting = order();
    const second = order({ orderId: ORDER_B });
    const elsewhere = order({ orderId: ORDER_OTHER_MARKET, marketId: 'ETH-USDT', ownerId: OTHER });

    const result = await notifyOwnersOfMarketHalt(notify, {
      journal: halt,
      orders: [resting, second, elsewhere],
    });

    expect(result.written).toBe(1);
    expect(halt.halted).toBe(true);
    expect(halt.unhaltCalls).toBe(0);
    expect(resting.status).toBe('open');
    expect(second.status).toBe('open');
    expect(elsewhere.status).toBe('open');

    const rows = await notify.list({ userId: OWNER, limit: 20, unreadOnly: false });
    expect(rows.items).toHaveLength(1);
    const row = rows.items[0]!;
    expect(row.kind).toBe(MARKET_HALT_KIND);
    expect(row.kind).not.toBe(TRADE_FILL_KIND);
    expect(row.titleKey).toBe(MARKET_HALT_TITLE_KEY);
    expect(row.bodyKey).toBe(MARKET_HALT_BODY_KEY);
    expect(row.params.marketId).toBe('BTC-USDT');
    expect(row.params.epoch).toBe('halt-epoch-1');
    expect(row.params.submits).toBe('refused');
    expect(row.params.cancels).toBe('available');
    expect(row.params.orderIds).toEqual([ORDER_A, ORDER_B]);

    expect(MESSAGE_KEYS).toContain(MARKET_HALT_TITLE_KEY);
    expect(MESSAGE_KEYS).toContain(MARKET_HALT_BODY_KEY);
    const copy = renderInboxCopy(row, 'en');
    expect(copy.title).toBe('Market halted');
    expect(copy.body).toBe('New submits on BTC-USDT are refused. Cancels remain available.');
    expect(await notify.unreadCount(OTHER)).toBe(0);
  });

  it('does not store a second notice for the same halt epoch', async () => {
    const notify = service();
    const halt = journal();
    const resting = order();

    await notifyOwnersOfMarketHalt(notify, { journal: halt, orders: [resting] });
    const again = await notifyOwnersOfMarketHalt(notify, { journal: halt, orders: [resting] });

    expect(again.written).toBe(0);
    expect(await notify.unreadCount(OWNER)).toBe(1);
    expect(resting.status).toBe('open');
    expect(halt.halted).toBe(true);
    expect(halt.unhaltCalls).toBe(0);
  });

  it('stores the notice when the owner is offline', async () => {
    const notify = service();
    const halt = journal();
    const resting = order();

    const result = await notifyOwnersOfMarketHalt(notify, {
      journal: halt,
      orders: [resting],
      onlineUserIds: new Set(),
    });

    expect(result.written).toBe(1);
    expect(await notify.unreadCount(OWNER)).toBe(1);
    expect(resting.status).toBe('open');
    expect(halt.unhaltCalls).toBe(0);
  });

  it('does not unhalt the market when the notice times out', async () => {
    const notify = service(new TimeoutStore());
    const halt = journal();
    const resting = order();

    const result = await notifyOwnersOfMarketHalt(notify, { journal: halt, orders: [resting] });

    expect(result.written).toBe(0);
    expect(result.deliveryFailed).toBe(true);
    expect(halt.halted).toBe(true);
    expect(halt.unhaltCalls).toBe(0);
    expect(resting.status).toBe('open');
  });
});

describe('TRD-0280 deposit credit notice', () => {
  it('writes neither a fill nor a deposit notice before available balance is booked', async () => {
    const notify = service();
    const ledger = book();
    const observation = credited();

    const result = await notifyDepositCredit(notify, {
      watch: (): ChainWatcherReport => ({ status: 'up', observation }),
      book: ledger,
    });

    expect(result.outcome).toBe('unconfirmed');
    expect(result.kind).toBeNull();
    expect(ledger.calls).toEqual([]);
    expect(await notify.unreadCount(OWNER)).toBe(0);
    const rows = await notify.list({ userId: OWNER, limit: 20, unreadOnly: false });
    expect(rows.items.filter((row) => row.kind === TRADE_FILL_KIND)).toHaveLength(0);
    expect(rows.items.filter((row) => row.kind === DEPOSIT_CREDITED_KIND)).toHaveLength(0);
  });

  it('does not write a notice when the minimum confirmations are met but available balance is not booked', async () => {
    const notify = service();
    const ledger = book();

    const result = await notifyDepositCredit(notify, {
      watch: () => ({
        status: 'up',
        observation: credited({ confirmations: 6, minConfirmations: 6, availableCredited: false }),
      }),
      book: ledger,
    });

    expect(result.outcome).toBe('not_credited');
    expect(result.kind).toBeNull();
    expect(ledger.calls).toEqual([]);
    expect(await notify.unreadCount(OWNER)).toBe(0);
  });

  it('refuses a tradable-balance notice while confirmations are under the minimum', async () => {
    const notify = service();
    const ledger = book();

    const result = await notifyDepositCredit(notify, {
      watch: () => ({
        status: 'up',
        observation: credited({ availableCredited: true, confirmations: 5, minConfirmations: 6 }),
      }),
      book: ledger,
    });

    expect(result.outcome).toBe('unconfirmed');
    expect(ledger.calls).toEqual([]);
    expect(await notify.unreadCount(OWNER)).toBe(0);
  });

  it('writes one deposit-credited notice, not a fill, only after the credit is booked', async () => {
    const notify = service();
    const ledger = book();
    const observation = credited({ confirmations: 6, minConfirmations: 6, availableCredited: true });

    const result = await notifyDepositCredit(notify, {
      watch: () => ({ status: 'up', observation }),
      book: ledger,
    });

    expect(result.outcome).toBe('stored');
    expect(result.kind).toBe(DEPOSIT_CREDITED_KIND);
    expect(result.kind).not.toBe(TRADE_FILL_KIND);
    expect(ledger.calls).toEqual([]);

    const rows = await notify.list({ userId: OWNER, limit: 20, unreadOnly: false });
    expect(rows.items).toHaveLength(1);
    const row = rows.items[0]!;
    expect(row.kind).toBe(DEPOSIT_CREDITED_KIND);
    expect(row.params.amount).toBe('1.25000000');
    expect(row.params.asset).toBe('USDT');
    expect(row.params.railEventId).toBe('rail-event-7');
    expect(MESSAGE_KEYS).toContain(DEPOSIT_CREDITED_TITLE_KEY);
    expect(MESSAGE_KEYS).toContain(DEPOSIT_CREDITED_BODY_KEY);
    const copy = renderInboxCopy(row, 'en');
    expect(copy.title).toBe('Deposit credited');
    expect(copy.body).toBe('1.25000000 USDT is in your available balance.');
    expect(copy.title).not.toBe('Order filled');
  });

  it('stores one credit notice for one rail event id', async () => {
    const notify = service();
    const ledger = book();
    const observation = credited({ confirmations: 6, minConfirmations: 6, availableCredited: true });
    const watch = () => ({ status: 'up' as const, observation });

    await notifyDepositCredit(notify, { watch, book: ledger });
    const again = await notifyDepositCredit(notify, { watch, book: ledger });

    expect(again.outcome).toBe('duplicate');
    expect(again.kind).toBe(DEPOSIT_CREDITED_KIND);
    expect(ledger.calls).toEqual([]);
    expect(await notify.unreadCount(OWNER)).toBe(1);
  });

  it('writes neither notice nor credit when the chain watcher is down', async () => {
    const notify = service();
    const ledger = book();

    const down = await notifyDepositCredit(notify, {
      watch: () => ({ status: 'down' }),
      book: ledger,
    });
    const thrown = await notifyDepositCredit(notify, {
      watch: () => {
        throw new Error('chain watcher down');
      },
      book: ledger,
    });

    expect(down.outcome).toBe('watcher_down');
    expect(thrown.outcome).toBe('watcher_down');
    expect(down.kind).toBeNull();
    expect(thrown.kind).toBeNull();
    expect(ledger.calls).toEqual([]);
    expect(await notify.unreadCount(OWNER)).toBe(0);
  });
});
