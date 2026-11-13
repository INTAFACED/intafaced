import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { readPortfolio, type HolderTransfer, type PortfolioChain } from './portfolio.js';
import { TokensReadError } from './tokens.js';

// One address's portfolio worked out from logs (J-dex-protocol-06 #1 #2 #3): the journey's own figures, on a stand-in chain.
const FACTORY = '0x00000000000000000000000000000000000fac70' as Address;
const ME = '0x1111111111111111111111111111111111111111' as Address;
const MOVER = '0x2222222222222222222222222222222222222222' as Address;
const A = { address: '0x00000000000000000000000000000000000a11ce' as Address, name: 'TEST Token A', symbol: 'TESTA', decimals: 6 };
const B = { address: '0x00000000000000000000000000000000000b0b00' as Address, name: 'TEST Token B', symbol: 'TESTB', decimals: 18 };
const USD = { address: '0x000000000000000000000000000000000000d011' as Address, name: 'TEST USD', symbol: 'TESTUSD', decimals: 6 };
const THIN = { address: '0x00000000000000000000000000000000000071a0' as Address, name: 'TEST Thin', symbol: 'TESTTHIN', decimals: 18 };
const POOL_AU = '0x000000000000000000000000000000000000a001' as Address;
const POOL_BU = '0x000000000000000000000000000000000000b001' as Address;
const POOL_AT = '0x000000000000000000000000000000000000c001' as Address;
const TOKENS = [A, B, USD, THIN];
const usd = (n: number) => BigInt(Math.round(n * 1e6));
const e18 = (n: number) => BigInt(n) * 10n ** 18n;
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

type Sync = { pool: Address; block: bigint; reserve0: bigint; reserve1: bigint };
function world() {
  const transfers: HolderTransfer[] = [];
  const syncs: Sync[] = [];
  const reserves = new Map<string, [bigint, bigint]>();
  let block = 1n;
  const sync = (pool: Address, r0: bigint, r1: bigint) => {
    reserves.set(pool, [r0, r1]);
    syncs.push({ pool, block: block++, reserve0: r0, reserve1: r1 });
  };
  const send = (token: Address, from: Address, to: Address, value: bigint) => {
    transfers.push({ token, from, to, value, block, logIndex: 0, tx: tx(Number(block)) });
    block++;
  };
  // Pools sort their pair: token0 is the lower address. A (…a11ce) and USD (…d011): A first; B (…b0b00) and USD: B first.
  sync(POOL_AU, usd(1_000_000), usd(1_000_000));
  sync(POOL_BU, e18(1_000_000), usd(1_000_000));
  sync(POOL_AT, usd(0.001), 10n ** 15n);
  const chain = (): PortfolioChain => {
    const head = block - 1n;
    const balance = (token: Address) =>
      transfers
        .filter((t) => t.token === token)
        .reduce((sum, t) => sum + (t.to === ME ? t.value : 0n) - (t.from === ME ? t.value : 0n), 0n);
    const pools: Record<string, { token0: Address; token1: Address }> = {
      [POOL_AU]: { token0: A.address, token1: USD.address },
      [POOL_BU]: { token0: B.address, token1: USD.address },
      [POOL_AT]: { token0: A.address, token1: THIN.address },
    };
    return {
      headBlock: async () => head,
      factoryPools: async () => [POOL_AU, POOL_BU, POOL_AT],
      poolSnapshot: async (pool) => {
        const [reserve0, reserve1] = reserves.get(pool)!;
        return { ...pools[pool]!, feeBps: 30, reserve0, reserve1, blockTimestampLast: 0 };
      },
      tokenBasics: async (token) => {
        const { name, symbol, decimals } = TOKENS.find((t) => t.address === token)!;
        return { name, symbol, decimals };
      },
      poolLogs: async () => ({
        syncs: syncs.map((s) => ({ ...s, tx: tx(Number(s.block)), logIndex: 0 })),
        swaps: [],
      }),
      blockTimes: async (blocks) => new Map(blocks.map((b) => [b, 1_700_000_000 + Number(b)])),
      balanceOf: async (token) => balance(token),
      holderTransfers: async () => [...transfers],
    };
  };
  return { send, sync, chain };
}
const setting = { usdTokens: new Set([USD.address.toLowerCase()]), minReserveUsd: 1000n };
const read = (chain: PortfolioChain) => readPortfolio({ chain, factory: FACTORY, setting }, ME);

describe('protocol.portfolio.read', () => {
  it('totals the priced holdings and leaves the token with no price out, counted', async () => {
    const w = world();
    w.send(A.address, MOVER, ME, usd(80));
    w.send(USD.address, '0x0000000000000000000000000000000000000000', ME, usd(20));
    w.send(THIN.address, '0x0000000000000000000000000000000000000000', ME, e18(5));
    const answer = await read(w.chain());
    expect(answer.totalUsd).toBe('100');
    expect(answer.unpriced).toBe(1);
    const thin = answer.holdings.find((h) => h.symbol === 'TESTTHIN')!;
    expect(thin).toMatchObject({ usd: null, valueUsd: null, reason: 'thin_reserve', balance: e18(5).toString() });
    expect(answer.holdings.map((h) => h.symbol).sort()).toEqual(['TESTA', 'TESTTHIN', 'TESTUSD']);
  });

  it('profit and loss leaves the deposit out, and the drawdown from 120 to 90 is 25 percent', async () => {
    const w = world();
    w.send(A.address, MOVER, ME, usd(80));
    w.send(USD.address, MOVER, ME, usd(20));
    w.send(THIN.address, MOVER, ME, e18(5));
    w.send(A.address, MOVER, ME, usd(20)); // the deposit: worth 120
    w.sync(POOL_AU, usd(1_000_000), usd(700_000)); // TEST Token A to 0.70: worth 90
    const answer = await read(w.chain());
    expect(answer.totalUsd).toBe('90');
    expect(answer.pnl).toMatchObject({ usd: '-30', depositsUsd: '120', withdrawalsUsd: '0' });
    expect(answer.drawdown).toMatchObject({ pct: '25.00', peakUsd: '120', troughUsd: '90' });
  });

  it('a value that only grows has no drawdown, and money taken out is not a fall', async () => {
    const w = world();
    w.send(USD.address, MOVER, ME, usd(100));
    w.send(USD.address, ME, MOVER, usd(60));
    const answer = await read(w.chain());
    expect(answer.totalUsd).toBe('40');
    expect(answer.pnl).toMatchObject({ usd: '0', depositsUsd: '100', withdrawalsUsd: '60' });
    expect(answer.drawdown).toBeNull();
  });

  it('a trade with a listed pool is not money in or out', async () => {
    const w = world();
    w.send(USD.address, MOVER, ME, usd(100));
    w.send(USD.address, ME, POOL_AU, usd(50));
    w.send(A.address, POOL_AU, ME, usd(50));
    const answer = await read(w.chain());
    expect(answer.pnl).toMatchObject({ usd: '0', depositsUsd: '100', withdrawalsUsd: '0' });
    expect(answer.transfers.filter((t) => t.pool)).toHaveLength(2);
  });

  it('the entry price is the price at the block the token arrived, not today', async () => {
    const w = world();
    w.sync(POOL_BU, e18(1_000_000), usd(2_000_000)); // TEST Token B at 2
    w.send(B.address, MOVER, ME, e18(10));
    w.sync(POOL_BU, e18(1_000_000), usd(1_000_000)); // back to 1
    const answer = await read(w.chain());
    const b = answer.holdings.find((h) => h.symbol === 'TESTB')!;
    expect(b.usd).toBe('1');
    expect(b.entry).toMatchObject({ usd: '2', arrivals: 1, unpriced: 0 });
  });

  it('an address with no history has no holdings, no profit and loss and no transfers', async () => {
    const answer = await read(world().chain());
    expect(answer).toMatchObject({ totalUsd: '0', holdings: [], pnl: null, drawdown: null, transfers: [], transferCount: 0 });
  });

  it('lists the newest transfer first, with its transaction and direction', async () => {
    const w = world();
    w.send(A.address, MOVER, ME, usd(1));
    w.send(A.address, ME, MOVER, usd(1));
    const answer = await read(w.chain());
    expect(answer.transfers.map((t) => t.direction)).toEqual(['out', 'in']);
    expect(answer.transfers[1]!.counterparty).toBe(MOVER);
  });

  it('a chain refusal is not answered as an empty portfolio', async () => {
    const w = world();
    const chain = {
      ...w.chain(),
      holderTransfers: async () => Promise.reject(new TokensReadError('protocol.tokens_read_too_large', 'too many')),
    };
    await expect(read(chain)).rejects.toBeInstanceOf(TokensReadError);
  });
});
