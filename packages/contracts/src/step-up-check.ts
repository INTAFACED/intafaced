/**
 * Identity's step-up check, for a service that spends a customer step-up (CB-bots-05: svc-trade's grid profit
 * withdrawal). The service holds no step-up logic: it names the scope, the signed-in user and session, the business
 * fields the person confirmed and the approval id they sent, and this check
 *
 *   1. hashes those fields exactly as identity hashed them at begin (`customerStepUpPayloadHash`, `actor` = the user),
 *   2. consumes the approval at identity once (single use, the same user and session, five minutes), with a business
 *      request id so a retry after a lost reply replays instead of refusing,
 *   3. accepts the answer only when it is this person's same-person approval for this scope at this service.
 *
 * It fails closed. No approval, or one identity refuses (spent, expired, foreign or for other details), is
 * `identity.step_up_required`: the person confirms again. Identity unwired, unreachable or answering something
 * unreadable is `identity.step_up_unavailable`: nothing was read or written, and a new confirmation would fail the
 * same way. The caller returns either code unchanged.
 */
import { ACTION_APPROVAL_CONSUME_FAILED } from './action-approval-client.js';
import {
  samePersonTargetService,
  type ActionApproval,
  type ActionApprovalConsumeInput,
  type SamePersonActionType,
} from './action-approval.js';
import { customerStepUpPayloadHash, doorForScope } from './customer-step-up.js';

export const STEP_UP_CHECK_CODES = ['identity.step_up_required', 'identity.step_up_unavailable'] as const;
export type StepUpCheckCode = (typeof STEP_UP_CHECK_CODES)[number];

export class StepUpCheckError extends Error {
  constructor(
    message: string,
    readonly code: StepUpCheckCode,
  ) {
    super(message);
    this.name = 'StepUpCheckError';
  }
}

/** What the check needs from the identity client: `createIdentityApprovalClient(...)` is one. */
export interface StepUpApprovalConsumer {
  consume(input: ActionApprovalConsumeInput): Promise<ActionApproval>;
}

/** A consumer error the check may read: the shared client's `fail` builds these. */
type CodedError = { readonly code?: unknown; readonly message?: unknown };

export type StepUpCheckRequest = {
  readonly scope: SamePersonActionType;
  readonly userId: string;
  readonly sessionId: string;
  /** The approval id the person sent beside the call. Blank or absent refuses `identity.step_up_required`. */
  readonly approvalId: string | null | undefined;
  /** Exactly the door's client fields (and any optional ones sent), as the person confirmed them. Never `actor`. */
  readonly fields: Readonly<Record<string, string>>;
  /** A business key for this one operation. A retry with the same key after a lost reply is answered, not refused. */
  readonly requestId: string;
};

export type StepUpCheckResult = {
  /** The consumed approval: the step-up event a receipt may name. It is an id, never a secret. */
  readonly stepUpEventId: string;
  readonly consumedAt: string | null;
  /**
   * True when identity answered a retry of the same request id, after a lost reply: the approval was already spent by
   * this request. The caller re-reads its own outcome by the business key and never applies the change a second time.
   */
  readonly replayed: boolean;
};

export interface StepUpCheck {
  require(req: StepUpCheckRequest): Promise<StepUpCheckResult>;
}

const IDENTITY_REFUSAL = /\[action_approval\.[a-z_]+\]/;
/** The shared client's refusal line: `identity refused consume (<status>) …`. A 5xx is identity failing, tagged or not. */
const IDENTITY_STATUS = /identity refused consume \((\d{3})\)/;
/** The consume wire caps both ids (`actionApprovalConsumeInputSchema`). */
const ID_MAX = 128;

const required = (why: string): never => {
  throw new StepUpCheckError(`Confirm this with your passkey or authenticator code first: ${why}`, 'identity.step_up_required');
};
const unavailable = (why: string): never => {
  throw new StepUpCheckError(
    `Your confirmation could not be checked right now, so nothing was changed: ${why}`,
    'identity.step_up_unavailable',
  );
};

/**
 * `service` is the calling service. It must be the scope's target service: identity refuses any other consumer, so a
 * mismatch is refused here as unavailable before identity is asked.
 */
export function createStepUpCheck(opts: { readonly service: string; readonly approvals: StepUpApprovalConsumer | null }): StepUpCheck {
  return {
    async require(req) {
      const door = doorForScope(req.scope);
      if (!door) return unavailable(`no step-up door for ${req.scope}`);
      const targetService = samePersonTargetService(req.scope);
      if (targetService !== opts.service) return unavailable(`${req.scope} is spent by ${targetService}, not ${opts.service}`);
      const approvalId = req.approvalId?.trim() ?? '';
      if (approvalId === '') return required('no confirmation was sent');
      if (approvalId.length > ID_MAX) return required('that is not a confirmation identity issued');
      if (req.requestId.trim() === '' || req.requestId.length > ID_MAX) {
        throw new Error(`step-up check: the request id must be 1 to ${ID_MAX} characters`);
      }
      const keys = Object.keys(req.fields);
      const optional = Object.keys(door.optionalFields ?? {});
      if (
        keys.includes('actor') ||
        door.clientFields.some((key) => req.fields[key] === undefined) ||
        keys.some((key) => !door.clientFields.includes(key) && !optional.includes(key))
      ) {
        return unavailable(`the fields sent for ${req.scope} are not the door's fields`);
      }
      if (!opts.approvals) return unavailable('identity is not wired in this deployment');
      const payloadHash = customerStepUpPayloadHash(req.scope, { ...req.fields, actor: req.userId });
      let consumed: ActionApproval;
      try {
        consumed = await opts.approvals.consume({
          approvalId,
          // Identity mints a customer step-up with its own id as the operation id and the scope as the target.
          operationId: approvalId,
          payloadHash,
          targetService,
          targetId: req.scope,
          expectedVersion: '1',
          principalUserId: req.userId,
          principalSessionId: req.sessionId,
          requestId: req.requestId,
        });
      } catch (err) {
        const coded = (err ?? {}) as CodedError;
        // Identity answered with its own refusal code: the person confirms again.
        const status = typeof coded.message === 'string' ? Number(IDENTITY_STATUS.exec(coded.message)?.[1] ?? NaN) : NaN;
        if (
          coded.code === ACTION_APPROVAL_CONSUME_FAILED &&
          typeof coded.message === 'string' &&
          IDENTITY_REFUSAL.test(coded.message) &&
          status >= 400 &&
          status < 500
        ) {
          return required('identity did not accept that confirmation for this request');
        }
        return unavailable('identity did not answer the check');
      }
      if (
        consumed.kind !== 'same_person' ||
        consumed.status !== 'CONSUMED' ||
        consumed.requesterId !== req.userId ||
        consumed.approverId !== req.userId ||
        consumed.actionType !== req.scope ||
        consumed.targetService !== targetService ||
        consumed.targetId !== req.scope
      ) {
        return required('that confirmation is not this person’s confirmation of this request');
      }
      return {
        stepUpEventId: consumed.approvalId,
        consumedAt: consumed.consumedAt ?? null,
        replayed: consumed.consumption === 'already_consumed_by_this_request',
      };
    },
  };
}
