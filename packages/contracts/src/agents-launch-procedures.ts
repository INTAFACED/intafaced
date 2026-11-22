import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `launch.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

export const AGENTS_LAUNCH_ASSESS = defineProcedure({
  ...base,
  name: 'agents.launch.assess',
  kind: 'query',
  path: 'launch.assess',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z.object({
    deployer: z.string().min(1).max(128).optional(),
    asBadge: z.boolean().optional(),
    asBlockDecision: z.boolean().optional(),
  }),
  output: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('refuse'),
      reason: z.enum(['deployer_missing', 'reputation_unread', 'history_absent', 'badge_forbidden', 'block_decision_forbidden']),
      kind: z.literal('not_a_badge'),
      isBadge: z.literal(false),
      isBlockDecision: z.literal(false),
      inventedCleanBadge: z.literal(false),
      userMessageKey: z.literal('agents.error.capability_unavailable'),
    }),
    z.object({
      status: z.literal('annotation'),
      kind: z.literal('pattern_flags'),
      isBadge: z.literal(false),
      isBlockDecision: z.literal(false),
      deployer: z.string(),
      lpLocks: z.number().int(),
      vestings: z.number().int(),
      patternFlags: z.array(
        z.object({
          code: z.enum(['no_lp_locks', 'no_vestings', 'sparse_lp_locks', 'sparse_vestings']),
          source: z.literal('deployer_reputation'),
        }),
      ),
      inventedCleanBadge: z.literal(false),
      userMessageKey: z.literal('agents.error.capability_unavailable'),
    }),
  ]),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
