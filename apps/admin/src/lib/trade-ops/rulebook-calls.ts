import 'server-only';
import type { ActionApproval } from '@intafaced/contracts';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import { serviceCode } from './approvals';
import { parseApproval } from './approvals-parse';
import { MATCHING_EXPECTED_VERSION, MATCHING_POLICY_VERSION, MATCHING_TARGET_SERVICE } from './matching-controls';
import { ok, refused, type Outcome } from './outcome';
import {
  parseRulebookCheck,
  parseRulebookHistory,
  parseRulebookPublish,
  type MatchingAnswer,
  type RulebookCheck,
  type RulebookDraft,
  type RulebookHistory,
  type RulebookPublished,
} from './rulebook-model';

/**
 * The rulebook room's calls (RC-cex-spot-08, J-cex-spot-20 #6). Reads go to the public `GET /api/v1/rulebook/versions`
 * (svc-trade passes svc-matching's answer on); the draft check and the publish go to svc-edge's founder doors onto
 * svc-matching (`/admin/matching/rulebook/check`, `/publish`); the approval is filed with identity. svc-matching checks the
 * draft and consumes the approval itself: nothing here decides that a version is whole or approved.
 */

export interface RulebookDeskView {
  readonly history: Outcome<RulebookHistory>;
  readonly asOf: string;
}

export async function loadRulebookDesk(ctx: TradeCtx): Promise<RulebookDeskView> {
  const history = await edgeCall(ctx, { method: 'GET', path: '/api/v1/rulebook/versions', parse: parseRulebookHistory });
  return { history, asOf: new Date().toISOString() };
}

function draftBody(draft: RulebookDraft): Record<string, unknown> {
  return {
    version: draft.version,
    sections: draft.sections,
    ...(draft.effectiveAt.trim() ? { effectiveAt: draft.effectiveAt.trim() } : {}),
  };
}

function answered<T>(o: Outcome<MatchingAnswer<T>>): Outcome<T> {
  if (o.kind !== 'ok') return o;
  return o.data.accepted ? ok(o.data.data, o.asOf) : refused(o.data.code, o.data.message, 409, null, o.asOf);
}

/** svc-matching reads the draft: a blank section or an edit of a published version is refused by its own code. */
export async function checkRulebookDraft(ctx: TradeCtx, draft: RulebookDraft): Promise<Outcome<RulebookCheck>> {
  return answered(
    await edgeCall(ctx, { method: 'POST', path: '/admin/matching/rulebook/check', body: draftBody(draft), parse: parseRulebookCheck }),
  );
}

/** File the two-person request for exactly the draft svc-matching checked: its target and payload hash. */
export async function proposeRulebook(ctx: TradeCtx, check: RulebookCheck): Promise<Outcome<ActionApproval>> {
  const o = await edgeCall(
    ctx,
    trpcSpec(
      'identity',
      'actionApproval.propose',
      'mutation',
      {
        actionType: check.actionType,
        targetService: MATCHING_TARGET_SERVICE,
        targetId: check.targetId,
        expectedVersion: MATCHING_EXPECTED_VERSION,
        payloadHash: check.payloadHash,
        policyVersion: MATCHING_POLICY_VERSION,
      },
      parseApproval,
    ),
  );
  if (o.kind !== 'refused') return o;
  const code = serviceCode(o.code, o.message);
  return code === o.code ? o : { ...o, code };
}

/** Publish an approved draft. svc-matching recomputes the payload hash and consumes the approval. */
export async function publishRulebook(
  ctx: TradeCtx,
  draft: RulebookDraft,
  approval: { readonly approvalId: string; readonly operationId: string },
): Promise<Outcome<RulebookPublished>> {
  return answered(
    await edgeCall(ctx, {
      method: 'POST',
      path: '/admin/matching/rulebook/publish',
      body: { ...draftBody(draft), approvalId: approval.approvalId, operationId: approval.operationId },
      parse: parseRulebookPublish,
    }),
  );
}
