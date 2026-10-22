import { encodeFunctionData, getAddress, isAddress, parseUnits, type Address, type Hex } from 'viem';
import { sovereignEscrowAbi } from './abi.js';

/**
 * RC-p2p-01 (svc-protocol half, builders only): unsigned calls on the deployed
 * `SovereignEscrow` contract, in the shape of `src/amm/build.ts`. These never
 * sign and never send, never touch a ledger recipe, and never choose a value:
 * the escrow address comes from the caller (the deployments registry for the
 * configured chain), and arbiter, fee and dispute window are owner values that
 * must be passed in — a blank one refuses with `EscrowBuildError`.
 */

export interface UnsignedEscrowCall {
  to: Address;
  data: Hex;
  value: '0';
  summary: string;
}

export type EscrowBuildErrorCode =
  | 'protocol.escrow_address_invalid'
  | 'protocol.escrow_amount_invalid'
  | 'protocol.escrow_fee_invalid'
  | 'protocol.escrow_window_invalid'
  | 'protocol.escrow_deal_id_invalid'
  | 'protocol.escrow_deal_ref_required'
  | 'protocol.escrow_parties_invalid';

export class EscrowBuildError extends Error {
  constructor(
    readonly code: EscrowBuildErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EscrowBuildError';
  }
}

const TIMEOUT_DISPOSITION = { refund_seller: 0, release_buyer: 1 } as const;
export type EscrowTimeoutDisposition = keyof typeof TIMEOUT_DISPOSITION;

const UINT128_MAX = (1n << 128n) - 1n;
const ZERO = '0x0000000000000000000000000000000000000000';

function addr(name: string, value: unknown, allowZero = false): Address {
  if (typeof value !== 'string' || !isAddress(value)) throw new EscrowBuildError('protocol.escrow_address_invalid', `${name} is not an address`);
  const a = getAddress(value);
  if (!allowZero && a === ZERO) throw new EscrowBuildError('protocol.escrow_address_invalid', `${name} is the zero address`);
  return a;
}

function dealIdOf(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,76})$/.test(value))
    throw new EscrowBuildError('protocol.escrow_deal_id_invalid', 'deal id is a non-negative integer string');
  return BigInt(value);
}

export interface BuildOpenInput {
  escrow: string;
  seller: string;
  buyer: string;
  token: string;
  /** Decimal string in token units, e.g. "12.5". Never a JS number. */
  amount: string;
  tokenDecimals: number;
  arbiter: string;
  feeRecipient: string | null;
  feeBps: number;
  disputeWindowSeconds: number;
  timeoutDisposition: EscrowTimeoutDisposition;
  /** The P2P trade id. Not stored on chain; carried so the caller can match the DealOpened event to its trade. */
  dealRef: string;
}

export interface BuildOpenResult {
  call: UnsignedEscrowCall;
  /** The DealOpened fields the caller should see once the seller's transaction lands. */
  expectedDealOpened: {
    seller: Address;
    buyer: Address;
    token: Address;
    amount: string;
    arbiter: Address;
    timeoutDisposition: EscrowTimeoutDisposition;
    disputeWindow: number;
    dealRef: string;
  };
}

/** `open(...)`, sent by the seller. Mirrors the contract's own refusals so a doomed call is never built. */
export function buildOpen(input: BuildOpenInput): BuildOpenResult {
  const escrow = addr('escrow', input.escrow);
  const seller = addr('seller', input.seller);
  const buyer = addr('buyer', input.buyer);
  if (buyer === seller) throw new EscrowBuildError('protocol.escrow_parties_invalid', 'buyer and seller must differ');
  const token = addr('token', input.token);
  const arbiter = addr('arbiter', input.arbiter);
  if (typeof input.dealRef !== 'string' || input.dealRef.trim() === '')
    throw new EscrowBuildError('protocol.escrow_deal_ref_required', 'dealRef (the P2P trade id) is required');
  if (!Number.isInteger(input.tokenDecimals) || input.tokenDecimals < 0 || input.tokenDecimals > 36) {
    throw new EscrowBuildError('protocol.escrow_amount_invalid', 'token decimals must be an integer 0..36');
  }
  if (typeof input.amount !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/.test(input.amount)) {
    throw new EscrowBuildError('protocol.escrow_amount_invalid', 'amount is a decimal string');
  }
  const frac = input.amount.split('.')[1] ?? '';
  if (frac.length > input.tokenDecimals) throw new EscrowBuildError('protocol.escrow_amount_invalid', 'amount has more decimals than the token');
  const base = parseUnits(input.amount, input.tokenDecimals);
  if (base <= 0n || base > UINT128_MAX) throw new EscrowBuildError('protocol.escrow_amount_invalid', 'amount must be positive and fit uint128');
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > 10_000)
    throw new EscrowBuildError('protocol.escrow_fee_invalid', 'feeBps is an integer 0..10000');
  const feeRecipient = input.feeRecipient === null ? (ZERO as Address) : addr('feeRecipient', input.feeRecipient);
  if (input.feeBps > 0 && feeRecipient === ZERO) throw new EscrowBuildError('protocol.escrow_fee_invalid', 'a fee needs a fee recipient');
  if (!Number.isInteger(input.disputeWindowSeconds) || input.disputeWindowSeconds <= 0 || input.disputeWindowSeconds > 0xffffffff) {
    throw new EscrowBuildError('protocol.escrow_window_invalid', 'dispute window is a positive uint32 of seconds');
  }
  if (!(input.timeoutDisposition in TIMEOUT_DISPOSITION))
    throw new EscrowBuildError('protocol.escrow_parties_invalid', 'unknown timeout disposition');
  const data = encodeFunctionData({
    abi: sovereignEscrowAbi,
    functionName: 'open',
    args: [
      buyer,
      token,
      base,
      arbiter,
      feeRecipient,
      input.feeBps,
      input.disputeWindowSeconds,
      TIMEOUT_DISPOSITION[input.timeoutDisposition],
    ],
  });
  return {
    call: {
      to: escrow,
      data,
      value: '0',
      summary: `escrow open buyer=${buyer} token=${token} amount=${input.amount} ref=${input.dealRef.trim()}`,
    },
    expectedDealOpened: {
      seller,
      buyer,
      token,
      amount: base.toString(),
      arbiter,
      timeoutDisposition: input.timeoutDisposition,
      disputeWindow: input.disputeWindowSeconds,
      dealRef: input.dealRef.trim(),
    },
  };
}

type DealAction = 'lock' | 'release' | 'refund' | 'dispute' | 'settleTimeout';

function buildDealCall(action: DealAction, escrowAddress: string, dealId: string): UnsignedEscrowCall {
  const escrow = addr('escrow', escrowAddress);
  const id = dealIdOf(dealId);
  return {
    to: escrow,
    data: encodeFunctionData({ abi: sovereignEscrowAbi, functionName: action, args: [id] }),
    value: '0',
    summary: `escrow ${action} deal=${id.toString()}`,
  };
}

/** Seller pulls the amount into the contract (after approving the escrow for the token). */
export const buildLock = (escrow: string, dealId: string) => buildDealCall('lock', escrow, dealId);
/** Seller releases to the buyer. */
export const buildRelease = (escrow: string, dealId: string) => buildDealCall('release', escrow, dealId);
/** Buyer refunds the seller. */
export const buildRefund = (escrow: string, dealId: string) => buildDealCall('refund', escrow, dealId);
/** Either party opens a dispute. */
export const buildDispute = (escrow: string, dealId: string) => buildDealCall('dispute', escrow, dealId);
/** Anyone, after the dispute window. */
export const buildSettleTimeout = (escrow: string, dealId: string) => buildDealCall('settleTimeout', escrow, dealId);
