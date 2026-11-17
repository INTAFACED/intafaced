/** Cards: the card, its catalogue and delivery, pay from, controls, details and PIN, 3D Secure, fraud and disputes. */
import { z } from 'zod';
import { decimalSchema as money } from '../../shared/money';

export const programmeSchema = z.object({ id: z.string(), simulated: z.boolean(), displayName: z.string() });
export const shippingAddressSchema = z.object({
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
/** The card room's product list for one country (J-bank-13 #1): eligibility with its reason, limits, terms, designs, speeds. */
export const cardCatalogueSchema = z.object({
  programme: programmeSchema,
  network: z.string(),
  country: z.string(),
  eligible: z.boolean(),
  reason: z.string().nullable(),
  countries: z.array(z.string()),
  products: z.array(z.object({ type: z.enum(['virtual', 'physical']), held: z.number().int(), limit: z.number().int() })),
  terms: z.object({
    version: z.string(),
    text: z.string(),
    textHash: z.string(),
    acceptance: z.object({ id: z.string(), version: z.string(), acceptedAt: z.string() }).nullable(),
  }),
  designs: z.array(z.object({ id: z.string(), name: z.string() })),
  speeds: z.array(z.object({ speed: z.enum(['standard', 'express', 'signed']), days: z.number().int() })),
  deliveryCountries: z.array(z.string()),
});
/** A physical card's delivery (J-bank-13 #3, #4): design, speed, estimate, state, tracking, address and its history. */
export const cardDeliverySchema = z.object({
  cardId: z.string(),
  state: z.enum(['ordered', 'produced', 'shipped', 'delivered']),
  designId: z.string().nullable(),
  designName: z.string().nullable(),
  speed: z.string(),
  estimateDays: z.number().int(),
  orderedAt: z.string(),
  expectedBy: z.string(),
  carrier: z.string().nullable(),
  trackingRef: z.string().nullable(),
  /** What the bank says delivery cannot do in this build: `hardware` while no printer or courier is connected. */
  notConnected: z.enum(['hardware']).nullable(),
  address: shippingAddressSchema,
  history: z.array(z.object({ address: shippingAddressSchema, changedAt: z.string() })),
});

/** Pay from (J-bank-29 #1 #2): svc-bank `cards.payFrom` and `cards.setPayFromOrder`. Each null is "not known". */
const payFromSchema = z.object({
  test: z.boolean(),
  custodyMode: z.enum(['partner_holds', 'wallet_pull']).nullable(),
  settlementAssetId: z.string().nullable(),
  assets: z.array(
    z.object({
      assetId: z.string(),
      state: z.enum(['offered', 'not_offered', 'not_known', 'not_listed']),
      partnerBalance: z.string().nullable(),
      rate: z.string().nullable(),
      rateAsOf: z.string().nullable(),
    }),
  ),
  order: z.array(z.string()).nullable(),
  notUsedForCards: z.array(z.enum(['trading', 'agent'])),
});

/**
 * svc-bank `cards.controls.*` (J-bank-14 #1, BK-cctl-01): the categories a card can block, its live blocks of a
 * category, a merchant or a country, and the history of its temporary lock, newest first.
 */
export const cardControlsSchema = z.object({
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

/**
 * svc-bank card details, PIN and phone wallets (J-bank-14 #3 #4, BK-cctl-03, BK-cctl-04): which the issuer offers, the
 * revealed details and PIN with when to drop them, and the wallets the card was added to. `test` marks the TEST
 * partner's stand-ins, which the screen labels TEST.
 */
export const cardSecretsOfferedSchema = z.object({
  details: z.boolean(),
  pin: z.boolean(),
  wallet: z.boolean(),
  test: z.boolean(),
  /** The card partner itself does not add this person's cards to a phone wallet (J-bank-13 #8). */
  walletNotOffered: z.boolean().default(false),
});
export const cardRevealSchema = z.object({
  pan: z.string(),
  expiry: z.string(),
  cvv: z.string(),
  expiresAt: z.string(),
  test: z.boolean(),
});
export const cardPinRevealSchema = z.object({ pin: z.string(), expiresAt: z.string(), test: z.boolean() });
export const cardWalletTokensSchema = z.object({
  test: z.boolean(),
  tokens: z.array(
    z.object({ id: z.string(), wallet: z.enum(['apple', 'google']), state: z.enum(['added', 'paused', 'closed']), addedAt: z.string() }),
  ),
});
export type CardWalletTokens = z.infer<typeof cardWalletTokensSchema>;
/** A 3D Secure challenge as svc-bank answers it (J-bank-14 #5). `testCode` is the TEST partner's code, TEST stack only. */
export const cardThreeDSChallengeSchema = z.object({
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
export const cardFraudReportSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  authorizationId: z.string(),
  state: z.literal('open'),
  createdAt: z.string(),
});
export type CardFraudReport = z.infer<typeof cardFraudReportSchema>;

/** J-bank-15: a cardholder's own card dispute, as svc-bank `cards.disputes.*` answers it. The money is the partner's. */
const disputeStateSchema = z.enum(['opened', 'representment', 'arbitration', 'closed']);
export const cardDisputeCaseSchema = z.object({
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
export const cardDisputeFormSchema = z.object({
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
export const cardsReads = {
  'cards.programme': programmeSchema,
  'cards.catalogue': cardCatalogueSchema,
  'cards.payFrom': payFromSchema,
  'cards.delivery': cardDeliverySchema,
  'cards.cashback': z.object({
    tier: z.enum(['none', 'standard', 'metal', 'obsidian']),
    rateBps: z.number().int().nullable(),
    assetId: z.string(),
    rates: z.array(z.object({ tier: z.enum(['none', 'standard', 'metal', 'obsidian']), bps: z.number().int() })),
    paid: money,
    unpaid: money,
    refused: money,
    /** Owed by INTAFACED on partner-held spend and paid to the person's own wallet (My rewards); never spendable here. */
    toWallet: money,
    payments: z.array(
      z.object({
        authorizationId: z.string(),
        cardId: z.string(),
        amount: money,
        status: z.string(),
        rejectionCode: z.string().nullable(),
        ledgerTxId: z.string().nullable(),
        paidBy: z.enum(['ledger', 'wallet']),
        announced: z.boolean(),
      }),
    ),
    paying: z.boolean(),
    simulated: z.boolean(),
  }),
  'cards.uses': z.object({ cardId: z.string(), usesAllowed: z.number().int().nullable(), usesMade: z.number().int() }),
  'cards.list': z.array(cardSchema),
  'cards.controls.get': cardControlsSchema,
  'cards.secretsOffered': cardSecretsOfferedSchema,
  'cards.walletTokens': cardWalletTokensSchema,
  'cards.threeDS.list': z.object({ challenges: z.array(cardThreeDSChallengeSchema) }),
  'cards.fraud.list': z.object({ reports: z.array(cardFraudReportSchema) }),
  'cards.disputes.form': cardDisputeFormSchema,
  'cards.disputes.list': z.array(cardDisputeCaseSchema.omit({ events: true })),
  'cards.disputes.get': cardDisputeCaseSchema,
  /** One row per merchant that charges the card on file (J-bank-14 #6), newest first. */
  'cards.recurring': z.array(
    z.object({
      merchant: z.string().nullable(),
      merchantCountry: z.string().nullable(),
      payments: z.number().int(),
      firstAt: z.string(),
      lastAt: z.string(),
      lastAmount: money,
    }),
  ),
  'cards.authorizations': z.array(
    z.object({
      id: z.string(),
      authorizationRef: z.string(),
      amount: money,
      merchantCategory: z.string().nullable(),
      /** The merchant and its country as the issuer named them (J-bank-14 #1); null when it named none. */
      merchant: z.string().nullable().default(null),
      merchantCountry: z.string().nullable().default(null),
      /** The issuer flagged a merchant charging the card on file on an agreed schedule (J-bank-14 #6). */
      recurring: z.boolean().default(false),
      decision: z.enum(['approved', 'declined']),
      declineCode: z.string().nullable(),
      status: z.string(),
      decidedAt: z.string(),
      /** The merchant's refund of this payment, as recorded; the partner moves it and our ledger posts nothing. */
      refund: z
        .object({ amount: money, status: z.enum(['pending', 'settled', 'rejected']), at: z.string() })
        .nullable()
        .default(null),
      conversion: z
        .object({ settlementAssetId: z.string(), settlementAmount: money, rate: money, rateQuality: z.string(), rateAsOf: z.string() })
        .nullable(),
    }),
  ),
} as const;

/** This area's writes to svc-bank `bank.*`, composed into `bankWrites` in contracts.ts. */
export const cardsWrites = {
  'cards.setStatus': z.object({ id: z.string(), status: z.string() }),
  'cards.issue': cardSchema,
  'cards.order': cardSchema,
  'cards.acceptTerms': z.object({ id: z.string(), version: z.string(), acceptedAt: z.string() }),
  'cards.updateShipping': cardDeliverySchema,
  'cards.setPayFromOrder': payFromSchema,
  'cards.activate': cardSchema,
  'cards.replace': cardSchema,
  'cards.setLimits': cardSchema,
  'cards.setChannels': cardSchema,
  'cards.controls.block': cardControlsSchema,
  'cards.controls.lift': cardControlsSchema,
  'cards.reveal': cardRevealSchema,
  'cards.pin.reveal': cardPinRevealSchema,
  'cards.pin.set': z.object({ ok: z.literal(true) }),
  'cards.walletProvision': z.object({ payload: z.string(), expiresAt: z.string(), test: z.boolean() }),
  'cards.threeDS.answer': cardThreeDSChallengeSchema,
  'cards.fraud.report': cardFraudReportSchema,
  'cards.disputes.open': cardDisputeCaseSchema,
  'cards.disputes.evidence': cardDisputeCaseSchema,
  'cards.disputes.withdraw': cardDisputeCaseSchema,
} as const;
