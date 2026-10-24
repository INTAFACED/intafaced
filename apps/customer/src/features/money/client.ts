import { t as copyText } from './copy';
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { decimalSchema, parseAmount } from '../../shared/money';
import { transferDepthCopy } from './transfer-depth-copy';
import { cleanText, messageEchoed, noteProblem, referenceProblem } from './transfer-message';

export const spaceSchema = z
  .object({
    id: z.string(),
    assetId: z.string(),
    kind: z.enum(['primary', 'named']),
    name: z.string(),
    goalTarget: decimalSchema.nullable(),
    lockedUntil: z.string().datetime({ offset: true }).nullable(),
    /** An early unlock still waiting (BK-pots-02): when the space opens. Absent from a bank that predates it. */
    unlocksAt: z.string().datetime({ offset: true }).nullable().optional(),
    balance: decimalSchema,
    ledgerAccount: z.object({ ownerType: z.string(), ownerId: z.string(), assetId: z.string(), kind: z.string() }),
  })
  .refine(
    (space) => space.assetId === space.ledgerAccount.assetId && space.ledgerAccount.kind === 'available',
    copyText('client.space.account.must.match.its.asset.and'),
  );
export type Space = z.infer<typeof spaceSchema>;
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
export function validateTransfer(spaces: Space[], input: TransferDraft): string | null {
  const from = spaces.find((space) => space.id === input.fromSpaceId);
  if (!from) return copyText('client.choose.one.of.your.available.spaces');
  if (from.lockedUntil && Date.parse(from.lockedUntil) > Date.now()) return copyText('client.this.space.is.locked.choose.an.unlocked');
  const amount = decimalSchema.safeParse(input.amount);
  if (!amount.success || parseAmount(amount.data) <= 0n) return copyText('client.enter.an.exact.amount.greater.than.zero');
  if (parseAmount(input.amount) > parseAmount(from.balance)) return copyText('client.the.amount.exceeds.the.available.quantity.in');
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
      return api.query('bank', 'spaces.list', { limit }, z.array(spaceSchema), { signal });
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
        if (space.ledgerAccount.ownerType !== 'user' || space.ledgerAccount.ownerId !== ownerId) {
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
    transfer(spaces: Space[], input: TransferDraft): Promise<ApiResult<{ ledgerTxId: string; amount: string }>> {
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
            ledgerTxId: z.string().min(1),
            amount: decimalSchema.refine(
              (amount) => parseAmount(amount) === parseAmount(input.amount),
              copyText('client.the.settled.amount.must.match.the.review'),
            ),
            note: z.string().nullable().optional(),
            reference: z.string().nullable().optional(),
          })
          // A send to a person echoes what it stored. The reply must be the note and reference that were reviewed.
          .refine((data) => !toPerson || (data.note !== undefined && data.reference !== undefined && messageEchoed(data, body)), {
            message: transferDepthCopy.t('echoMismatch'),
          }),
      );
    },
  };
}
export type MoneyOverview = Awaited<ReturnType<ReturnType<typeof createMoneyClient>['overview']>>;
