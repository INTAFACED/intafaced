import { categoryPolicyPreviewInputSchema, type CategoryPolicyPreviewInput } from '@intafaced/contracts/business-category';
import { readAdminJson } from '@/lib/admin-json';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest } from '@/lib/founder-session';
import { fromFailure, json } from '@/lib/merchants/bff';
import { type PayCallContext, payRecordCall } from '@/lib/merchants/pay-call';
import { moduleDisabledResponse } from '@/lib/modules';
import {
  IDENTITY_ACTION_APPROVAL_REJECT,
  IDENTITY_ACTION_APPROVAL_PROPOSE,
  IDENTITY_ACTION_APPROVAL_APPROVE,
} from '@intafaced/contracts/identity-action-approval-records';
import {
  PAY_FOUNDER_ADMIN_CATEGORY_POLICY_PREVIEW,
  PAY_FOUNDER_ADMIN_CATEGORY_POLICY_SET,
} from '@intafaced/contracts/pay-founder-admin-procedures';

/**
 * Merchants panel BFF: the business category table (RC-merchant-08, J-merchant-02 step 7).
 *
 *   POST { action: 'preview', change }              what the change needs (always a second founder) and its hash
 *   POST { action: 'propose', change }              step 1: ask identity for the other founder's approval
 *   POST { action: 'approve', change, approvalId }  step 2: the OTHER founder approves exactly this change
 *   POST { action: 'reject',  approvalId }          the other founder declines
 *   POST { action: 'save',    change, approvalId, operationId }   write it; svc-pay consumes the approval
 *
 * Founder-only (`authorizeAdminRequest`: sealed cookie, exact origin, CSRF nonce, live founder entitlement), `no-store`
 * on every answer, and every call carries the signed-in founder's own token. The browser never names an actor. The
 * change is checked with the same contract svc-pay applies before anything is sent. No money moves.
 */

export const dynamic = 'force-dynamic';

const bad = () => new AdminSessionError('admin.merchants_input', 400);
const approvalIdOf = (value: unknown) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || text.length > 128) throw bad();
  return text;
};

function changeOf(raw: unknown): CategoryPolicyPreviewInput {
  const parsed = categoryPolicyPreviewInputSchema.safeParse(raw);
  if (!parsed.success) throw bad();
  return parsed.data;
}

const previewOf = (ctx: PayCallContext, change: CategoryPolicyPreviewInput) =>
  payRecordCall(ctx, PAY_FOUNDER_ADMIN_CATEGORY_POLICY_PREVIEW, change);

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

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('merchants');
  if (disabled) return disabled;
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const ctx: PayCallContext = { session, config };
    const body = await readAdminJson(request);

    if (body.action === 'reject') {
      const result = await payRecordCall(ctx, IDENTITY_ACTION_APPROVAL_REJECT, { approvalId: approvalIdOf(body.approvalId) });
      if (result.kind !== 'ok') return fromFailure(result);
      return json({ ok: true, approval: { approvalId: result.data.approvalId, status: result.data.status } });
    }

    if (!['preview', 'propose', 'approve', 'save'].includes(String(body.action))) throw bad();
    const change = changeOf(body.change);
    // The ids are checked before anything is sent, so a malformed save or approve reaches no service.
    const approvalId = body.action === 'approve' || body.action === 'save' ? approvalIdOf(body.approvalId) : '';
    const operationId = body.action === 'save' ? approvalIdOf(body.operationId) : '';
    const preview = await previewOf(ctx, change);
    if (preview.kind !== 'ok') return fromFailure(preview);

    if (body.action === 'preview') return json({ ok: true, preview: preview.data });

    if (body.action === 'propose') {
      const proposed = await payRecordCall(ctx, IDENTITY_ACTION_APPROVAL_PROPOSE, {
        actionType: preview.data.actionType,
        targetService: 'svc-pay',
        targetId: preview.data.actionType,
        expectedVersion: '1',
        payloadHash: preview.data.payloadHash,
        policyVersion: 'v1',
      });
      if (proposed.kind !== 'ok') return fromFailure(proposed);
      const a = proposed.data;
      return json({
        ok: true,
        approval: {
          approvalId: a.approvalId,
          operationId: a.operationId,
          status: a.status,
          expiresAt: a.expiresAt,
          payloadHash: a.payloadHash,
        },
      });
    }

    if (body.action === 'approve') {
      // Bound to the change this founder just reviewed: identity refuses unless its stored hash equals this one.
      const approved = await payRecordCall(ctx, IDENTITY_ACTION_APPROVAL_APPROVE, {
        approvalId,
        expectedPayloadHash: preview.data.payloadHash,
      });
      if (approved.kind !== 'ok') return fromFailure(approved);
      const a = approved.data;
      return json({
        ok: true,
        approval: { approvalId: a.approvalId, status: a.status, payloadHash: a.payloadHash },
        matchesReviewedChange: a.payloadHash === preview.data.payloadHash,
      });
    }

    if (body.action === 'save') {
      const saved = await payRecordCall(ctx, PAY_FOUNDER_ADMIN_CATEGORY_POLICY_SET, { ...change, approvalId, operationId });
      if (saved.kind !== 'ok') return fromFailure(saved);
      return json({ ok: true, saved: saved.data });
    }

    throw bad();
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
