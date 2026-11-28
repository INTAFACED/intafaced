/**
 * TRADING RESTRICTION READ (J-support-public-20 #7): whether identity refuses a new order for one person now, by the
 * record `IDENTITY_TRADING_RESTRICTION`. It answers the same facts identity's operation decision refuses
 * `trade.account_restricted` on (`operation-identity-decisions.ts`): the account's trading restriction
 * (`trading_restrictions.restricted`, which a support agent's account freeze and the founder controls set) or a staff
 * close with a grace date, which ends trading first. svc-trade's user-venue door reads it per order, since it relays
 * the person's own signed venue order and asks no operation decision; it keeps no copy.
 *
 * Only svc-trade may call it: unsigned is 401, any other service 403, a malformed or unknown person 404 (which the caller
 * refuses on, never reads as unrestricted), a failed read 503.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from 'postgres';
import { IDENTITY_TRADING_RESTRICTION } from '@intafaced/contracts/identity-trading-restriction-procedures';
import type { ServiceBodyBindMode } from '@intafaced/contracts';
import { serviceOfRequest, type IdentityS2s } from '../s2s-door.js';

type TradingRestriction = z.output<typeof IDENTITY_TRADING_RESTRICTION.output>;

const Row = z.object({ id: z.string(), restricted: z.boolean() });

/** The person's trading restriction now, or null for a person identity does not hold. */
async function tradingRestrictionOf(sql: Sql, userId: string): Promise<TradingRestriction | null> {
  if (!IDENTITY_TRADING_RESTRICTION.params.shape.userId.safeParse(userId).success) return null;
  const rows = Row.array().parse(
    await sql`
      SELECT u.id,
             (u.close_grace_until IS NOT NULL OR COALESCE(t.restricted, false)) AS restricted
        FROM users u LEFT JOIN trading_restrictions t ON t.user_id = u.id
       WHERE u.id = ${userId.toLowerCase()} LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  return IDENTITY_TRADING_RESTRICTION.output.parse({ userId: row.id, restricted: row.restricted });
}

export function registerTradingRestrictionRoute(
  app: FastifyInstance,
  deps: {
    readonly sql: Sql;
    readonly internalSecret: string;
    readonly bodyBind: ServiceBodyBindMode | undefined;
    readonly s2s?: IdentityS2s;
  },
): void {
  const callers: readonly string[] = IDENTITY_TRADING_RESTRICTION.access.callers;
  app.get<{ Params: { userId: string } }>(IDENTITY_TRADING_RESTRICTION.path, async (req, reply) => {
    const { service } = serviceOfRequest(req, deps.internalSecret, deps.bodyBind, deps.s2s);
    if (service === null) return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    if (!callers.includes(service))
      return reply.code(403).send({ error: 'the trading restriction is read by svc-trade only', code: 'identity.forbidden' });
    let state: TradingRestriction | null;
    try {
      state = await tradingRestrictionOf(deps.sql, req.params.userId);
    } catch {
      return reply.code(503).send({ error: 'trading restriction unavailable', code: 'identity.trading_restriction_unavailable' });
    }
    if (!state) return reply.code(404).send({ error: 'account not found', code: 'identity.account_not_found' });
    return state;
  });
}
