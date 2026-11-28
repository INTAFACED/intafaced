import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { signalWebhookCreatedAnswer, signalWebhooksAnswer } from './trade-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-trade `signals.*`, one record per call: svc-trade mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;

export const TRADE_SIGNALS_WEBHOOKS_CREATE = defineProcedure({
  ...base,
  name: 'trade.signals.webhooks.create',
  kind: 'mutation',
  path: 'signals.webhooks.create',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z
    .object({
      symbol: z.string().min(1).max(32),
      venueOwner: z.string().min(1).max(64),
      clientRequestId: z.string().min(1).max(120),
    })
    .strict(),
  output: signalWebhookCreatedAnswer,
  samples: [
    { verdict: 'accept', input: { symbol: 'USDC', venueOwner: 'USDC', clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_SIGNALS_WEBHOOKS_LIST = defineProcedure({
  ...base,
  name: 'trade.signals.webhooks.list',
  kind: 'query',
  path: 'signals.webhooks.list',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: signalWebhooksAnswer,
  samples: [{ verdict: 'accept' }],
});
