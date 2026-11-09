/**
 * SUPPORT WITHDRAWAL FREEZE (J-support-public-20 #7, RC-support-public-06): svc-support asks, from a customer's request,
 * that the customer's withdrawals be frozen. This service records it: the account's security lock (`set_by = 'support'`,
 * the agent as `set_by_user_id`), which already stops withdrawals and changes to withdrawal addresses, and one
 * `support_withdrawal_freezes` row naming the request, the agent and the reason, in one transaction.
 *
 * It only takes power away: no balance, no ledger entry, and existing holds stay as they are. A lock that already holds
 * (the customer's own, or an earlier one) stays as it is and is recorded with `lock_set = false`; a waiting unlock
 * request is withdrawn, as the customer's own lock does. Asking again from the same request on the same lock answers the
 * first record. Support has no door that lifts the lock: only the customer's own unlock, after the owner's wait, ends it.
 *
 * `POST SUPPORT_WITHDRAWAL_FREEZE_PATH`, signed with the body bound. Only svc-support (`SUPPORT_WITHDRAWAL_FREEZE_CALLERS`)
 * may call it: unsigned is 401, any other service 403, bad input 400, an unknown customer 404, a failed write 503.
 */
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import {
  retainRawBody,
  SUPPORT_WITHDRAWAL_FREEZE_CALLERS,
  SUPPORT_WITHDRAWAL_FREEZE_PATH,
  supportWithdrawalFreezeInputSchema,
  type ServiceBodyBindMode,
  type SupportWithdrawalFreezeInput,
  type SupportWithdrawalFreezeResult,
} from '@intafaced/contracts';
import { SecurityLockError, type SecurityLock } from './security-lock.js';
import { serviceOfRequest, type IdentityS2s } from '../s2s-door.js';

export async function freezeWithdrawalsForSupport(
  lock: Pick<SecurityLock, 'lockWith'>,
  input: SupportWithdrawalFreezeInput,
): Promise<SupportWithdrawalFreezeResult> {
  const { change, recorded } = await lock.lockWith(input.userId, { kind: 'support', userId: input.operatorId }, async (tx: Sql, held) => {
    const inserted = await tx<Array<{ id: string; recorded_at: Date }>>`
      INSERT INTO support_withdrawal_freezes (user_id, lock_id, ticket_id, operator_id, reason, lock_set)
      VALUES (${input.userId}, ${held.id}, ${input.ticketId}, ${input.operatorId}, ${input.reason}, ${held.changed})
      ON CONFLICT (ticket_id, lock_id) DO NOTHING
      RETURNING id, recorded_at`;
    if (inserted[0]) return { ...inserted[0], fresh: true };
    const first = await tx<Array<{ id: string; recorded_at: Date }>>`
      SELECT id, recorded_at FROM support_withdrawal_freezes WHERE ticket_id = ${input.ticketId} AND lock_id = ${held.id}`;
    return { ...first[0]!, fresh: false };
  });
  const { changed: _changed, ...view } = change;
  return {
    recordedBy: 'svc-identity',
    lock: view,
    changed: recorded.fresh,
    auditId: recorded.id,
    recordedAt: recorded.recorded_at.toISOString(),
  };
}

export function registerSupportWithdrawalFreezeRoute(
  app: FastifyInstance,
  deps: {
    internalSecret: string;
    s2s?: IdentityS2s;
    bodyBind?: ServiceBodyBindMode;
    installRawBody?: boolean;
    freeze: (input: SupportWithdrawalFreezeInput) => Promise<SupportWithdrawalFreezeResult>;
  },
): void {
  if (deps.installRawBody !== false) retainRawBody(app);
  app.post(SUPPORT_WITHDRAWAL_FREEZE_PATH, async (req, reply) => {
    // The body is always bound: a freeze is a write, so a replayed signature can't carry another customer or reason.
    const { service } = serviceOfRequest(req, deps.internalSecret, 'require', deps.s2s);
    if (service === null) return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    if (!(SUPPORT_WITHDRAWAL_FREEZE_CALLERS as readonly string[]).includes(service))
      return reply
        .code(403)
        .send({ error: 'the withdrawal freeze is for the support service only', code: 'identity.support_freeze_forbidden' });
    const parsed = supportWithdrawalFreezeInputSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'withdrawal freeze input is invalid', code: 'identity.support_freeze_input' });
    try {
      return await deps.freeze(parsed.data);
    } catch (err) {
      if (err instanceof SecurityLockError && err.code === 'identity.security_lock_not_found')
        return reply.code(404).send({ error: 'account not found', code: 'identity.account_not_found' });
      return reply.code(503).send({ error: 'withdrawal freeze unavailable', code: 'identity.support_freeze_unavailable' });
    }
  });
}
