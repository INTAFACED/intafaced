// hand-declared-ok: moved unchanged from features/money/contracts.ts; svc-bank has no browser-safe business schema in packages/contracts yet
import { z } from 'zod';
import { decimalSchema as money } from '../../shared/money';

/**
 * A business account as svc-bank `bank.business.list` returns it. Its own module because the session reads the list
 * at sign-in, and the rest of the bank's contracts (and their copy) need not load with it.
 */
export const businessSchema = z.object({
  id: z.string(),
  name: z.string(),
  assetId: z.string(),
  spendThreshold: money,
  status: z.enum(['active', 'closed']),
  createdAt: z.string(),
});

/** `bank.business.list`: the person's business accounts. */
export const businessListSchema = z.array(businessSchema);
