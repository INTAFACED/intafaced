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
    /** Whole seconds until `availableAt`, on the database clock that decided "too soon". */
    readonly secondsLeft: number | null = null,
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

type WarnLog = { warn(obj: Record<string, unknown>, msg: string): void };

export class SelfFreezeLift {
  /** Structured warn sink, as AuthService: one JSON line on stderr until index.ts swaps in the Fastify logger. */
  private log: WarnLog = {
    warn: (obj, msg) => process.stderr.write(`${JSON.stringify({ level: 'warn', ...obj, msg })}\n`),
  };

  constructor(
    private readonly sql: Sql,
    private readonly waitSeconds: number | undefined,
  ) {}

  useLogger(log: WarnLog): void {
    this.log = log;
  }

  /** The wait must be published before the router spends a step-up on a lift that cannot happen. */
  assertConfigured(): void {
    assertLiftWaitSet(this.waitSeconds);
  }

  /**
   * Read-only due check, run before the router spends a step-up: an open freeze still inside the wait
   * refuses `identity.self_freeze_lift_too_soon` now, so no approval is burnt on a lift that cannot happen.
   * `lift` re-checks under the row lock; this is not the authority.
   */
  async assertDue(userId: string): Promise<void> {
    const wait = this.waitSeconds;
    assertLiftWaitSet(wait);
    const open = await this.sql<Array<{ available_at: Date; due: boolean; seconds_left: number }>>`
      SELECT since + make_interval(secs => ${wait}) AS available_at,
             since + make_interval(secs => ${wait}) <= now() AS due,
             ceil(extract(epoch FROM since + make_interval(secs => ${wait}) - now()))::int AS seconds_left
        FROM account_self_freezes WHERE user_id = ${userId} AND state = 'frozen'`;
    const row = open[0];
    if (row && !row.due)
      throw new SelfFreezeLiftError('identity.self_freeze_lift_too_soon', row.available_at, Math.max(1, row.seconds_left));
  }

  async lift(userId: string): Promise<SelfFreezeLiftResult> {
    const wait = this.waitSeconds;
    assertLiftWaitSet(wait);
    const result = await transaction(this.sql, async (tx): Promise<SelfFreezeLiftResult> => {
      await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const open = await tx<Array<{ id: string; available_at: Date; due: boolean; seconds_left: number }>>`
        SELECT id,
               since + make_interval(secs => ${wait}) AS available_at,
               since + make_interval(secs => ${wait}) <= now() AS due,
               ceil(extract(epoch FROM since + make_interval(secs => ${wait}) - now()))::int AS seconds_left
          FROM account_self_freezes WHERE user_id = ${userId} AND state = 'frozen'`;
      const row = open[0];
      // Nothing open: already lifted (a retry after a lost reply) answers the same, changes nothing.
      if (!row) return { frozen: false as const, changed: false, liftedAt: null };
      if (!row.due) throw new SelfFreezeLiftError('identity.self_freeze_lift_too_soon', row.available_at, Math.max(1, row.seconds_left));
      const lifted = await tx<Array<{ lifted_at: Date }>>`
        UPDATE account_self_freezes SET state = 'lifted', lifted_at = now() WHERE id = ${row.id} RETURNING lifted_at`;
      return { frozen: false as const, changed: true, liftedAt: lifted[0]!.lifted_at };
    });
    // Logged after commit, as `auth.self_frozen` is: a lift that rolled back is never reported.
    if (result.changed) this.log.warn({ userId, liftedAt: result.liftedAt?.toISOString() ?? null }, 'auth.self_freeze_lifted');
    return result;
  }
}
