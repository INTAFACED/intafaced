/**
 * S2S: how a person pays for agent usage, and one payment of a sealed usage window (J-agents-01; launch money model,
 * docs/adr/2026-11-10-launch-money-model.md; contract `@intafaced/contracts` agents-usage-payment).
 *
 * Only svc-agents may call; the body is bound to the signature. At launch the person's money is held by the partner
 * (OWNER 226): the partner carries the payment out, from the person's main balance to INTAFACED's own account at the
 * partner, as one partner move under a key derived from the window's business key. Our ledger posts nothing here:
 * svc-agents earns the charge before it asks, and collects it, keyed on the partner's payment id, after.
 *
 * Every refusal is an answer (200, `ok: false`) naming why, so svc-agents keeps the window owed and asks again later; a
 * failure to answer at all is 503. `reply_lost` means the partner may have made the payment: asking again under the same
 * key answers with that payment, or makes it once.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AGENTS_USAGE_PAYMENT_PATH,
  agentsUsagePaymentCollectSchema,
  agentsUsagePaymentReadSchema,
  agentsUsagePaymentRequestSchema,
  verifyServiceRequest,
  type AgentsUsagePaymentCollect,
  type AgentsUsagePaymentRead,
  type AgentsUsagePaymentRequest,
  type ServiceAuthMode,
  type ServiceVerifier,
} from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { assertPostingEnabled, type PartnerAccountRef, type PartnerBank, type PostingFreeze } from '../partner/partner-bank.js';

/** INTAFACED's own account at the partner, where a person's payment to us lands. It is on no person's list of balances. */
export const PARTNER_INTAFACED_OWNER = 'partner:intafaced';
export const partnerIntafacedAccount = (assetId: string): PartnerAccountRef => ({
  userId: PARTNER_INTAFACED_OWNER,
  assetId,
  spaceId: null,
});

/** The partner move key for one usage window: one window is one payment. */
export const usagePaymentKey = (chargeKey: string): string => `agents.usage-payment:${chargeKey}`;

export interface UsagePaymentDeps {
  /** Where the person's money is held: `partner` (with its book), `ledger` (the custodial layer) or `none`. */
  heldBy(
    userId: string,
  ): { readonly kind: 'partner'; readonly bank: PartnerBank; readonly partnerId: string } | { readonly kind: 'ledger' | 'none' };
  readonly freeze: PostingFreeze;
}

export async function readUsagePayment(deps: UsagePaymentDeps, userId: string, assetId: string): Promise<AgentsUsagePaymentRead> {
  const held = deps.heldBy(userId);
  if (held.kind !== 'partner') return { heldBy: held.kind };
  const balance = await held.bank.balance({ userId, assetId, spaceId: null });
  const known = balance.amount !== null && balance.asOf !== null && balance.unavailable !== true;
  return {
    heldBy: 'partner',
    label: balance.label,
    available: known ? formatAmount(balance.amount!) : null,
    asOf: known ? balance.asOf!.toISOString() : null,
  };
}

const REFUSAL_BY_CODE: Record<string, Extract<AgentsUsagePaymentCollect, { ok: false }>['reason']> = {
  'bank.partner_insufficient_funds': 'insufficient_funds',
  'bank.partner_unavailable': 'partner_unavailable',
  'bank.partner_reply_lost': 'reply_lost',
  'bank.posting_frozen': 'posting_frozen',
};

export async function collectUsagePayment(
  deps: UsagePaymentDeps,
  input: Extract<AgentsUsagePaymentRequest, { action: 'collect' }>,
): Promise<AgentsUsagePaymentCollect> {
  const held = deps.heldBy(input.userId);
  if (held.kind !== 'partner') return { ok: false, reason: 'not_partner_held' };
  const amount = parseAmount(input.amount);
  if (amount <= 0n) throw new BankError('A usage payment needs an amount above zero.', 'bank.partner_amount_invalid');
  const key = usagePaymentKey(input.chargeKey);
  try {
    // A payment already made under this key is answered as made, even while the freeze is on: nothing moves again.
    const prior = await held.bank.moveByKey(key);
    if (!prior) await assertPostingEnabled(deps.freeze, 'agents_usage_payment');
    const move = await held.bank.move({
      key,
      from: { userId: input.userId, assetId: input.assetId, spaceId: null },
      to: partnerIntafacedAccount(input.assetId),
      amount,
    });
    return {
      ok: true,
      paymentId: move.id,
      partnerId: held.partnerId,
      label: move.label,
      amount: formatAmount(move.amount),
      paidAt: move.movedAt.toISOString(),
    };
  } catch (err) {
    const reason = err instanceof BankError ? REFUSAL_BY_CODE[err.code] : undefined;
    if (reason) return { ok: false, reason };
    throw err;
  }
}

function callerOf(req: FastifyRequest, secret: string, s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode }): string | null {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  try {
    return verifyServiceRequest(req, { verifier: s2s?.verifier, mode: s2s?.mode, legacySecret: secret, bodyBindMode: 'require' }).service;
  } catch {
    return null;
  }
}

export function registerAgentsUsagePayment(
  app: FastifyInstance,
  deps: UsagePaymentDeps & { secret: string; s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode } },
): void {
  app.post(AGENTS_USAGE_PAYMENT_PATH, async (req, reply) => {
    const caller = callerOf(req, deps.secret, deps.s2s);
    if (caller === null) return reply.code(401).send({ error: 'service credentials required', code: 'bank.unauthenticated' });
    if (caller !== 'svc-agents') {
      return reply.code(403).send({ error: 'agent usage payment is for the agents service only', code: 'bank.usage_payment_forbidden' });
    }
    const parsed = agentsUsagePaymentRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'usage payment request is invalid', code: 'bank.usage_payment_input' });
    try {
      if (parsed.data.action === 'read') {
        const read = agentsUsagePaymentReadSchema.safeParse(await readUsagePayment(deps, parsed.data.userId, parsed.data.assetId));
        if (read.success) return read.data;
      } else {
        const done = agentsUsagePaymentCollectSchema.safeParse(await collectUsagePayment(deps, parsed.data));
        if (done.success) return done.data;
      }
    } catch {
      // Falls through: an answer we cannot give is never a payment made or refused.
    }
    return reply.code(503).send({ error: 'usage payment could not be answered', code: 'bank.usage_payment_unavailable' });
  });
}
