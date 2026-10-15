import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { PayGuardRefusal } from '../seams/guards.js';
import type { PayScreeningService } from './service.js';

export function createScreeningRouter(screening: PayScreeningService) {
  return router({
    screening: router({
      reviews: scopedProcedure('admin:compliance', { module: 'pay' })
        .input(z.object({ limit: z.number().int().min(1).max(200) }))
        .output(
          z.array(
            z.object({
              settlementId: z.string().uuid(),
              attempt: z.number().int(),
              merchantId: z.string().uuid(),
              provider: z.string(),
              fixture: z.boolean(),
              createdAt: z.string(),
            }),
          ),
        )
        .query(async ({ input }) => {
          try {
            return await screening.listReviews(input);
          } catch (error) {
            if (error instanceof PayGuardRefusal)
              throw new TRPCError({
                code: error.kind === 'unavailable' ? 'SERVICE_UNAVAILABLE' : 'FORBIDDEN',
                message: error.code,
                cause: error,
              });
            throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'pay.guard_screening_unavailable' });
          }
        }),
    }),
  });
}
