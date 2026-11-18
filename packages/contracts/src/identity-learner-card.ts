import { z } from 'zod';

/**
 * Identity's `learnerCard.lookup` (J-academy-14 #1): one account found by its exact email, exact handle or account id, as
 * a support desk needs it: the handle, the email masked, the account's status and sign-up time, and its sign-in
 * statistics, counted from identity's own sessions. It needs `admin:read` on a signed-in, second-factor session, never an
 * API key or a sub-account, and every lookup is audited as a hash of the term. Nothing else about the account leaves.
 */
export const identityLearnerCardInputSchema = z
  .object({
    email: z.string().trim().min(3).max(320).optional(),
    handle: z.string().trim().min(3).max(32).optional(),
    userId: z.string().guid().optional(),
  })
  .strict();
export type IdentityLearnerCardInput = z.infer<typeof identityLearnerCardInputSchema>;

export const identityLearnerCardSchema = z
  .object({
    id: z.string().guid(),
    handle: z.string(),
    emailMasked: z.string(),
    status: z.enum(['active', 'frozen', 'closed']),
    created: z.string().datetime({ offset: true }),
    signIns: z
      .object({
        /** Every sign-in session identity holds for the account, live or ended. */
        total: z.number().int().nonnegative(),
        last30Days: z.number().int().nonnegative(),
        lastAt: z.string().datetime({ offset: true }).nullable(),
      })
      .strict(),
  })
  .strict();
export type IdentityLearnerCard = z.infer<typeof identityLearnerCardSchema>;

/** Null: no account matches. */
export const identityLearnerCardResultSchema = z.object({ card: identityLearnerCardSchema.nullable() }).strict();
