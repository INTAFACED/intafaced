import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountString, cardOutput, shippingAddressInput } from './bank-call-schemas.js';
import { stepUpApprovalField } from './bank-cards-procedures.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `cards.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/**
 * `cardId` is supplied by the client so a retried request is the same card,
 * not a second one drawing on the same balance (§5).
 */
export const BANK_CARDS_ISSUE = defineProcedure({
  ...base,
  name: 'bank.cards.issue',
  kind: 'mutation',
  path: 'cards.issue',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    cardId: z.string().guid(),
    assetId: assetIdSchema.min(1).max(16),
    /**
     * What merchants charge this card in. Omitted means the funding asset,
     * which is no conversion — the shape every card had before §18.
     *
     * A card may be issued with a settlement asset nothing can quote; the
     * refusal belongs on the authorisation, where the rate is needed, not
     * on a path that moves no money and could be refused by one transient
     * feed outage.
     */
    settlementAssetId: z.string().min(1).max(16).optional(),
    cashbackBps: z.number().int().min(0).max(10_000).optional(),
    perAuthorizationLimit: amountString,
    cardType: z.enum(['virtual', 'physical']).optional(),
    shippingAddress: shippingAddressInput.optional(),
    stepUpApprovalId: stepUpApprovalField,
  }),
  output: cardOutput,
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111', assetId: 'USDC', perAuthorizationLimit: '1' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Spending ceilings. Step-up only when a ceiling is raised or removed.
 * Tightening does not prompt. `commandId` retries the same change.
 */
export const BANK_CARDS_SET_LIMITS = defineProcedure({
  ...base,
  name: 'bank.cards.setLimits',
  kind: 'mutation',
  path: 'cards.setLimits',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    cardId: z.string().guid(),
    commandId: z.string().guid(),
    perAuthorizationLimit: amountString,
    dailyLimit: amountString.nullable().optional(),
    monthlyLimit: amountString.nullable().optional(),
    cashLimit: amountString.nullable().optional(),
    stepUpApprovalId: stepUpApprovalField,
  }),
  output: cardOutput,
  samples: [
    {
      verdict: 'accept',
      input: {
        cardId: '11111111-1111-4111-8111-111111111111',
        commandId: '11111111-1111-4111-8111-111111111111',
        perAuthorizationLimit: '1',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Online, contactless, ATM and abroad. `commandId` retries the same four flags. */
export const BANK_CARDS_SET_CHANNELS = defineProcedure({
  ...base,
  name: 'bank.cards.setChannels',
  kind: 'mutation',
  path: 'cards.setChannels',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    cardId: z.string().guid(),
    commandId: z.string().guid(),
    online: z.boolean(),
    contactless: z.boolean(),
    atm: z.boolean(),
    abroad: z.boolean(),
  }),
  output: cardOutput,
  samples: [
    {
      verdict: 'accept',
      input: {
        cardId: '11111111-1111-4111-8111-111111111111',
        commandId: '11111111-1111-4111-8111-111111111111',
        online: true,
        contactless: true,
        atm: true,
        abroad: true,
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
