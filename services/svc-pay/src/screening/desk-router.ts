import { requireMfa } from '@intafaced/auth';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { ScreeningDeskError } from './desk-errors.js';
import { screeningDeskToTrpcError } from './desk-errors.js';
import {
  caseDecideInputSchema,
  caseDetailSchema,
  caseKeyInputSchema,
  caseListInputSchema,
  caseListSchema,
  caseRescreenInputSchema,
  caseViewSchema,
  listStatusSchema,
} from './desk-schemas.js';
import type { ScreeningDeskService } from './desk-service.js';
import { z } from 'zod';

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw screeningDeskToTrpcError(error);
  }
}
export type { ScreeningDeskError };

/**
 * `screening.*`: the compliance desk over screened sends. `admin:compliance` in the pay module, like KYB decide.
 * A decision or rescreen also needs MFA locally (the scope is not interactive-only). The actor is the signed-in
 * operator, never a field in the body.
 */
export function createScreeningRouter(desk: ScreeningDeskService) {
  const compliance = scopedProcedure('admin:compliance', { module: 'pay' });
  return router({
    screening: router({
      cases: router({
        list: compliance
          .input(caseListInputSchema)
          .output(caseListSchema)
          .query(({ input }) => wrap(() => desk.list(input))),
        get: compliance
          .input(caseKeyInputSchema)
          .output(caseDetailSchema)
          .query(({ input }) => wrap(() => desk.get(input.subjectKind, input.caseId))),
        decide: compliance
          .input(caseDecideInputSchema)
          .output(caseViewSchema)
          .mutation(({ ctx, input }) =>
            wrap(async () => {
              requireMfa(ctx.principal);
              return desk.decide(ctx.principal.userId, input);
            }),
          ),
        rescreen: compliance
          .input(caseRescreenInputSchema)
          .output(caseViewSchema)
          .mutation(({ ctx, input }) =>
            wrap(async () => {
              requireMfa(ctx.principal);
              return desk.rescreen(ctx.principal.userId, input);
            }),
          ),
      }),
      sanctions: router({
        status: compliance
          .input(z.object({}).strict().optional())
          .output(listStatusSchema)
          .query(() => desk.listStatus()),
      }),
    }),
  });
}
export type ScreeningRouter = ReturnType<typeof createScreeningRouter>;
