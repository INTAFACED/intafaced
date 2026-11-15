import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import {
  ASSET_LINK_NOT_TOKEN,
  VENUE_UNSET,
  protocolAssetLinkReviewOutputSchema,
  protocolVenueReadsOutputSchema,
} from '@intafaced/contracts';
import { reviewAssetLink, venueReads } from './asset-link.js';
import type { VenueChain } from './funds.js';

const VENUE = getAddress('0x00000000000000000000000000000000000be000');
const BASE = getAddress('0x00000000000000000000000000000000000a11ce');
const QUOTE = getAddress('0x000000000000000000000000000000000000d011');
const OTHER = getAddress('0x0000000000000000000000000000000000000b0b');
const EOA = getAddress('0x1111111111111111111111111111111111111111');

function fakeChain(): VenueChain & { reads: string[] } {
  const reads: string[] = [];
  const values: Record<string, unknown> = {
    [`${VENUE}:baseToken`]: BASE,
    [`${VENUE}:quoteToken`]: QUOTE,
    [`${BASE}:symbol`]: 'TA',
    [`${BASE}:decimals`]: 18,
    [`${QUOTE}:symbol`]: 'TUSD',
    [`${QUOTE}:decimals`]: 6,
    [`${OTHER}:symbol`]: 'TB',
    [`${OTHER}:decimals`]: 8,
  };
  return {
    reads,
    getChainId: async () => 84532,
    getBlockNumber: async () => 77n,
    readContract: (async (call: { address: Address; functionName: string; blockNumber?: bigint }) => {
      reads.push(`${call.address}:${call.functionName}`);
      expect(call.blockNumber, `${call.functionName} is read at the one pinned block`).toBe(77n);
      const key = `${call.address}:${call.functionName}`;
      if (!(key in values)) throw new Error(`execution reverted: ${key}`);
      return values[key];
    }) as unknown as VenueChain['readContract'],
  };
}

const deps = (chain: VenueChain, venue: Address | null = VENUE) => ({ chain: () => chain, venue: () => venue });

describe('asset link review (D-bridge-chain-04, J-dex-protocol-05 #10)', () => {
  it("the venue's base token is linked, with its own decimals", async () => {
    const review = protocolAssetLinkReviewOutputSchema.parse(await reviewAssetLink(deps(fakeChain()), BASE.toLowerCase()));
    expect(review).toMatchObject({ verdict: 'linked', side: 'base', blockNumber: '77', chainId: 84532, venue: VENUE });
    expect(review.token).toEqual({ address: BASE, symbol: 'TA', decimals: 18 });
  });

  it("the venue's quote token is linked as quote", async () => {
    const review = await reviewAssetLink(deps(fakeChain()), QUOTE);
    expect(review).toMatchObject({ verdict: 'linked', side: 'quote', token: { decimals: 6 } });
  });

  it('a token the venue does not trade is not linked, naming the two it does', async () => {
    const review = await reviewAssetLink(deps(fakeChain()), OTHER);
    expect(review).toMatchObject({ verdict: 'not_linked', side: null, token: { symbol: 'TB', decimals: 8 } });
    expect(review.reason).toContain('only TA (base) and TUSD (quote)');
  });

  it('an address with no decimals() is refused protocol.asset_link_not_token', async () => {
    await expect(reviewAssetLink(deps(fakeChain()), EOA)).rejects.toThrow(ASSET_LINK_NOT_TOKEN);
  });

  it('refuses protocol.venue_unset with no venue address, before any chain read', async () => {
    const chain = fakeChain();
    await expect(reviewAssetLink(deps(chain, null), BASE)).rejects.toThrow(VENUE_UNSET);
    await expect(venueReads(deps(chain, null))).rejects.toThrow(VENUE_UNSET);
    expect(chain.reads).toEqual([]);
  });
});

describe('contract-read docs (D-bridge-chain-04, J-dex-protocol-05 #10)', () => {
  it("lists the venue's read-only getters, each with an example aimed at the configured venue", async () => {
    const docs = protocolVenueReadsOutputSchema.parse(await venueReads(deps(fakeChain())));
    expect(docs.venue).toBe(VENUE);
    expect(docs.calls.map((c) => c.name)).toEqual(
      expect.arrayContaining(['baseToken', 'quoteToken', 'baseBal', 'reservedBase', 'bestBid', 'positionSize']),
    );
    for (const call of docs.calls) {
      expect(call.example).toContain(`address: '${VENUE}'`);
      expect(call.example).toContain(`functionName: '${call.name}'`);
      expect(call.example).toContain(' view returns ');
    }
  });
});
