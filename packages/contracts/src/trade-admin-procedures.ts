import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { deskAuditAnswer, deskConnectionAnswer, deskConnectionsAnswer, deskQuarantineAnswer } from './trade-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-trade `admin.*`, one record per call: svc-trade mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;

export const TRADE_ADMIN_AGENT_DESK_CONNECTIONS = defineProcedure({
  ...base,
  name: 'trade.admin.agentDesk.connections',
  kind: 'query',
  path: 'admin.agentDesk.connections',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: NO_INPUT,
  output: deskConnectionsAnswer,
  samples: [{ verdict: 'accept' }],
});

export const TRADE_ADMIN_AGENT_DESK_AUDIT = defineProcedure({
  ...base,
  name: 'trade.admin.agentDesk.audit',
  kind: 'query',
  path: 'admin.agentDesk.audit',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: NO_INPUT,
  output: deskAuditAnswer,
  samples: [{ verdict: 'accept' }],
});

export const TRADE_ADMIN_AGENT_DESK_CONNECTION = defineProcedure({
  ...base,
  name: 'trade.admin.agentDesk.connection',
  kind: 'query',
  path: 'admin.agentDesk.connection',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({ keyId: z.string().max(64) }).strict(),
  output: deskConnectionAnswer,
  samples: [
    { verdict: 'accept', input: { keyId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_ADMIN_AGENT_DESK_QUARANTINE = defineProcedure({
  ...base,
  name: 'trade.admin.agentDesk.quarantine',
  kind: 'mutation',
  path: 'admin.agentDesk.quarantine',
  access: { caller: 'scope', scope: 'admin:write' },
  refusals: {},
  input: z.object({ keyId: z.string().max(64), reason: z.string().max(600), requestId: z.string().max(256) }).strict(),
  output: deskQuarantineAnswer,
  samples: [
    { verdict: 'accept', input: { keyId: 'USDC', reason: 'USDC', requestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
