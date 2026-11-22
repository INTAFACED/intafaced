/** Cards: the card, its catalogue and delivery, pay from, controls, details and PIN, 3D Secure, fraud and disputes. */
import { z } from 'zod';
import { decimalSchema as money } from '../../shared/money';

const shippingAddressSchema = z.object({
  name: z.string(),
  line1: z.string(),
  line2: z.string().nullable(),
  city: z.string(),
  region: z.string().nullable(),
  postalCode: z.string(),
  country: z.string(),
});
export const cardSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  settlementAssetId: z.string(),
  issuer: z.string(),
  simulated: z.boolean(),
  panTail: z.string(),
  /** `inactive`: issued, not activated yet (J-bank-13 #5); it declines every payment until the person activates it. */
  status: z.enum(['active', 'inactive', 'frozen', 'closed']),
  cashbackBps: z.number().int(),
  perAuthorizationLimit: money,
  /** A blank ceiling is `null`: the card has no cap of that kind. It is never shown as zero. */
  dailyLimit: money.nullable(),
  monthlyLimit: money.nullable(),
  cashLimit: money.nullable(),
  online: z.boolean(),
  contactless: z.boolean(),
  atm: z.boolean(),
  abroad: z.boolean(),
  cardType: z.enum(['virtual', 'physical']),
  shippingAddress: shippingAddressSchema.nullable(),
  /** Single-use (1) or n-use: captured payments before the card closes itself. Null is no limit. */
  usesAllowed: z.number().int().nullable().optional(),
  designId: z.string().nullable().optional(),
  deliverySpeed: z.string().nullable().optional(),
  replacesCardId: z.string().nullable().optional(),
  replacedByCardId: z.string().nullable().optional(),
});

/**
 * svc-bank `cards.controls.*` (J-bank-14 #1, BK-cctl-01): the categories a card can block, its live blocks of a
 * category, a merchant or a country, and the history of its temporary lock, newest first.
 */
const cardControlsSchema = z.object({
  categories: z.array(z.string()),
  controls: z.array(
    z.object({ id: z.string(), kind: z.enum(['category', 'merchant', 'country']), value: z.string(), createdAt: z.string() }),
  ),
  history: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['active', 'frozen', 'closed']),
      actor: z.enum(['owner', 'holder', 'operator', 'system']),
      at: z.string(),
    }),
  ),
});
export type CardControls = z.infer<typeof cardControlsSchema>;

const cardWalletTokensSchema = z.object({
  test: z.boolean(),
  tokens: z.array(
    z.object({ id: z.string(), wallet: z.enum(['apple', 'google']), state: z.enum(['added', 'paused', 'closed']), addedAt: z.string() }),
  ),
});
export type CardWalletTokens = z.infer<typeof cardWalletTokensSchema>;
/** A 3D Secure challenge as svc-bank answers it (J-bank-14 #5). `testCode` is the TEST partner's code, TEST stack only. */
const cardThreeDSChallengeSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  challengeRef: z.string(),
  amount: z.string(),
  merchant: z.string().nullable(),
  merchantCountry: z.string().nullable(),
  state: z.enum(['open', 'approved', 'locked']),
  /** Null while the owner has not set the count. */
  triesLeft: z.number().int().nullable(),
  authorizationId: z.string().nullable(),
  /** The completed authorisation's own decision: an approved code can still meet a declined purchase. */
  decision: z.enum(['approved', 'declined']).nullable(),
  declineCode: z.string().nullable(),
  createdAt: z.string(),
  testCode: z.string().nullable(),
});
export type CardThreeDSChallenge = z.infer<typeof cardThreeDSChallengeSchema>;
/** One card fraud report (J-bank-14 #7). */
const cardFraudReportSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  authorizationId: z.string(),
  state: z.literal('open'),
  createdAt: z.string(),
});
export type CardFraudReport = z.infer<typeof cardFraudReportSchema>;

/** J-bank-15: a cardholder's own card dispute, as svc-bank `cards.disputes.*` answers it. The money is the partner's. */
const disputeStateSchema = z.enum(['opened', 'representment', 'arbitration', 'closed']);
const cardDisputeCaseSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  authorizationRef: z.string(),
  assetId: z.string(),
  amount: money,
  reason: z.string(),
  state: disputeStateSchema,
  test: z.boolean(),
  provisionalCredit: z.object({
    state: z.enum(['none', 'asked', 'credited']),
    amount: money.nullable(),
    partnerRef: z.string().nullable(),
    at: z.string().nullable(),
  }),
  decision: z
    .object({
      outcome: z.enum(['cardholder', 'merchant', 'withdrawn']),
      reason: z.string().nullable(),
      creditSettlement: z.enum(['final', 'reversed']).nullable(),
      creditSettlementPartnerRef: z.string().nullable(),
      closedAt: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
  events: z.array(
    z.object({
      sequence: z.number().int(),
      kind: z.enum(['opened', 'evidence', 'representment', 'arbitration', 'provisional_credit', 'closed']),
      fromState: disputeStateSchema.nullable(),
      toState: disputeStateSchema,
      by: z.enum(['you', 'support']),
      detail: z.string().nullable(),
      afterSubmission: z.boolean(),
      at: z.string(),
    }),
  ),
});
const cardDisputeFormSchema = z.object({
  test: z.boolean(),
  rules: z.object({ windowDays: z.number().int(), evidenceAfterSubmission: z.boolean() }).nullable(),
  charge: z.object({
    authorizationRef: z.string(),
    assetId: z.string(),
    merchant: z.string().nullable(),
    captured: money,
    disputable: money,
    settledAt: z.string().nullable(),
  }),
  deadline: z.string().nullable(),
  standing: z.enum(['disputable', 'declined', 'not_settled', 'refunded', 'already_disputed', 'window_closed', 'rules_unset']),
  disputeId: z.string().nullable(),
});

/** This area's reads of svc-bank `bank.*`, composed into `bankReads` in contracts.ts. */
export const cardsReads = {} as const;

/** This area's writes to svc-bank `bank.*`, composed into `bankWrites` in contracts.ts. */
export const cardsWrites = {
  'cards.controls.block': cardControlsSchema,
  'cards.controls.lift': cardControlsSchema,
} as const;
