import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import {
  createMinimalOriginalJournal,
  type JournalLease,
  type JournalPorts,
  type JournalProblem,
} from '../../shared/minimal-original-journal';
import { parseAmount } from '../../shared/money';
import type { PayBusinessAuthority } from './pay-api';
import * as s from './schemas';
import { isTokenRefused } from './portal/access/step-up-store';

type Original = { status: 'uncertain'; reference?: string };
export type RefundReceipt = Readonly<{ kind: 'refunded' | 'reversed'; refundId: string; eventId: string; ts: string }>;
type Known = { raw: string; receipt: RefundReceipt; current: () => boolean };
export type RefundSnapshot = {
  status: 'empty' | 'unknown' | 'unreadable';
  reference: string | null;
  references: string[];
  problem: JournalProblem | null;
  known: RefundReceipt | null;
};
export type RefundLookup = { receipt: RefundReceipt | null; count: number; cleanupPending: boolean };
const inputSchema = z.object({ paymentId: s.id, amount: s.positiveAmount, refundId: z.string().min(1).max(200) });

// The existing payment operation shares this codec/key with authorize/capture.
// Legacy pending records cannot reconstruct a missing original refund identity.
function decode(raw: string): Original {
  if (raw === 'pending' || raw === 'uncertain') return { status: 'uncertain' };
  const result = z
    .object({ status: z.literal('uncertain'), reference: z.string().min(1).max(200).optional() })
    .strict()
    .parse(JSON.parse(raw));
  return result;
}
function refusal(
  code: string,
  reason: 'aborted' | 'uncertain' | 'invalid_response' | 'not_supported' | 'error' = 'uncertain',
): Extract<ApiResult<never>, { ok: false }> {
  return { ok: false, reason, code: `pay.refund_${code}`, message: 'The original refund has not been confirmed.' };
}
const browserPorts: JournalPorts = {
  durable: () => globalThis.localStorage,
  legacy: () => globalThis.sessionStorage,
  locks: () => globalThis.navigator?.locks,
};

/** Refund outcomes belong to exact payment history, never the aggregate mutation reply.
 * Only references are durable; amounts/request bodies and known receipts stay in RAM.
 */
export function createMerchantRefundApi({
  api,
  userId,
  authority,
  access,
  merchant,
  ports = browserPorts,
}: {
  api: ApiClient;
  userId: string | null;
  authority: PayBusinessAuthority | null;
  access: (scope: string) => Extract<ApiResult<never>, { ok: false }> | null;
  merchant: (signal?: AbortSignal) => Promise<ApiResult<z.infer<typeof s.merchantSchema>>>;
  ports?: JournalPorts;
}) {
  const identity = authority
    ? [authority.companyId, authority.companyName, authority.userId, authority.merchantId, authority.scopes.join('\0')].join('\n')
    : null;
  const journals = new Map<string, ReturnType<typeof createMinimalOriginalJournal<Original>>>();
  const known = new Map<string, Known>();
  const problems = new Map<string, JournalProblem>();
  const key = (paymentId: string) => `pay.unresolved:${userId}:payment:${paymentId}`;
  function current(isCurrent: () => boolean) {
    return Boolean(
      userId &&
      authority?.verified &&
      authority.userId === userId &&
      api.canWrite() &&
      identity ===
        [authority.companyId, authority.companyName, authority.userId, authority.merchantId, authority.scopes.join('\0')].join('\n') &&
      isCurrent(),
    );
  }
  function journal(paymentId: string) {
    const name = key(paymentId);
    if (!journals.has(name)) journals.set(name, createMinimalOriginalJournal(name, decode, ports));
    return journals.get(name)!;
  }
  function unavailable(paymentId: string, problem: JournalProblem) {
    problems.set(key(paymentId), problem);
    return refusal('recovery_unavailable', 'not_supported');
  }
  function inspect(paymentId: string, isCurrent: () => boolean): RefundSnapshot {
    if (!current(isCurrent) || access('pay:read'))
      return { status: 'unreadable', reference: null, references: [], problem: 'inactive', known: null };
    const saved = journal(paymentId).read();
    const proof = known.get(key(paymentId));
    const receipt = proof?.current() && current(isCurrent) ? proof.receipt : null;
    if (saved.status === 'unreadable')
      return {
        status: 'unreadable',
        reference: null,
        references: (saved.originals ?? []).flatMap((row) => (row.value.reference ? [row.value.reference] : [])),
        problem: saved.reason,
        known: receipt,
      };
    const reference = saved.status === 'present' ? (saved.value.reference ?? null) : null;
    return {
      status: saved.status === 'empty' ? 'empty' : 'unknown',
      reference,
      references: reference ? [reference] : [],
      problem: problems.get(key(paymentId)) ?? null,
      known: receipt,
    };
  }
  async function restore(paymentId: string, isCurrent: () => boolean) {
    if (!current(isCurrent)) return refusal('context_changed', 'aborted');
    const denied = access('pay:read');
    if (denied) return denied;
    const original = journal(paymentId).read();
    if (original.status === 'unreadable') return unavailable(paymentId, original.reason);
    if (original.status === 'present' && original.origin === 'durable') {
      problems.delete(key(paymentId));
      return { ok: true as const, data: null };
    }
    const result = await journal(paymentId).coordinate(async (lease) => {
      if (!current(isCurrent)) return { ok: false as const, reason: 'inactive' as const };
      return lease.migrateLegacy();
    });
    if (!result.ok && result.reason === 'busy' && current(isCurrent)) {
      // Another restoration/preflight may hold admission without an original.
      // A fresh verified empty read permits review; submit still requires its
      // own native lease and verified write before any POST.
      const returned = journal(paymentId).read();
      if (returned.status === 'empty' && !known.get(key(paymentId))?.current()) {
        problems.delete(key(paymentId));
        return { ok: true as const, data: null };
      }
    }
    if (!result.ok) return unavailable(paymentId, result.reason);
    if (!result.value.ok) return unavailable(paymentId, result.value.reason);
    problems.delete(key(paymentId));
    return { ok: true as const, data: null };
  }
  async function readPayment(paymentId: string, isCurrent: () => boolean, signal?: AbortSignal): Promise<ApiResult<s.Payment>> {
    if (!current(isCurrent)) return refusal('context_changed', 'aborted');
    const checked = await merchant(signal);
    if (!current(isCurrent)) return refusal('context_changed', 'aborted');
    if (!checked.ok) return checked;
    const result = await api.query('pay', 'payment.get', { paymentId }, s.paymentSchema, { signal });
    if (!current(isCurrent)) return refusal('context_changed', 'aborted');
    if (result.ok && (result.data.id !== paymentId || result.data.merchantId !== authority!.merchantId))
      return refusal('payment_mismatch', 'invalid_response');
    return result;
  }
  async function prove(paymentId: string, original: Original, isCurrent: () => boolean): Promise<ApiResult<RefundLookup>> {
    if (!original.reference) return { ok: true, data: { receipt: null, count: 0, cleanupPending: false } };
    const payment = await readPayment(paymentId, isCurrent);
    if (!payment.ok) return payment;
    if (!current(isCurrent)) return refusal('context_changed', 'aborted');
    const history = await api.query('pay', 'payment.history', { paymentId, limit: 200 }, z.array(s.paymentEventSchema).max(200));
    if (!current(isCurrent)) return refusal('context_changed', 'aborted');
    if (!history.ok) return history;
    const matches = history.data.filter((event) => {
      if (!['refunded', 'refund.reversed'].includes(event.event) || !('payload' in event)) return false;
      return event.payload.refundId === original.reference;
    });
    const event = matches[0];
    const payload = event && 'payload' in event ? event.payload : null;
    if (
      matches.length !== 1 ||
      !event ||
      !payload ||
      !s.positiveAmount.safeParse(payload.amount).success ||
      !Number.isFinite(Date.parse(event.ts))
    )
      return { ok: true, data: { receipt: null, count: history.data.length, cleanupPending: false } };
    const receipt: RefundReceipt = Object.freeze({
      kind: event.event === 'refunded' ? 'refunded' : 'reversed',
      refundId: original.reference,
      eventId: event.id,
      ts: event.ts,
    });
    return { ok: true, data: { receipt, count: history.data.length, cleanupPending: false } };
  }
  async function finish(
    paymentId: string,
    raw: string,
    result: RefundLookup,
    isCurrent: () => boolean,
    lease: JournalLease<Original>,
    ownerCurrent: () => boolean,
  ) {
    if (!current(isCurrent) || !current(ownerCurrent)) return refusal('context_changed', 'aborted');
    if (!result.receipt) return { ok: true as const, data: result };
    // The read attempt retires after publication; the immutable known receipt
    // remains eligible for local cleanup within its separate owner lifetime.
    const proof: Known = { raw, receipt: result.receipt, current: () => current(ownerCurrent) };
    known.set(key(paymentId), proof);
    const cleared = lease.finishExact(raw);
    if (cleared.ok) {
      problems.delete(key(paymentId));
      known.delete(key(paymentId));
    } else problems.set(key(paymentId), cleared.reason);
    return { ok: true as const, data: { ...result, cleanupPending: !cleared.ok } };
  }
  async function checkOriginal(paymentId: string, isCurrent: () => boolean, ownerCurrent = isCurrent): Promise<ApiResult<RefundLookup>> {
    if (!current(isCurrent)) return refusal('context_changed', 'aborted');
    const denied = access('pay:read');
    if (denied) return denied;
    const retained = known.get(key(paymentId));
    if (retained?.current()) return { ok: true, data: { receipt: retained.receipt, count: 0, cleanupPending: true } };
    const result = await journal(paymentId).coordinate(async (lease) => {
      if (!current(isCurrent)) return refusal('context_changed', 'aborted');
      const migrated = lease.migrateLegacy();
      if (!migrated.ok) return unavailable(paymentId, migrated.reason);
      const saved = lease.read();
      if (saved.status === 'unreadable') return unavailable(paymentId, saved.reason);
      if (saved.status !== 'present') return refusal('original_missing');
      const found = await prove(paymentId, saved.value, isCurrent);
      return found.ok ? finish(paymentId, saved.raw, found.data, isCurrent, lease, ownerCurrent) : found;
    });
    return result.ok ? result.value : unavailable(paymentId, result.reason);
  }
  async function submit(
    input: z.infer<typeof inputSchema>,
    isReviewCurrent: () => boolean,
    recoveryCurrent: () => boolean,
    ownerCurrent = recoveryCurrent,
  ): Promise<ApiResult<RefundLookup>> {
    if (!current(isReviewCurrent)) return refusal('context_changed', 'aborted');
    const denied = access('pay:refund');
    if (denied) return denied;
    if (known.get(key(input.paymentId))?.current()) return refusal('original_unresolved');
    if (!inputSchema.safeParse(input).success) return refusal('input_invalid', 'error');
    const result = await journal(input.paymentId).coordinate(async (lease) => {
      if (!current(isReviewCurrent)) return refusal('context_changed', 'aborted');
      if (known.get(key(input.paymentId))?.current()) return refusal('original_unresolved');
      const migrated = lease.migrateLegacy();
      if (!migrated.ok) return unavailable(input.paymentId, migrated.reason);
      const previous = lease.read();
      if (previous.status === 'unreadable') return unavailable(input.paymentId, previous.reason);
      if (previous.status !== 'empty') return refusal('original_unresolved');
      const payment = await readPayment(input.paymentId, isReviewCurrent);
      if (!payment.ok) return payment;
      if (!current(isReviewCurrent)) return refusal('context_changed', 'aborted');
      if (
        !['captured', 'settled', 'refunded'].includes(payment.data.status) ||
        parseAmount(input.amount) > parseAmount(payment.data.capturedAmount) - parseAmount(payment.data.refundedAmount)
      )
        return refusal('amount_invalid', 'error');
      const raw = JSON.stringify({ status: 'uncertain', reference: input.refundId });
      const saved = lease.writeExact(null, raw);
      if (!saved.ok) return unavailable(input.paymentId, saved.reason);
      if (!current(isReviewCurrent)) {
        const cleared = lease.finishExact(raw);
        if (!cleared.ok) problems.set(key(input.paymentId), cleared.reason);
        return refusal('context_changed', 'aborted');
      }
      // Every dispatched result remains unresolved until this feature's exact history proof.
      // Even an aggregate 200 or typed 400 may follow a committed original refund.
      let sent: ApiResult<unknown> | null = null;
      try {
        sent = await api.mutate('pay', 'payment.refund', input, s.paymentSchema);
      } catch {
        /* Preserve original after a lost response. */
      }
      // The gateway turned the confirmation token away before the refund service saw the call: the confirmation ran out
      // between the review and the send. Nothing was refunded, so the saved original is cleared and the caller asks the
      // person to confirm again and sends this same review, with this same refund reference, once more.
      if (sent && !sent.ok && isTokenRefused(sent)) {
        const cleared = lease.finishExact(raw);
        if (!cleared.ok) problems.set(key(input.paymentId), cleared.reason);
        return refusal('step_up_expired', 'error');
      }
      if (!current(recoveryCurrent)) return refusal('context_changed', 'aborted');
      const found = await prove(input.paymentId, { status: 'uncertain', reference: input.refundId }, recoveryCurrent);
      return found.ok ? finish(input.paymentId, raw, found.data, recoveryCurrent, lease, ownerCurrent) : found;
    });
    return result.ok ? result.value : unavailable(input.paymentId, result.reason);
  }
  async function cleanupKnown(paymentId: string, receipt: RefundReceipt, isCurrent: () => boolean) {
    const proof = known.get(key(paymentId));
    if (!proof || proof.receipt !== receipt || !proof.current() || !current(isCurrent)) return false;
    const result = await journal(paymentId).coordinate(async (lease) => {
      if (known.get(key(paymentId)) !== proof || !proof.current() || !current(isCurrent))
        return { ok: false as const, reason: 'inactive' as const };
      const saved = lease.read();
      return saved.status === 'empty' ? { ok: true as const } : lease.finishExact(proof.raw);
    });
    if (!result.ok || !result.value.ok) {
      problems.set(key(paymentId), !result.ok ? result.reason : !result.value.ok ? result.value.reason : 'mismatch');
      return false;
    }
    if (known.get(key(paymentId)) === proof) known.delete(key(paymentId));
    problems.delete(key(paymentId));
    return true;
  }
  return { inspect, restore, readPayment, submit, checkOriginal, cleanupKnown, isCurrent: current };
}
export type MerchantRefundApi = ReturnType<typeof createMerchantRefundApi>;
