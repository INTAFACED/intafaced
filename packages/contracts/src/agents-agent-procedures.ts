import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { REFUSAL_CODES } from './agents-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `agent.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

/** What an agent may do, so a user can read the guardrail before granting a session. */
export const AGENTS_AGENT_GET = defineProcedure({
  ...base,
  name: 'agents.agent.get',
  kind: 'query',
  path: 'agent.get',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z.object({ agentId: z.string().min(1) }),
  output: z
    .object({
      agentId: z.string(),
      version: z.number().int(),
      enabled: z.boolean(),
      tools: z.array(
        z.object({
          name: z.string(),
          module: z.string(),
          mode: z.enum(['read', 'write']),
          requiresApproval: z.boolean(),
          maxCallsPerSession: z.number().int().nullable(),
          /** Every refusal the runtime can return for this tool under this guardrail, in check order. */
          refusals: z.array(z.enum(REFUSAL_CODES)),
          /** The tool's declared input and output (own/catalog.ts `declaredToolShape`); null when it declares none. */
          shape: z.object({ input: z.record(z.string(), z.string()), output: z.record(z.string(), z.string()) }).nullable(),
        }),
      ),
      /** The permission mode the agent runs under; null when the guardrail names none, which refuses live writes. */
      capacityMode: z.string().nullable(),
      limits: z.object({
        maxActionsPerSession: z.number().int(),
        maxOutputTokensPerCall: z.number().int(),
        maxSpendPerSession: z.string().nullable(),
        allowedModules: z.array(z.string()),
        allowedTasks: z.array(z.string()),
      }),
      engine: z.enum(['sandbox', 'live', 'unknown']),
      metered: z.boolean(),
      /** Who may use the agent under its published law, and whether this person may (fleet/eligibility.ts). */
      eligibility: z.discriminatedUnion('rule', [
        z.object({
          rule: z.literal('none'),
          eligible: z.literal(true),
          reason: z.null(),
          code: z.null(),
          yourPlan: z.string(),
        }),
        z.object({
          rule: z.literal('plan'),
          published: z.boolean(),
          plans: z.array(z.string()),
          yourPlan: z.string(),
          eligible: z.boolean(),
          reason: z.literal('plan').nullable(),
          code: z.string().nullable(),
        }),
      ]),
    })
    .nullable(),
  samples: [
    { verdict: 'accept', input: { agentId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Stored catalogue. Purpose is the column, null when absent.
 * Disabled agents stay in the list with enabled false.
 */
export const AGENTS_AGENT_CATALOGUE = defineProcedure({
  ...base,
  name: 'agents.agent.catalogue',
  kind: 'query',
  path: 'agent.catalogue',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(
    z.object({
      agentId: z.string(),
      name: z.string().nullable(),
      purpose: z.string().nullable(),
      enabled: z.boolean(),
      version: z.number().int(),
    }),
  ),
  samples: [{ verdict: 'accept' }],
});
