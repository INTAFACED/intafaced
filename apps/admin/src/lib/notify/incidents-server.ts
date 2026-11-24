import 'server-only';
import { createHash } from 'node:crypto';
import { actionApprovalSchema } from '@intafaced/contracts';
import {
  parseWith,
  type FounderCallContext,
  type FounderCallResult,
  partFrom,
  type Part,
  type PartLabels,
  explainRefusal,
  founderRecordRead,
  founderRecordCall,
} from '@/lib/desk';
import { readDefinition } from './status-model';
import {
  readOperatorNotices,
  readPostmortems,
  readTemplates,
  type IncidentDeskReply,
  type IncidentDeskView,
  type IncidentDraftInput,
  type Impact,
  type OperatorNotice,
  type Postmortem,
  type PublishApproval,
  publishApprovalOf,
} from './incidents-model';
import {
  NOTIFY_OPERATOR_NOTICES,
  NOTIFY_DRAFT_NOTICE,
  NOTIFY_NOTICE_PROPOSAL,
  NOTIFY_PUBLISH_NOTICE,
} from '@intafaced/contracts/notify-notify-procedures';
import {
  NOTIFY_STATUS_PAGE_POSTMORTEMS_FOR_INCIDENTS,
  NOTIFY_STATUS_PAGE_TEMPLATES_LIST,
  NOTIFY_STATUS_PAGE_DEFINITION,
  NOTIFY_STATUS_PAGE_POSTMORTEMS_PROPOSAL,
  NOTIFY_STATUS_PAGE_POSTMORTEMS_WRITE,
  NOTIFY_STATUS_PAGE_POSTMORTEMS_PUBLISH,
  NOTIFY_STATUS_PAGE_TEMPLATES_DEFINE,
  NOTIFY_STATUS_PAGE_TEMPLATES_RETIRE,
} from '@intafaced/contracts/notify-status-page-procedures';
import { IDENTITY_ACTION_APPROVAL_PROPOSE, IDENTITY_ACTION_APPROVAL_APPROVE } from '@intafaced/contracts/identity-action-approval-records';
import { IDENTITY_ACTION_APPROVAL_LIST } from '@intafaced/contracts/identity-action-approval-procedures';

/**
 * The incident desk as the signed-in founder. svc-notify holds the incidents (`notify.operatorNotices`, drafts included),
 * the templates (`statusPage.templates.*`) and the exact approval a publish spends (`notify.noticeProposal`); identity
 * holds the approvals (`actionApproval.*`). Every call carries the founder's own token, so each service records who acted.
 */

export const NOTIFY: PartLabels = {
  service: 'svc-notify',
  forbiddenMessage:
    'svc-notify did not accept your founder session. The incident desk needs the operator write permission (admin:write) on a signed-in session with a second factor.',
};
const IDENTITY: PartLabels = {
  service: 'svc-identity',
  forbiddenMessage: 'svc-identity did not show your approvals. Founder approvals need a signed-in founder session with a second factor.',
};

export const PUBLISH_ACTION = 'notify.notice.publish';
export const POSTMORTEM_PUBLISH_ACTION = 'notify.postmortem.publish';
const DESK_ACTIONS: readonly string[] = [PUBLISH_ACTION, POSTMORTEM_PUBLISH_ACTION];
const LIST_LIMIT = 50;
const APPROVALS_LIMIT = 100;

const approvalList = parseWith(actionApprovalSchema.array());
const readApprovals = (raw: unknown) =>
  raw && typeof raw === 'object' && 'approvals' in raw ? approvalList((raw as { approvals: unknown }).approvals) : null;

const POSTMORTEMS_PER_CALL = 200;

/** The postmortems of the published incidents the desk shows, asked for by id. With no incidents read, none are asked for. */
async function postmortemsOf(ctx: FounderCallContext, notices: readonly OperatorNotice[] | null): Promise<Part<readonly Postmortem[]>> {
  if (notices === null)
    return {
      kind: 'failed',
      message: 'The incidents could not be read, so their postmortems were not asked for.',
      code: null,
      notBuilt: false,
      forbidden: false,
    };
  const ids = notices.filter((n) => n.kind === 'incident' && n.parentId === null && n.status === 'published').map((n) => n.id);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += POSTMORTEMS_PER_CALL) chunks.push(ids.slice(i, i + POSTMORTEMS_PER_CALL));
  const reads = await Promise.all(
    chunks.map((incidentIds) => founderRecordRead(ctx, NOTIFY_STATUS_PAGE_POSTMORTEMS_FOR_INCIDENTS, { incidentIds }, readPostmortems)),
  );
  const failed = reads.find((r) => r.kind !== 'ok');
  if (failed) return partFrom(failed, () => [], NOTIFY);
  return { kind: 'ok', data: reads.flatMap((r) => (r.kind === 'ok' ? r.data : [])) };
}

/**
 * The svc-notify publish approvals this founder can see: pending ones of the other founders and their own, one row per
 * approval. Either identity view failing fails the part: half a list would hide one.
 */
export async function loadPublishApprovals(ctx: FounderCallContext): Promise<Part<readonly PublishApproval[]>> {
  const [pending, mine] = await Promise.all([
    founderRecordRead(ctx, IDENTITY_ACTION_APPROVAL_LIST, { view: 'pending', limit: APPROVALS_LIMIT }, readApprovals),
    founderRecordRead(ctx, IDENTITY_ACTION_APPROVAL_LIST, { view: 'mine', limit: APPROVALS_LIMIT }, readApprovals),
  ]);
  if (pending.kind !== 'ok') return partFrom(pending, () => [], IDENTITY);
  if (mine.kind !== 'ok') return partFrom(mine, () => [], IDENTITY);
  const rows = new Map<string, PublishApproval>();
  for (const a of [...pending.data, ...mine.data])
    if (DESK_ACTIONS.includes(a.actionType) && a.targetService === 'svc-notify') rows.set(a.approvalId, publishApprovalOf(a)!);
  return { kind: 'ok', data: [...rows.values()] };
}

export async function loadIncidentDesk(ctx: FounderCallContext): Promise<IncidentDeskView> {
  const [notices, templates, definition, approvals] = await Promise.all([
    founderRecordRead(ctx, NOTIFY_OPERATOR_NOTICES, { kind: 'incident', limit: LIST_LIMIT }, readOperatorNotices),
    founderRecordRead(ctx, NOTIFY_STATUS_PAGE_TEMPLATES_LIST, undefined, readTemplates),
    founderRecordRead(ctx, NOTIFY_STATUS_PAGE_DEFINITION, undefined, readDefinition),
    loadPublishApprovals(ctx),
  ]);
  return {
    notices: partFrom(notices, (d) => d, NOTIFY),
    postmortems: await postmortemsOf(ctx, notices.kind === 'ok' ? notices.data : null),
    templates: partFrom(templates, (d) => d, NOTIFY),
    components: partFrom(definition, (d) => d.components.map((c) => ({ id: c.id, name: c.name })), NOTIFY),
    approvals,
    me: ctx.session.userId,
    asOf: new Date().toISOString(),
  };
}

export function reply<T>(result: FounderCallResult<T>, what: string): { status: number; reply: IncidentDeskReply } {
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

export const anyData = (raw: unknown) => (raw === undefined ? null : raw);

/**
 * The draft's key is its content and the newest entry the founder saw when writing it (`basis`): a lost reply sent again
 * finds the same draft instead of making a second one, while the same words written again later (a recurrence declared
 * from the same template, or "still monitoring" posted twice) are a new draft, since the desk has moved on since.
 */
export function draftKey(founder: string, input: IncidentDraftInput): string {
  const fields = [
    input.basis ?? null,
    input.title.trim(),
    input.body.trim(),
    input.impact,
    [...input.components].sort(),
    input.parentId,
    input.resolves,
  ];
  return `incident-draft:${createHash('sha256')
    .update(JSON.stringify([founder, fields]))
    .digest('hex')
    .slice(0, 48)}`;
}

export async function draftIncident(ctx: FounderCallContext, input: IncidentDraftInput) {
  return reply(
    await founderRecordRead(
      ctx,
      NOTIFY_DRAFT_NOTICE,
      {
        kind: 'incident',
        title: input.title.trim(),
        body: input.body.trim(),
        impact: input.impact,
        components: input.components.length > 0 ? [...input.components] : null,
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

/** What a publish spends: a notice draft, or the postmortem of an incident. */
export type PublishSubject =
  { readonly kind: 'notice'; readonly id: string } | { readonly kind: 'postmortem'; readonly incidentId: string };

/** The proposal as svc-notify holds the subject now; never taken from the browser. */
const proposalOf = (ctx: FounderCallContext, subject: PublishSubject) =>
  subject.kind === 'notice'
    ? founderRecordRead(ctx, NOTIFY_NOTICE_PROPOSAL, { id: subject.id }, readProposal)
    : founderRecordRead(ctx, NOTIFY_STATUS_PAGE_POSTMORTEMS_PROPOSAL, { incidentId: subject.incidentId }, readProposal);

/** Ask identity for the approval bound to this draft exactly as svc-notify holds it now. */
export async function requestPublish(ctx: FounderCallContext, subject: PublishSubject) {
  const proposal = await proposalOf(ctx, subject);
  if (proposal.kind !== 'ok') return reply(proposal, 'requested');
  const { actionType, targetService, targetId, expectedVersion, payloadHash } = proposal.data;
  return reply(
    await founderRecordCall(ctx, IDENTITY_ACTION_APPROVAL_PROPOSE, {
      actionType,
      targetService,
      targetId,
      expectedVersion,
      payloadHash,
      policyVersion: 'v1',
    }),
    'requested',
  );
}

/**
 * A second founder signs off on the draft as svc-notify holds it now (the hash is read again here, never from the browser).
 * The approved row comes back with the answer: identity lists an approval to its requester and, while pending, to the
 * other founders, so once decided the approver would not see it in a list.
 */
export async function approvePublish(ctx: FounderCallContext, subject: PublishSubject, approvalId: string) {
  const proposal = await proposalOf(ctx, subject);
  if (proposal.kind !== 'ok') return reply(proposal, 'approved');
  const approved = await founderRecordCall(ctx, IDENTITY_ACTION_APPROVAL_APPROVE, {
    approvalId,
    expectedPayloadHash: proposal.data.payloadHash,
  });
  const answer = reply(approved, 'approved');
  const approval = approved.kind === 'ok' ? publishApprovalOf(approved.data) : null;
  return approval && answer.reply.ok ? { ...answer, reply: { ...answer.reply, approval } } : answer;
}

/** svc-notify spends the approval once. The key is the approval: sending it again replays the stored answer. */
export async function publishIncident(ctx: FounderCallContext, noticeId: string, approvalId: string, operationId: string) {
  return reply(
    await founderRecordRead(
      ctx,
      NOTIFY_PUBLISH_NOTICE,
      { id: noticeId, approvalId, operationId, clientRequestId: `incident-publish:${approvalId}` },
      anyData,
    ),
    'published',
  );
}

/** A postmortem draft, naming the version it was written over (0 for the first). The same words again are a replay. */
export async function writePostmortem(ctx: FounderCallContext, input: { incidentId: string; body: string; expectedVersion: number }) {
  return reply(
    await founderRecordRead(
      ctx,
      NOTIFY_STATUS_PAGE_POSTMORTEMS_WRITE,
      { incidentId: input.incidentId, body: input.body.trim(), expectedVersion: input.expectedVersion },
      anyData,
    ),
    'postmortem saved',
  );
}

/** svc-notify spends the approval once; the same approval sent again answers the published postmortem. */
export async function publishPostmortem(ctx: FounderCallContext, incidentId: string, approvalId: string, operationId: string) {
  return reply(
    await founderRecordRead(ctx, NOTIFY_STATUS_PAGE_POSTMORTEMS_PUBLISH, { incidentId, approvalId, operationId }, anyData),
    'postmortem published',
  );
}

export interface TemplateInput {
  readonly id: string;
  readonly name: string;
  readonly group: string | null;
  readonly title: string;
  readonly body: string;
  readonly impact: Impact | null;
  readonly components: readonly string[];
}

export async function defineTemplate(ctx: FounderCallContext, input: TemplateInput) {
  return reply(
    await founderRecordRead(ctx, NOTIFY_STATUS_PAGE_TEMPLATES_DEFINE, { ...input, components: [...input.components] }, anyData),
    'template saved',
  );
}

export async function retireTemplate(ctx: FounderCallContext, id: string) {
  return reply(await founderRecordRead(ctx, NOTIFY_STATUS_PAGE_TEMPLATES_RETIRE, { id }, anyData), 'template retired');
}
