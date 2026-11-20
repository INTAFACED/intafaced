import { encodeFunctionData, formatUnits, getAddress, parseAbi, parseUnits, type Address, type PublicClient } from 'viem';
import {
  VENUE_BAD_AMOUNT,
  VENUE_INSUFFICIENT_FREE,
  VENUE_UNSET,
  type ProtocolVenueAsset,
  type ProtocolVenueBalances,
  type ProtocolVenueBuild,
  type ProtocolVenueBuildInput,
  type ProtocolVenueSide,
} from '@intafaced/contracts';
import { isZeroAddress } from '../chain/availability.js';
import { planApproval } from '../amm/build.js';

/**
 * Moving a wallet's own tokens into and out of the trading venue (D-bridge-chain-04, J-dex-protocol-05 #9).
 *
 * The venue is the SovereignVenue contract (`contracts/venue/SovereignVenue.sol`): `deposit` and `withdraw` move the
 * caller's own tokens, and its public mappings hold each account's balance and what its open orders reserve. That balance
 * is the contract's state, read from the chain at one block; this service keeps no copy of it and posts nothing to the
 * ledger. It only builds unsigned calls: the person's own wallet signs and sends them.
 *
 * Refusals, before any call is built:
 * - `protocol.venue_unset`: no venue address is set (`PROTOCOL_VENUE_ADDRESS`, an owner setting). Nothing is read.
 * - `protocol.venue_bad_amount`: zero, or finer than the token's own decimals (the venue moves whole token units only).
 * - `protocol.venue_insufficient_free`: a withdrawal above the free amount (balance less what open orders reserve). The
 *   contract would revert `Insufficient` and leave everything in place; this says so first, naming the free amount.
 */
export class VenueFundsRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'VenueFundsRefusal';
  }
}

export const VENUE_FUNDS_ABI = parseAbi([
  'function baseToken() view returns (address)',
  'function quoteToken() view returns (address)',
  'function baseBal(address) view returns (uint256)',
  'function quoteBal(address) view returns (uint256)',
  'function reservedBase(address) view returns (uint256)',
  'function reservedQuote(address) view returns (uint256)',
  'function deposit(uint256 baseAmount, uint256 quoteAmount)',
  'function withdraw(uint256 baseAmount, uint256 quoteAmount)',
]);
const TOKEN_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

/** The venue's own precision: every amount inside it has 18 decimals, whatever the token's. */
const VENUE_DECIMALS = 18;

export type VenueChain = Pick<PublicClient, 'readContract' | 'getChainId' | 'getBlockNumber'>;

export interface VenueFundsDeps {
  chain: () => VenueChain;
  /** `PROTOCOL_VENUE_ADDRESS`. Null or zero refuses `protocol.venue_unset`. */
  venue: () => Address | null;
  /** Whether `token` reverts a direct change of a non-zero allowance (so the approval is reset to zero first). */
  directApproveReverts?: (token: Address, owner: Address, spender: Address, amount: bigint) => Promise<boolean>;
}

export function requireVenue(venue: Address | null): Address {
  if (venue === null || isZeroAddress(venue))
    throw new VenueFundsRefusal(
      VENUE_UNSET,
      'the trading venue is an owner setting (PROTOCOL_VENUE_ADDRESS) that is not set, so nothing can be moved into or out of it.',
    );
  return getAddress(venue);
}

type Reading = {
  venue: Address;
  chainId: number;
  account: Address;
  blockNumber: bigint;
  assets: Record<ProtocolVenueSide, { token: Address; symbol: string | null; decimals: number; total: bigint; reserved: bigint }>;
};

async function read(chain: VenueChain, venue: Address, account: Address): Promise<Reading> {
  const blockNumber = await chain.getBlockNumber();
  const at = <T>(address: Address, abi: typeof VENUE_FUNDS_ABI | typeof TOKEN_ABI, functionName: string, args: unknown[] = []) =>
    chain.readContract({ address, abi, functionName, args, blockNumber } as never) as Promise<T>;
  const [chainId, baseToken, quoteToken, baseBal, quoteBal, reservedBase, reservedQuote] = await Promise.all([
    chain.getChainId(),
    at<Address>(venue, VENUE_FUNDS_ABI, 'baseToken'),
    at<Address>(venue, VENUE_FUNDS_ABI, 'quoteToken'),
    at<bigint>(venue, VENUE_FUNDS_ABI, 'baseBal', [account]),
    at<bigint>(venue, VENUE_FUNDS_ABI, 'quoteBal', [account]),
    at<bigint>(venue, VENUE_FUNDS_ABI, 'reservedBase', [account]),
    at<bigint>(venue, VENUE_FUNDS_ABI, 'reservedQuote', [account]),
  ]);
  const facts = async (token: Address) => {
    const [symbol, decimals] = await Promise.all([
      at<string>(token, TOKEN_ABI, 'symbol').catch(() => null),
      at<number>(token, TOKEN_ABI, 'decimals'),
    ]);
    return { token: getAddress(token), symbol, decimals: Number(decimals) };
  };
  const [base, quote] = await Promise.all([facts(baseToken), facts(quoteToken)]);
  return {
    venue,
    chainId,
    account,
    blockNumber,
    assets: {
      base: { ...base, total: baseBal, reserved: reservedBase },
      quote: { ...quote, total: quoteBal, reserved: reservedQuote },
    },
  };
}

const show = (wad: bigint) => formatUnits(wad, VENUE_DECIMALS);

/** Free is the balance less what open orders reserve. The contract keeps reserved within the balance. */
function freeOf(asset: { total: bigint; reserved: bigint }): bigint {
  const free = asset.total - asset.reserved;
  if (free < 0n) throw new Error(`the venue reports more reserved (${asset.reserved}) than held (${asset.total})`);
  return free;
}

function assetRow(side: ProtocolVenueSide, a: Reading['assets'][ProtocolVenueSide]): ProtocolVenueAsset {
  return {
    side,
    token: { address: a.token, symbol: a.symbol, decimals: a.decimals },
    total: show(a.total),
    reserved: show(a.reserved),
    free: show(freeOf(a)),
  };
}

/** `protocol.venue.balances`: the account's two venue balances, total, reserved and free, at one block. */
export async function venueBalances(deps: VenueFundsDeps, accountInput: string): Promise<ProtocolVenueBalances> {
  const venue = requireVenue(deps.venue());
  const r = await read(deps.chain(), venue, getAddress(accountInput));
  return {
    venue,
    chainId: r.chainId,
    account: r.account,
    blockNumber: r.blockNumber.toString(),
    assets: [assetRow('base', r.assets.base), assetRow('quote', r.assets.quote)],
  };
}

/**
 * The amount in the venue's 18 decimals, and the same amount in the token's own units (what moves between the wallet and
 * the contract). Refuses zero, and an amount finer than the token's decimals: the contract would revert `BadAmount`.
 */
export function venueAmount(amount: string, tokenDecimals: number): { wad: bigint; units: bigint } {
  const wad = parseUnits(amount, VENUE_DECIMALS);
  if (wad <= 0n) throw new VenueFundsRefusal(VENUE_BAD_AMOUNT, 'the amount must be more than zero.');
  if (tokenDecimals !== 18 && tokenDecimals !== 6)
    throw new VenueFundsRefusal(VENUE_BAD_AMOUNT, `the venue moves only 6- or 18-decimal tokens; this one has ${tokenDecimals}.`);
  const scale = 10n ** BigInt(VENUE_DECIMALS - tokenDecimals);
  if (wad % scale !== 0n)
    throw new VenueFundsRefusal(
      VENUE_BAD_AMOUNT,
      `the token has ${tokenDecimals} decimals, so the amount can have at most ${tokenDecimals}.`,
    );
  return { wad, units: wad / scale };
}

function pair(side: ProtocolVenueSide, wad: bigint): readonly [bigint, bigint] {
  return side === 'base' ? [wad, 0n] : [0n, wad];
}

function label(a: { symbol: string | null; token: Address }): string {
  return a.symbol ?? a.token;
}

/**
 * `protocol.venue.buildDeposit`: the token approval the venue needs to pull the amount (none when the allowance covers
 * it), then `deposit`. Unsigned; nothing is sent.
 */
export async function buildVenueDeposit(deps: VenueFundsDeps, input: ProtocolVenueBuildInput): Promise<ProtocolVenueBuild> {
  const venue = requireVenue(deps.venue());
  const chain = deps.chain();
  const account = getAddress(input.account);
  const r = await read(chain, venue, account);
  const asset = r.assets[input.side];
  const { wad, units } = venueAmount(input.amount, asset.decimals);
  const current = (await chain.readContract({
    address: asset.token,
    abi: TOKEN_ABI,
    functionName: 'allowance',
    args: [account, venue],
    blockNumber: r.blockNumber,
  })) as bigint;
  const directChangeReverts =
    current > 0n && current < units && deps.directApproveReverts
      ? await deps.directApproveReverts(asset.token, account, venue, units)
      : false;
  const approval = planApproval({ token: asset.token, spender: venue, amount: units, current, unlimited: false, directChangeReverts });
  const deposit = {
    to: venue,
    data: encodeFunctionData({ abi: VENUE_FUNDS_ABI, functionName: 'deposit', args: pair(input.side, wad) }),
    value: '0',
    summary: `deposit(${show(wad)} ${label(asset)}) into the venue`,
  };
  return {
    kind: 'deposit',
    venue,
    chainId: r.chainId,
    account,
    side: input.side,
    token: { address: asset.token, symbol: asset.symbol, decimals: asset.decimals },
    amount: show(wad),
    free: show(freeOf(asset)),
    blockNumber: r.blockNumber.toString(),
    calls: [...approval.calls.map((c) => ({ to: c.to, data: c.data, value: c.value, summary: c.summary })), deposit],
  };
}

/**
 * `protocol.venue.buildWithdraw`: `withdraw` for an amount within the free balance. Above it refuses
 * `protocol.venue_insufficient_free`, naming the free amount, before any call is built.
 */
export async function buildVenueWithdraw(deps: VenueFundsDeps, input: ProtocolVenueBuildInput): Promise<ProtocolVenueBuild> {
  const venue = requireVenue(deps.venue());
  const account = getAddress(input.account);
  const r = await read(deps.chain(), venue, account);
  const asset = r.assets[input.side];
  const { wad } = venueAmount(input.amount, asset.decimals);
  const free = freeOf(asset);
  if (wad > free)
    throw new VenueFundsRefusal(
      VENUE_INSUFFICIENT_FREE,
      `${show(wad)} ${label(asset)} is more than is free (${show(free)} free). Funds reserved by open orders can't be withdrawn.`,
    );
  return {
    kind: 'withdraw',
    venue,
    chainId: r.chainId,
    account,
    side: input.side,
    token: { address: asset.token, symbol: asset.symbol, decimals: asset.decimals },
    amount: show(wad),
    free: show(free),
    blockNumber: r.blockNumber.toString(),
    calls: [
      {
        to: venue,
        data: encodeFunctionData({ abi: VENUE_FUNDS_ABI, functionName: 'withdraw', args: pair(input.side, wad) }),
        value: '0',
        summary: `withdraw(${show(wad)} ${label(asset)}) from the venue`,
      },
    ],
  };
}
