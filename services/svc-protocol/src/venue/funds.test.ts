import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress, parseAbi, type Address } from 'viem';
import { VENUE_BAD_AMOUNT, VENUE_INSUFFICIENT_FREE, VENUE_UNSET, protocolVenueBuildOutputSchema } from '@intafaced/contracts';
import { VENUE_FUNDS_ABI, buildVenueDeposit, buildVenueWithdraw, venueAmount, venueBalances, type VenueChain } from './funds.js';

const VENUE = getAddress('0x00000000000000000000000000000000000be000');
const BASE = getAddress('0x00000000000000000000000000000000000a11ce');
const QUOTE = getAddress('0x000000000000000000000000000000000000d011');
const ACCOUNT = getAddress('0x1111111111111111111111111111111111111111');
const WAD = 10n ** 18n;
const ERC20 = parseAbi(['function approve(address spender, uint256 amount)']);

/** A venue holding `bal` and `reserved` (18-decimal amounts) per side for ACCOUNT, and the token's allowance to it. */
function fakeChain(opts: {
  baseBal?: bigint;
  reservedBase?: bigint;
  quoteBal?: bigint;
  reservedQuote?: bigint;
  allowance?: bigint;
  baseDecimals?: number;
}): VenueChain & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    getChainId: async () => 84532,
    getBlockNumber: async () => 77n,
    readContract: (async (call: { address: Address; functionName: string; blockNumber?: bigint }) => {
      reads.push(`${call.address}:${call.functionName}`);
      expect(call.blockNumber, `${call.functionName} is read at the one pinned block`).toBe(77n);
      const values: Record<string, unknown> = {
        [`${VENUE}:baseToken`]: BASE,
        [`${VENUE}:quoteToken`]: QUOTE,
        [`${VENUE}:baseBal`]: opts.baseBal ?? 0n,
        [`${VENUE}:reservedBase`]: opts.reservedBase ?? 0n,
        [`${VENUE}:quoteBal`]: opts.quoteBal ?? 0n,
        [`${VENUE}:reservedQuote`]: opts.reservedQuote ?? 0n,
        [`${BASE}:symbol`]: 'TA',
        [`${BASE}:decimals`]: opts.baseDecimals ?? 6,
        [`${BASE}:allowance`]: opts.allowance ?? 0n,
        [`${QUOTE}:symbol`]: 'TUSD',
        [`${QUOTE}:decimals`]: 6,
        [`${QUOTE}:allowance`]: opts.allowance ?? 0n,
      };
      const key = `${call.address}:${call.functionName}`;
      if (!(key in values)) throw new Error(`unexpected read ${key}`);
      return values[key];
    }) as unknown as VenueChain['readContract'],
  };
}

const deps = (chain: VenueChain, venue: Address | null = VENUE) => ({ chain: () => chain, venue: () => venue });

describe('venue funds (D-bridge-chain-04)', () => {
  it('refuses protocol.venue_unset with no venue address, before any chain read', async () => {
    for (const venue of [null, '0x0000000000000000000000000000000000000000' as Address]) {
      const chain = fakeChain({});
      await expect(venueBalances(deps(chain, venue), ACCOUNT)).rejects.toThrow(VENUE_UNSET);
      await expect(buildVenueDeposit(deps(chain, venue), { account: ACCOUNT, side: 'base', amount: '10' })).rejects.toThrow(VENUE_UNSET);
      await expect(buildVenueWithdraw(deps(chain, venue), { account: ACCOUNT, side: 'base', amount: '1' })).rejects.toThrow(VENUE_UNSET);
      expect(chain.reads).toEqual([]);
    }
  });

  it('reads total, reserved and free per asset from the contract at one block', async () => {
    const out = await venueBalances(deps(fakeChain({ baseBal: 10n * WAD, reservedBase: 4n * WAD, quoteBal: WAD / 2n })), ACCOUNT);
    expect(out).toMatchObject({ venue: VENUE, chainId: 84532, account: ACCOUNT, blockNumber: '77' });
    expect(out.assets[0]).toMatchObject({
      side: 'base',
      total: '10',
      reserved: '4',
      free: '6',
      token: { address: BASE, symbol: 'TA', decimals: 6 },
    });
    expect(out.assets[1]).toMatchObject({ side: 'quote', total: '0.5', reserved: '0', free: '0.5' });
  });

  it('builds an approval for the exact wallet amount, then deposit(10 base) on the venue; nothing is sent', async () => {
    const out = await buildVenueDeposit(deps(fakeChain({})), { account: ACCOUNT, side: 'base', amount: '10' });
    protocolVenueBuildOutputSchema.parse(out);
    expect(out).toMatchObject({ kind: 'deposit', amount: '10', free: '0', chainId: 84532 });
    expect(out.calls).toHaveLength(2);
    const approve = decodeFunctionData({ abi: ERC20, data: out.calls[0]!.data as `0x${string}` });
    expect(out.calls[0]!.to).toBe(BASE);
    // 10 TEST Token A in its own 6 decimals: what the venue pulls.
    expect(approve.args).toEqual([VENUE, 10_000_000n]);
    const deposit = decodeFunctionData({ abi: VENUE_FUNDS_ABI, data: out.calls[1]!.data as `0x${string}` });
    expect(out.calls[1]!.to).toBe(VENUE);
    expect(deposit.functionName).toBe('deposit');
    expect(deposit.args).toEqual([10n * WAD, 0n]);
  });

  it('builds deposit alone when the allowance already covers it, and a quote deposit fills the second argument', async () => {
    const out = await buildVenueDeposit(deps(fakeChain({ allowance: 10_000_000n })), { account: ACCOUNT, side: 'quote', amount: '2.5' });
    expect(out.calls).toHaveLength(1);
    expect(decodeFunctionData({ abi: VENUE_FUNDS_ABI, data: out.calls[0]!.data as `0x${string}` }).args).toEqual([0n, (5n * WAD) / 2n]);
  });

  it('refuses a withdrawal above the free amount, naming it, and builds one within it', async () => {
    const chain = fakeChain({ baseBal: 10n * WAD, reservedBase: 4n * WAD });
    const refused = buildVenueWithdraw(deps(chain), { account: ACCOUNT, side: 'base', amount: '8' });
    await expect(refused).rejects.toThrow(VENUE_INSUFFICIENT_FREE);
    await expect(refused).rejects.toThrow('more than is free (6 free)');
    const out = await buildVenueWithdraw(deps(chain), { account: ACCOUNT, side: 'base', amount: '6' });
    expect(out).toMatchObject({ kind: 'withdraw', amount: '6', free: '6' });
    const call = decodeFunctionData({ abi: VENUE_FUNDS_ABI, data: out.calls[0]!.data as `0x${string}` });
    expect(call.functionName).toBe('withdraw');
    expect(call.args).toEqual([6n * WAD, 0n]);
  });

  it('refuses a withdrawal from an empty venue balance, naming 0 free', async () => {
    await expect(buildVenueWithdraw(deps(fakeChain({})), { account: ACCOUNT, side: 'base', amount: '1000000' })).rejects.toThrow(
      'more than is free (0 free)',
    );
  });

  it('refuses zero, an amount finer than the token, and a token the venue cannot move', async () => {
    expect(() => venueAmount('0', 6)).toThrow(VENUE_BAD_AMOUNT);
    expect(() => venueAmount('0.0000001', 6)).toThrow(VENUE_BAD_AMOUNT);
    expect(venueAmount('0.000001', 6)).toEqual({ wad: 10n ** 12n, units: 1n });
    expect(venueAmount('0.000000000000000001', 18)).toEqual({ wad: 1n, units: 1n });
    expect(() => venueAmount('1', 8)).toThrow(VENUE_BAD_AMOUNT);
    await expect(buildVenueDeposit(deps(fakeChain({})), { account: ACCOUNT, side: 'base', amount: '0.0000001' })).rejects.toThrow(
      VENUE_BAD_AMOUNT,
    );
  });
});
