/**
 * Spot cancel-all-after, the dead-man switch.
 *
 * A trader arms a countdown (`armCancelAllAfter`) and keeps re-arming it while their session is alive. When the
 * deadline passes with no re-arm, `sweepCancelAllAfter` cancels every open order of that user through the ordinary
 * `cancelAllOrders` path (engine first, one hold release per order), as the caller who armed it.
 *
 * Authority: the sweep has no caller, so the caller's own claims are stored with the countdown (as a bracket stores
 * its place grant) and arming is refused unless the credential outlives the deadline. A countdown whose stored
 * authority has lapsed anyway is counted and dropped, never covered by minting a principal from a user id.
 *
 * Timeouts are the owner's published set; a blank set refuses arming. Timeout 0 always disarms, because turning
 * the switch off can never put a customer at risk.
 *
 * Installed onto TradeService.prototype so trade-service.ts never moves.
 */
import type { Sql } from 'postgres';
import { requireScope, type Principal } from '@intafaced/auth';
import { armCancelAllAfter as planArm } from '../futures/cancel-all-after.js';
import { captureAlgoPlaceGrant, parseAlgoPlaceGrant, principalFromAlgoGrant } from '../algo/durable-principal.js';
import { TradeError, type OrderRecord } from './types.js';
import { TradeService } from './trade-service.js';

const FLAG = Symbol.for('intafaced.trade.cancelAllAfter');

type Host = {
  sql: Sql;
  now: () => Date;
  cancelAllOrders: (principal: Principal) => Promise<OrderRecord[]>;
};

export interface ArmedCountdown {
  readonly armed: boolean;
  readonly timeoutSec: number;
  readonly deadline: Date | null;
}

/** The two methods this module installs on TradeService. */
export interface CancelAllAfterHost {
  armCancelAllAfter(principal: Principal, timeoutSec: number, published: readonly number[] | null): Promise<ArmedCountdown>;
  sweepCancelAllAfter(): Promise<CancelAllAfterSweep>;
}

export interface CancelAllAfterSweep {
  readonly examined: number;
  readonly fired: number;
  readonly unavailable: number;
  readonly failed: number;
}

const MAX_PER_PASS = 200;

async function arm(host: Host, principal: Principal, timeoutSec: number, published: readonly number[] | null): Promise<ArmedCountdown> {
  requireScope(principal, 'trade:write');
  if (timeoutSec === 0) {
    await host.sql`DELETE FROM trade.cancel_all_after WHERE user_id = ${principal.userId}`;
    return { armed: false, timeoutSec: 0, deadline: null };
  }
  if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 0) {
    throw new TradeError('cancel-all-after timeout must be a whole number of seconds', 'trade.cancel_all_after_rejected');
  }
  if (published === null || published.length === 0) {
    throw new TradeError('cancel-all-after timeouts are not published; trade does not invent one', 'trade.cancel_all_after_unset');
  }
  const now = host.now();
  const planned = planArm({
    callerId: principal.userId,
    timeoutSec,
    publishedTimeouts: published,
    nowMs: now.getTime(),
    countdownId: `${principal.userId}:${now.getTime()}`,
  });
  if (!planned.ok || planned.armed === null) {
    throw new TradeError('that cancel-all-after timeout is not one of the published values', 'trade.cancel_all_after_rejected');
  }
  const deadline = new Date(planned.armed.deadlineMs);
  if (!(principal.expiresAt instanceof Date) || principal.expiresAt.getTime() < deadline.getTime()) {
    throw new TradeError(
      'cancel-all-after needs a credential with a known expiry at or after the deadline; renew the credential first',
      'trade.cancel_all_after_rejected',
    );
  }
  await host.sql`
    INSERT INTO trade.cancel_all_after (user_id, timeout_sec, deadline_at, grant_claims, grant_expires_at, armed_at)
    VALUES (${principal.userId}, ${timeoutSec}, ${deadline}, ${host.sql.json(captureAlgoPlaceGrant(principal) as never)}, ${principal.expiresAt}, ${now})
    ON CONFLICT (user_id) DO UPDATE SET
      timeout_sec = EXCLUDED.timeout_sec,
      deadline_at = EXCLUDED.deadline_at,
      grant_claims = EXCLUDED.grant_claims,
      grant_expires_at = EXCLUDED.grant_expires_at,
      armed_at = EXCLUDED.armed_at
  `;
  return { armed: true, timeoutSec, deadline };
}

async function sweep(host: Host): Promise<CancelAllAfterSweep> {
  const now = host.now();
  const rows = await host.sql<Array<{ user_id: string; deadline_at: Date; grant_claims: unknown; grant_expires_at: Date }>>`
    SELECT user_id, deadline_at, grant_claims, grant_expires_at
      FROM trade.cancel_all_after
     WHERE deadline_at <= ${now}
     ORDER BY deadline_at
     LIMIT ${MAX_PER_PASS}
  `;
  let fired = 0;
  let unavailable = 0;
  let failed = 0;
  // Removing a row only when its deadline is still the one this pass read means a re-arm that landed during the
  // cancel pass survives it.
  const drop = (userId: string, deadline: Date) =>
    host.sql`DELETE FROM trade.cancel_all_after WHERE user_id = ${userId} AND deadline_at = ${deadline}`;
  for (const row of rows) {
    const deadline = new Date(row.deadline_at);
    const grant = parseAlgoPlaceGrant(row.grant_claims);
    let principal: Principal | null = null;
    if (grant) {
      try {
        principal = principalFromAlgoGrant({ userId: row.user_id, grant, expiresAt: new Date(row.grant_expires_at), now });
      } catch {
        principal = null;
      }
    }
    if (principal === null) {
      unavailable += 1;
      await drop(row.user_id, deadline);
      continue;
    }
    try {
      await host.cancelAllOrders(principal);
      await drop(row.user_id, deadline);
      fired += 1;
    } catch {
      // Left armed: the next pass retries, and each order already cancelled stays cancelled.
      failed += 1;
    }
  }
  return { examined: rows.length, fired, unavailable, failed };
}

export function installCancelAllAfter(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    armCancelAllAfter?: unknown;
    sweepCancelAllAfter?: unknown;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;
  proto.armCancelAllAfter = function (this: TradeService, principal: Principal, timeoutSec: number, published: readonly number[] | null) {
    return arm(this as unknown as Host, principal, timeoutSec, published);
  };
  proto.sweepCancelAllAfter = function (this: TradeService) {
    return sweep(this as unknown as Host);
  };
}

installCancelAllAfter(TradeService);
