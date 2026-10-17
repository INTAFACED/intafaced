import { founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import {
  founderChangeConfirmInputSchema,
  founderChangeSubmitInputSchema,
  founderChangeSubmitResultSchema,
  payoutApprovalSchema,
  payReasonSchema,
} from '@intafaced/contracts';
import { readAdminJson } from '@/lib/admin-json';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest } from '@/lib/founder-session';
import { fromFailure, json } from '@/lib/merchants/bff';
import { asList } from '@/lib/merchants/registry-model';
import { asTier } from '@/lib/merchants/control-model';
import { parseWith, payCall, type PayCallContext } from '@/lib/merchants/pay-call';
import { moduleDisabledResponse } from '@/lib/modules';

/**
 * Merchants panel BFF: merchant control changes (two founders) and payout approvals (two founders).
 *
 * Founder-only (`authorizeAdminRequest`: sealed cookie, exact origin, CSRF nonce, live founder entitlement),
 * `no-store` on every answer. Every call to svc-pay carries the signed-in founder's own Bearer token; the
 * browser never sees a token and never names an actor. The service decides who the actor is and refuses the
 * same founder confirming their own change.
 *
 *   POST { action: 'submit',  requestId, merchantId, change, reason, expectedVersion }   founder 1 records the change as pending
 *   POST { action: 'confirm', requestId, merchantId, expectedVersion, change, reason }     founder 2 applies it
 *   POST { action: 'decline', requestId, merchantId, expectedVersion, change, reason }     founder 2 refuses it
 *   POST { action: 'tiers' }                                                                  a read of the tier definitions (no change)
 *   POST { action: 'decide',  approvalId, decision, expectedPayloadHash, reason }          a founder signs a payout approval
 *
 * Every input is checked against the contract schema before anything is forwarded, so a malformed body is a
 * 400 here and never reaches the service.
 *
 * A confirm or decline names the change the second founder was SHOWN (the pasted request). This route hashes it
 * with the same canonical function svc-pay used when the first founder submitted, and sends the hash as
 * `expectedChangeHash`: the service refuses (`pay.change_hash_mismatch`) unless the change on file is exactly that one.
 */

export const dynamic = 'force-dynamic';

const SHA = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('merchants');
  if (disabled) return disabled;
  try {
    await authorizeAdminRequest(request);
    return json({ error: 'method_not_allowed', allow: 'POST' }, 405);
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}

const lower = (v: unknown): unknown => (typeof v === 'string' ? v.toLowerCase() : v);
const bad = () => new AdminSessionError('admin.merchants_input', 400);

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('merchants');
  if (disabled) return disabled;
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const ctx: PayCallContext = { session, config };
    const body = await readAdminJson(request);
    const action = body.action;

    if (action === 'submit') {
      const input = founderChangeSubmitInputSchema.safeParse({
        requestId: body.requestId,
        merchantId: lower(body.merchantId),
        change: body.change,
        reason: body.reason,
        expectedVersion: body.expectedVersion,
      });
      if (!input.success) throw bad();
      const result = await payCall(ctx, 'founderAdmin.changes.submit', 'POST', input.data, parseWith(founderChangeSubmitResultSchema));
      if (result.kind !== 'ok') return fromFailure(result, { notBuilt: RESERVE_NOT_BUILT, notFoundCode: 'pay.merchant_not_found' });
      return json({ ok: true, result: result.data });
    }

    if (action === 'confirm' || action === 'decline') {
      // The change the second founder read, validated as strictly as a submit, then hashed exactly as svc-pay hashed it.
      const shown = founderChangeSubmitInputSchema.safeParse({
        requestId: body.requestId,
        merchantId: lower(body.merchantId),
        change: body.change,
        reason: body.reason,
        expectedVersion: body.expectedVersion,
      });
      if (!shown.success) throw bad();
      const input = founderChangeConfirmInputSchema.safeParse({
        requestId: shown.data.requestId,
        decision: action === 'confirm' ? 'confirm' : 'reject',
        reason: shown.data.reason,
        expectedChangeHash: founderChangeHash(
          { scope: 'merchant', merchantId: shown.data.merchantId, change: shown.data.change },
          shown.data.expectedVersion,
        ),
      });
      if (!input.success) throw bad();
      const result = await payCall(ctx, 'founderAdmin.changes.confirm', 'POST', input.data, parseWith(founderChangeSubmitResultSchema));
      if (result.kind !== 'ok') return fromFailure(result, { notBuilt: RESERVE_NOT_BUILT, notFoundCode: 'pay.change_not_found' });
      return json({ ok: true, result: result.data });
    }

    if (action === 'tiers') {
      // A read, here so the confirm panel can ask "did a tier change since this page loaded?" before it calls a mismatch an incident.
      const tiers = await payCall(ctx, 'founderAdmin.control.tiers.list', 'GET', {}, (raw) => asList(raw, asTier));
      if (tiers.kind !== 'ok') return fromFailure(tiers);
      return json({ ok: true, tiers: tiers.data });
    }

    if (action === 'decide') {
      const reason = payReasonSchema.safeParse(body.reason);
      const decision = body.decision === 'approve' || body.decision === 'reject' ? body.decision : null;
      if (
        !reason.success ||
        !decision ||
        typeof body.approvalId !== 'string' ||
        !UUID.test(body.approvalId) ||
        typeof body.expectedPayloadHash !== 'string' ||
        !SHA.test(body.expectedPayloadHash)
      )
        throw bad();
      const result = await payCall(
        ctx,
        'founderAdmin.control.approvals.decide',
        'POST',
        { approvalId: body.approvalId.toLowerCase(), decision, expectedPayloadHash: body.expectedPayloadHash, reason: reason.data },
        parseWith(payoutApprovalSchema),
      );
      if (result.kind !== 'ok') return fromFailure(result, { notFoundCode: 'pay.approval_not_found' });
      return json({ ok: true, approval: result.data });
    }

    throw bad();
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}

/** `pay.reserve_ledger_unwired` reaches us as a not-implemented answer; it is the one control change with this honest reason. */
const RESERVE_NOT_BUILT = {
  title: 'This change is not switched on',
  body: 'The service behind it is not switched on for this deployment. For a reserve, the ledger side of withholding money is not connected.',
  next: 'Nothing was changed. This control is not connected here.',
};
