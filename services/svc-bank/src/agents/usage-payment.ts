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
 *
 * A business team's run (J-agents-11) names `businessId`: the business pays. Its payment method is the main balance at
 * the partner of its first administrator (`businessPayer`), since a business account holds no money of its own here; a
 * closed or unknown business has none. The member who ran it is still named, and settles what they ran after removal.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from 'postgres';
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
import {
  assertPostingEnabled,
  type PartnerAccountRef,
  type PartnerBank,
  type PartnerCustody,
  type PostingFreeze,
} from '../partner/partner-bank.js';
import { moneyHeldBy, type TestPartnerDoors } from '../partner/test-partner.js';

/** INTAFACED's own account at the partner, where a person's payment to us lands. It is on no person's list of balances. */
export const PARTNER_INTAFACED_OWNER = 'partner:intafaced';
export const partnerIntafacedAccount = (assetId: string): PartnerAccountRef => ({
  userId: PARTNER_INTAFACED_OWNER,
  assetId,
  spaceId: null,
});

/** The partner move key for one usage window: one window is one payment. */
/** A business's first administrator, while the business is active: who pays for its team runs. */
export async function firstAdministrator(sql: Sql, businessId: string): Promise<string | null> {
  const [row] = await sql<Array<{ user_id: string }>>`
    SELECT m.user_id
      FROM bank.business_accounts a
      JOIN bank.business_members m ON m.account_id = a.id
     WHERE a.id = ${businessId.toLowerCase()} AND a.status = 'active' AND m.role = 'admin'
     ORDER BY m.created_at, m.user_id
     LIMIT 1
  `;
  return row?.user_id ?? null;
}

export const usagePaymentKey = (chargeKey: string): string => `agents.usage-payment:${chargeKey}`;

export interface UsagePaymentDeps {
  /** Where the person's money is held: `partner` (with its book), `ledger` (the custodial layer) or `none`. */
  heldBy(
    userId: string,
  ): { readonly kind: 'partner'; readonly bank: PartnerBank; readonly partnerId: string } | { readonly kind: 'ledger' | 'none' };
  readonly freeze: PostingFreeze;
  /** Who pays for an active business: its first administrator, or null for a closed or unknown business. */
  businessPayer(businessId: string): Promise<string | null>;
}

/**
 * Where a person's money is held, with the partner's GUARDED bank: the custody `createBankServices` builds, which asks the
 * posting freeze and the operator's partner stop before every move. Never the TEST partner's raw bank, which asks neither
 * (until 16 Nov this door was handed the raw one, so an operator's stop never refused a usage payment).
 */
export function usagePaymentHeldBy(
  partner: TestPartnerDoors | null,
  custody: PartnerCustody,
  custodyLayer: 'on' | 'off',
): UsagePaymentDeps['heldBy'] {
  return (userId) => {
    const held = moneyHeldBy(partner, userId, custodyLayer);
    const bank = held === 'partner' ? custody.bankFor(userId) : null;
    if (bank) return { kind: 'partner', bank, partnerId: 'test' };
    return { kind: held === 'partner' ? 'none' : held };
  };
}

/** The person whose payment method pays: the business's payer for a team run, else the person themselves. */
async function payerOf(deps: UsagePaymentDeps, userId: string, businessId: string | undefined): Promise<string | null> {
  return businessId === undefined ? userId : deps.businessPayer(businessId);
}

export async function readUsagePayment(
  deps: UsagePaymentDeps,
  member: string,
  assetId: string,
  businessId?: string,
): Promise<AgentsUsagePaymentRead> {
  const userId = await payerOf(deps, member, businessId);
  if (userId === null) return { heldBy: 'none' };
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
  'bank.partner_stopped': 'partner_stopped',
  'bank.partner_stop_unreadable': 'partner_stopped',
};

export async function collectUsagePayment(
  deps: UsagePaymentDeps,
  input: Extract<AgentsUsagePaymentRequest, { action: 'collect' }>,
): Promise<AgentsUsagePaymentCollect> {
  const payer = await payerOf(deps, input.userId, input.businessId);
  if (payer === null) return { ok: false, reason: 'not_partner_held' };
  const held = deps.heldBy(payer);
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
      from: { userId: payer, assetId: input.assetId, spaceId: null },
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
        const read = agentsUsagePaymentReadSchema.safeParse(
          await readUsagePayment(deps, parsed.data.userId, parsed.data.assetId, parsed.data.businessId),
        );
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
