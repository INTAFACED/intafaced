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

  // Every withdrawal post names its withdrawal three ways, and they agree: the hold it moves (`withdraw:<id>`), its key and its
  // meta. The hold is then found by that id, so a post cannot point its fee check at another withdrawal's hold.
  const holdLeg = input.entries.find((e) => e.account.ownerType === 'user' && e.account.kind === 'hold');
  const purpose = holdLeg?.account.purpose ?? '';
  if (!purpose.startsWith('withdraw:')) refuse('it moves no withdrawal hold');
  const withdrawalId = purpose.slice('withdraw:'.length);
  const step = { 'withdraw.held': 'hold', 'withdraw.settled': 'settle', 'withdraw.reversed': 'reverse' }[input.reason];
  if (!withdrawalId || input.idempotencyKey !== `withdraw.${step}:${withdrawalId}` || input.meta?.withdrawalId !== withdrawalId) {
    refuse('its key, its meta and the hold it moves do not name one withdrawal');
  }
  if (input.reason === 'withdraw.held') {
    // The ledger replays a repeated key by its entries, never its meta, so a retried hold whose fee differs from the posted one
    // (26.5 held with no fee, then 25 + 1.5) would replay as a success while the book keeps the first meta. Refuse it instead.
    const posted = await ledger.getTxByKey(input.idempotencyKey);
    if (posted && posted.reason === 'withdraw.held' && feeOf(posted.meta) !== fee) {
      refuse('a hold under this key is already posted with another fee');
    }
    return;
  }
  const hold = await ledger.getTxByKey(`withdraw.hold:${withdrawalId}`);
  const heldFee = hold && hold.module === 'ledger' && hold.reason === 'withdraw.held' ? feeOf(hold.meta) : null;
  if (fee !== heldFee) refuse(heldFee === null ? 'its hold carried no fee' : 'it does not carry the fee its hold carried');
  if (heldFee === null || !hold) return;
  // A fee-carrying hold is settled or reversed whole: amount and fee together, never a part.
  const held = hold.entries.find((e) => e.direction === 'debit')?.amount;
  const drawn = input.entries.find((e) => e.direction === 'credit');
  if (held === undefined || !drawn || parseAmount(drawn.amount) !== held) refuse('it does not draw the whole fee-carrying hold');
  // A reverse gives the hold back to the person whose hold it is, and a settle sends it on the rail it was held for.
  if (input.reason === 'withdraw.reversed') {
    const back = input.entries.find((e) => e.direction === 'debit');
    if (back?.account.ownerType !== 'user' || back.account.kind !== 'available' || back.account.ownerId !== holdLeg?.account.ownerId) {
      refuse('it gives the hold back to someone other than its owner');
    }
  } else {
    const railLeg = input.entries.find((e) => e.direction === 'debit' && e.account.ownerType === 'treasury');
    if (input.meta?.rail !== hold.meta.rail || railLeg?.account.ownerId !== `rail:${String(hold.meta.rail)}`) {
      refuse('it sends on another rail than its hold');
    }
  }
}
