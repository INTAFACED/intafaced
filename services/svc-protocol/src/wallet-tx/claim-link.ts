import { getAddress, parseAbi, parseAbiItem, type Address, type PublicClient } from 'viem';
import { CLAIM_ESCROW_UNSET, CLAIM_LINK_NOT_FOUND, type ProtocolClaimLink, type ProtocolClaimLinkConfig } from '@intafaced/contracts';
import { isZeroAddress } from '../chain/availability.js';

/**
 * Claim links (D-swap-12), read from the ClaimLinkEscrow contract. This service only reads: the sender's wallet locks
 * and claws back, the claimer's wallet claims. The link key is made and used in the browser and never reaches here; the
 * only thing about a link this service ever sees is its id, the key's address, which is public on chain anyway.
 */
export class WalletTxRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'WalletTxRefusal';
  }
}

export const CLAIM_ESCROW_ABI = parseAbi([
  'function minExpirySeconds() view returns (uint64)',
  'function maxExpirySeconds() view returns (uint64)',
  'function links(address id) view returns (address sender, address token, uint256 amount, uint64 expiresAt, uint8 state)',
  'function openAmount(address token) view returns (uint256)',
  'function claimDigest(address id, address to) view returns (bytes32)',
  'function create(address token, uint256 amount, address id, uint64 lifetime)',
  'function claim(address id, address to, bytes signature)',
  'function clawback(address id)',
]);
const CREATED = parseAbiItem(
  'event Created(address indexed id, address indexed sender, address indexed token, uint256 amount, uint64 expiresAt)',
);
const CLAIMED = parseAbiItem('event Claimed(address indexed id, address indexed to, uint256 amount)');
const TOKEN_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

/** The escrow's on-chain states (ClaimLinkEscrow: 1 open, 2 claimed, 3 clawed back). */
const STATES = { 1: 'open', 2: 'claimed', 3: 'clawed_back' } as const;

export type ClaimChain = Pick<PublicClient, 'readContract' | 'getBlock' | 'getLogs' | 'getChainId'>;

/** `PROTOCOL_CLAIM_ESCROW_ADDRESS`; zero refuses `protocol.claim_escrow_unset` before any chain read. */
export function requireEscrow(escrow: Address | null): Address {
  if (escrow === null || isZeroAddress(escrow))
    throw new WalletTxRefusal(
      CLAIM_ESCROW_UNSET,
      'claim links need the claim-link escrow, an owner setting (PROTOCOL_CLAIM_ESCROW_ADDRESS); nothing can be sent by link until it is set.',
    );
  return escrow;
}

/** The escrow and its expiry bounds, read from the contract (immutable there, so nobody can change them later). */
export async function claimLinkConfig(chain: ClaimChain, escrow: Address): Promise<ProtocolClaimLinkConfig> {
  const [min, max, chainId] = await Promise.all([
    chain.readContract({ address: escrow, abi: CLAIM_ESCROW_ABI, functionName: 'minExpirySeconds' }),
    chain.readContract({ address: escrow, abi: CLAIM_ESCROW_ABI, functionName: 'maxExpirySeconds' }),
    chain.getChainId(),
  ]);
  return { escrow: getAddress(escrow), chainId, minExpirySeconds: Number(min), maxExpirySeconds: Number(max) };
}

async function tokenFacts(chain: ClaimChain, token: Address, blockNumber: bigint) {
  const read = <T>(functionName: 'name' | 'symbol' | 'decimals') =>
    chain.readContract({ address: token, abi: TOKEN_ABI, functionName, blockNumber }).then(
      (value) => value as T,
      () => null,
    );
  const [name, symbol, decimals] = await Promise.all([read<string>('name'), read<string>('symbol'), read<number>('decimals')]);
  return {
    address: getAddress(token),
    name,
    symbol,
    decimals: decimals !== null && Number(decimals) <= 36 ? Number(decimals) : null,
  };
}

/** The state a person sees: an open link whose expiry the chain's clock has reached is `expired`. */
export function linkState(onChain: number, expiresAt: number, chainTime: number): ProtocolClaimLink['state'] | null {
  const state = STATES[onChain as keyof typeof STATES];
  if (!state) return null;
  return state === 'open' && chainTime >= expiresAt ? 'expired' : state;
}

async function readLink(chain: ClaimChain, escrow: Address, id: Address, block: { number: bigint; timestamp: bigint }) {
  const [sender, token, amount, expiresAt, onChain] = await chain.readContract({
    address: escrow,
    abi: CLAIM_ESCROW_ABI,
    functionName: 'links',
    args: [id],
    blockNumber: block.number,
  });
  const state = linkState(Number(onChain), Number(expiresAt), Number(block.timestamp));
  if (state === null) return null;
  let claimedBy: Address | null = null;
  if (state === 'claimed') {
    const logs = await chain.getLogs({ address: escrow, event: CLAIMED, args: { id }, fromBlock: 0n, toBlock: block.number });
    claimedBy = logs[0]?.args.to ? getAddress(logs[0].args.to) : null;
  }
  return {
    id: getAddress(id),
    sender: getAddress(sender),
    token: await tokenFacts(chain, token, block.number),
    amount: amount.toString(),
    expiresAt: Number(expiresAt),
    state,
    claimedBy,
  } satisfies ProtocolClaimLink;
}

/** One link at the latest block; an id the escrow never saw refuses `protocol.claim_link_not_found`. */
export async function getClaimLink(chain: ClaimChain, escrow: Address, id: Address) {
  const block = await chain.getBlock({ blockTag: 'latest' });
  const link = await readLink(chain, escrow, id, { number: block.number, timestamp: block.timestamp });
  if (!link) throw new WalletTxRefusal(CLAIM_LINK_NOT_FOUND, 'there is no claim link with this id on this network.');
  return { link, chainTime: Number(block.timestamp) };
}

/** Every link `sender` created, newest first, each read at one block. */
export async function listClaimLinks(chain: ClaimChain, escrow: Address, sender: Address) {
  const block = await chain.getBlock({ blockTag: 'latest' });
  const logs = await chain.getLogs({ address: escrow, event: CREATED, args: { sender }, fromBlock: 0n, toBlock: block.number });
  const ids = [...new Set(logs.map((log) => log.args.id).filter((id): id is Address => Boolean(id)))].reverse();
  const at = { number: block.number, timestamp: block.timestamp };
  const links = (await Promise.all(ids.map((id) => readLink(chain, escrow, id, at)))).filter((link) => link !== null);
  return { links, chainTime: Number(block.timestamp) };
}
