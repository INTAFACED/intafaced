/**
 * SUPPORT ACCOUNT FREEZE (J-support-public-20 #7, RC-support-public-07, RC-support-public-06): svc-support asks, from a
 * customer's request, that the customer's account be frozen. This service records it in one transaction: the account's
 * trading restriction (`trading_restrictions.restricted`, the one founder controls set, so every fresh svc-trade
 * operation refuses `trade.account_restricted` in `operation-identity-decisions.ts`) and one `support_account_freezes`
 * row naming the request, the agent and the reason. The relay below then announces each row on the bus
 * (`supportAccountFrozen`), so every service that keeps a permission for an agent to act for the customer revokes it.
 *
 * It only takes power away: no balance, no ledger entry, and the customer's own wallet and venue account are not
 * touched. A restriction that already holds stays as it is, with its reason code, and is recorded with
 * `restriction_set = false`. Asking again from the same request while the same restriction holds answers the first
 * record. Support has no door that lifts it: only the founder controls' four-eyes restore does.
 *
 * The doors are the records `IDENTITY_SUPPORT_ACCOUNT_FREEZE` and `IDENTITY_SUPPORT_ACCOUNT_FREEZE_RECORDS`, signed with
 * the body bound. Only svc-support may call them: unsigned is 401, any other service 403, bad input 400, an unknown
 * customer 404, a failed write 503.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from 'postgres';
import type { EventBus } from '@intafaced/events';
import { httpRecordHandler } from '@intafaced/contracts/procedure-http';
import {
  IDENTITY_SUPPORT_ACCOUNT_FREEZE,
  IDENTITY_SUPPORT_ACCOUNT_FREEZE_RECORDS,
  type SupportAccountFreezeInput,
  type SupportAccountFreezeRecords,
  type SupportAccountFreezeResult,
} from '@intafaced/contracts/support-account-freeze';
import { transaction } from '@intafaced/db';
import { lockFounderControls } from '../controls/founder-control-lock.js';
import { serviceOfRequest, type IdentityS2s } from '../s2s-door.js';

const IdRow = z.object({ id: z.string() });
const RestrictionRow = z.object({ restricted: z.boolean(), version: z.string() });
const RecordedRow = z.object({ id: z.string(), recorded_at: z.date() });
const AuditRow = z.object({
  id: z.string(),
  ticket_id: z.string(),
  operator_id: z.string(),
  reason: z.string(),
  restriction_set: z.boolean(),
  recorded_at: z.date(),
});
const DueRow = z.object({ user_id: z.string(), recorded_at: z.date(), published_at: z.date().nullable() });

export class SupportAccountFreezeNotFound extends Error {
  readonly code = 'identity.account_not_found' as const;
  constructor() {
    super('account not found');
    this.name = 'SupportAccountFreezeNotFound';
  }
}

export async function freezeAccountForSupport(sql: Sql, input: SupportAccountFreezeInput): Promise<SupportAccountFreezeResult> {
  const userId = input.userId.toLowerCase();
  return transaction(
    sql,
    async (tx) => {
      // The founder controls' order: their lock, then the user row, then the restriction row.
      await lockFounderControls(tx);
      const [user] = IdRow.array().parse(await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
      if (!user) throw new SupportAccountFreezeNotFound();
      const [row] = RestrictionRow.array().parse(
        await tx`SELECT restricted, version::text AS version FROM trading_restrictions WHERE user_id = ${userId} FOR UPDATE`,
      );
      const held = row?.restricted === true;
      const version = held ? row.version : (BigInt(row?.version ?? '0') + 1n).toString();
      const [first] = RecordedRow.array().parse(
        await tx`SELECT id, recorded_at FROM support_account_freezes
          WHERE ticket_id = ${input.ticketId} AND restriction_version = ${version}::bigint AND user_id = ${userId}`,
      );
      if (first) return result(userId, first, false);
      if (!held)
        // A new restriction carries no reason code: the customer reads "No reason recorded", never the agent's words.
        await tx`INSERT INTO trading_restrictions (user_id, restricted, version, reason_code)
          VALUES (${userId}, true, ${version}::bigint, NULL)
          ON CONFLICT (user_id) DO UPDATE SET restricted = true, version = EXCLUDED.version, reason_code = NULL, updated_at = now()`;
      const inserted = RecordedRow.parse(
        (
          await tx`INSERT INTO support_account_freezes (user_id, ticket_id, operator_id, reason, restriction_version, restriction_set)
            VALUES (${userId}, ${input.ticketId}, ${input.operatorId}, ${input.reason}, ${version}::bigint, ${!held})
            RETURNING id, recorded_at`
        )[0],
      );
      return result(userId, inserted, true);
    },
    { isolation: 'read committed' },
  );
}

function result(userId: string, row: { id: string; recorded_at: Date }, changed: boolean): SupportAccountFreezeResult {
  return {
    recordedBy: 'svc-identity',
    userId,
    tradingRestricted: true,
    changed,
    auditId: row.id,
    recordedAt: row.recorded_at.toISOString(),
  };
}

/** The audit rows one request's freezes wrote for its customer, oldest first. A request of another customer reads none. */
export async function supportAccountFreezeRecords(
  sql: Sql,
  input: { userId: string; ticketId: string },
): Promise<SupportAccountFreezeRecords> {
  const rows = AuditRow.array().parse(
    await sql`SELECT id, ticket_id, operator_id, reason, restriction_set, recorded_at FROM support_account_freezes
      WHERE user_id = ${input.userId.toLowerCase()} AND ticket_id = ${input.ticketId}
      ORDER BY recorded_at, id LIMIT 50`,
  );
  return {
    recordedBy: 'svc-identity',
    records: rows.map((row) => ({
      id: row.id,
      ticketId: row.ticket_id,
      operatorId: row.operator_id,
      reason: row.reason,
      restrictionSet: row.restriction_set,
      recordedAt: row.recorded_at.toISOString(),
    })),
  };
}

type Deps = { readonly sql: Sql; readonly internalSecret: string; readonly s2s?: IdentityS2s };

const freezeAnswer = httpRecordHandler(IDENTITY_SUPPORT_ACCOUNT_FREEZE, (deps: Deps, input) => freezeAccountForSupport(deps.sql, input));
const recordsAnswer = httpRecordHandler(IDENTITY_SUPPORT_ACCOUNT_FREEZE_RECORDS, (deps: Deps, input) =>
  supportAccountFreezeRecords(deps.sql, input),
);

/** Both doors; the raw body is already retained by the app (the body is always bound: a freeze is a write). */
export function registerSupportAccountFreezeRoutes(app: FastifyInstance, deps: Deps): void {
  const doors = [
    [IDENTITY_SUPPORT_ACCOUNT_FREEZE, freezeAnswer],
    [IDENTITY_SUPPORT_ACCOUNT_FREEZE_RECORDS, recordsAnswer],
  ] as const;
  for (const [record, answer] of doors) {
    const callers: readonly string[] = record.access.callers;
    app.post(record.path, async (req, reply) => {
      const { service } = serviceOfRequest(req, deps.internalSecret, 'require', deps.s2s);
      if (service === null) return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
      if (!callers.includes(service))
        return reply
          .code(403)
          .send({ error: 'the account freeze is for the support service only', code: 'identity.support_freeze_forbidden' });
      if (!record.input.safeParse(req.body).success)
        return reply.code(400).send({ error: 'account freeze input is invalid', code: 'identity.support_freeze_input' });
      try {
        return await answer(deps, req.body);
      } catch (err) {
        if (err instanceof SupportAccountFreezeNotFound) return reply.code(404).send({ error: 'account not found', code: err.code });
        return reply.code(503).send({ error: 'account freeze unavailable', code: 'identity.support_freeze_unavailable' });
      }
    });
  }
}

/**
 * The relay: announces each support account freeze whose `published_at` is null on the bus (`supportAccountFrozen`), at
 * least once, with the business key `identity.support_account_freeze.frozen:<id>`. A row another run holds is skipped;
 * a publish that fails leaves the row for the next run. Moves no money.
 */
export async function relaySupportAccountFreezeEvents(
  deps: { readonly sql: Sql; readonly bus: Pick<EventBus, 'publish'>; readonly now: () => Date },
  limit = 50,
): Promise<number> {
  const due = IdRow.array().parse(
    await deps.sql`SELECT id FROM support_account_freezes WHERE published_at IS NULL ORDER BY recorded_at, id LIMIT ${limit}`,
  );
  let published = 0;
  let failure: unknown;
  for (const { id } of due) {
    try {
      published += await deps.sql.begin(async (tx) => {
        const [row] = DueRow.array().parse(
          await tx`SELECT user_id, recorded_at, published_at FROM support_account_freezes WHERE id = ${id} FOR UPDATE SKIP LOCKED`,
        );
        if (!row || row.published_at) return 0;
        await deps.bus.publish(
          'supportAccountFrozen',
          { userId: row.user_id, freezeId: id, since: row.recorded_at.toISOString() },
          { idempotencyKey: `identity.support_account_freeze.frozen:${id}` },
        );
        await tx`UPDATE support_account_freezes SET published_at = ${deps.now()} WHERE id = ${id}`;
        return 1;
      });
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure !== undefined) throw failure;
  return published;
}
