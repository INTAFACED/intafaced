import { z } from 'zod';

/** svc-trade's `GET /api/v1/futures/margin-modes`: every named mode, whether it is offered, and its typed refusal (services/svc-trade/src/public-rest.ts). Browser-safe (zod only). */
export const marginModesSchema = z.object({
  modes: z.array(z.object({ mode: z.string(), offered: z.boolean(), code: z.string().nullable(), reason: z.string().nullable() })),
});
export type MarginModes = z.infer<typeof marginModesSchema>;
