/**
 * A returned withdrawal is booked only against the settle it returns (W-withdraw-07).
 *
 * The recipe gate knows a post by its shape, and the shape of `withdraw.returned` (rail boundary to a person's available
 * balance) is the shape of a deposit: on its own it would let a caller credit anyone any amount. Here the door reads the
 * posted `withdraw.settle:<withdrawalId>` and lets the return through only when it goes back to the person whose hold that
 * settle drew on, in that asset, from the rail boundary it was sent to, and for no more than it sent. The key is the
 * settle's own id, so one attempt comes back once. Anything else refuses before anything posts.
 */
import { LedgerError, parseAmount, withdrawalHoldAccount, type AccountRef, type Balance, type LedgerTx } from '@intafaced/ledger-client';

export const WITHDRAW_RETURN_UNBOUND_CODE = 'ledger.withdraw_return_unbound';
export const WITHDRAW_RETURN_REASON = 'withdraw.returned';

interface WireReturnPost {
  readonly idempotencyKey: string;
  readonly module: string;
  readonly reason: string;
  readonly entries: readonly {
    readonly account: { ownerType: string; ownerId?: string; assetId: string; kind: string; purpose?: string };
    readonly direction: string;
    readonly amount: string;
  }[];
  readonly meta?: Record<string, unknown>;
}

export interface ReturnSettleReader {
  getTxByKey(idempotencyKey: string): Promise<LedgerTx | null>;
  balance(ref: AccountRef): Promise<Balance>;
}

function refuse(why: string): never {
  throw new LedgerError(`A returned withdrawal must match its posted settle: ${why}`, WITHDRAW_RETURN_UNBOUND_CODE);
}

export async function assertWithdrawReturnBound(ledger: ReturnSettleReader, input: WireReturnPost): Promise<void> {
  if (input.reason !== WITHDRAW_RETURN_REASON) return;
  if (input.module !== 'ledger') refuse('not the ledger module');
  const meta = input.meta ?? {};
  const withdrawalId = typeof meta.withdrawalId === 'string' ? meta.withdrawalId : '';
  if (!withdrawalId || input.idempotencyKey !== `${WITHDRAW_RETURN_REASON}:${withdrawalId}`) refuse('the key does not name its withdrawal');

  const boundary = input.entries.find((e) => e.account.ownerType === 'treasury' && e.direction === 'credit');
  const person = input.entries.find((e) => e.account.ownerType === 'user' && e.direction === 'debit');
  if (input.entries.length !== 2 || !boundary || !person) refuse('not the return shape');
  const assetId = boundary.account.assetId;
  const userId = person.account.ownerId ?? '';
  if (person.account.assetId !== assetId || !userId) refuse('the person is credited in another asset');
  const amount = parseAmount(boundary.amount);

  const settle = await ledger.getTxByKey(`withdraw.settle:${withdrawalId}`);
  if (!settle || settle.module !== 'ledger' || settle.reason !== 'withdraw.settled') refuse('no posted settle');
  if (settle.meta.rail !== meta.rail) refuse('another rail');

  const [hold, rail] = await Promise.all([
    ledger.balance(withdrawalHoldAccount(userId, assetId, withdrawalId)),
    ledger.balance(boundary.account as AccountRef),
  ]);
  const holdId = hold.accountId;
  const drawn = holdId ? settle.entries.find((e) => e.accountId === holdId && e.direction === 'credit') : undefined;
  if (!drawn) refuse('that settle did not draw on this person’s hold in this asset');
  const boundaryId = rail.accountId;
  const sent = boundaryId ? settle.entries.find((e) => e.accountId === boundaryId && e.direction === 'debit') : undefined;
  if (!sent) refuse('that settle was not sent to this rail boundary');

  if (amount > drawn.amount) refuse('more than the settle sent');
}
