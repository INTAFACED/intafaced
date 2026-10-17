import { z } from 'zod';

/** Reply of the Growth agent's `propose` door. A proposal is a draft for a
 * person to read; it is never published, and returns or budgets are refused. */
export const proposalResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('refuse'),
    reason: z.enum(['warehouse_dark', 'autonomous_publish', 'returns_claim', 'budget_undecided', 'inputs_missing']),
    isPublication: z.literal(false),
    published: z.literal(false),
    warehouseConfigured: z.boolean(),
    inventedReturns: z.literal(false),
    inventedBudget: z.literal(false),
  }),
  z.object({
    status: z.literal('proposal'),
    isPublication: z.literal(false),
    published: z.literal(false),
    headline: z.string(),
    inventedReturns: z.literal(false),
    inventedBudget: z.literal(false),
  }),
]);
export type ProposalResult = z.infer<typeof proposalResult>;

export const HEADLINE_MAX = 200;
export const COPY_MAX = 2000;

/** What is sent. Publishing and budgets are never part of a customer request. */
export function proposalRequest(headline: string, copy: string): { headline: string; copy: string } | null {
  const h = headline.trim(),
    c = copy.trim();
  if (!h || !c || h.length > HEADLINE_MAX || c.length > COPY_MAX) return null;
  return { headline: h, copy: c };
}
