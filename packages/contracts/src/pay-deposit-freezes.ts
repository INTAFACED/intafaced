import { z } from 'zod';

/**
 * svc-pay's deposit address freezes (`founderAdmin.depositFreezes.*`): what the service answers, in one place, so the
 * service declares its output and the admin console reads it from the same file.
 *
 * The `*ResultSchema`s are the wire shape svc-pay declares as its procedure output (strict, every field). The
 * `*AnswerSchema`s are what a reader accepts: the freeze fields it reads (unknown fields ignored, so a new field on the
 * service does not break a console deployed before it), and the checks a reader must make even though the service never
 * sends such a value: a count is a safe, non-negative integer, and no more deposits are credited than were released.
 * The counts are numbers of deposits, not amounts of money.
 */

const freezeFields = {
  id: z.string(),
  userId: z.string(),
  networkId: z.string(),
  address: z.string(),
};

export const depositFreezeViewSchema = z
  .object({
    ...freezeFields,
    reason: z.string(),
    frozenBy: z.string(),
    frozenAt: z.string(),
    unfrozenBy: z.string().nullable(),
    unfreezeApprover: z.string().nullable(),
    unfreezeReason: z.string().nullable(),
    unfrozenAt: z.string().nullable(),
  })
  .strict();
export type DepositFreezeView = z.infer<typeof depositFreezeViewSchema>;

export const depositFreezeResultSchema = z
  .object({ freeze: depositFreezeViewSchema, held: z.number().int(), creditedUntouched: z.number().int() })
  .strict();
export const depositUnfreezeResultSchema = z
  .object({ freeze: depositFreezeViewSchema, released: z.number().int(), credited: z.number().int() })
  .strict();

/** A number of deposits: a safe, non-negative integer (zod's `int` refuses an unsafe one). */
const depositCountSchema = z.number().int().nonnegative();
const freezeAnswerViewSchema = z.object(freezeFields);

/** `founderAdmin.depositFreezes.freeze`, as a reader accepts it. */
export const depositFreezeAnswerSchema = z.object({
  freeze: freezeAnswerViewSchema,
  held: depositCountSchema,
  creditedUntouched: depositCountSchema,
});
export type DepositFreezeAnswer = z.infer<typeof depositFreezeAnswerSchema>;

/** `founderAdmin.depositFreezes.unfreeze`, as a reader accepts it: never more credited than released. */
export const depositUnfreezeAnswerSchema = z
  .object({ freeze: freezeAnswerViewSchema, released: depositCountSchema, credited: depositCountSchema })
  .refine((a) => a.credited <= a.released, { message: 'more deposits credited than released', path: ['credited'] });
export type DepositUnfreezeAnswer = z.infer<typeof depositUnfreezeAnswerSchema>;
