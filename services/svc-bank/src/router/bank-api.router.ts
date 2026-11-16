import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import {
  API_ACCOUNT_TYPES,
  type ApiAccount,
  type ApiDelivery,
  type ApiMove,
  type ApiMoveQuote,
  type ApiPayment,
  type ApiWebhookEndpoint,
} from '../developer-api/bank-api.js';
import { PARTNER_PAYMENT_METHODS, PARTNER_TRANSFER_STATES } from '../partner/partner-bank.js';
import { amountString } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

/** A caller's business key: what they will send again, unchanged, when they retry. */
const businessKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9:._-]+$/);
const limit = z.number().int().min(1).max(100);
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

const accountOut = z
  .object({
    id: z.string(),
    type: z.enum(API_ACCOUNT_TYPES),
    name: z.string(),
    assetId: z.string(),
    owner: z.enum(['self', 'other']),
    heldAt: z.string(),
    balance: z.string().nullable(),
    figure: z.enum(['known', 'stale', 'unknown']),
    asOf: z.string().nullable(),
    spendToday: z.string().nullable(),
    locked: z.boolean(),
    lockedUntil: z.string().nullable(),
  })
  .strict();
const accountView = (a: ApiAccount) => ({ ...a, asOf: iso(a.asOf), locked: a.lockedUntil !== null, lockedUntil: iso(a.lockedUntil) });

const quoteOut = z
  .object({
    quoteId: z.string(),
    fromAccountId: z.string(),
    toAccountId: z.string(),
    assetId: z.string(),
    amount: z.string(),
    fee: z.string().nullable(),
    receives: z.string().nullable(),
    heldAt: z.string(),
    quotedAt: z.string(),
    validUntil: z.string(),
  })
  .strict();
const quoteView = (q: ApiMoveQuote) => ({ ...q, quotedAt: q.quotedAt.toISOString(), validUntil: q.validUntil.toISOString() });

const moveOut = z
  .object({
    dedupeId: z.string(),
    quote: quoteOut,
    state: z.enum(['pending', 'completed']),
    partnerMoveId: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .strict();
const moveView = (m: ApiMove) => ({ ...m, quote: quoteView(m.quote), completedAt: iso(m.completedAt) });

const recipient = z
  .object({
    name: z.string().trim().min(1).max(140),
    accountNumber: z.string().regex(/^\d{4,17}$/),
    routingNumber: z.string().regex(/^\d{9}$/),
  })
  .strict();
const paymentOut = z
  .object({
    id: z.string(),
    idempotencyKey: z.string(),
    fromAccountId: z.string(),
    assetId: z.string(),
    method: z.enum(PARTNER_PAYMENT_METHODS),
    recipient,
    amount: z.string(),
    state: z.enum(['asked', 'refused', ...PARTNER_TRANSFER_STATES]),
    refusalCode: z.string().nullable(),
    version: z.number().int(),
    heldAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
const paymentView = (p: ApiPayment) => ({ ...p, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() });

const endpointOut = z.object({ id: z.string(), url: z.string(), createdAt: z.string(), secret: z.string().nullable() }).strict();
const endpointView = (e: ApiWebhookEndpoint) => ({ ...e, createdAt: e.createdAt.toISOString() });
const deliveryOut = z
  .object({
    eventId: z.string(),
    endpointId: z.string(),
    paymentId: z.string(),
    previous: z.string().nullable(),
    current: z.string(),
    version: z.number().int(),
    state: z.enum(['pending', 'delivered', 'failed']),
    attempts: z.number().int(),
    lastStatus: z.number().int().nullable(),
    lastError: z.string().nullable(),
    deliveredAt: z.string().nullable(),
  })
  .strict();
const deliveryView = (d: ApiDelivery) => ({ ...d, deliveredAt: iso(d.deliveredAt) });

/**
 * `bankApi.*` (J-bank-24; BK-bdev-01, BK-bdev-02): the bank API a person's own program calls with an API key they approved
 * with a second factor, or the person signed in. Reads take `bank:read`; a move between the person's own accounts and an
 * endpoint take `bank:write`; a payment out takes `trade:withdraw`, the person's own signed-in session after its second
 * factor, never a key, as the keys page promises ("No key can withdraw or move money off the platform"). Every figure and every move is the partner bank's; nothing here posts to the ledger (`developer-api/bank-api.ts`).
 */
export function createBankApiRouter(c: BankRouterContext) {
  const api = () => c.bank.bankApi;
  return router({
    accounts: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ type: z.enum(API_ACCOUNT_TYPES).optional(), limit }).strict())
      .output(z.object({ items: z.array(accountOut) }))
      .query(({ ctx, input }) => guard(async () => ({ items: (await api().accounts(ctx.principal.userId, input)).map(accountView) }))),
    quoteMove: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ fromAccountId: z.string().guid(), toAccountId: z.string().guid(), amount: amountString }).strict())
      .output(quoteOut)
      .mutation(({ ctx, input }) =>
        guard(async () => quoteView(await api().quote(ctx.principal.userId, { ...input, amount: parseAmount(input.amount) }))),
      ),
    move: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ quoteId: z.string().min(1).max(128), dedupeId: businessKey }).strict())
      .output(moveOut)
      .mutation(({ ctx, input }) => guard(async () => moveView(await api().move(ctx.principal.userId, input)))),
    // A payment out moves money off the platform: like every money-out door (`railSends.send`) it takes `trade:withdraw`,
    // which only the person's own session holds, after its second factor. No API key ever holds it (`INTERACTIVE_ONLY_SCOPES`).
    createPayment: scopedProcedure('trade:withdraw', { module: 'bank' })
      .input(
        z
          .object({
            idempotencyKey: businessKey,
            fromAccountId: z.string().guid(),
            method: z.enum(PARTNER_PAYMENT_METHODS),
            recipient,
            amount: amountString,
          })
          .strict(),
      )
      .output(paymentOut)
      .mutation(({ ctx, input }) =>
        guard(async () => paymentView(await api().createPayment(ctx.principal.userId, { ...input, amount: parseAmount(input.amount) }))),
      ),
    payment: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ paymentId: z.string().guid() }).strict())
      .output(paymentOut)
      .query(({ ctx, input }) => guard(async () => paymentView(await api().getPayment(ctx.principal.userId, input.paymentId)))),
    payments: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ limit }).strict())
      .output(z.object({ items: z.array(paymentOut) }))
      .query(({ ctx, input }) =>
        guard(async () => ({ items: (await api().listPayments(ctx.principal.userId, input.limit)).map(paymentView) })),
      ),
    createWebhook: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ endpointId: z.string().guid(), url: z.string().min(1).max(2048) }).strict())
      .output(endpointOut)
      .mutation(({ ctx, input }) => guard(async () => endpointView(await api().createEndpoint(ctx.principal.userId, input)))),
    webhooks: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ limit }).strict())
      .output(z.object({ items: z.array(endpointOut) }))
      .query(({ ctx, input }) =>
        guard(async () => ({ items: (await api().listEndpoints(ctx.principal.userId, input.limit)).map(endpointView) })),
      ),
    deliveries: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ endpointId: z.string().guid().optional(), paymentId: z.string().guid().optional(), limit }).strict())
      .output(z.object({ items: z.array(deliveryOut) }))
      .query(({ ctx, input }) => guard(async () => ({ items: (await api().deliveries(ctx.principal.userId, input)).map(deliveryView) }))),
  });
}
