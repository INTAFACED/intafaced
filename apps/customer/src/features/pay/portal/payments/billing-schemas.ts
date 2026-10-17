import { z } from 'zod';
import { amount, id } from '../../schemas';
export const cycleSchema = z.object({
  occurrence: z.number().int().nonnegative(),
  amount,
  status: z.enum(['pending', 'invoiced', 'settled', 'rejected', 'skipped']),
  idempotencyKey: z.string().nullable(),
  attemptCount: z.number().int().positive(),
  rejectionCode: z.string().nullable(),
  paymentId: id.nullable(),
  exhausted: z.boolean(),
  settledAt: z.string().nullable(),
  notifyStatus: z.enum(['attempted', 'skipped_unwired', 'failed']).nullable(),
  notifyCode: z.string().nullable(),
});
export type Cycle = z.infer<typeof cycleSchema>;
