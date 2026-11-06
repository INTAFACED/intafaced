import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { ok, refused, type Outcome } from '@/lib/trade-ops/outcome';
import { approvedFor, proposeApproval, readMembers, readTerms, writeMember, writeTerms } from '@/lib/trade-ops/maker-programme-calls';
import { memberDraft, termsDraft } from '@/lib/trade-ops/maker-programme-drafts';
import {
  checkMember,
  checkTerms,
  MAKER_MEMBER_ACTION_TYPE,
  MAKER_PROGRAMME_TERM_UNSET,
  MAKER_PROGRAMME_TIER_UNKNOWN,
  MAKER_TERMS_ACTION_TYPE,
  MAKER_TERMS_TARGET,
  type MemberInput,
  type TermsInput,
} from '@/lib/trade-ops/maker-programme-model';
import {
  MAKER_MEMBER_POLICY_VERSION,
  MAKER_TERMS_POLICY_VERSION,
  memberPayloadHash,
  termsPayloadHash,
} from '@/lib/trade-ops/maker-programme-view';

/**
 * Maker programme room (J-cex-spot-20 #8, RC-cex-spot-06), through svc-trade `admin.makerProgramme.*` and identity's
 * approvals.
 *
 *   POST { action: 'propose-terms', draft }               file the two-person request for the next terms version
 *   POST { action: 'apply-terms', draft, approvalId }     write it, once APPROVED
 *   POST { action: 'propose-member', draft }              file a member's admission or change
 *   POST { action: 'apply-member', draft, approvalId }    write it, once APPROVED
 *
 * The version a request is bound to is read here from svc-trade, never taken from the page. A blank refuses by name with
 * svc-trade's own code before anything is filed; svc-trade checks again when it writes. No money moves here.
 */
export const dynamic = 'force-dynamic';

const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
const bad = (code: string, message: string) => refused(code, message, 400);

type Req<T> = { value: T; expectedVersion: string; payloadHash: string; targetId: string };

async function termsReq(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<Req<TermsInput>>> {
  const draft = termsDraft(body.draft);
  if (!draft) return bad('trade_ops.terms_draft_invalid', 'The terms are not complete. Read the room again.');
  const check = checkTerms(draft);
  if (!check.ok) return bad(check.code, `${check.message}.`);
  const current = await readTerms(ctx);
  if (current.kind !== 'ok') return current;
  const expectedVersion = current.data.terms?.version ?? '0';
  return ok({
    value: check.value,
    expectedVersion,
    payloadHash: termsPayloadHash(expectedVersion, check.value),
    targetId: MAKER_TERMS_TARGET,
  });
}

async function memberReq(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<Req<MemberInput>>> {
  const draft = memberDraft(body.draft);
  if (!draft) return bad('trade_ops.member_draft_invalid', 'The member is not complete. Read the room again.');
  const check = checkMember(draft);
  if (!check.ok) return bad(check.code, `${check.message}.`);
  const [terms, members] = await Promise.all([readTerms(ctx), readMembers(ctx)]);
  if (terms.kind !== 'ok') return terms;
  if (members.kind !== 'ok') return members;
  if (!terms.data.terms) return bad(MAKER_PROGRAMME_TERM_UNSET, 'The programme has no terms. Write the terms before admitting a member.');
  if (!terms.data.terms.tiers.some((t) => t.name === check.value.tier))
    return bad(MAKER_PROGRAMME_TIER_UNKNOWN, `Tier ${check.value.tier} is not in the programme terms v${terms.data.terms.version}.`);
  const expectedVersion = members.data.find((m) => m.accountId === check.value.accountId)?.version ?? '0';
  return ok({
    value: check.value,
    expectedVersion,
    payloadHash: memberPayloadHash(expectedVersion, check.value),
    targetId: check.value.accountId!,
  });
}

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  const terms = body.action === 'propose-terms' || body.action === 'apply-terms';
  const member = body.action === 'propose-member' || body.action === 'apply-member';
  if (!terms && !member) return bad('trade_ops.bad_action', 'Unknown maker programme action.');
  const req = terms ? await termsReq(ctx, body) : await memberReq(ctx, body);
  if (req.kind !== 'ok') return req;
  const { expectedVersion, payloadHash, targetId } = req.data;
  const actionType = terms ? MAKER_TERMS_ACTION_TYPE : MAKER_MEMBER_ACTION_TYPE;
  if (body.action === 'propose-terms' || body.action === 'propose-member') {
    const filed = await proposeApproval(ctx, {
      actionType,
      targetId,
      expectedVersion,
      payloadHash,
      policyVersion: terms ? MAKER_TERMS_POLICY_VERSION : MAKER_MEMBER_POLICY_VERSION,
    });
    return filed.kind === 'ok' ? ok({ approval: filed.data, payloadHash, expectedVersion }, filed.asOf) : filed;
  }
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : '';
  if (!TOKEN.test(approvalId)) return bad('trade_ops.approval_id_invalid', 'Enter the id of an APPROVED request.');
  const approval = await approvedFor(ctx, approvalId, { actionType, targetId, payloadHash });
  if (approval.kind !== 'ok') return approval;
  const write = { expectedVersion, approvalId, clientRequestId: approval.data.operationId };
  return terms
    ? writeTerms(ctx, { ...write, terms: req.data.value as TermsInput })
    : writeMember(ctx, { ...write, member: req.data.value as MemberInput });
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
