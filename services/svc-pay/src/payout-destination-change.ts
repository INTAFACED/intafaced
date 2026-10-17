import { customerStepUpPayloadHash, type ActionApproval, type ActionApprovalConsumeInput } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { ActionApprovalConsumeError, type ActionApprovalConsumer } from './action-approval-consume.js';
import {
  assertPersistableDestination,
  type DestinationState,
  type DestinationWriter,
  type MerchantPayoutDestinations,
} from './merchant-payout-destination.js';
import { recordMerchantNotification } from './merchant-ops/notifications.js';
import { PayError, type PayErrorCode } from './payment-service.js';
import type { MerchantRole } from './merchant-ops/roles.js';

/**
 * Add or change the destination a rail pays. A payout cannot do this.
 *
 * The first verified destination is active as soon as step-up succeeds.
 * A change of a verified destination waits until the hold passes. Blank hold
 * config refuses the change (`pay.destination_hold_unset`). An API key cannot
 * call this. `pay:payout` is not enough: the caller must be the merchant
 * owner or an admin.
 *
 * Step-up is the customer verifier from STEPUP #4880. The approval is minted
 * for `pay.step_up.payoutDestination.set` and consumed by svc-pay. The hash
 * is `customerStepUpPayloadHash` over actor, merchantId, railId, kind, ref.
 */

export const PAY_DESTINATION_STEP_UP = 'pay.step_up.payoutDestination.set' as const;

/** Positive integer seconds. Blank, zero, and junk are unset. There is no default. */
export function loadDestinationHoldSeconds(raw: string | undefined): number | null {
  const text = raw?.trim() ?? '';
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  const seconds = Number(text);
  if (!Number.isSafeInteger(seconds)) return null;
  return seconds;
}

export type DestinationCaller = {
  readonly userId: string;
  readonly sessionId: string;
  /** True when an `ifc_` key minted the token (`kid` is set). */
  readonly viaApiKey: boolean;
  /** No API key, MFA passed, not a sub-account. */
  readonly interactive: boolean;
};

export type DestinationChangeResult = {
  readonly status: 'active' | 'pending';
  readonly railId: string;
  readonly kind: string;
  readonly ref: string;
  readonly activatesAt: string | null;
};

export type DestinationRoleLookup = (userId: string, merchantId: string) => Promise<MerchantRole | null>;

const STEP_UP_CODE: PayErrorCode = 'pay.destination_step_up_required';

function refuse(code: PayErrorCode, message: string): never {
  throw new PayError(message, code);
}

/**
 * Consume one same-person approval. Identity minted it for svc-pay.
 * A missing, foreign, or mismatched approval refuses and nothing is written.
 */
export async function verifyDestinationStepUp(
  approvals: ActionApprovalConsumer,
  input: {
    readonly approvalId: string | null | undefined;
    readonly userId: string;
    readonly sessionId: string;
    readonly merchantId: string;
    readonly railId: string;
    readonly kind: string;
    readonly ref: string;
  },
): Promise<void> {
  const approvalId = input.approvalId?.trim() ?? '';
  if (!approvalId) refuse(STEP_UP_CODE, 'A fresh confirmation is required to change a payout destination');
  const fields = {
    actor: input.userId,
    merchantId: input.merchantId,
    railId: input.railId,
    kind: input.kind,
    ref: input.ref,
  };
  const payloadHash = customerStepUpPayloadHash(PAY_DESTINATION_STEP_UP, fields);
  let consumed: ActionApproval;
  try {
    consumed = await approvals.consume({
      approvalId,
      operationId: approvalId,
      payloadHash,
      targetService: 'svc-pay',
      targetId: PAY_DESTINATION_STEP_UP,
      expectedVersion: '1',
      principalUserId: input.userId,
      principalSessionId: input.sessionId,
    } satisfies ActionApprovalConsumeInput);
  } catch (err) {
    if (err instanceof ActionApprovalConsumeError) {
      refuse(STEP_UP_CODE, 'A fresh confirmation is required to change a payout destination');
    }
    refuse(STEP_UP_CODE, 'A fresh confirmation is required to change a payout destination');
  }
  if (
    consumed.kind !== 'same_person' ||
    consumed.status !== 'CONSUMED' ||
    consumed.requesterId !== input.userId ||
    consumed.approverId !== input.userId ||
    consumed.targetService !== 'svc-pay' ||
    consumed.targetId !== PAY_DESTINATION_STEP_UP
  ) {
    refuse(STEP_UP_CODE, 'A fresh confirmation is required to change a payout destination');
  }
}

export class PayoutDestinationChange {
  constructor(
    private readonly book: MerchantPayoutDestinations,
    private readonly roleOf: DestinationRoleLookup,
    private readonly verify: typeof verifyDestinationStepUp,
    private readonly approvals: ActionApprovalConsumer,
    private readonly holdSeconds: number | null,
    private readonly notify: (merchantId: string, title: string, body: string, dedupeKey: string) => Promise<void>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async set(input: {
    readonly caller: DestinationCaller;
    readonly merchantId: string;
    readonly railId: string;
    readonly kind: string;
    readonly ref: string;
    readonly stepUpApprovalId?: string | null;
  }): Promise<DestinationChangeResult> {
    const role = await this.roleOf(input.caller.userId, input.merchantId);
    if (role === null) refuse('pay.merchant_not_found', `Merchant ${input.merchantId} not found`);
    if (role !== 'owner' && role !== 'admin') {
      refuse('pay.destination_role_forbidden', 'Only an owner or admin can change a payout destination');
    }
    if (input.caller.viaApiKey) {
      refuse('pay.destination_api_key_refused', 'An API key cannot change a payout destination');
    }
    if (!input.caller.interactive) {
      refuse('pay.destination_session_required', 'Changing a payout destination needs an interactive session');
    }
    const dest = assertPersistableDestination(input.railId, input);
    await this.verify(this.approvals, {
      approvalId: input.stepUpApprovalId,
      userId: input.caller.userId,
      sessionId: input.caller.sessionId,
      merchantId: input.merchantId,
      railId: input.railId,
      kind: dest.kind,
      ref: dest.ref,
    });

    const now = this.clock();
    const written: { result: DestinationChangeResult | null; tellOwners: boolean } = { result: null, tellOwners: false };
    await this.book.transaction(input.merchantId, input.railId, async (row, write) => {
      const applied = await this.apply(row, dest, input.railId, now, write);
      written.result = applied.result;
      written.tellOwners = applied.tellOwners;
    });
    const result = written.result;
    if (!result) refuse('pay.payout_destination_missing', 'Payout destination was not stored');
    if (written.tellOwners) {
      const title = result.status === 'active' ? 'Payout destination added' : 'Payout destination change pending';
      const body =
        result.status === 'active'
          ? `A payout destination for ${input.railId} is active.`
          : `A payout destination for ${input.railId} is pending until ${result.activatesAt}.`;
      const stamp = result.activatesAt ?? now.toISOString();
      await this.notify(input.merchantId, title, body, `payout-destination:${input.railId}:${result.status}:${stamp}`);
    }
    return result;
  }

  private async apply(
    row: DestinationState | null,
    dest: { kind: string; ref: string },
    railId: string,
    now: Date,
    write: DestinationWriter,
  ): Promise<{ result: DestinationChangeResult; tellOwners: boolean }> {
    const sameActive = row?.verified === true && row.kind === dest.kind && row.ref === dest.ref && row.pending === null;
    if (sameActive) {
      return { result: { status: 'active', railId, kind: dest.kind, ref: dest.ref, activatesAt: null }, tellOwners: false };
    }
    const changingVerified = row?.verified === true && (row.kind !== dest.kind || row.ref !== dest.ref);
    if (changingVerified) {
      if (this.holdSeconds === null) {
        refuse('pay.destination_hold_unset', 'PAY_DESTINATION_HOLD_SECONDS is unset — a destination change is refused');
      }
      const activatesAt = new Date(now.getTime() + this.holdSeconds * 1000);
      await write.stagePending({ kind: dest.kind, ref: dest.ref, activatesAt });
      return {
        result: { status: 'pending', railId, kind: dest.kind, ref: dest.ref, activatesAt: activatesAt.toISOString() },
        tellOwners: true,
      };
    }
    const verifiedAt = now;
    if (row && !row.verified) await write.verifyExisting({ ...dest, verifiedAt });
    else await write.insertVerified({ ...dest, verifiedAt });
    return {
      result: { status: 'active', railId, kind: dest.kind, ref: dest.ref, activatesAt: null },
      tellOwners: true,
    };
  }
}

export function notifyMerchantOwners(sql: Sql): (merchantId: string, title: string, body: string, dedupeKey: string) => Promise<void> {
  return async (merchantId, title, body, dedupeKey) => {
    await recordMerchantNotification(sql, {
      merchantId,
      kind: 'payout_destination',
      title,
      body,
      subjectType: 'payout_destination',
      subjectId: merchantId,
      dedupeKey,
    });
  };
}

export async function roleOnMerchantForDestination(sql: Sql, userId: string, merchantId: string): Promise<MerchantRole | null> {
  const owned = await sql<Array<{ id: string }>>`
    SELECT id FROM pay.merchants WHERE id = ${merchantId} AND user_id = ${userId} LIMIT 1
  `;
  if (owned[0]) return 'owner';
  const member = await sql<Array<{ role: MerchantRole }>>`
    SELECT role FROM pay.merchant_team_members
     WHERE merchant_id = ${merchantId} AND user_id = ${userId} AND status = 'active'
     LIMIT 1
  `;
  if (!member[0]) {
    const exists = await sql<Array<{ id: string }>>`SELECT id FROM pay.merchants WHERE id = ${merchantId} LIMIT 1`;
    if (!exists[0]) return null;
    return null;
  }
  return member[0].role;
}
