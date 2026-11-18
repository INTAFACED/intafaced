import { describe, expect, it } from 'vitest';
import { formatAmount } from '@intafaced/ledger-client';
import { testPartner } from '../partner/test-partner.js';
import { nextWeekday } from './pay-yourself-service.js';
import { TEST_PAY_IN_CONFIRMATIONS, payInCredited, testPayInAddress, testPayInRail, unitsToAmount } from './test-pay-in.js';

// J-bank-31 #4 #6: the TEST partner credits a USDC pay-in to its TEST address once, after its confirmations, never while
// its answer is held, and a pending one is never spendable.
const TOKEN = '0x000000000000000000000000000000000000d011';
const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function chain() {
  let head = 10n;
  const logs: Record<string, unknown>[] = [];
  const fetchFn: typeof globalThis.fetch = async (_url, init) => {
    const { method, params, id } = JSON.parse(String(init?.body)) as {
      method: string;
      params: { topics: (string | string[] | null)[] }[];
      id: number;
    };
    let result: unknown;
    if (method === 'eth_blockNumber') result = `0x${head.toString(16)}`;
    else {
      const to = params[0]!.topics[2] as string[];
      result = logs.filter((l) => to.includes((l.topics as string[])[2]!));
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });
  };
  return {
    fetchFn,
    mine: (n = 1) => {
      head += BigInt(n);
    },
    transfer(to: string, units: bigint, tx: string) {
      head += 1n;
      logs.push({
        transactionHash: tx,
        logIndex: '0x0',
        blockNumber: `0x${head.toString(16)}`,
        data: `0x${units.toString(16)}`,
        topics: [TOPIC, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${to.slice(2)}`],
      });
    },
  };
}

describe('the TEST partner pay-in', () => {
  it('gives each person their own address, credits a transfer once after its confirmations, and counts only what it credited', async () => {
    const partner = testPartner();
    const c = chain();
    const rail = testPayInRail({ partner, rpcUrl: 'http://127.0.0.1:8545', chainId: 84532, token: TOKEN, fetchFn: c.fetchFn });
    const route = rail.route('user-1');
    expect(route.address).toBe(testPayInAddress('user-1'));
    expect(route.address).not.toBe(testPayInAddress('user-2'));
    await rail.poll();
    c.transfer(route.address, 298_750_000n, '0xaaa');
    await rail.poll();
    expect(rail.credits('user-1').map((x) => [x.status, formatAmount(x.amount), x.confirmations])).toEqual([['pending', '298.75', 1]]);
    expect(payInCredited(rail, 'user-1', 'USDC')).toBe(0n);
    // One short of its confirmations: still pending, not counted.
    c.mine(TEST_PAY_IN_CONFIRMATIONS - 2);
    await rail.poll();
    expect(rail.credits('user-1').map((x) => [x.status, x.confirmations])).toEqual([['pending', TEST_PAY_IN_CONFIRMATIONS - 1]]);
    expect(payInCredited(rail, 'user-1', 'USDC')).toBe(0n);
    c.mine();
    await rail.poll();
    await rail.poll();
    const [credit] = rail.credits('user-1');
    expect(credit!.status).toBe('available');
    expect(credit!.key).toBe('bank.pay-in:usdc:84532:0xaaa:0');
    // Credited once, on the partner's own book, to the main USDC balance.
    expect(partner.record('user-1').moves.filter((m) => m.key === credit!.key)).toHaveLength(1);
    expect(formatAmount(partner.record('user-1').accounts[0]!.amount)).toBe('298.75');
    expect(formatAmount(payInCredited(rail, 'user-1', 'USDC'))).toBe('298.75');
    expect(payInCredited(rail, 'user-1', 'BTC')).toBe(0n);
    expect(rail.credits('user-2')).toEqual([]);
  });

  it('holds a pay-in pending while the partner holds its answer, and credits it once the switch goes back', async () => {
    const partner = testPartner();
    const c = chain();
    const rail = testPayInRail({ partner, rpcUrl: 'http://localhost:8545', chainId: 84532, token: TOKEN, fetchFn: c.fetchFn });
    const { address } = rail.route('user-1');
    partner.set('user-1', { payIn: 'held' });
    await rail.poll();
    c.transfer(address, 5_000_000n, '0xbbb');
    c.mine(TEST_PAY_IN_CONFIRMATIONS);
    await rail.poll();
    expect(rail.credits('user-1').map((x) => [x.status, x.held])).toEqual([['pending', true]]);
    expect(partner.record('user-1').accounts).toEqual([]);
    partner.set('user-1', { payIn: 'answered' });
    await rail.poll();
    expect(rail.credits('user-1').map((x) => [x.status, x.held])).toEqual([['available', false]]);
  });

  it('refuses a TEST chain off loopback', () => {
    expect(() => testPayInRail({ partner: testPartner(), rpcUrl: 'https://rpc.example', chainId: 1, token: TOKEN })).toThrow(/loopback/);
  });

  it('reads token units exactly', () => {
    expect(formatAmount(unitsToAmount(1_500_000n, 6))).toBe('1.5');
    expect(formatAmount(unitsToAmount(300_000_000n, 6))).toBe('300');
  });
});

describe('the weekly rule day', () => {
  it('is the start of the next such day, strictly after now', () => {
    // 17 Nov 2026 is a Tuesday.
    expect(nextWeekday('friday', new Date('2026-11-17T10:00:00Z')).toISOString()).toBe('2026-11-20T00:00:00.000Z');
    expect(nextWeekday('tuesday', new Date('2026-11-17T10:00:00Z')).toISOString()).toBe('2026-11-24T00:00:00.000Z');
    expect(nextWeekday('friday', new Date('2026-11-20T00:00:00Z')).toISOString()).toBe('2026-11-27T00:00:00.000Z');
  });
});
