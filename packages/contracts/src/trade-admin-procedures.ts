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

/** One reading of a venue account's margin, every figure the venue's own at its as-of time (J-derivatives-26 #8). */
const venueMarginSample = z.object({
  asOf: z.string().datetime(),
  asset: z.string(),
  equity: z.string(),
  maintenanceMargin: z.string(),
  marginRatio: z.union([z.object({ known: z.literal(true), value: z.string() }), z.object({ known: z.literal(false) })]),
  crossState: z.enum(['healthy', 'margin_call']).nullable(),
});

/**
 * A founder's read of one person's venue accounts (J-derivatives-26 #8; svc-trade admin/venue-account-read.ts): each
 * account their own signed actions named, its margin now and its ratio history, as the venue reported them. Audited
 * (`venue_accounts.get`) before the venue is asked; read-only.
 */
export const TRADE_ADMIN_VENUE_ACCOUNTS_GET = defineProcedure({
  ...base,
  name: 'trade.admin.venueAccounts.get',
  kind: 'query',
  path: 'admin.venueAccounts.get',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({ userId: z.string().guid() }).strict(),
  output: z.object({
    userId: z.string(),
    venueId: z.string(),
    source: z.string(),
    accounts: z.array(
      z.object({
        owner: z.string(),
        subAccount: z.string().nullable(),
        now: venueMarginSample.nullable(),
        history: z.array(venueMarginSample),
      }),
    ),
    auditId: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
