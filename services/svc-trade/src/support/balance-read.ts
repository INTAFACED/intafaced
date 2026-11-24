/**
 * SUPPORT READ OF ONE CUSTOMER'S BALANCE (J-support-public-20 #2, RC-support-public-01): the door of the record
 * `SUPPORT_CUSTOMER_BALANCE_READ`. svc-support asks it for the customer of a request that holds the customer's own live
 * grant (svc-support checks the grant and lists the read to the customer; svc-trade cannot read the support tables).
 *
 * The answer is the customer's balance by asset, the same projection of the ledger their own balance read gives
 * (`GET /api/v1/account/balance`): no second balance store, no recipe, no post. Only svc-support may call it, signed with
 * the body bound. Unsigned is 401, any other service 403, bad input 400, and a read that fails is 503, never an empty
 * balance.
 */
import type { FastifyInstance } from 'fastify';
import type { ServiceAuthMode, ServiceVerifier, SupportCustomerBalances } from '@intafaced/contracts';
import { httpRecordHandler } from '@intafaced/contracts/procedure-http';
import { verifyServiceRequest } from '@intafaced/contracts/service-auth-http';
import { SUPPORT_CUSTOMER_BALANCE_READ } from '@intafaced/contracts/support-read-grants';

export interface SupportBalanceReadDeps {
  /** The customer's balance by asset, as their own balance read presents it. */
  readonly balances: (userId: string) => Promise<SupportCustomerBalances>;
  readonly secret: string;
  readonly s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode };
}

const answer = httpRecordHandler(SUPPORT_CUSTOMER_BALANCE_READ, async (deps: SupportBalanceReadDeps, input) => ({
  balances: await deps.balances(input.userId.toLowerCase()),
}));

export function registerSupportBalanceRead(app: FastifyInstance, deps: SupportBalanceReadDeps): void {
  const callers: readonly string[] = SUPPORT_CUSTOMER_BALANCE_READ.access.callers;
  app.post(SUPPORT_CUSTOMER_BALANCE_READ.path, async (req, reply) => {
    let caller: string | null = null;
    try {
      caller =
        typeof deps.secret === 'string' && deps.secret.length > 0
          ? verifyServiceRequest(req, {
              verifier: deps.s2s?.verifier,
              mode: deps.s2s?.mode,
              legacySecret: deps.secret,
              bodyBindMode: 'require',
            }).service
          : null;
    } catch {
      caller = null;
    }
    if (caller === null) return reply.code(401).send({ error: 'service credentials required', code: 'trade.unauthenticated' });
    if (!callers.includes(caller))
      return reply.code(403).send({ error: 'this balance read is for the support service only', code: 'trade.support_read_forbidden' });
    if (!SUPPORT_CUSTOMER_BALANCE_READ.input.safeParse(req.body).success)
      return reply.code(400).send({ error: 'balance read input is invalid', code: 'trade.support_read_input' });
    try {
      return await answer(deps, req.body);
    } catch {
      return reply.code(503).send({ error: 'balance read unavailable', code: 'trade.support_read_unavailable' });
    }
  });
}
