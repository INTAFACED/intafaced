import { publicProcedure } from '@intafaced/contracts';
import { z } from 'zod';
import type { QuantCore } from './core.js';

export function healthRoutes(_core: QuantCore) {
  return publicProcedure
    .output(z.object({ ok: z.literal(true), service: z.literal('svc-quant') }))
    .query(() => ({ ok: true as const, service: 'svc-quant' as const }));
}
