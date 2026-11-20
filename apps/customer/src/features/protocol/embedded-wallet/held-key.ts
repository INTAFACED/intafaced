import { z } from 'zod';

/** The session key as this tab keeps it in sessionStorage (trading-session.ts): a browser record, never a service answer. */
export const heldSchema = z.object({
  address: z.string().regex(/^0x[0-9a-f]{40}$/),
  privateKey: z.string().regex(/^0x[0-9a-f]{64}$/),
  nextTicket: z.number().int().positive().default(1),
  pendingOrder: z
    .object({ key: z.string(), intent: z.record(z.string(), z.unknown()) })
    .nullable()
    .default(null),
});
