import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { deskAuditAnswer, deskConnectionAnswer, deskConnectionsAnswer, deskQuarantineAnswer } from './trade-call-schemas.js';
import { supportTradeOrderSchema } from './support-trade-summary.js';

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

/**
 * One customer's orders for the console's customer record (J-ops-console-02 #3, the trade tab), newest first, in the support
 * trade summary's narrowed order view. Needs the desk read scope at the door and `support:lookup` in the service; audited.
 */
export const TRADE_ADMIN_CUSTOMER_ORDERS = defineProcedure({
  ...base,
  name: 'trade.admin.customerOrders',
  kind: 'query',
  path: 'admin.customerOrders',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({ userId: z.string().guid(), limit: z.number().int().min(1).max(200) }).strict(),
  output: z.object({ userId: z.string(), readAt: z.string(), orders: z.array(supportTradeOrderSchema), truncated: z.boolean() }).strict(),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111', limit: 200 } },
    { verdict: 'refuse', input: 42 },
  ],
});
