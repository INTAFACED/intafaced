import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { actionOutput, sessionOutput } from './agents-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `session.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

/** Selects one of the caller's own sessions for their history; someone else's session is not found. */
export const AGENTS_SESSION_SELECT = defineProcedure({
  ...base,
  name: 'agents.session.select',
  kind: 'mutation',
  path: 'session.select',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true, ownSession: 'agents.select_person_only' },
  refusals: {},
  input: z.object({ sessionId: z.string().guid() }),
  output: z.object({ sessionId: z.string().guid(), agentId: z.string() }),
  samples: [
    { verdict: 'accept', input: { sessionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The session the caller last selected in their history, kept by the service so the choice survives a reload and
 * another device. Null when they have selected none.
 */
export const AGENTS_SESSION_SELECTED = defineProcedure({
  ...base,
  name: 'agents.session.selected',
  kind: 'query',
  path: 'session.selected',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ sessionId: z.string().guid(), agentId: z.string() }).nullable(),
  samples: [{ verdict: 'accept' }],
});

export const AGENTS_SESSION_LOG = defineProcedure({
  ...base,
  name: 'agents.session.log',
  kind: 'query',
  path: 'session.log',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z.object({ sessionId: z.string().guid(), limit: z.number().int().min(1).max(500).optional() }),
  output: z.array(actionOutput),
  samples: [
    { verdict: 'accept', input: { sessionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * One of the caller's own sessions: its state and every usage window with what it was charged. Open windows have
 * no amount yet; a sealed window with no ledger transaction is unpaid and is retried on its charge key.
 */
export const AGENTS_SESSION_DETAIL = defineProcedure({
  ...base,
  name: 'agents.session.detail',
  kind: 'query',
  path: 'session.detail',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z.object({ sessionId: z.string().guid() }),
  output: z.object({
    session: sessionOutput,
    assetId: z.string(),
    windows: z.array(
      z.object({
        windowId: z.string(),
        openedAt: z.string(),
        state: z.enum(['open', 'unpaid', 'settled']),
        amount: z.string().nullable(),
        chargeKey: z.string().nullable(),
        /**
         * How a settled window was paid: `ledger` (the custodial fee charge), or `partner` with the partner's own
         * name and payment id (earned as owed, then collected from the person's payment method). Null until paid.
         */
        paidBy: z.enum(['ledger', 'partner']).nullable(),
        payment: z.object({ ref: z.string(), label: z.string() }).nullable(),
      }),
    ),
    /**
     * Each run of the session by its request id, oldest first. The run's claim commits before the engine is
     * called, so a run the engine has not answered reads `running`; one whose usage is recorded reads `completed`.
     */
    runs: z.array(
      z.object({
        requestId: z.string(),
        startedAt: z.string(),
        state: z.enum(['running', 'completed']),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: { sessionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_SESSION_CLOSE = defineProcedure({
  ...base,
  name: 'agents.session.close',
  kind: 'mutation',
  path: 'session.close',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: z.object({ sessionId: z.string().guid() }),
  output: sessionOutput,
  samples: [
    { verdict: 'accept', input: { sessionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_SESSION_OPEN = defineProcedure({
  ...base,
  name: 'agents.session.open',
  kind: 'mutation',
  path: 'session.open',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: z.object({ agentId: z.string().min(1) }),
  output: sessionOutput,
  samples: [
    { verdict: 'accept', input: { agentId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
