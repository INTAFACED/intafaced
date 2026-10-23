import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { factorStatus, FactorStatusError } from './auth/factor-status.js';

const kinds = z.object({
  platform: z.number().int(),
  cross_device: z.number().int(),
  security_key: z.number().int(),
  unknown: z.number().int(),
});
const status = z.object({
  password: z.boolean(),
  authenticator: z.object({ on: z.boolean(), label: z.string().nullable() }),
  passkeys: z.object({ count: z.number().int(), kinds }),
  recoveryCodesLeft: z.number().int(),
  secondStepRequired: z.object({ floor: z.array(z.enum(['money_out', 'security_change'])), policy: z.null() }),
  checklist: z.array(z.object({ key: z.enum(['second_factor', 'passkey', 'authenticator', 'recovery_codes']), done: z.boolean() })),
});

/**
 * Top-level `factorStatus` (I-signin-sessions-14): the caller's own sign-in methods and Security checklist. It takes no
 * input, so no one can ask about another account.
 */
export function createFactorStatusRouter(sql: Sql) {
  return router({
    factorStatus: scopedProcedure('identity:read')
      .output(status)
      .query(async ({ ctx }) => {
        try {
          return await factorStatus(sql, ctx.principal.userId);
        } catch (err) {
          if (err instanceof FactorStatusError) throw new TRPCError({ code: 'NOT_FOUND', message: err.code, cause: err });
          throw err;
        }
      }),
  });
}
