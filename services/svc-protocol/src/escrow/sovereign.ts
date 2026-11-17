import { encodeFunctionData, getAddress, parseAbi, parseAbiItem, type Address, type PublicClient } from 'viem';
import {
  ESCROW_AUDIT_EXTERNAL,
  ESCROW_DEAL_NOT_FOUND,
  ESCROW_NOT_DEPLOYED,
  type ProtocolEscrowBuild,
  type ProtocolEscrowBuildInput,
  type ProtocolEscrowDeal,
  type ProtocolEscrowStatus,
} from '@intafaced/contracts';
import { isZeroAddress } from '../chain/availability.js';

/**
 * The sovereign P2P escrow (RC-p2p-01): reads of the SovereignEscrow contract and the unsigned calls a party signs.
 * Pure builders and chain reads: no key, no send, no deal row, no ledger recipe. The address is the owner's setting
 * (`PROTOCOL_P2P_ESCROW_ADDRESS`), never a literal; zero refuses `protocol.escrow_not_deployed`. Builders only ever
 * target that address (or, for `approve`, the token, with the escrow as the only spender).
 */
export class EscrowRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'EscrowRefusal';
  }
}

export const SOVEREIGN_ESCROW_ABI = parseAbi([
  'function open(address buyer, address token, uint128 amount, address arbiter, address feeRecipient, uint16 feeBps, uint32 disputeWindow, uint8 timeoutDisposition) returns (uint256)',
  'function lock(uint256 dealId)',
  'function release(uint256 dealId)',
  'function refund(uint256 dealId)',
  'function dispute(uint256 dealId)',
  'function settleTimeout(uint256 dealId)',
  'function nextDealId() view returns (uint256)',
  'function deals(uint256 dealId) view returns (address seller, address buyer, address token, uint128 amount, address arbiter, address feeRecipient, uint16 feeBps, uint32 disputeWindow, uint64 disputeDeadline, uint8 status, uint8 timeoutDisposition)',
]);
const APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const DEAL_OPENED = parseAbiItem(
  'event DealOpened(uint256 indexed dealId, address indexed seller, address indexed buyer, address token, uint128 amount, address arbiter, uint8 timeoutDisposition, uint32 disputeWindow)',
);

/** SovereignEscrow.Status: 0 None, 1 Open, 2 Locked, 3 Disputed, 4 Released, 5 Refunded. */
const STATES = { 1: 'open', 2: 'locked', 3: 'disputed', 4: 'released', 5: 'refunded' } as const;
const TIMEOUTS = { 0: 'refund_seller', 1: 'release_buyer' } as const;
const MAX_UINT128 = (1n << 128n) - 1n;
const ZERO = '0x0000000000000000000000000000000000000000' as const;

export type EscrowChain = Pick<PublicClient, 'readContract' | 'getBlock' | 'getLogs'>;

export interface EscrowSetting {
  chainId: number;
  /** `PROTOCOL_P2P_ESCROW_ADDRESS`; null or zero: not deployed on this chain. */
  escrow: Address | null;
  /** True unless the owner's network registry names the chain a testnet or local chain. */
  mainnet: boolean;
}

/** Plain words for the configured network. Base Sepolia is never called INTACHAIN. */
export function networkLabel(chainId: number): string {
  return chainId === 84532 ? 'Base Sepolia testnet, not INTACHAIN' : `TEST chain ${chainId}, not INTACHAIN`;
}

function refuseMainnet(setting: EscrowSetting) {
  if (setting.mainnet)
    throw new EscrowRefusal(
      ESCROW_AUDIT_EXTERNAL,
      'the escrow contract has no external audit, so a mainnet deal is switched off in this build; testnet only.',
    );
}

/** The escrow on the configured chain; refuses on mainnet (`audit.external`) and when not deployed. */
export function requireP2pEscrow(setting: EscrowSetting): Address {
  refuseMainnet(setting);
  if (setting.escrow === null || isZeroAddress(setting.escrow))
    throw new EscrowRefusal(
      ESCROW_NOT_DEPLOYED,
      `the P2P escrow contract is not deployed on chain ${setting.chainId} (PROTOCOL_P2P_ESCROW_ADDRESS is unset).`,
    );
  return getAddress(setting.escrow);
}

export function escrowStatus(setting: EscrowSetting): ProtocolEscrowStatus {
  refuseMainnet(setting);
  const deployed = setting.escrow !== null && !isZeroAddress(setting.escrow);
  return {
    testnet: {
      chainId: setting.chainId,
      label: networkLabel(setting.chainId),
      deployed,
      escrow: deployed ? getAddress(setting.escrow!) : null,
      blocker: deployed ? null : ESCROW_NOT_DEPLOYED,
    },
    mainnet: { available: false, blocker: ESCROW_AUDIT_EXTERNAL },
    audited: false,
  };
}

/** One deal at the latest block. An id the contract never opened refuses `protocol.escrow_deal_not_found`. */
export async function readDeal(chain: EscrowChain, setting: EscrowSetting, dealId: string): Promise<ProtocolEscrowDeal> {
  const escrow = requireP2pEscrow(setting);
  const id = BigInt(dealId);
  const block = await chain.getBlock({ blockTag: 'latest' });
  const [seller, buyer, token, held, arbiter, , , disputeWindow, disputeDeadline, status, timeout] = await chain.readContract({
    address: escrow,
    abi: SOVEREIGN_ESCROW_ABI,
    functionName: 'deals',
    args: [id],
    blockNumber: block.number,
  });
  const state = STATES[Number(status) as keyof typeof STATES];
  if (!state) throw new EscrowRefusal(ESCROW_DEAL_NOT_FOUND, `there is no deal ${dealId} in the escrow on this network.`);
  // The contract zeroes a deal's amount once it pays out, so the amount it was opened for comes from its own event.
  const opened = await chain.getLogs({ address: escrow, event: DEAL_OPENED, args: { dealId: id }, fromBlock: 0n, toBlock: block.number });
  const amount = opened[0]?.args.amount;
  if (amount === undefined) throw new EscrowRefusal(ESCROW_DEAL_NOT_FOUND, `deal ${dealId} has no DealOpened event on this network.`);
  return {
    dealId,
    chainId: setting.chainId,
    escrow,
    seller: getAddress(seller),
    buyer: getAddress(buyer),
    token: getAddress(token),
    amount: amount.toString(),
    held: held.toString(),
    arbiter: isZeroAddress(arbiter) ? null : getAddress(arbiter),
    disputeWindowSeconds: Number(disputeWindow),
    disputeDeadline: Number(disputeDeadline) === 0 ? null : Number(disputeDeadline),
    timeout: TIMEOUTS[Number(timeout) as keyof typeof TIMEOUTS] ?? 'refund_seller',
    state,
    chainTime: Number(block.timestamp),
    audited: false,
  };
}

/**
 * One unsigned call. `open` names no arbiter and no fee: the platform has no role in the deal, and a dispute settles
 * after its window by the disposition fixed here. An amount past uint128 refuses `protocol.escrow_amount_invalid`
 * (the schema already refuses zero, signs and decimal points).
 */
export function buildEscrowCall(setting: EscrowSetting, input: ProtocolEscrowBuildInput): ProtocolEscrowBuild {
  const escrow = requireP2pEscrow(setting);
  const base = { chainId: setting.chainId, value: '0' as const };
  if (input.action === 'open' || input.action === 'approve') {
    const amount = BigInt(input.amount);
    if (amount > MAX_UINT128)
      throw new EscrowRefusal('protocol.escrow_amount_invalid', 'the amount is larger than the escrow can hold for one deal.');
    const token = getAddress(input.token);
    if (input.action === 'approve')
      return {
        ...base,
        to: token,
        data: encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [escrow, amount] }),
        summary: `approve escrow=${escrow} token=${token} amount=${amount}`,
      };
    const buyer = getAddress(input.buyer);
    return {
      ...base,
      to: escrow,
      data: encodeFunctionData({
        abi: SOVEREIGN_ESCROW_ABI,
        functionName: 'open',
        args: [buyer, token, amount, ZERO, ZERO, 0, input.disputeWindowSeconds, input.timeout === 'release_buyer' ? 1 : 0],
      }),
      summary: `open escrow deal buyer=${buyer} token=${token} amount=${amount} window=${input.disputeWindowSeconds}s timeout=${input.timeout}`,
    };
  }
  const dealId = BigInt(input.dealId);
  return {
    ...base,
    to: escrow,
    data: encodeFunctionData({ abi: SOVEREIGN_ESCROW_ABI, functionName: input.action, args: [dealId] }),
    summary: `${input.action} escrow deal ${dealId}`,
  };
}
