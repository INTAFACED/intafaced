import { actionApprovalSchema } from '@intafaced/contracts';
import { readAdminJson } from '@/lib/admin-json';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest } from '@/lib/founder-session';
import { parseWith, payCall, type PayCallContext, type PayCallResult } from '@/lib/merchants/pay-call';
import {
  acceptChange,
  asNetwork,
  asPreview,
  asVenue,
  asWalletRoute,
  explainRefusal,
  REGISTRY_INFO,
  REGISTRY_KINDS,
  type RegistryKind,
  type RegistryPreview,
} from '@/lib/merchants/registry-model';
import { moduleDisabledResponse } from '@/lib/modules';

/**
 * Merchants panel BFF: registry preview, second-founder approval and save.
 *
 * Founder-only (`authorizeAdminRequest`: sealed cookie, exact origin, CSRF nonce,
 * live founder entitlement), `no-store` on every answer, and every call to the
 * services carries the signed-in founder's own Bearer token. The browser never
 * sees a token and never names an actor.
 *
 *   POST { action: 'preview',  registry, change }            what would this change need, and its hash
 *   POST { action: 'propose',  registry, change }            step 1: ask identity for a second-founder approval
 *   POST { action: 'approve',  registry, change, approvalId } step 2: the OTHER founder approves
 *   POST { action: 'reject',   approvalId }                  the other founder declines
 *   POST { action: 'save',     registry, change }            write it (approvalId + operationId inside `change` when dual control applies)
 */

export const dynamic = 'force-dynamic';
const NO_STORE = { 'cache-control': 'no-store' } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function refusal(code: string | null, message: string, status: number, requestId: string | null): Response {
  const plain = explainRefusal(code, message, status);
  return json({ ok: false, refusal: { ...plain, code, requestId } }, status >= 400 && status < 600 ? status : 502);
}

function fromFailure<T>(result: Exclude<PayCallResult<T>, { kind: 'ok' }>): Response {
  switch (result.kind) {
    case 'refused':
      return refusal(result.refusal.code, result.refusal.message, result.refusal.status, result.requestId);
    case 'forbidden':
      return refusal('operator.denied', '', 403, result.requestId);
    case 'not_built':
      return json(
        {
          ok: false,
          refusal: {
            title: 'This is not built yet',
            body: 'The service behind this action has not been switched on for this deployment.',
            next: 'Nothing was changed. Ask engineering when it arrives.',
            code: 'pay.not_built',
            requestId: result.requestId,
          },
        },
        501,
      );
    case 'not_found':
      return refusal('registries.not_found', '', 404, result.requestId);
    case 'unavailable':
      return refusal(null, '', 503, result.requestId);
    default:
      return refusal(null, '', 502, result.requestId);
  }
}

const withoutApproval = (change: Record<string, unknown>): Record<string, unknown> => {
  const { approvalId: _a, operationId: _o, ...rest } = change;
  return rest;
};

const viewParser = (kind: RegistryKind) => (kind === 'venue' ? asVenue : kind === 'network' ? asNetwork : asWalletRoute);

async function previewOf(ctx: PayCallContext, kind: RegistryKind, change: Record<string, unknown>) {
  return payCall(ctx, 'founderAdmin.registries.preview', 'GET', { registry: kind, change: withoutApproval(change) }, asPreview);
}

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
    const action = body.action;

    if (action === 'reject') {
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : '';
      if (approvalId === '' || approvalId.length > 128) throw new AdminSessionError('admin.merchants_input', 400);
      const result = await payCall(ctx, 'actionApproval.reject', 'POST', { approvalId }, parseWith(actionApprovalSchema), 'identity');
      if (result.kind !== 'ok') return fromFailure(result);
      return json({ ok: true, approval: { approvalId: result.data.approvalId, status: result.data.status } });
    }

    const registry = typeof body.registry === 'string' ? (REGISTRY_KINDS.find((k) => k === body.registry) ?? null) : null;
    if (registry === null) throw new AdminSessionError('admin.merchants_input', 400);
    const change = acceptChange(registry, body.change);
    if (change === null) throw new AdminSessionError('admin.merchants_input', 400);

    if (action === 'preview') {
      const preview = await previewOf(ctx, registry, change);
      if (preview.kind !== 'ok') return fromFailure(preview);
      return json({ ok: true, preview: preview.data });
    }

    if (action === 'propose' || action === 'approve') {
      const preview = await previewOf(ctx, registry, change);
      if (preview.kind !== 'ok') return fromFailure(preview);
      const hash: RegistryPreview = preview.data;
      if (!hash.needsDualControl) {
        return json(
          {
            ok: false,
            refusal: {
              title: 'No second founder is needed',
              body: 'This change can be saved by you alone.',
              next: 'Go back and save it.',
              code: null,
              requestId: null,
            },
          },
          409,
        );
      }
      if (action === 'propose') {
        const proposed = await payCall(
          ctx,
          'actionApproval.propose',
          'POST',
          {
            actionType: hash.actionType,
            targetService: 'svc-pay',
            targetId: hash.actionType,
            expectedVersion: '1',
            payloadHash: hash.payloadHash,
            policyVersion: 'v1',
          },
          parseWith(actionApprovalSchema),
          'identity',
        );
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
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : '';
      if (approvalId === '' || approvalId.length > 128) throw new AdminSessionError('admin.merchants_input', 400);
      // Bind the approval to the change this founder just reviewed: identity refuses unless its stored hash equals this one.
      const approved = await payCall(
        ctx,
        'actionApproval.approve',
        'POST',
        { approvalId, expectedPayloadHash: hash.payloadHash },
        parseWith(actionApprovalSchema),
        'identity',
      );
      if (approved.kind !== 'ok') return fromFailure(approved);
      const a = approved.data;
      return json({
        ok: true,
        approval: { approvalId: a.approvalId, status: a.status, payloadHash: a.payloadHash },
        // False means the approval was issued for a different change than the one this founder just reviewed.
        matchesReviewedChange: a.payloadHash === hash.payloadHash,
        reviewedPayloadHash: hash.payloadHash,
      });
    }

    if (action === 'save') {
      const procedure = `founderAdmin.registries.${REGISTRY_INFO[registry].listProcedure.replace('.list', '.save')}`;
      const saved = await payCall(ctx, procedure, 'POST', change, (raw) => viewParser(registry)(raw));
      if (saved.kind !== 'ok') return fromFailure(saved);
      return json({ ok: true, saved: saved.data, listHref: `/merchants/registries/${REGISTRY_INFO[registry].slug}` });
    }

    throw new AdminSessionError('admin.merchants_input', 400);
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
