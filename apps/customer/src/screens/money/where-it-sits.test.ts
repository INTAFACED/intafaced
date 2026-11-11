import { describe, expect, it } from 'vitest';
import { balanceOfData, readWallet, venueRows, type NodeRead } from './where-it-sits';

const OWNER = '0x00000000000000000000000000000000000000aa';
const USD = '0x000000000000000000000000000000000000d011';
const DROP = '0x00000000000000000000000000000000000d7090';
const tokens = [
  { address: null, symbol: 'ETH', decimals: 18 },
  { address: USD, symbol: 'TESTUSD', decimals: 6 },
  { address: DROP, symbol: 'TESTDROP', decimals: 18 },
];

function node(answers: Record<string, unknown>, calls: unknown[][] = []): NodeRead {
  return async (method, params) => {
    calls.push([method, ...params]);
    if (method === 'eth_getBlockByNumber') return answers.block;
    if (method === 'eth_getBalance') return answers.native;
    const to = (params[0] as { to: string }).to;
    if (answers[to] instanceof Error) throw answers[to];
    return answers[to];
  };
}

describe('readWallet', () => {
  it('reads every balance at the one block it read first, and dates them by that block', async () => {
    const calls: unknown[][] = [];
    const read = node(
      { block: { number: '0x10', timestamp: '0x6553f100' }, native: '0xde0b6b3a7640000', [USD]: '0x5f5e100', [DROP]: '0x0' },
      calls,
    );
    const out = await readWallet(read, 84532, OWNER, tokens);
    expect(out).toEqual({
      ok: true,
      chainId: 84532,
      address: OWNER,
      block: '16',
      asOf: new Date(0x6553f100 * 1000).toISOString(),
      rows: [
        { symbol: 'ETH', token: null, amount: '1' },
        { symbol: 'TESTUSD', token: USD, amount: '100' },
      ],
      unread: [],
    });
    // Every balance read names block 0x10, never "latest".
    for (const call of calls.slice(1)) expect(call.at(-1)).toBe('0x10');
    expect(calls).toContainEqual(['eth_call', { to: USD, data: balanceOfData(OWNER) }, '0x10']);
  });

  it('names a token it could not read, and never shows it as 0', async () => {
    const read = node({ block: { number: '0x1', timestamp: '0x1' }, native: '0x0', [USD]: new Error('down'), [DROP]: null });
    const out = await readWallet(read, 84532, OWNER, tokens);
    expect(out.ok && out.rows).toEqual([]);
    expect(out.ok && out.unread).toEqual(['TESTUSD', 'TESTDROP']);
  });

  it('is no read at all when the block cannot be read', async () => {
    expect(await readWallet(node({ block: null }), 84532, OWNER, tokens)).toEqual({ ok: false });
  });
});

describe('venueRows', () => {
  it('names each open order behind a lock and offers only the free figure to withdraw', () => {
    const rows = venueRows(
      [
        { asset: 'USDC', free: '480', locked: '20', total: '500' },
        { asset: 'BTC', free: '0', locked: '0', total: '0' },
      ],
      [
        {
          venueOrderId: '7',
          venueClientOrderId: 'order:0xaa:btc-usdc:abc',
          symbol: 'BTC-USDC',
          side: 'buy',
          locked: '20',
          lockedAsset: 'USDC',
        },
        { venueOrderId: '8', venueClientOrderId: null, symbol: 'BTC-USDC', side: 'sell', locked: '0.1', lockedAsset: 'BTC' },
      ],
    );
    expect(rows).toEqual([
      {
        asset: 'USDC',
        free: '480',
        locked: '20',
        total: '500',
        withdrawable: '480',
        orders: [{ id: 'order:0xaa:btc-usdc:abc', symbol: 'BTC-USDC', side: 'buy', locked: '20' }],
      },
    ]);
  });
});
