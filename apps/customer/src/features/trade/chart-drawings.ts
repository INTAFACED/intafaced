import { z } from 'zod';
import { decimalSchema, parseAmount } from '../../shared/money';

/**
 * The lines and boxes a person drew on one market's chart, kept in this browser's local storage. Not a service answer:
 * only this browser writes it. Each point is a bar time and a positive price.
 */
export const drawingsSchema = z.array(
  z.object({
    kind: z.enum(['level', 'trend', 'rectangle']),
    points: z
      .array(z.tuple([z.number().int().nonnegative().safe(), decimalSchema.refine((value) => parseAmount(value) > 0n)]))
      .min(1)
      .max(2),
  }),
);
