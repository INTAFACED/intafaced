import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const privateKey = z.string().regex(/^0x[0-9a-f]{64}$/);
/** A tab's own order-ticket lane under one key: '' for the tab that made it, `1`, `1.2`, … for tabs it was handed to. */
const lane = z.string().regex(/^(?:[1-9]\d*(?:\.[1-9]\d*)*)?$/);

/** The session key as this tab keeps it in sessionStorage (trading-session.ts): a browser record, never a service answer. */
export const heldSchema = z.object({
  address,
  privateKey,
  nextTicket: z.number().int().positive().default(1),
  pendingOrder: z
    .object({ key: z.string(), intent: z.record(z.string(), z.unknown()) })
    .nullable()
    .default(null),
  lane: lane.default(''),
});

/** How many lanes this tab has handed on under one key, so no two tabs it hands the key to share a lane. */
export const lanesGivenSchema = z.object({ address, given: z.number().int().nonnegative() });

/** One tab asks the browser's other tabs (same origin only) for the live session key it does not hold. */
export const keyAskSchema = z.object({ type: z.literal('ask'), ask: z.string().min(1), userId: z.string().min(1), address });
/** A tab that holds the key answers that one ask with it and the asker's own lane. */
export const keyGiveSchema = z.object({ type: z.literal('give'), ask: z.string().min(1), address, privateKey, lane });
