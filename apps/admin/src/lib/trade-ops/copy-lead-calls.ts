import 'server-only';
import type { ActionApproval } from '@intafaced/contracts';
import { serviceCode } from './approvals';
import { parseApproval } from './approvals-parse';
import {
  parseApplication,
  parseAudit,
  parseCriteria,
  parseListings,
  parseQueue,
  type LeadApplication,
  type LeadCriteria,
  type LeadDeskRead,
} from './copy-lead';
import { COPY_LEAD_ACTION_TYPE, COPY_LEAD_POLICY_VERSION, COPY_LEAD_TARGET_SERVICE, copyLeadPayloadHash } from './copy-lead-hash';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import { ok, type Outcome } from './outcome';

/**
 * The calls behind the Copy trading room. Server only: each is a real call to svc-trade (`copy.ops.*`) or svc-identity
 * (`actionApproval`) through svc-edge with the signed-in founder's own token. Nothing is cached or retried.
 */

/** Put svc-trade's own code (it ends the message in square brackets) on a refusal. */
function coded<T>(o: Outcome<T>): Outcome<T> {
  if (o.kind !== 'refused') return o;
  const code = serviceCode(o.code, o.message);
  return code === o.code ? o : { ...o, code, message: o.message.replace(/\s*\[[a-z_.]+\]\s*$/, '') };
}

const leadDesk = <T>(ctx: TradeCtx, proc: string, kind: 'query' | 'mutation', input: unknown, parse: (raw: unknown) => T | null) =>
  edgeCall(ctx, trpcSpec('trade', `copy.ops.leadDesk.${proc}`, kind, input, parse)).then(coded);

/** The queue, the leads and the audit, read together; any one refused refuses the read. */
export async function readLeadDesk(ctx: TradeCtx): Promise<Outcome<LeadDeskRead>> {
  const [queue, leads, audit] = await Promise.all([
    leadDesk(ctx, 'queue', 'query', {}, parseQueue),
    leadDesk(ctx, 'leads', 'query', {}, parseListings),
    leadDesk(ctx, 'audit', 'query', {}, parseAudit),
  ]);
  if (queue.kind !== 'ok') return queue;
  if (leads.kind !== 'ok') return leads;
  if (audit.kind !== 'ok') return audit;
  return ok({ queue: queue.data, leads: leads.data, audit: audit.data }, queue.asOf);
}

export function setLeadCriteria(
  ctx: TradeCtx,
  input: { minTrackRecordDays: number; clientRequestId: string },
): Promise<Outcome<LeadCriteria>> {
  return leadDesk(ctx, 'setCriteria', 'mutation', input, parseCriteria);
}

/** Founder A: file identity's approval, bound to the application, its name and the criteria in force now. */
export function fileLeadApproval(
  ctx: TradeCtx,
  input: { applicationId: string; displayName: string; minTrackRecordDays: number },
): Promise<Outcome<ActionApproval>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'identity',
      'actionApproval.propose',
      'mutation',
      {
        actionType: COPY_LEAD_ACTION_TYPE,
        targetService: COPY_LEAD_TARGET_SERVICE,
        targetId: input.applicationId,
        expectedVersion: 'pending',
        payloadHash: copyLeadPayloadHash(input),
        policyVersion: COPY_LEAD_POLICY_VERSION,
      },
      parseApproval,
    ),
  ).then(coded);
}

/** Founder B: approve identity's request, checking it carries the hash this desk computes for what it shows. */
export function approveLeadApproval(
  ctx: TradeCtx,
  input: { approvalId: string; expectedPayloadHash: string },
): Promise<Outcome<ActionApproval>> {
  return edgeCall(ctx, trpcSpec('identity', 'actionApproval.approve', 'mutation', input, parseApproval)).then(coded);
}

export function proposeLead(ctx: TradeCtx, input: { applicationId: string; approvalId: string }): Promise<Outcome<LeadApplication>> {
  return leadDesk(ctx, 'propose', 'mutation', input, parseApplication);
}

export function approveLead(
  ctx: TradeCtx,
  input: { applicationId: string; approvalId: string; operationId: string },
): Promise<Outcome<LeadApplication>> {
  return leadDesk(ctx, 'approve', 'mutation', input, parseApplication);
}

export function rejectLead(ctx: TradeCtx, input: { applicationId: string; reason: string }): Promise<Outcome<LeadApplication>> {
  return leadDesk(ctx, 'reject', 'mutation', input, parseApplication);
}

export function setLeadState(
  ctx: TradeCtx,
  input: { leaderRef: string; state: 'suspended'; reason: string; clientRequestId: string },
): Promise<Outcome<{ leaderRef: string; state: string }>> {
  return edgeCall(
    ctx,
    trpcSpec('trade', 'copy.ops.setLeaderState', 'mutation', input, (raw) => {
      const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
      return r && typeof r.leaderRef === 'string' && typeof r.state === 'string' ? { leaderRef: r.leaderRef, state: r.state } : null;
    }),
  ).then(coded);
}
