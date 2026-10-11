import {
  crmErasurePreviewInputSchema,
  crmErasurePreviewSchema,
  crmErasureBeginInputSchema,
  crmErasureAdvanceInputSchema,
  crmErasureStatusInputSchema,
  crmErasureStatusSchema,
  crmRetentionStatusSchema,
  crmRetentionReviewStatusInputSchema,
  crmRetentionReviewInputSchema,
  crmRetentionReviewSchema,
} from '@intafaced/contracts';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest, founderEdgeCall } from '@/lib/founder-session';
import { readAdminJson } from '@/lib/admin-json';

export const dynamic = 'force-dynamic';
type Schema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
function input<T>(schema: Schema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AdminSessionError('admin.crm_input', 400);
  return result.data;
}
function output<T>(schema: Schema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AdminSessionError('admin.upstream_invalid', 502);
  return result.data;
}
function bound(allowed: boolean): void {
  if (!allowed) throw new AdminSessionError('admin.upstream_invalid', 502);
}
function response(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } });
}

export async function GET(request: Request) {
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const params = new URL(request.url).searchParams;
    if (new Set(params.keys()).size !== [...params.keys()].length) throw new AdminSessionError('admin.crm_input', 400);
    const action = params.get('view');
    const raw = Object.fromEntries([...params].filter(([key]) => key !== 'view'));
    if (action === 'privacyRetentionStatus') {
      if (Object.keys(raw).length) throw new AdminSessionError('admin.crm_input', 400);
      return response(
        output(
          crmRetentionStatusSchema,
          await founderEdgeCall(config, 'ops', 'outreach.privacyRetentionStatus', 'GET', {}, session.accessToken),
        ),
      );
    }
    if (action === 'privacyRetentionReviewStatus') {
      const selection = input(crmRetentionReviewStatusInputSchema, raw);
      const review = await founderEdgeCall(config, 'ops', 'outreach.privacyRetentionReviewStatus', 'GET', selection, session.accessToken);
      const parsed = review === null ? null : output(crmRetentionReviewSchema, review);
      bound(parsed === null || parsed.canonicalContactId === selection.canonicalContactId);
      return response(parsed);
    }
    if (action === 'privacyPreview') {
      const selection = input(crmErasurePreviewInputSchema, raw);
      const preview = output(
        crmErasurePreviewSchema,
        await founderEdgeCall(config, 'ops', 'outreach.privacyPreview', 'GET', selection, session.accessToken),
      );
      const canonical = preview.contacts.find((c) => c.contactId === selection.canonicalContactId);
      bound(
        preview.canonicalContactId === selection.canonicalContactId &&
          canonical?.revision === preview.canonicalRevision &&
          new Set(preview.contacts.map((c) => c.contactId)).size === preview.contacts.length &&
          new Set(preview.submissionIds).size === preview.submissionIds.length &&
          preview.counts.contacts === preview.contacts.length &&
          preview.counts.submissions === preview.submissionIds.length,
      );
      return response(preview);
    }
    if (action === 'privacyStatus') {
      if (Object.keys(raw).some((key) => !['intentId', 'canonicalContactId'].includes(key)))
        throw new AdminSessionError('admin.crm_input', 400);
      const { canonicalContactId } = input(crmErasurePreviewInputSchema, { canonicalContactId: raw.canonicalContactId });
      // The BFF retains canonical binding for known intents; OPS receives exactly one strict selector.
      const selection = input(crmErasureStatusInputSchema, 'intentId' in raw ? { intentId: raw.intentId } : { canonicalContactId });
      const receipt = output(
        crmErasureStatusSchema,
        await founderEdgeCall(config, 'ops', 'outreach.privacyStatus', 'GET', selection, session.accessToken),
      );
      bound(receipt.canonicalContactId === canonicalContactId && (!('intentId' in selection) || receipt.intentId === selection.intentId));
      return response(receipt);
    }
    throw new AdminSessionError('admin.crm_input', 400);
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const body = await readAdminJson(request);
    if (body.action === 'privacyRetentionReview') {
      if (Object.keys(body).some((key) => !['action', 'input'].includes(key))) throw new AdminSessionError('admin.crm_input', 400);
      const selection = input(crmRetentionReviewInputSchema, body.input);
      const receipt = output(
        crmRetentionReviewSchema,
        await founderEdgeCall(config, 'ops', 'outreach.privacyRetentionReview', 'POST', selection, session.accessToken),
      );
      bound(
        receipt.canonicalContactId === selection.canonicalContactId &&
          receipt.reviewedBy === session.userId.toLowerCase() &&
          receipt.revision === selection.expectedReviewRevision + 1 &&
          receipt.state === selection.state &&
          receipt.evidenceRef === selection.evidenceRef &&
          receipt.reason === selection.reason,
      );
      return response(receipt);
    }
    if (body.action === 'privacyBegin') {
      if (Object.keys(body).some((key) => !['action', 'input'].includes(key))) throw new AdminSessionError('admin.crm_input', 400);
      const selection = input(crmErasureBeginInputSchema, body.input);
      const receipt = output(
        crmErasureStatusSchema,
        await founderEdgeCall(config, 'ops', 'outreach.privacyBegin', 'POST', selection, session.accessToken),
      );
      bound(receipt.canonicalContactId === selection.canonicalContactId && receipt.requestedBy === session.userId.toLowerCase());
      return response(receipt);
    }
    if (body.action !== 'privacyAdvance' || Object.keys(body).some((key) => !['action', 'input', 'canonicalContactId'].includes(key)))
      throw new AdminSessionError('admin.crm_input', 400);
    const value = {
      input: input(crmErasureAdvanceInputSchema, body.input),
      ...input(crmErasurePreviewInputSchema, { canonicalContactId: body.canonicalContactId }),
    };
    // Any current founder may advance. requestedBy belongs to the original intent, not the advancing actor.
    const before = output(
      crmErasureStatusSchema,
      await founderEdgeCall(
        config,
        'ops',
        'outreach.privacyStatus',
        'GET',
        input(crmErasureStatusInputSchema, { intentId: value.input.intentId }),
        session.accessToken,
      ),
    );
    bound(
      before.intentId === value.input.intentId &&
        before.canonicalContactId === value.canonicalContactId &&
        before.revision >= value.input.expectedRevision,
    );
    const after = output(
      crmErasureStatusSchema,
      await founderEdgeCall(config, 'ops', 'outreach.privacyAdvance', 'POST', value.input, session.accessToken),
    );
    bound(
      after.intentId === before.intentId &&
        after.canonicalContactId === before.canonicalContactId &&
        after.requestedBy === before.requestedBy &&
        after.requestedAt === before.requestedAt &&
        after.pendingSubmissionCount <= before.pendingSubmissionCount &&
        (before.status === 'complete'
          ? after.status === 'complete' && after.revision === before.revision && after.completedAt === before.completedAt
          : after.revision > before.revision),
    );
    return response(after);
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
