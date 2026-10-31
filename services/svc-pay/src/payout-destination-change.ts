import { createHash } from 'node:crypto';
import { customerStepUpPayloadHash, type ActionApproval, type ActionApprovalConsumeInput } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { ActionApprovalConsumeError, type ActionApprovalConsumer } from './action-approval-consume.js';
import {
  assertPersistableDestination,
  destinationLifecycle,
  type DestinationState,
  type DestinationWriter,
  type MerchantPayoutDestinations,
} from './merchant-payout-destination.js';
import { maskDestination } from './control/mask-destination.js';
import { recordMerchantNotification } from './merchant-ops/notifications.js';
import { PayError, type PayErrorCode } from './payment-service.js';
import type { MerchantRole } from './merchant-ops/roles.js';

/**
 * Save, verify or change the destination a rail pays. A payout cannot do this.
 *
 * J-merchant-02 #5: `add` saves a destination unverified (no step-up); nothing
 * is paid to it. `set` with a fresh step-up verifies it (or saves and verifies
 * one in a single call): it is then held until `verifiedAt + hold` and reads
 * Active after that. A change of a verified destination is staged as pending
 * until the hold passes. Blank hold config refuses a verification or a change
 * (`pay.destination_hold_unset`) and writes nothing. An API key cannot call
 * either. `pay:payout` is not enough: the caller must be the merchant owner or
 * an admin, in an interactive session.
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
  /** `held` until `activatesAt`. `pending`: a change of a verified one waits for `activatesAt`. */
  readonly status: 'held' | 'active' | 'pending';
  readonly railId: string;
  readonly kind: string;
  readonly ref: string;
  readonly activatesAt: string | null;
};

/** What `add` answers: the destination as saved, unverified. */
export type DestinationSavedResult = {
  readonly status: 'unverified';
  readonly railId: string;
  readonly kind: string;
  readonly ref: string;
  readonly activatesAt: null;
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
    await this.assertCaller(input.caller, input.merchantId);
    const dest = assertPersistableDestination(input.railId, input);
    // Checked before the step-up is spent (and again under the row lock): verifying never swaps the saved address.
    assertVerifiesSaved(await this.book.read({ merchantId: input.merchantId, railId: input.railId }), dest);
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
      const title = result.status === 'held' ? 'Payout destination verified' : 'Payout destination change pending';
      const masked = maskDestination(result.kind, result.ref);
      const body =
        result.status === 'held'
          ? `A payout destination for ${input.railId} (${masked}) is verified and becomes active at ${result.activatesAt}.`
          : `A payout destination change for ${input.railId} to ${masked} is pending until ${result.activatesAt}.`;
      const stamp = result.activatesAt ?? now.toISOString();
      await this.notify(input.merchantId, title, body, `payout-destination:${input.railId}:${result.status}:${stamp}`);
    }
    return result;
  }

  /**
   * Save a destination unverified. No step-up: nothing can be paid to it until
   * `set` verifies it. Saving again on the rail replaces an unverified row; a
   * verified one is refused (`pay.payout_destination_verified_locked`), since
   * it changes only through step-up plus the hold. Same caller rules as `set`.
   */
  async add(input: {
    readonly caller: DestinationCaller;
    readonly merchantId: string;
    readonly railId: string;
    readonly kind: string;
    readonly ref: string;
  }): Promise<DestinationSavedResult> {
    await this.assertCaller(input.caller, input.merchantId);
    const dest = assertPersistableDestination(input.railId, input);
    let tellOwners = false;
    await this.book.transaction(input.merchantId, input.railId, async (row, write) => {
      if (row?.verified) {
        refuse(
          'pay.payout_destination_verified_locked',
          'A verified payout destination changes only with a fresh confirmation and the hold',
        );
      }
      if (row && row.kind === dest.kind && row.ref === dest.ref) return;
      if (row) await write.replaceUnverified(dest);
      else await write.insertUnverified(dest);
      tellOwners = true;
    });
    if (tellOwners) {
      await this.notify(
        input.merchantId,
        'Payout destination added',
        `A payout destination for ${input.railId} (${maskDestination(dest.kind, dest.ref)}) was saved. It is unverified and cannot receive a payout until it is verified.`,
        // The save's own time is in the key, so saving A, then B, then A again tells the owners each time.
        `payout-destination:${input.railId}:unverified:${createHash('sha256').update(`${dest.kind}:${dest.ref}`).digest('hex').slice(0, 16)}:${this.clock().toISOString()}`,
      );
    }
    return { status: 'unverified', railId: input.railId, kind: dest.kind, ref: dest.ref, activatesAt: null };
  }

  /**
   * Cancel a hold: a held destination goes back to unverified (the lead's ruling, 2026-10-30 19:19). The owner only,
   * in an interactive session, never an API key. No step-up: it only lowers risk (nothing can be paid to an unverified
   * destination). Cancelling an unverified one changes nothing and tells nobody again. An active one is refused
   * `pay.payout_destination_not_held`; a pending change of an active one is not this door's to cancel.
   */
  async cancelHold(input: {
    readonly caller: DestinationCaller;
    readonly merchantId: string;
    readonly destinationId: string;
  }): Promise<{ readonly destinationId: string; readonly state: 'unverified'; readonly changed: boolean }> {
    await this.assertCaller(input.caller, input.merchantId, ['owner']);
    const out = await this.book.cancelHold({ merchantId: input.merchantId, destinationId: input.destinationId });
    if (out.changed) {
      await this.notify(
        input.merchantId,
        'Payout destination verification cancelled',
        `The waiting period for the payout destination for ${out.railId} (${maskDestination(out.kind, out.ref)}) was cancelled. It is unverified and cannot receive a payout until it is verified again.`,
        `payout-destination:${out.railId}:hold-cancelled:${createHash('sha256').update(`${out.kind}:${out.ref}`).digest('hex').slice(0, 16)}:${this.clock().toISOString()}`,
      );
    }
    return { destinationId: input.destinationId, state: 'unverified', changed: out.changed };
  }

  private async assertCaller(
    caller: DestinationCaller,
    merchantId: string,
    roles: readonly MerchantRole[] = ['owner', 'admin'],
  ): Promise<void> {
    const role = await this.roleOf(caller.userId, merchantId);
    if (role === null) refuse('pay.merchant_not_found', `Merchant ${merchantId} not found`);
    if (!roles.includes(role)) {
      refuse(
        'pay.destination_role_forbidden',
        roles.includes('admin')
          ? 'Only an owner or admin can change a payout destination'
          : 'Only the owner can do this to a payout destination',
      );
    }
    if (caller.viaApiKey) {
      refuse('pay.destination_api_key_refused', 'An API key cannot change a payout destination');
    }
    if (!caller.interactive) {
      refuse('pay.destination_session_required', 'Changing a payout destination needs an interactive session');
    }
  }

  private async apply(
    row: DestinationState | null,
    dest: { kind: string; ref: string },
    railId: string,
    now: Date,
    write: DestinationWriter,
  ): Promise<{ result: DestinationChangeResult; tellOwners: boolean }> {
    assertVerifiesSaved(row, dest);
    const sameVerified = row?.verified === true && row.kind === dest.kind && row.ref === dest.ref && row.pending === null;
    if (sameVerified) {
      // Verifying again changes nothing: the hold keeps its first end.
      const life = destinationLifecycle(row, now);
      return {
        result: {
          status: life.state === 'held' ? 'held' : 'active',
          railId,
          kind: dest.kind,
          ref: dest.ref,
          activatesAt: life.activatesAt?.toISOString() ?? null,
        },
        tellOwners: false,
      };
    }
    if (row?.verified === true && row.kind === dest.kind && row.ref === dest.ref && row.pending !== null) {
      // Confirming the current address while a change to another one waits would not cancel that change (there is no
      // cancel door yet), so it is refused by name rather than written over.
      refuse('pay.destination_change_pending', 'A change of this payout destination is pending until its hold passes');
    }
    // A held destination (verified, not yet active) changed to another address is verified afresh below: the new one
    // waits the whole hold, as a pending change would, and nothing was payable before.
    const changingVerified =
      row?.verified === true && destinationLifecycle(row, now).state === 'active' && (row.kind !== dest.kind || row.ref !== dest.ref);
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
    if (this.holdSeconds === null) {
      refuse('pay.destination_hold_unset', 'PAY_DESTINATION_HOLD_SECONDS is unset — verifying a payout destination is refused');
    }
    const verifiedAt = now;
    const activatesAt = new Date(now.getTime() + this.holdSeconds * 1000);
    if (row) await write.verifyExisting({ ...dest, verifiedAt, activatesAt });
    else await write.insertVerified({ ...dest, verifiedAt, activatesAt });
    return {
      result: { status: 'held', railId, kind: dest.kind, ref: dest.ref, activatesAt: activatesAt.toISOString() },
      tellOwners: true,
    };
  }
}

/**
 * Verify must verify the saved address: with an unverified row on the rail, a different kind or ref is refused
 * (`pay.destination_verify_mismatch`) and nothing is written. Replacing an unverified address goes through `add`, which
 * carries the in-flight check. With no row, `set` saves and verifies in one call (the go-live save).
 */
function assertVerifiesSaved(row: DestinationState | null, dest: { kind: string; ref: string }): void {
  if (row && !row.verified && (row.kind !== dest.kind || row.ref !== dest.ref)) {
    refuse('pay.destination_verify_mismatch', 'That is not the payout destination saved for this rail; save the new one first');
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
