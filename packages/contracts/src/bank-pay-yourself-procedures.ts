import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { amountString } from './bank-earn-procedures.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `payYourself.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/**
 * `bank.payYourself.*` (J-bank-31): pay yourself from your trading. A move is one venue withdrawal the person signs once
 * in their own wallet (through svc-trade's venue door), to their own partner account; these procedures read what their
 * trading realised as the venue reports it and the partner's pay-in, record a move once the venue took it, and keep the
 * weekly rule. Nothing here posts to the ledger or moves money: only the person's signature sends a withdrawal.
 */
export const moveView = z.object({
  id: z.string(),
  moveKey: z.string(),
  source: z.enum(['manual', 'rule']),
  assetId: assetIdSchema,
  amount: z.string(),
  status: z.enum(['prepared', 'sent']),
  owner: z.string().nullable(),
  venueNonce: z.string().nullable(),
  windowFrom: z.string().nullable(),
  windowTo: z.string().nullable(),
  preparedAt: z.string(),
  sentAt: z.string().nullable(),
});

export const creditView = z.object({
  key: z.string(),
  txHash: z.string(),
  amount: z.string(),
  from: z.string(),
  status: z.enum(['pending', 'available']),
  held: z.boolean(),
  confirmations: z.number().int(),
  required: z.number().int(),
  seenAt: z.string(),
  availableAt: z.string().nullable(),
});

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

export const ruleView = z.object({
  id: z.string(),
  weekday: z.enum(WEEKDAYS),
  assetId: assetIdSchema,
  cap: z.string(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string(),
});

export const payYourselfSummaryView = z.object({
  payIn: z.union([
    z.object({
      label: z.literal('TEST'),
      chainId: z.number().int(),
      token: z.string(),
      tokenDecimals: z.number().int(),
      address: z.string(),
      asset: z.string(),
      confirmations: z.number().int(),
    }),
    z.object({ unset: z.string() }),
  ]),
  partnerFee: z.string().nullable(),
  realised: z.union([
    z.object({ since: z.string(), asOf: z.string(), amount: z.string(), owner: z.string().nullable() }),
    z.object({ unread: z.string() }),
  ]),
  moves: z.array(moveView),
  credits: z.array(creditView),
  rule: ruleView.nullable(),
});

export const BANK_PAY_YOURSELF_SUMMARY = defineProcedure({
  ...base,
  name: 'bank.payYourself.summary',
  kind: 'query',
  path: 'payYourself.summary',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: payYourselfSummaryView,
  samples: [{ verdict: 'accept' }],
});

/** A move the person signed and the venue took, recorded once by its key and the venue's nonce. */
export const BANK_PAY_YOURSELF_RECORD = defineProcedure({
  ...base,
  name: 'bank.payYourself.record',
  kind: 'mutation',
  path: 'payYourself.record',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      moveKey: z.string().min(8).max(160),
      owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      nonce: z.string().min(1).max(80),
      amount: amountString,
    })
    .strict(),
  output: moveView,
  samples: [
    { verdict: 'accept', input: { moveKey: 'ethereum', owner: '0x1111111111111111111111111111111111111111', nonce: 'USDC', amount: '1' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The person's weekly rule: on `weekday`, the week's realised profit, up to `cap`, prepared for one signature. */
export const BANK_PAY_YOURSELF_SET_RULE = defineProcedure({
  ...base,
  name: 'bank.payYourself.setRule',
  kind: 'mutation',
  path: 'payYourself.setRule',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ weekday: z.enum(WEEKDAYS), cap: amountString }).strict(),
  output: ruleView,
  samples: [
    { verdict: 'accept', input: { weekday: 'monday', cap: '1' } },
    { verdict: 'refuse', input: 42 },
  ],
});
