import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `growth.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

export const AGENTS_GROWTH_PROPOSE = defineProcedure({
  ...base,
  name: 'agents.growth.propose',
  kind: 'mutation',
  path: 'growth.propose',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z.object({
    headline: z.string().max(200).optional(),
    copy: z.string().max(2000).optional(),
    publish: z.boolean().optional(),
    incentiveBudget: z.string().max(32).optional(),
    spendAmount: z.string().max(32).optional(),
  }),
  output: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('refuse'),
      reason: z.enum(['warehouse_dark', 'autonomous_publish', 'returns_claim', 'budget_undecided', 'inputs_missing']),
      kind: z.literal('not_a_publication'),
      isPublication: z.literal(false),
      published: z.literal(false),
      warehouseConfigured: z.boolean(),
      warehouseMayLabelLive: z.boolean(),
      inventedReturns: z.literal(false),
      inventedBudget: z.literal(false),
      userMessageKey: z.literal('agents.error.capability_unavailable'),
    }),
    z.object({
      status: z.literal('proposal'),
      kind: z.literal('proposal'),
      isPublication: z.literal(false),
      published: z.literal(false),
      headline: z.string(),
      warehouseConfigured: z.literal(true),
      warehouseMayLabelLive: z.literal(true),
      inventedReturns: z.literal(false),
      inventedBudget: z.literal(false),
      userMessageKey: z.literal('agents.error.capability_unavailable'),
    }),
  ]),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
