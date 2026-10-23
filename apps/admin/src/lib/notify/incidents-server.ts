import 'server-only';
import { createHash } from 'node:crypto';
import { actionApprovalSchema } from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type Part, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { readDefinition } from './status-model';
import {
  readOperatorNotices,
  readTemplates,
  type IncidentDeskReply,
  type IncidentDeskView,
  type IncidentDraftInput,
  type PublishApproval,
  publishApprovalOf,
} from './incidents-model';

/**
 * The incident desk as the signed-in founder. svc-notify holds the incidents (`notify.operatorNotices`, drafts included),
 * the templates (`statusPage.templates.*`) and the exact approval a publish spends (`notify.noticeProposal`); identity
 * holds the approvals (`actionApproval.*`). Every call carries the founder's own token, so each service records who acted.
 */

const NOTIFY: PartLabels = {
  service: 'svc-notify',
  forbiddenMessage:
    'svc-notify did not accept your founder session. The incident desk needs the operator write permission (admin:write) on a signed-in session with a second factor.',
};
const IDENTITY: PartLabels = {
  service: 'svc-identity',
  forbiddenMessage: 'svc-identity did not show your approvals. Founder approvals need a signed-in founder session with a second factor.',
};

export const PUBLISH_ACTION = 'notify.notice.publish';
const LIST_LIMIT = 50;
const APPROVALS_LIMIT = 100;

const approvalList = parseWith(actionApprovalSchema.array());
const readApprovals = (raw: unknown) =>
  raw && typeof raw === 'object' && 'approvals' in raw ? approvalList((raw as { approvals: unknown }).approvals) : null;

export async function loadIncidentDesk(ctx: FounderCallContext): Promise<IncidentDeskView> {
  const [notices, templates, definition, pending, mine] = await Promise.all([
    founderCall(ctx, 'notify', 'notify.operatorNotices', 'GET', { kind: 'incident', limit: LIST_LIMIT }, readOperatorNotices),
    founderCall(ctx, 'notify', 'statusPage.templates.list', 'GET', undefined, readTemplates),
    founderCall(ctx, 'notify', 'statusPage.definition', 'GET', undefined, readDefinition),
    founderCall(ctx, 'identity', 'actionApproval.list', 'GET', { view: 'pending', limit: APPROVALS_LIMIT }, readApprovals),
    founderCall(ctx, 'identity', 'actionApproval.list', 'GET', { view: 'mine', limit: APPROVALS_LIMIT }, readApprovals),
  ]);
  // Both views, publish approvals only, one row per approval. Either view failing fails the part: half a list would hide one.
  const failed = pending.kind !== 'ok' ? pending : mine.kind !== 'ok' ? mine : null;
  let approvals: Part<readonly PublishApproval[]>;
  if (failed || pending.kind !== 'ok' || mine.kind !== 'ok') approvals = partFrom(failed ?? pending, () => [], IDENTITY);
  else {
    const rows = new Map<string, PublishApproval>();
    for (const a of [...pending.data, ...mine.data])
      if (a.actionType === PUBLISH_ACTION && a.targetService === 'svc-notify') rows.set(a.approvalId, publishApprovalOf(a)!);
    approvals = { kind: 'ok', data: [...rows.values()] };
  }
  return {
    notices: partFrom(notices, (d) => d, NOTIFY),
    templates: partFrom(templates, (d) => d, NOTIFY),
    components: partFrom(definition, (d) => d.components.map((c) => ({ id: c.id, name: c.name })), NOTIFY),
    approvals,
    me: ctx.session.userId,
    asOf: new Date().toISOString(),
  };
}

function reply<T>(result: FounderCallResult<T>, what: string): { status: number; reply: IncidentDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => {
    const view = explainRefusal(code, status, uncertain);
    return { status: status >= 400 && status < 600 ? status : 502, reply: { ok: false as const, ...view } };
  };
  switch (result.kind) {
    case 'ok':
      return { status: 200, reply: { ok: true, what } };
    case 'refused':
      return refused(result.refusal.code, result.refusal.status);
    case 'forbidden':
      return refused(result.refusal.code ?? 'operator.denied', 403);
    case 'not_built':
      return refused('not_built', 501);
    case 'unavailable':
      return refused(null, 503, result.uncertain);
    case 'invalid':
      return refused(null, 502, true);
  }
}

const anyData = (raw: unknown) => (raw === undefined ? null : raw);

/**
 * The draft's key is its content: a lost reply sent again finds the same draft instead of making a second one, and the
 * same words drafted twice are one draft.
 */
export function draftKey(founder: string, input: IncidentDraftInput): string {
  const fields = [input.title.trim(), input.body.trim(), input.impact, [...input.components].sort(), input.parentId, input.resolves];
  return `incident-draft:${createHash('sha256')
    .update(JSON.stringify([founder, fields]))
    .digest('hex')
    .slice(0, 48)}`;
}

export async function draftIncident(ctx: FounderCallContext, input: IncidentDraftInput) {
  return reply(
    await founderCall(
      ctx,
      'notify',
      'notify.draftNotice',
      'POST',
      {
        kind: 'incident',
        title: input.title.trim(),
        body: input.body.trim(),
        impact: input.impact,
        components: input.components.length > 0 ? input.components : null,
        parentId: input.parentId,
        resolves: input.resolves,
        clientRequestId: draftKey(ctx.session.userId, input),
      },
      anyData,
    ),
    'drafted',
  );
}

type Proposal = { actionType: string; targetService: string; targetId: string; expectedVersion: string; payloadHash: string };
const readProposal = (raw: unknown): Proposal | null =>
  raw && typeof raw === 'object' && 'payloadHash' in raw && typeof (raw as Proposal).payloadHash === 'string' ? (raw as Proposal) : null;

/** Ask identity for the approval bound to this draft exactly as svc-notify holds it now. */
export async function requestPublish(ctx: FounderCallContext, noticeId: string) {
  const proposal = await founderCall(ctx, 'notify', 'notify.noticeProposal', 'GET', { id: noticeId }, readProposal);
  if (proposal.kind !== 'ok') return reply(proposal, 'requested');
  const { actionType, targetService, targetId, expectedVersion, payloadHash } = proposal.data;
  return reply(
    await founderCall(
      ctx,
      'identity',
      'actionApproval.propose',
      'POST',
      { actionType, targetService, targetId, expectedVersion, payloadHash, policyVersion: 'v1' },
      parseWith(actionApprovalSchema),
    ),
    'requested',
  );
}

/**
 * A second founder signs off on the draft as svc-notify holds it now (the hash is read again here, never from the browser).
 * The approved row comes back with the answer: identity lists an approval to its requester and, while pending, to the
 * other founders, so once decided the approver would not see it in a list.
 */
export async function approvePublish(ctx: FounderCallContext, noticeId: string, approvalId: string) {
  const proposal = await founderCall(ctx, 'notify', 'notify.noticeProposal', 'GET', { id: noticeId }, readProposal);
  if (proposal.kind !== 'ok') return reply(proposal, 'approved');
  const approved = await founderCall(
    ctx,
    'identity',
    'actionApproval.approve',
    'POST',
    { approvalId, expectedPayloadHash: proposal.data.payloadHash },
    parseWith(actionApprovalSchema),
  );
  const answer = reply(approved, 'approved');
  const approval = approved.kind === 'ok' ? publishApprovalOf(approved.data) : null;
  return approval && answer.reply.ok ? { ...answer, reply: { ...answer.reply, approval } } : answer;
}

/** svc-notify spends the approval once. The key is the approval: sending it again replays the stored answer. */
export async function publishIncident(ctx: FounderCallContext, noticeId: string, approvalId: string, operationId: string) {
  return reply(
    await founderCall(
      ctx,
      'notify',
      'notify.publishNotice',
      'POST',
      { id: noticeId, approvalId, operationId, clientRequestId: `incident-publish:${approvalId}` },
      anyData,
    ),
    'published',
  );
}

export interface TemplateInput {
  readonly id: string;
  readonly name: string;
  readonly group: string | null;
  readonly title: string;
  readonly body: string;
  readonly impact: string | null;
  readonly components: readonly string[];
}

export async function defineTemplate(ctx: FounderCallContext, input: TemplateInput) {
  return reply(await founderCall(ctx, 'notify', 'statusPage.templates.define', 'POST', input, anyData), 'template saved');
}

export async function retireTemplate(ctx: FounderCallContext, id: string) {
  return reply(await founderCall(ctx, 'notify', 'statusPage.templates.retire', 'POST', { id }, anyData), 'template retired');
}
