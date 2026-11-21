/**
 * The card programme's authorisation rules and 3DS policy (J-bank-26 #1, #4; BK-cops-07, BK-cops-02), as pure decisions.
 *
 * A rule declines; it never approves past another check and never moves value. A 3DS policy decides whether an online
 * payment needs the cardholder's challenge; an SCA exemption skips it for a payment within its limit. Each answer comes
 * with the words the authorisation's trace keeps, so support reads why a payment was decided the way it was.
 */
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { z } from 'zod';

export const RULE_KINDS = ['amount_above', 'merchant_category', 'channel'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/);
const assetId = z.string().regex(/^[A-Z0-9]{2,16}$/);

export const ruleParamsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('amount_above'), assetId, amount: decimal }).strict(),
  z.object({ kind: z.literal('merchant_category'), category: z.string().trim().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('channel'), channel: z.enum(['card-present', 'online', 'contactless', 'atm', 'foreign']) }).strict(),
]);
export type RuleParams = z.infer<typeof ruleParamsSchema>;

/** What a rule reads of one authorisation: its amount in the card's funding asset, its channel and merchant category. */
export interface RuleInput {
  readonly assetId: string;
  readonly amount: Amount;
  readonly channel: string;
  readonly merchantCategory: string | null;
}

/** Whether a rule would decline this authorisation. */
export function ruleDeclines(params: RuleParams, at: RuleInput): boolean {
  switch (params.kind) {
    case 'amount_above':
      return at.assetId === params.assetId && at.amount > parseAmount(params.amount);
    case 'merchant_category':
      return at.merchantCategory !== null && at.merchantCategory === params.category;
    case 'channel':
      return at.channel === params.channel;
  }
}

/** The rule in words, for the desk and the trace. */
export function ruleWords(params: RuleParams): string {
  switch (params.kind) {
    case 'amount_above':
      return `declines a payment above ${params.amount} ${params.assetId}`;
    case 'merchant_category':
      return `declines merchant category ${params.category}`;
    case 'channel':
      return `declines the ${params.channel} channel`;
  }
}

/** One step of an authorisation's trace: a check, its answer and why. */
export interface TraceStep {
  readonly check: string;
  readonly result: 'pass' | 'decline' | 'skip';
  readonly detail: string;
}

// ── 3DS ──────────────────────────────────────────────────────────────────────

export const THREEDS_MODES = ['challenge_all', 'frictionless'] as const;

export const threeDsPolicySchema = z
  .object({
    /** `challenge_all`: every online payment is challenged unless an exemption applies. `frictionless`: none is. */
    mode: z.enum(THREEDS_MODES),
    /** The SCA low-value exemption: an online payment within this amount skips the challenge. Null: no exemption. */
    lowValueExemption: z.object({ assetId, limit: decimal }).strict().nullable(),
  })
  .strict();
export type ThreeDsPolicy = z.infer<typeof threeDsPolicySchema>;

/** The cardholder's answer to a challenge, as the issuer's message carries it. Omitted: no challenge was done. */
export type ThreeDsResult = 'authenticated' | 'failed';

export interface ThreeDsDecision {
  /** `exempt`: the challenge is skipped. `challenge`: the payment needs one. `none`: no policy asks for one. */
  readonly outcome: 'exempt' | 'challenge' | 'none';
  readonly step: TraceStep;
  /** The decline code when the payment needed a challenge it did not pass. */
  readonly decline: string | null;
}

/**
 * The 3DS answer for one payment. Only online payments are asked. With no policy saved this app asks no challenge and
 * says so; the payment is not treated as authenticated.
 */
export function threeDsDecision(
  policy: ThreeDsPolicy | null,
  at: { channel: string; assetId: string; amount: Amount; result?: ThreeDsResult },
): ThreeDsDecision | null {
  if (at.channel !== 'online') return null;
  if (policy === null) {
    return {
      outcome: 'none',
      decline: null,
      step: { check: '3DS policy', result: 'skip', detail: 'No 3DS policy is set, so this app asked no challenge.' },
    };
  }
  const amount = formatAmount(at.amount);
  const exemption = policy.lowValueExemption;
  if (exemption && exemption.assetId === at.assetId && at.amount <= parseAmount(exemption.limit)) {
    return {
      outcome: 'exempt',
      decline: null,
      step: {
        check: '3DS policy',
        result: 'skip',
        detail: `SCA low-value exemption: ${amount} ${at.assetId} is under the exemption limit of ${exemption.limit} ${exemption.assetId}, so the challenge was skipped.`,
      },
    };
  }
  if (policy.mode === 'frictionless') {
    return {
      outcome: 'none',
      decline: null,
      step: { check: '3DS policy', result: 'pass', detail: 'The 3DS policy is frictionless: no challenge is asked.' },
    };
  }
  const why = exemption
    ? `${amount} ${at.assetId} is not under the exemption limit of ${exemption.limit} ${exemption.assetId}`
    : 'no exemption is set';
  if (at.result === 'authenticated') {
    return {
      outcome: 'challenge',
      decline: null,
      step: { check: '3DS policy', result: 'pass', detail: `Challenge required (${why}); the cardholder passed it.` },
    };
  }
  return {
    outcome: 'challenge',
    decline: 'bank.card_3ds_required',
    step: {
      check: '3DS policy',
      result: 'decline',
      detail: `Challenge required (${why}); ${at.result === 'failed' ? 'the cardholder failed it' : 'none was passed'}.`,
    },
  };
}
