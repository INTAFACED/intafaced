/**
 * Inbound HMAC mill for tRPC ops job twins of POST /internal/jobs/*.
 * Session admin:treasury is not a service caller — refuse-closed.
 */
import { TRPCError } from '@trpc/server';
import { requireServiceCaller } from '@intafaced/contracts/service-auth';

export const JOB_CALLER = 'svc-bank' as const;

export function requireBankJobService(service: string | null): asserts service is typeof JOB_CALLER {
  requireServiceCaller(service);
  if (service !== JOB_CALLER) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'ops job is callable only as svc-bank',
    });
  }
}
