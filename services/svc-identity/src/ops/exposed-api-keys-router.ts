import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import type { EventBus } from '@intafaced/events';
import { OperatorApiKeyError } from './operator-api-keys.js';
import { reportExposedApiKey } from './exposed-api-keys.js';

function intakeError(error: unknown): never {
  if (error instanceof OperatorApiKeyError) {
    const code = error.code === 'mfa.required' ? 'UNAUTHORIZED' : error.code === 'operator.denied' ? 'FORBIDDEN' : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${error.message} [${error.code}]`, cause: error });
  }
  throw error;
}

/** Operator intake of an exposed key (DV-keys-05). The reply never says whether the string matched a key. */
export function createExposedApiKeyRouter(sql: Sql, bus: Pick<EventBus, 'publish'>) {
  return router({
    apiKeyExposure: router({
      report: scopedProcedure('admin:write')
        .input(z.object({ key: z.string().min(1).max(512), clientRequestId: z.string().max(128) }).strict())
        .output(
          z.object({ reportId: z.string().uuid(), received: z.literal(true), reportedAt: z.string().datetime({ offset: true }) }).strict(),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            return await reportExposedApiKey(sql, bus, ctx, input);
          } catch (error) {
            intakeError(error);
          }
        }),
    }),
  });
}
