/**
 * A withdrawal's quoted network fee is bound to its posted hold (J-wallet-05 #6, issue #6517).
 *
 * `withdrawHold`, `withdrawSettle` and `withdrawReverse` take an optional fee: the hold is the amount plus the fee, the settle
 * sends the amount to the rail and the fee to houseFees(pay), and a reverse returns both. The recipe gate knows these posts by
 * shape only, so on its own a settle could name a fee its hold never carried (the settle then fails after the rail sent, or
 * strands part of the hold) or move a hold into the fee pot in any split. Here the door reads the posted
 * `withdraw.hold:<withdrawalId>` and lets a settle or reverse through only when it carries exactly that hold's fee (`meta.fee`,
 * or none for both), its fee leg is that fee, and, for a fee-carrying hold, it draws the whole hold (no part settle). A fee is
 * svc-pay's alone: a verified caller other than svc-pay is refused a withdrawal post that carries one. Anything else refuses
 * before anything posts.
 */
import { LedgerError, parseAmount, type Amount, type LedgerTx } from '@intafaced/ledger-client';
import type { PostCaller } from './caller-binding.js';

export const WITHDRAW_FEE_UNBOUND_CODE = 'ledger.withdraw_fee_unbound';
const FEE_REASONS = new Set(['withdraw.held', 'withdraw.settled', 'withdraw.reversed']);

interface WireFeePost {
  readonly idempotencyKey: string;
  readonly module: string;
  readonly reason: string;
  readonly entries: readonly {
    readonly account: { ownerType: string; ownerId?: string; kind: string; purpose?: string };
    readonly direction: string;
    readonly amount: string;
  }[];
  readonly meta?: Record<string, unknown>;
}

export interface FeeHoldReader {
  getTxByKey(idempotencyKey: string): Promise<LedgerTx | null>;
}

function refuse(why: string): never {
  throw new LedgerError(`A withdrawal fee must match its posted hold: ${why}`, WITHDRAW_FEE_UNBOUND_CODE);
}

/** `meta.fee` as an amount, null when absent. A present fee that is not an amount above zero is refused. */
function feeOf(meta: Record<string, unknown> | undefined): Amount | null {
  const raw = meta?.fee;
  if (raw === undefined) return null;
  if (typeof raw !== 'string') refuse('meta.fee is not a decimal string');
  let fee: Amount;
  try {
    fee = parseAmount(raw);
  } catch {
    refuse('meta.fee is not a decimal string');
  }
  if (fee <= 0n) refuse('meta.fee is not above zero');
  return fee;
}

const isFeePot = (account: WireFeePost['entries'][number]['account']) =>
  account.ownerType === 'house' && (account.ownerId ?? '').startsWith('fees:');

export async function assertWithdrawFeeBound(ledger: FeeHoldReader, input: WireFeePost, caller?: PostCaller): Promise<void> {
  if (input.module !== 'ledger' || !FEE_REASONS.has(input.reason)) return;
  const fee = feeOf(input.meta);
  const feeLegs = input.entries.filter((e) => e.direction === 'debit' && isFeePot(e.account));
  if (fee === null ? feeLegs.length > 0 : feeLegs.length !== (input.reason === 'withdraw.settled' ? 1 : 0)) {
    refuse('the fee leg is not the fee the post names');
  }
  if (fee !== null && feeLegs[0] && parseAmount(feeLegs[0].amount) !== fee) refuse('the fee leg is not the fee the post names');
  if (fee !== null && caller?.kind === 'bound' && caller.service !== 'svc-pay') refuse('only svc-pay posts a withdrawal fee');

  const withdrawalId = typeof input.meta?.withdrawalId === 'string' ? input.meta.withdrawalId : '';
  if (fee !== null) {
    // A fee-carrying post names its own withdrawal three ways, and they agree: its key, its meta and the hold it moves.
    const step = { 'withdraw.held': 'hold', 'withdraw.settled': 'settle', 'withdraw.reversed': 'reverse' }[input.reason];
    if (!withdrawalId || input.idempotencyKey !== `withdraw.${step}:${withdrawalId}`) refuse('the key does not name its withdrawal');
    const holdLeg = input.entries.find((e) => e.account.ownerType === 'user' && e.account.kind === 'hold');
    if (holdLeg?.account.purpose !== `withdraw:${withdrawalId}`) refuse('it does not move the hold of the withdrawal it names');
  }
  if (input.reason === 'withdraw.held') return;
  const hold = withdrawalId ? await ledger.getTxByKey(`withdraw.hold:${withdrawalId}`) : null;
  const heldFee = hold && hold.module === 'ledger' && hold.reason === 'withdraw.held' ? feeOf(hold.meta) : null;
  if (fee !== heldFee) refuse(heldFee === null ? 'its hold carried no fee' : 'it does not carry the fee its hold carried');
  if (heldFee === null || !hold) return;
  // A fee-carrying hold is settled or reversed whole: amount and fee together, never a part.
  const held = hold.entries.find((e) => e.direction === 'debit')?.amount;
  const drawn = input.entries.find((e) => e.direction === 'credit');
  if (held === undefined || !drawn || parseAmount(drawn.amount) !== held) refuse('it does not draw the whole fee-carrying hold');
}
