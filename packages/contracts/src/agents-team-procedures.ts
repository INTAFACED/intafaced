import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
  agentsTeamGrantResultSchema,
  agentsTeamHeldActionResultSchema,
  agentsTeamHeldActionSchema,
  agentsTeamPoolResultSchema,
  agentsTeamProjectResultSchema,
  agentsTeamRunClosedSchema,
  agentsTeamRunResultSchema,
  agentsTeamRunSessionSchema,
  agentsTeamUsageSchema,
  agentsTeamViewSchema,
} from './agents-team.js';
import { amount, businessId, memberId, revision } from './agents-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `team.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

export const AGENTS_TEAM_VIEW = defineProcedure({
  ...base,
  name: 'agents.team.view',
  kind: 'query',
  path: 'team.view',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z.object({ businessId }).strict(),
  output: agentsTeamViewSchema,
  samples: [
    { verdict: 'accept', input: { businessId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_TEAM_GRANTS_SET = defineProcedure({
  ...base,
  name: 'agents.team.grants.set',
  kind: 'mutation',
  path: 'team.grants.set',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: z
    .object({ businessId, memberUserId: memberId, role: z.string().max(32), allow: z.boolean(), deny: z.boolean(), revision })
    .strict(),
  output: agentsTeamGrantResultSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        businessId: '11111111-1111-4111-8111-111111111111',
        memberUserId: 'USDC',
        role: 'USDC',
        allow: true,
        deny: true,
        revision: 1,
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_TEAM_POOL_SET = defineProcedure({
  ...base,
  name: 'agents.team.pool.set',
  kind: 'mutation',
  path: 'team.pool.set',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: z
    .object({
      businessId,
      limit: amount,
      allocations: z.array(z.object({ memberUserId: memberId, amount }).strict()).max(200),
      revision,
    })
    .strict(),
  output: agentsTeamPoolResultSchema,
  samples: [
    { verdict: 'accept', input: { businessId: '11111111-1111-4111-8111-111111111111', allocations: [], revision: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_TEAM_PROJECTS_CREATE = defineProcedure({
  ...base,
  name: 'agents.team.projects.create',
  kind: 'mutation',
  path: 'team.projects.create',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: z
    .object({
      businessId,
      name: z.string().max(80).nullable().optional(),
      limit: amount,
      memberUserIds: z.array(memberId).max(200),
      seq: revision,
    })
    .strict(),
  output: agentsTeamProjectResultSchema,
  samples: [
    { verdict: 'accept', input: { businessId: '11111111-1111-4111-8111-111111111111', memberUserIds: [], seq: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_TEAM_RUNS_OPEN = defineProcedure({
  ...base,
  name: 'agents.team.runs.open',
  kind: 'mutation',
  path: 'team.runs.open',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: z.object({ businessId, agentId: z.string().min(1).max(64) }).strict(),
  output: agentsTeamRunSessionSchema,
  samples: [
    { verdict: 'accept', input: { businessId: '11111111-1111-4111-8111-111111111111', agentId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_TEAM_RUNS_RUN = defineProcedure({
  ...base,
  name: 'agents.team.runs.run',
  kind: 'mutation',
  path: 'team.runs.run',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: z
    .object({
      businessId,
      sessionId: z.string().uuid(),
      requestId: z.string().min(8).max(190),
      ask: z.string().min(1).max(4000),
    })
    .strict(),
  output: agentsTeamRunResultSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        businessId: '11111111-1111-4111-8111-111111111111',
        sessionId: '11111111-1111-4111-8111-111111111111',
        requestId: 'ethereum',
        ask: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_TEAM_RUNS_CLOSE = defineProcedure({
  ...base,
  name: 'agents.team.runs.close',
  kind: 'mutation',
  path: 'team.runs.close',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: z.object({ businessId, sessionId: z.string().uuid() }).strict(),
  output: agentsTeamRunClosedSchema,
  samples: [
    { verdict: 'accept', input: { businessId: '11111111-1111-4111-8111-111111111111', sessionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_TEAM_ACTIONS_LIST = defineProcedure({
  ...base,
  name: 'agents.team.actions.list',
  kind: 'query',
  path: 'team.actions.list',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z.object({ businessId, limit: z.number().int().min(1).max(200) }).strict(),
  output: z.array(agentsTeamHeldActionSchema),
  samples: [
    { verdict: 'accept', input: { businessId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_TEAM_ACTIONS_HOLD = defineProcedure({
  ...base,
  name: 'agents.team.actions.hold',
  kind: 'mutation',
  path: 'team.actions.hold',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: z.object({ businessId, agentId: z.string().min(1).max(64), tool: z.string().min(1).max(120), seq: revision }).strict(),
  output: agentsTeamHeldActionResultSchema,
  samples: [
    { verdict: 'accept', input: { businessId: '11111111-1111-4111-8111-111111111111', agentId: 'USDC', tool: 'USDC', seq: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_TEAM_ACTIONS_APPROVE = defineProcedure({
  ...base,
  name: 'agents.team.actions.approve',
  kind: 'mutation',
  path: 'team.actions.approve',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true },
  refusals: {},
  input: z.object({ businessId, actionId: z.string().uuid() }).strict(),
  output: agentsTeamHeldActionResultSchema,
  samples: [
    { verdict: 'accept', input: { businessId: '11111111-1111-4111-8111-111111111111', actionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_TEAM_USAGE = defineProcedure({
  ...base,
  name: 'agents.team.usage',
  kind: 'query',
  path: 'team.usage',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z.object({ businessId }).strict(),
  output: agentsTeamUsageSchema,
  samples: [
    { verdict: 'accept', input: { businessId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
