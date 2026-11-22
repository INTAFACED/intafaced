/**
 * Inbound HMAC mill for usage.settle / usage.settleSession.
 * Session admin:write is not a service caller — refuse-closed.
 */
import { TRPCError } from '@trpc/server';
import { requireServiceCaller } from '@intafaced/contracts/service-auth';

export const SETTLE_CALLER = 'svc-agents' as const;

export function requireSettleService(service: string | null): asserts service is typeof SETTLE_CALLER {
  requireServiceCaller(service);
  if (service !== SETTLE_CALLER) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'usage settle is callable only as svc-agents',
    });
  }
}
