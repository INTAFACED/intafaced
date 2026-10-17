import 'server-only';
import { founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import type { AccountControlResult, AccountControlState, ActionApproval } from '@intafaced/contracts';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import {
  restrictionTargetId,
  serviceCode,
  RESTRICTION_ACTION_TYPE,
  RESTRICTION_POLICY_VERSION,
  RESTRICTION_TARGET_SERVICE,
  type ActOnApproval,
  type ProposeInput,
} from './approvals';
import { parseApproval } from './approvals-parse';
import { parseHistory, parseResult, parseState } from './restrictions-parse';
import type { RestrictionChange } from './restrictions';
import { refused, type Outcome } from './outcome';

/**
 * The calls behind the Freezes & approvals, Audit and Exports rooms. Server only: each one is a real call to
 * svc-trade (accountControls) or svc-identity (actionApproval) through svc-edge, signed with the signed-in
 * operator's own token, and returns an Outcome. Nothing is cached, nothing is retried.
 */

/** Put the service's own code (it hides in the message) on a refusal, so the UI can say it in words. */
function withServiceCode<T>(o: Outcome<T>): Outcome<T> {
  if (o.kind !== 'refused') return o;
  const code = serviceCode(o.code, o.message);
  return code === o.code ? o : { ...o, code };
}

// ── svc-trade accountControls ───────────────────────────────────────────────

export interface RestrictionState {
  /** null = the service has no trading account for that user id. */
  readonly state: AccountControlState | null;
}

export async function readRestrictionState(ctx: TradeCtx, userId: string): Promise<Outcome<RestrictionState>> {
  return withServiceCode(
    await edgeCall(
      ctx,
      trpcSpec('trade', 'accountControls.getState', 'query', { target: { area: 'trading', userId } }, (raw) => {
        const s = parseState(raw);
        return s === undefined ? null : { state: s };
      }),
    ),
  );
}

export async function readRestrictionHistory(ctx: TradeCtx, userId: string, limit = 50): Promise<Outcome<readonly AccountControlResult[]>> {
  return withServiceCode(
    await edgeCall(
      ctx,
      trpcSpec('trade', 'accountControls.history', 'query', { target: { area: 'trading', userId }, limit }, parseHistory),
    ),
  );
}

/** accountControls.change: only reachable once the two-person action type exists (blocker restriction_no_four_eyes). Kept ready, not wired to any button. */
export async function changeRestriction(
  ctx: TradeCtx,
  change: RestrictionChange,
  requestId: string,
): Promise<Outcome<AccountControlResult>> {
  return withServiceCode(
    await edgeCall(
      ctx,
      trpcSpec(
        'trade',
        'accountControls.change',
        'mutation',
        {
          requestId,
          target: { area: 'trading', userId: change.userId },
          action: change.action,
          reason: change.reason,
          expectedVersion: change.expectedVersion,
        },
        parseResult,
      ),
    ),
  );
}

// ── svc-identity actionApproval ─────────────────────────────────────────────

/**
 * The hash identity stores for a restriction proposal and an approver must repeat. Same canonical function the
 * merchant controls use (`founderChangeHash`): sorted keys, fixed collation, so the machine never changes it.
 */
export const restrictionPayloadHash = (p: ProposeInput): string =>
  founderChangeHash({ area: 'trading', userId: p.userId, action: p.action, reason: p.reason }, p.expectedVersion);

export async function proposeRestriction(ctx: TradeCtx, p: ProposeInput): Promise<Outcome<ActionApproval>> {
  return withServiceCode(
    await edgeCall(
      ctx,
      trpcSpec(
        'identity',
        'actionApproval.propose',
        'mutation',
        {
          actionType: RESTRICTION_ACTION_TYPE,
          targetService: RESTRICTION_TARGET_SERVICE,
          targetId: restrictionTargetId(p.userId),
          expectedVersion: p.expectedVersion,
          payloadHash: restrictionPayloadHash(p),
          policyVersion: RESTRICTION_POLICY_VERSION,
        },
        parseApproval,
      ),
    ),
  );
}

export async function actOnApproval(ctx: TradeCtx, a: ActOnApproval): Promise<Outcome<ActionApproval>> {
  // Same person: refuse here too, before any call, from what the signed-in session says.
  if (a.verb !== 'revoke' && a.knownRequesterId && a.knownRequesterId.toLowerCase() === ctx.session.userId.toLowerCase())
    return refused(
      'action_approval.same_person',
      'The person who proposed this cannot approve or reject it. A different signed-in operator must do it.',
      409,
    );
  const input =
    a.verb === 'approve' ? { approvalId: a.approvalId, expectedPayloadHash: a.expectedPayloadHash } : { approvalId: a.approvalId };
  return withServiceCode(await edgeCall(ctx, trpcSpec('identity', `actionApproval.${a.verb}`, 'mutation', input, parseApproval)));
}
