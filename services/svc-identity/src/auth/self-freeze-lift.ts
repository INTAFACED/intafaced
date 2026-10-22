/**
 * W-security-accounts-03, the customer half of unfreeze: lifting the owner's own freeze.
 *
 * `selfFreeze` (I-account-lifecycle-08) applies at once. Lifting it needs (1) a fresh step-up for
 * `identity.step_up.self_freeze_lift`, spent by the router through the existing SecurityStepUp guard,
 * and (2) the owner-set wait since the freeze began (IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS). A blank
 * wait refuses (`identity.self_freeze_lift_wait_unset`); it never means "no wait". The time check runs
 * on the database clock inside the row lock, never a wall-clock read in the app. A staff freeze is a
 * different control and is never lifted here; neither is the ledger posting freeze.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';

export type SelfFreezeLiftCode = 'identity.self_freeze_lift_wait_unset' | 'identity.self_freeze_lift_too_soon';

export class SelfFreezeLiftError extends Error {
  constructor(
    readonly code: SelfFreezeLiftCode,
    readonly availableAt: Date | null = null,
  ) {
    super(code);
    this.name = 'SelfFreezeLiftError';
  }
}

export type SelfFreezeLiftResult = { frozen: false; changed: boolean; liftedAt: Date | null };

/** Owner value in whole seconds. Blank / unset → undefined (refuse). Zero is a published "no wait". */
export function parseSelfFreezeLiftWait(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  if (!/^\d+$/.test(raw.trim())) throw new Error('IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS must be whole seconds');
  const n = Number(raw.trim());
  if (n > 30 * 24 * 3600) throw new Error('IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS is above 30 days');
  return n;
}

/** Fail closed before any write when the owner has not published a wait. */
export function assertLiftWaitSet(waitSeconds: number | undefined): asserts waitSeconds is number {
  if (waitSeconds === undefined) throw new SelfFreezeLiftError('identity.self_freeze_lift_wait_unset');
}

export class SelfFreezeLift {
  constructor(
    private readonly sql: Sql,
    private readonly waitSeconds: number | undefined,
  ) {}

  /** The wait must be published before the router spends a step-up on a lift that cannot happen. */
  assertConfigured(): void {
    assertLiftWaitSet(this.waitSeconds);
  }

  async lift(userId: string): Promise<SelfFreezeLiftResult> {
    const wait = this.waitSeconds;
    assertLiftWaitSet(wait);
    return transaction(this.sql, async (tx) => {
      await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const open = await tx<Array<{ id: string; available_at: Date; due: boolean }>>`
        SELECT id,
               since + make_interval(secs => ${wait}) AS available_at,
               since + make_interval(secs => ${wait}) <= now() AS due
          FROM account_self_freezes WHERE user_id = ${userId} AND state = 'frozen'`;
      const row = open[0];
      // Nothing open: already lifted (a retry after a lost reply) answers the same, changes nothing.
      if (!row) return { frozen: false as const, changed: false, liftedAt: null };
      if (!row.due) throw new SelfFreezeLiftError('identity.self_freeze_lift_too_soon', row.available_at);
      const lifted = await tx<Array<{ lifted_at: Date }>>`
        UPDATE account_self_freezes SET state = 'lifted', lifted_at = now() WHERE id = ${row.id} RETURNING lifted_at`;
      return { frozen: false as const, changed: true, liftedAt: lifted[0]!.lifted_at };
    });
  }
}
