import { getAddress, parseAbi, type Address } from 'viem';
import {
  ASSET_LINK_NOT_TOKEN,
  type ProtocolAssetLinkReview,
  type ProtocolVenueReadCall,
  type ProtocolVenueReads,
  type ProtocolVenueSide,
} from '@intafaced/contracts';
import { VENUE_FUNDS_ABI, VenueFundsRefusal, requireVenue, type VenueChain, type VenueFundsDeps } from './funds.js';

/**
 * The asset link review and the contract-read docs (D-bridge-chain-04, J-dex-protocol-05 #10).
 *
 * The trading venue is one SovereignVenue contract with two assets fixed at deployment (`baseToken`, `quoteToken`). An ERC-20
 * is linked to the venue only when it is one of those two tokens: then what moves in and out of the venue is that very
 * token, with no bridge and no wrapped copy. The review reads the token's own `decimals()` and `symbol()` and the venue's two
 * assets from the chain at one block and says which. It stores nothing; there is no list of links of our own to keep.
 */
const TOKEN_ABI = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

type Token = { address: Address; symbol: string | null; decimals: number };

async function tokenAt(chain: VenueChain, token: Address, blockNumber: bigint): Promise<Token> {
  const read = (functionName: 'symbol' | 'decimals') =>
    chain.readContract({ address: token, abi: TOKEN_ABI, functionName, blockNumber } as never) as Promise<unknown>;
  const [symbol, decimals] = await Promise.all([read('symbol').catch(() => null), read('decimals').catch(() => undefined)]);
  if (decimals === undefined)
    throw new VenueFundsRefusal(
      ASSET_LINK_NOT_TOKEN,
      `${token} answers no decimals() on this network, so it is not a token the venue could hold.`,
    );
  return { address: token, symbol: typeof symbol === 'string' ? symbol : null, decimals: Number(decimals) };
}

/** `protocol.venue.assetLinkReview`: the token's decimals, and whether it is one of the venue's own two assets. */
export async function reviewAssetLink(deps: VenueFundsDeps, tokenInput: string): Promise<ProtocolAssetLinkReview> {
  const venue = requireVenue(deps.venue());
  const chain = deps.chain();
  const token = getAddress(tokenInput);
  const blockNumber = await chain.getBlockNumber();
  const venueRead = (functionName: 'baseToken' | 'quoteToken') =>
    chain.readContract({ address: venue, abi: VENUE_FUNDS_ABI, functionName, blockNumber } as never) as Promise<Address>;
  const [chainId, baseToken, quoteToken] = await Promise.all([chain.getChainId(), venueRead('baseToken'), venueRead('quoteToken')]);
  const [reviewed, base, quote] = await Promise.all([
    tokenAt(chain, token, blockNumber),
    tokenAt(chain, getAddress(baseToken), blockNumber),
    tokenAt(chain, getAddress(quoteToken), blockNumber),
  ]);
  const side: ProtocolVenueSide | null = token === base.address ? 'base' : token === quote.address ? 'quote' : null;
  const name = (t: Token) => t.symbol ?? t.address;
  const reason =
    side === null
      ? `The venue trades only ${name(base)} (base) and ${name(quote)} (quote); this token is neither, so it can't be moved into the venue.`
      : `This is the venue's own ${side} asset: the same token moves in and out, with no bridge or wrapped copy.`;
  return {
    venue,
    chainId,
    blockNumber: blockNumber.toString(),
    token: reviewed,
    verdict: side === null ? 'not_linked' : 'linked',
    side,
    venueAssets: [
      { side: 'base', token: base },
      { side: 'quote', token: quote },
    ],
    reason,
  };
}

/** The venue's public getters (`contracts/venue/SovereignVenue.sol`): the state any contract or client may read. */
const READS: readonly { name: string; signature: string; description: string; args: readonly string[] }[] = [
  { name: 'marketId', signature: 'marketId() returns (bytes32)', description: "The market's id.", args: [] },
  { name: 'baseToken', signature: 'baseToken() returns (address)', description: 'The ERC-20 the market trades.', args: [] },
  { name: 'quoteToken', signature: 'quoteToken() returns (address)', description: 'The ERC-20 the market is priced in.', args: [] },
  { name: 'takerFeeBps', signature: 'takerFeeBps() returns (uint16)', description: 'The taker fee, in basis points.', args: [] },
  { name: 'bestBid', signature: 'bestBid() returns (uint256)', description: 'The best bid price, 18 decimals; 0 with no bid.', args: [] },
  { name: 'bestAsk', signature: 'bestAsk() returns (uint256)', description: 'The best ask price, 18 decimals; 0 with no ask.', args: [] },
  {
    name: 'qtyAt',
    signature: 'qtyAt(uint8 side, uint256 price) returns (uint256)',
    description: 'The quantity resting at one price on one side (0 bid, 1 ask), 18 decimals.',
    args: ['0', '1000000000000000000'],
  },
  {
    name: 'baseBal',
    signature: 'baseBal(address account) returns (uint256)',
    description: "An account's base balance in the venue, 18 decimals, open orders' reserve included.",
    args: ['ACCOUNT'],
  },
  {
    name: 'quoteBal',
    signature: 'quoteBal(address account) returns (uint256)',
    description: "An account's quote balance in the venue, 18 decimals, open orders' reserve included.",
    args: ['ACCOUNT'],
  },
  {
    name: 'reservedBase',
    signature: 'reservedBase(address account) returns (uint256)',
    description: "The part of an account's base balance its open orders reserve; balance less this is free to withdraw.",
    args: ['ACCOUNT'],
  },
  {
    name: 'reservedQuote',
    signature: 'reservedQuote(address account) returns (uint256)',
    description: "The part of an account's quote balance its open orders reserve; balance less this is free to withdraw.",
    args: ['ACCOUNT'],
  },
  {
    name: 'positionSize',
    signature: 'positionSize(address account) returns (int256)',
    description: "An account's position, 18 decimals; negative is short.",
    args: ['ACCOUNT'],
  },
  {
    name: 'positionEntry',
    signature: 'positionEntry(address account) returns (uint256)',
    description: "An account's average entry price, 18 decimals.",
    args: ['ACCOUNT'],
  },
];

function example(venue: Address, read: (typeof READS)[number]): string {
  const args = read.args.map((a) => (a === 'ACCOUNT' ? "'0xYourAddress'" : `${a}n`));
  return [
    `await client.readContract({`,
    `  address: '${venue}',`,
    `  abi: parseAbi(['function ${read.signature.replace(' returns', ' view returns')}']),`,
    `  functionName: '${read.name}',`,
    ...(args.length ? [`  args: [${args.join(', ')}],`] : []),
    `});`,
  ].join('\n');
}

/** `protocol.venue.reads`: the contract-read docs for the configured venue on its chain. */
export async function venueReads(deps: VenueFundsDeps): Promise<ProtocolVenueReads> {
  const venue = requireVenue(deps.venue());
  const chainId = await deps.chain().getChainId();
  const calls: ProtocolVenueReadCall[] = READS.map((read) => ({
    name: read.name,
    signature: read.signature,
    description: read.description,
    example: example(venue, read),
  }));
  return { venue, chainId, calls };
}
