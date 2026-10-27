import { z } from 'zod';
import { authoredRefusal, type ApiClient, type ApiResult } from '../../shared/api';
import { decimalSchema } from '../../shared/money';
import { withdrawalCopy } from './withdrawal-copy';

/** svc-pay's customer vocabulary for a withdrawal (`withdrawals/status.ts`). */
export const WITHDRAWAL_SHOWN = [
  'requested',
  'pending_review',
  'approved',
  'held',
  'dispatching',
  'broadcast',
  'confirming',
  'settled',
  'rejected',
  'canceled',
  'failed',
  'needs_review',
] as const;

// Published svc-pay withdrawalView. A record is a projection, not a balance
// book, a delivery receipt or settlement evidence for another original action.
export const withdrawalSchema = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  assetId: z.string().min(1).max(16),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,18})?$/)
    .pipe(decimalSchema),
  rail: z.string(),
  destination: z.object({ kind: z.string(), ref: z.string() }),
  clientRef: z.string(),
  railRef: z.string().nullable(),
  attempts: z.number().int(),
  failureCode: z.string().nullable(),
  status: z.enum(['pending', 'held', 'sent', 'failed']),
  createdAt: z.string().datetime({ offset: true }),
  // W-withdraw-07: the row in the customer vocabulary (a held row split by its dispatch journal), and whether a cancel would
  // run now. Optional so an older svc-pay without them still reads; without `cancellable` the page offers Cancel on a
  // requested withdrawal only, which is what an older svc-pay cancels.
  customerStatus: z.enum(WITHDRAWAL_SHOWN).optional(),
  cancellable: z.boolean().optional(),
});
export type WithdrawalRecord = z.infer<typeof withdrawalSchema>;
export type WithdrawalShown = (typeof WITHDRAWAL_SHOWN)[number];
// svc-pay's answer to `withdrawal.cancel`: the cancelled row, and whether a hold went back (`null`: unknown on a repeat).
const canceledSchema = withdrawalSchema.extend({ customerStatus: z.literal('canceled'), holdReleased: z.boolean().nullable() });
export type CanceledWithdrawal = z.infer<typeof canceledSchema>;
/** One page of `withdrawal.history` (W-withdraw-06): the person's own withdrawals newest first, in the customer vocabulary. */
export const withdrawalHistoryItemSchema = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  assetId: z.string().min(1).max(16),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,18})?$/)
    .pipe(decimalSchema),
  rail: z.string(),
  destination: z.object({ kind: z.string(), ref: z.string() }),
  clientRef: z.string(),
  railRef: z.string().nullable(),
  attempts: z.number().int(),
  status: z.enum(WITHDRAWAL_SHOWN),
  failure: z.object({ code: z.string(), known: z.boolean(), message: z.string() }).nullable(),
  returned: z.boolean(),
  /** What came back, when anything did, and whether it is back in available yet. An older svc-pay sends none. */
  returnedFunds: z
    .object({
      amount: z
        .string()
        .regex(/^\d+(\.\d{1,18})?$/)
        .pipe(decimalSchema),
      reasonCode: z.string().nullable(),
      credited: z.boolean(),
    })
    .nullable()
    .optional(),
  createdAt: z.string().datetime({ offset: true }),
});
const withdrawalHistoryPageSchema = z.object({ items: z.array(withdrawalHistoryItemSchema), next: z.string().min(1).max(200).nullable() });
export type WithdrawalHistoryItem = z.infer<typeof withdrawalHistoryItemSchema>;
export type ReturnedFunds = NonNullable<WithdrawalHistoryItem['returnedFunds']>;
export type WithdrawalHistoryPage = z.infer<typeof withdrawalHistoryPageSchema>;
/** What the person filters History by. `null` is every coin, or every status. */
export type WithdrawalHistoryFilter = { assetId: string | null; status: WithdrawalShown | null };
/** Rows asked for per page. svc-pay has no default page size, so the page says it; older rows come by the cursor. */
export const HISTORY_PAGE = 50;
export const withdrawalIdSchema = z
  .string()
  .guid()
  .transform((value) => value.toLowerCase());
type FailureKey = 'invalidId' | 'invalidOwner' | 'invalidWindow' | 'signedOut' | 'notCancellable';
const failureKeys: Record<string, FailureKey> = {
  'pay.withdrawal_not_cancellable': 'notCancellable',
  'pay.withdrawal_cursor_invalid': 'invalidWindow',
  'withdrawal.input_invalid': 'invalidId',
  'withdrawal.owner_or_original_invalid': 'invalidOwner',
  'withdrawal.window_invalid': 'invalidWindow',
  'withdrawal.session_required': 'signedOut',
};
export function withdrawalFailureMessage(result: Extract<ApiResult<unknown>, { ok: false }>) {
  const key = result.code && failureKeys[result.code];
  return key ? withdrawalCopy.t(key) : undefined;
}
function refuse(reason: 'error' | 'invalid_response' | 'unauthorized', code: keyof typeof failureKeys, key: FailureKey) {
  return { ok: false as const, reason, code, message: withdrawalCopy.t(key) };
}
export function requestedWithdrawal(search: string): { ok: true; id: string | null } | { ok: false } {
  const values = new URLSearchParams(search).getAll('withdrawalId');
  if (!values.length) return { ok: true, id: null };
  if (values.length !== 1) return { ok: false };
  const parsed = withdrawalIdSchema.safeParse(values[0]);
  return parsed.success ? { ok: true, id: parsed.data } : { ok: false };
}
export function createWithdrawalReads(api: ApiClient, userId: string | null, current: () => boolean) {
  function admission(signal?: AbortSignal) {
    if (!current() || signal?.aborted) return authoredRefusal('aborted', { key: 'accountChanged' });
    return !userId ? refuse('unauthorized', 'withdrawal.session_required', 'signedOut') : null;
  }
  return {
    /**
     * One page of the person's history: the newest first, or the page after `after` (svc-pay's cursor). A page longer than
     * asked, a row twice, or a row outside the filter is refused rather than shown.
     */
    async history(filter: WithdrawalHistoryFilter, after: string | null, signal?: AbortSignal): Promise<ApiResult<WithdrawalHistoryPage>> {
      const denied = admission(signal);
      if (denied) return denied;
      const input = {
        limit: HISTORY_PAGE,
        ...(filter.assetId ? { assetId: filter.assetId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(after ? { after } : {}),
      };
      const result = await api.query('pay', 'withdrawal.history', input, withdrawalHistoryPageSchema, { signal });
      const departed = admission(signal);
      if (departed) return departed;
      if (!result.ok) return result;
      const { items } = result.data;
      if (items.some((item) => item.userId !== userId))
        return refuse('invalid_response', 'withdrawal.owner_or_original_invalid', 'invalidOwner');
      if (
        items.length > HISTORY_PAGE ||
        new Set(items.map((item) => item.id.toLowerCase())).size !== items.length ||
        items.some((item) => (filter.assetId && item.assetId !== filter.assetId) || (filter.status && item.status !== filter.status))
      )
        return refuse('invalid_response', 'withdrawal.window_invalid', 'invalidWindow');
      return result;
    },
    /**
     * What came back from one of the person's own sent withdrawals (W-withdraw-07), read from History by its id: null when
     * nothing did. svc-pay says whether it is back in available; the page never infers it.
     */
    async returnOf(withdrawalId: string, signal?: AbortSignal): Promise<ApiResult<ReturnedFunds | null>> {
      const denied = admission(signal);
      if (denied) return denied;
      const parsed = withdrawalIdSchema.safeParse(withdrawalId);
      if (!parsed.success) return refuse('error', 'withdrawal.input_invalid', 'invalidId');
      const result = await api.query('pay', 'withdrawal.history', { id: parsed.data, limit: 1 }, withdrawalHistoryPageSchema, { signal });
      const departed = admission(signal);
      if (departed) return departed;
      if (!result.ok) return result;
      const [item, ...more] = result.data.items;
      if (more.length > 0 || (item && (item.userId !== userId || item.id.toLowerCase() !== parsed.data)))
        return refuse('invalid_response', 'withdrawal.owner_or_original_invalid', 'invalidOwner');
      return { ok: true, data: item?.returnedFunds ?? null };
    },
    async get(withdrawalId: string, signal?: AbortSignal): Promise<ApiResult<WithdrawalRecord>> {
      const denied = admission(signal);
      if (denied) return denied;
      const parsed = withdrawalIdSchema.safeParse(withdrawalId);
      if (!parsed.success) return refuse('error', 'withdrawal.input_invalid', 'invalidId');
      const result = await api.query('pay', 'withdrawal.get', { withdrawalId: parsed.data }, withdrawalSchema, { signal });
      const departed = admission(signal);
      if (departed) return departed;
      // A named missing original is different from an absent route. Preserve
      // the exact original for retry; an ordinary 404 remains not_mounted.
      if (!result.ok && result.status === 404 && result.code === 'pay.withdrawal_not_found')
        return { ...result, reason: 'error', message: withdrawalCopy.t('notFoundNote'), messageCopy: undefined };
      if (result.ok && (result.data.userId !== userId || result.data.id.toLowerCase() !== parsed.data))
        return refuse('invalid_response', 'withdrawal.owner_or_original_invalid', 'invalidOwner');
      return result;
    },
    /** Cancel one of the person's own withdrawals (W-withdraw-07). svc-pay decides whether it may; a refusal is typed. */
    async cancel(withdrawalId: string): Promise<ApiResult<CanceledWithdrawal>> {
      const denied = admission();
      if (denied) return denied;
      const parsed = withdrawalIdSchema.safeParse(withdrawalId);
      if (!parsed.success) return refuse('error', 'withdrawal.input_invalid', 'invalidId');
      const result = await api.mutate('pay', 'withdrawal.cancel', { withdrawalId: parsed.data }, canceledSchema);
      const departed = admission();
      if (departed) return departed;
      if (result.ok && (result.data.userId !== userId || result.data.id.toLowerCase() !== parsed.data))
        return refuse('invalid_response', 'withdrawal.owner_or_original_invalid', 'invalidOwner');
      return result;
    },
  };
}
