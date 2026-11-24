import { describe, expect, it } from 'vitest';
import { PrivateOrderHub, ORDERS_ENGINE_UNAVAILABLE, type PrivateBalanceUpdate } from './hub.js';
import { parsePrivateChannel } from './gateway.js';

// J-cex-spot-15 #9 at the private hub: `/private/stream?channel=balances` carries one frame per change in the person's own
// venue balance, with its source and the new total; a change id already sent is ignored; another person's change, and a
// connection that did not name the channel, carry none of it.

function sink() {
  const sent: string[] = [];
  return {
    sent,
    get bufferedBytes() {
      return 0;
    },
    send(frame: string) {
      sent.push(frame);
    },
    close() {
      /* not closed in these tests */
    },
  };
}

const hubOf = () => new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });

const change = (userId: string, changeId: string, total: string): PrivateBalanceUpdate => ({
  changeId,
  userId,
  venueId: 'test-venue-sim',
  owner: '0x00000000000000000000000000000000000000c9',
  subAccount: null,
  asset: 'USDC',
  source: 'deposit',
  sourceId: changeId,
  change: '25',
  total,
  ts: '2026-11-24T03:00:00.000Z',
});

describe('the private balances stream (J-cex-spot-15 #9)', () => {
  it('is a channel opened only by name', () => {
    expect(parsePrivateChannel('balances')).toBe('balances');
    expect(parsePrivateChannel(null)).toBe('all');
  });

  it('sends each change once to the person who owns it, with its source and new total', () => {
    const hub = hubOf();
    const mine = sink();
    const theirs = sink();
    hub.attach('user-a', mine, 'balances');
    hub.attach('user-b', theirs, 'balances');
    hub.publishBalance(change('user-a', 'deposit:1', '1025'));
    hub.publishBalance(change('user-a', 'deposit:1', '1025'));
    hub.publishBalance(change('user-a', 'deposit:2', '1050'));
    const frames = mine.sent.map((f) => JSON.parse(f) as Record<string, unknown>);
    expect(frames.map((f) => [f.channel, f.type, f.changeId, f.source, f.total])).toEqual([
      ['balances', 'balance', 'deposit:1', 'deposit', '1025'],
      ['balances', 'balance', 'deposit:2', 'deposit', '1050'],
    ]);
    expect(theirs.sent).toEqual([]);
  });

  it('never reaches a connection that did not name it, and carries no engine frames', () => {
    const hub = hubOf();
    const all = sink();
    const orders = sink();
    const balances = sink();
    hub.attach('user-a', all);
    hub.attach('user-a', orders, 'orders');
    hub.attach('user-a', balances, 'balances');
    hub.markEngineUnavailable();
    hub.publishBalance(change('user-a', 'deposit:1', '1025'));
    expect(all.sent.some((f) => f.includes('"balances"'))).toBe(false);
    expect(orders.sent.some((f) => f.includes('"balances"'))).toBe(false);
    expect(balances.sent.some((f) => f.includes(ORDERS_ENGINE_UNAVAILABLE))).toBe(false);
    expect(balances.sent).toHaveLength(1);
  });
});
