import { t as copyText } from './copy';
import { BANK_SPACES_LIST, type BankSpace } from '@intafaced/contracts/bank-spaces-list';
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { decimalSchema, parseAmount } from '../../shared/money';
import { transferDepthCopy } from './transfer-depth-copy';
import { cleanText, messageEchoed, noteProblem, referenceProblem } from './transfer-message';

/**
 * Money's check over each row of `bank` `spaces.list` (the record in `@intafaced/contracts/bank-spaces-list`): a ledger
 * space is a view of its own available account in its own asset; a space with no ledger account is one the partner holds.
 */
function spaceAccepted(space: BankSpace): boolean {
  return space.ledgerAccount
    ? space.assetId === space.ledgerAccount.assetId && space.ledgerAccount.kind === 'available'
    : Boolean(space.heldAt);
}
/** Every space of the person, read by the record and checked row by row. */
export function readSpaces(api: ApiClient, limit: number, signal?: AbortSignal) {
  return api.call(BANK_SPACES_LIST, { limit }, { signal, accept: (rows) => rows.every(spaceAccepted) });
}
export type Space = BankSpace;
export type Holding = { assetId: string; available: string; held: string | null; quantity: string | null };
const balanceEntry = z
  .object({ free: decimalSchema, used: decimalSchema, total: decimalSchema })
  .refine(
    (row) => parseAmount(row.free) + parseAmount(row.used) === parseAmount(row.total),
    copyText('client.available.and.restricted.must.match.the.scoped'),
  );
const balancesSchema = z.object({
  timestamp: z.number().int(),
  datetime: z.string().datetime({ offset: true }),
  balances: z.record(z.string(), balanceEntry),
});
const unnamedSchema = z.array(z.object({ assetId: z.string(), balance: decimalSchema }));
export type TransferDraft = {
  transferId: string;
  fromSpaceId: string;
  toSpaceId?: string;
  toUserId?: string;
  amount: string;
  /** Plain text the recipient can read. Left out when the customer wrote none. */
  note?: string;
  /** A printable payment reference. Left out when the customer wrote none. */
  reference?: string;
  /** The single-use step-up approval for this exact send to a person (J-bank-04 #4). */
  stepUpApprovalId?: string;
};
/**
 * An amount above the source's balance is always refused with the plain message (J-wallet-07 #2 reads it by name);
 * `overBalance` adds what follows it, the shortfall and the plan's rule (J-bank-02 #8), and adds nothing when it has
 * nothing to say.
 */
export function validateTransfer(
  spaces: Space[],
  input: TransferDraft,
  overBalance?: (from: Space, amount: string) => string | null,
): string | null {
  const from = spaces.find((space) => space.id === input.fromSpaceId);
  if (!from) return copyText('client.choose.one.of.your.available.spaces');
  if (from.lockedUntil && Date.parse(from.lockedUntil) > Date.now()) return copyText('client.this.space.is.locked.choose.an.unlocked');
  const amount = decimalSchema.safeParse(input.amount);
  if (!amount.success || parseAmount(amount.data) <= 0n) return copyText('client.enter.an.exact.amount.greater.than.zero');
  if (parseAmount(input.amount) > parseAmount(from.balance)) {
    const plain = copyText('client.the.amount.exceeds.the.available.quantity.in');
    const more = overBalance?.(from, input.amount);
    return more ? `${plain} ${more}` : plain;
  }
  if (input.toSpaceId) {
    if (input.toSpaceId === from.id) return copyText('client.choose.a.different.destination.space');
    const destination = spaces.find((space) => space.id === input.toSpaceId);
    if (destination && destination.assetId !== from.assetId) return copyText('client.both.spaces.must.use.the.same.asset');
    if (!z.string().guid().safeParse(input.toSpaceId).success) return copyText('client.enter.a.valid.destination.space.id');
  } else if (!input.toUserId?.trim()) return copyText('client.enter.the.recipient.user.id');
  const note = noteProblem(input.note);
  if (note) return transferDepthCopy.t(note === 'tooLong' ? 'noteTooLong' : 'noteControl');
  const reference = referenceProblem(input.reference);
  if (reference) return transferDepthCopy.t(reference === 'tooLong' ? 'referenceTooLong' : 'referenceCharacters');
  if (!z.string().guid().safeParse(input.fromSpaceId).success) return copyText('client.choose.a.valid.source.space');
  return null;
}
export function createMoneyClient(api: ApiClient) {
  return {
    spaces(limit: number, signal?: AbortSignal) {
      return readSpaces(api, limit, signal);
    },
    balances(signal?: AbortSignal) {
      return api.rest('/account/balance', balancesSchema, { signal });
    },
    async overview(ownerId: string, limit: number, signal?: AbortSignal) {
      const [balances, spaces, unnamed] = await Promise.all([
        this.balances(signal),
        this.spaces(limit, signal),
        api.query('bank', 'spaces.unnamed', undefined, unnamedSchema, { signal }),
      ]);
      const projection = new Map<string, string>();
      const conflicts = new Set<string>();
      for (const space of spaces.ok ? spaces.data : []) {
        if (space.kind !== 'primary') continue;
        // Partner-held money has no ledger account to check; the schema has already required the partner's label.
        if (space.ledgerAccount && (space.ledgerAccount.ownerType !== 'user' || space.ledgerAccount.ownerId !== ownerId)) {
          conflicts.add(space.assetId);
          continue;
        }
        const old = projection.get(space.assetId);
        if (old !== undefined && parseAmount(old) !== parseAmount(space.balance)) conflicts.add(space.assetId);
        projection.set(space.assetId, space.balance);
      }
      for (const row of unnamed.ok ? unnamed.data : []) {
        const old = projection.get(row.assetId);
        if (old !== undefined && parseAmount(old) !== parseAmount(row.balance)) conflicts.add(row.assetId);
        else projection.set(row.assetId, row.balance);
      }
      const holdings: Holding[] = balances.ok
        ? Object.entries(balances.data.balances).map(([assetId, row]) => ({
            assetId,
            available: row.free,
            held: row.used,
            quantity: row.total,
          }))
        : [...projection]
            .filter(([assetId]) => !conflicts.has(assetId))
            .map(([assetId, available]) => ({ assetId, available, held: null, quantity: null }));
      return { coverage: 'partial' as const, balances, spaces, unnamed, holdings, conflicts: [...conflicts] };
    },
    transfer(spaces: Space[], input: TransferDraft): Promise<ApiResult<TransferOutcome>> {
      const message = validateTransfer(spaces, input);
      if (message) return Promise.resolve({ ok: false, reason: 'error', code: 'money.invalid_transfer', message });
      // Only a field the customer wrote goes on the wire, trimmed exactly as the service trims it.
      const { note, reference, ...rest } = input;
      const body = {
        ...rest,
        ...(cleanText(note) ? { note: cleanText(note) } : {}),
        ...(cleanText(reference) ? { reference: cleanText(reference) } : {}),
      };
      const toPerson = !input.toSpaceId;
      return api.mutate(
        'bank',
        toPerson ? 'transfers.toUser' : 'transfers.create',
        body,
        z
          .object({
            // A move the partner bank holds the money for (OWNER 226), between the person's own spaces or to another
            // person (J-bank-04 #4), is one partner move and posts nothing to the ledger: its reply names the partner's
            // move and no ledger transaction.
            ledgerTxId: z.string().min(1).nullable(),
            partnerMove: z
              .object({ id: z.string().min(1), label: z.string().min(1), movedAt: z.string().optional() })
              .nullable()
              .optional(),
            amount: decimalSchema.refine(
              (amount) => parseAmount(amount) === parseAmount(input.amount),
              copyText('client.the.settled.amount.must.match.the.review'),
            ),
            note: z.string().nullable().optional(),
            reference: z.string().nullable().optional(),
          })
          // Exactly one book made the move: the ledger's transaction, or the partner's move.
          .refine((data) => (data.ledgerTxId === null) === (data.partnerMove != null), {
            message: copyText('client.transfer.names.one.book'),
          })
          // A send to a person echoes what it stored. The reply must be the note and reference that were reviewed.
          .refine((data) => !toPerson || (data.note !== undefined && data.reference !== undefined && messageEchoed(data, body)), {
            message: transferDepthCopy.t('echoMismatch'),
          })
          .transform(({ ledgerTxId, partnerMove, ...rest }): TransferOutcome =>
            ledgerTxId !== null
              ? { ledgerTxId, ...rest }
              : {
                  ...rest,
                  partnerMoveId: partnerMove!.id,
                  heldBy: partnerMove!.label,
                  ledgerPosting: copyText('client.partner.move.posts.nothing'),
                },
          ),
      );
    },
  };
}
/** What a confirmed transfer settled to: the ledger's transaction, or the partner bank's one move with nothing posted. */
export type TransferOutcome = { amount: string; note?: string | null; reference?: string | null } & (
  { ledgerTxId: string } | { partnerMoveId: string; heldBy: string; ledgerPosting: string }
);
export type MoneyOverview = Awaited<ReturnType<ReturnType<typeof createMoneyClient>['overview']>>;
