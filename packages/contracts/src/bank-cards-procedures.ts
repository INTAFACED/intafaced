import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { amountString } from './bank-earn-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `cards.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** The merchant categories a person can block, as the issuer names them on an authorisation. */
export const CARD_CATEGORIES = [
  'gambling',
  'cash_like',
  'adult',
  'travel',
  'entertainment',
  'online_shopping',
  'groceries',
  'fuel',
] as const;

export const CARD_CONTROL_KINDS = ['category', 'merchant', 'country'] as const;

/** `cards.controls.*`: the card's live controls, the categories it can block, and its lock history (J-bank-14 #1). */
export const cardControlsOutput = z.object({
  categories: z.array(z.enum(CARD_CATEGORIES)),
  controls: z.array(z.object({ id: z.string(), kind: z.enum(CARD_CONTROL_KINDS), value: z.string(), createdAt: z.string() })),
  history: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['active', 'frozen', 'closed']),
      actor: z.enum(['owner', 'holder', 'operator', 'system']),
      at: z.string(),
    }),
  ),
});

/**
 * CARDS (§8.1) — the LEDGER half only.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * There is no user-callable `authorize`, `capture` or `reverse`. Those three
 * are the ISSUER speaking, not the user, and they are in `ops` behind
 * `admin:treasury` for the same reason the risk sweep is: a user who can
 * decide their own authorisation is a user who can approve a purchase the
 * ledger would have declined, and a user who can trigger a capture can choose
 * when their own money leaves.
 *
 * On a live rail they do not become user procedures either. They become a
 * signed webhook endpoint owned by the issuer integration — which is
 * `socket.live-issuer`, a card-scheme sponsor and an issuing BIN, and is a
 * contract rather than code.
 *
 * ── EVERY SURFACE SAYS WHAT IT IS ──────────────────────────────────────────
 *
 * `simulated` is on the card output and it is not optional. A screen rendering
 * a card from this router cannot accidentally present it as a real one, and a
 * deployment with no issuer at all cannot get this far: it refuses with
 * `bank.no_card_issuer` before a row is written.
 */
export const shippingAddressInput = z.object({
  name: z.string().trim().min(1).max(120),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().min(1).max(32),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/),
});

/** Optional on the wire so a missing approval is `bank.step_up_required`, not a Zod error. */
export const stepUpApprovalField = z.string().min(1).max(128).optional();

export const deliveryOutput = z.object({
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
  notConnected: z.enum(['hardware']).nullable(),
  address: z.object({
    name: z.string(),
    line1: z.string(),
    line2: z.string().nullable(),
    city: z.string(),
    region: z.string().nullable(),
    postalCode: z.string(),
    country: z.string(),
  }),
  history: z.array(
    z.object({
      address: z.object({
        name: z.string(),
        line1: z.string(),
        line2: z.string().nullable(),
        city: z.string(),
        region: z.string().nullable(),
        postalCode: z.string(),
        country: z.string(),
      }),
      changedAt: z.string(),
    }),
  ),
});

export const cardOutput = z.object({
  id: z.string(),
  /** Which balance the card draws on. Every posting against it is in this asset. */
  assetId: z.string(),
  /**
   * What merchants charge this card in (§18).
   *
   * Equal to `assetId` means no conversion happens and no rate is consulted.
   * Different means every authorisation is quoted at the authorisation moment
   * — and refuses by name where no rate can be got, which on a fiat settlement
   * asset is every time, because this platform has no FX source.
   */
  settlementAssetId: z.string(),
  /** The programme id, which is also the ledger rail label. */
  issuer: z.string(),
  /** TRUE MEANS THERE IS NO CARD. Never omitted, never defaulted. */
  simulated: z.boolean(),
  /** Four digits. Not a card number and not part of one. */
  panTail: z.string(),
  /** `inactive`: issued but not activated yet (BK-cissue-04); it declines every authorisation until it is. */
  status: z.enum(['active', 'inactive', 'frozen', 'closed']),
  cashbackBps: z.number().int(),
  perAuthorizationLimit: amountString,
  dailyLimit: amountString.nullable(),
  monthlyLimit: amountString.nullable(),
  cashLimit: amountString.nullable(),
  online: z.boolean(),
  contactless: z.boolean(),
  atm: z.boolean(),
  abroad: z.boolean(),
  cardType: z.enum(['virtual', 'physical']),
  shippingAddress: z
    .object({
      name: z.string(),
      line1: z.string(),
      line2: z.string().nullable(),
      city: z.string(),
      region: z.string().nullable(),
      postalCode: z.string(),
      country: z.string(),
    })
    .nullable(),
  /** Single-use (1) or n-use: captured payments before it closes itself. NULL is no limit. */
  usesAllowed: z.number().int().nullable(),
  designId: z.string().nullable(),
  deliverySpeed: z.string().nullable(),
  replacesCardId: z.string().nullable(),
  replacedByCardId: z.string().nullable(),
});

export const CARD_TIERS = ['none', 'standard', 'metal', 'obsidian'] as const;

/**
 * THE CARD PARTNER'S UNKNOWNS (CUSTODY-DELTA §1.3 and §4, row "TEST partner card"), and they are the partner's.
 *
 * INTAFACED holds no customer money (OWNER 226): the card and its money sit with Phantom's partner, who is not named yet.
 * Four things only that partner can answer, so each is a fact the issuer adapter REPORTS, never one this service decides:
 *
 *   · `custodyMode`: does the partner hold the person's crypto to spend it (`partner_holds`), or does the card pull from the
 *     person's own wallet (`wallet_pull`)? J-bank-29 runs in both modes.
 *   · `spendFrom`: the assets the partner can spend from. Any other asset reads "not offered by the partner" (J-bank-29 #2).
 *   · `lossLiability`: who bears a lost chargeback or a card fraud loss, under the partner's terms (J-bank-15, J-bank-27 #4).
 *   · `reserve` and `funder`: any reserve or pre-funding the partner requires of the programme, and who funds the
 *     programme (J-bank-26 #6).
 *
 * `null` is "not known", and it stays "not known" on every surface. It is never read as the partner bearing the loss, never
 * as a reserve of zero and never as an empty asset list: an unknown is not an answer (CUSTODY-DELTA §1.3, "Unknown, never
 * zero").
 */
export const CARD_CUSTODY_MODES = ['partner_holds', 'wallet_pull'] as const;

export const decimalOrNull = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/)
  .nullable();

/** The two kinds of account a card never pays from (J-bank-29 #2 and its Money line), whatever the order says. */
export const NOT_USED_FOR_CARDS = ['trading', 'agent'] as const;

export const payFromOutput = z.object({
  test: z.boolean(),
  custodyMode: z.enum(CARD_CUSTODY_MODES).nullable(),
  settlementAssetId: z.string().nullable(),
  assets: z.array(
    z.object({
      assetId: z.string(),
      state: z.enum(['offered', 'not_offered', 'not_known', 'not_listed']),
      partnerBalance: decimalOrNull,
      rate: decimalOrNull,
      rateAsOf: z.string().nullable(),
    }),
  ),
  order: z.array(z.string()).nullable(),
  notUsedForCards: z.array(z.enum(NOT_USED_FOR_CARDS)),
});

export const DELIVERY_SPEEDS = ['standard', 'express', 'signed'] as const;

/** One 3D Secure challenge as the person sees it (J-bank-14 #5). */
export const threeDSChallengeOutput = z.object({
  id: z.string(),
  cardId: z.string(),
  challengeRef: z.string(),
  amount: z.string(),
  merchant: z.string().nullable(),
  merchantCountry: z.string().nullable(),
  state: z.enum(['open', 'approved', 'locked']),
  /** Null while the owner has not set the count (answering refuses `bank.card_3ds_try_limit_unset`). */
  triesLeft: z.number().int().nullable(),
  authorizationId: z.string().nullable(),
  /** The completed authorisation's own decision: an approved code can still meet a declined purchase. */
  decision: z.enum(['approved', 'declined']).nullable(),
  declineCode: z.string().nullable(),
  createdAt: z.string(),
  testCode: z.string().nullable(),
});

/** One card fraud report (J-bank-14 #7). */
export const fraudReportOutput = z.object({
  id: z.string(),
  cardId: z.string(),
  authorizationId: z.string(),
  state: z.literal('open'),
  createdAt: z.string(),
});

/**
 * The card partner's figures for one cardholder and asset, as it reports them (OWNER 226; `cards/partner-card-holds.ts`).
 * `test` is true on the TEST partner card. Each null is "not known", never 0.
 */
export const partnerFiguresOutput = z
  .object({
    test: z.boolean(),
    mode: z.enum(['partner_holds', 'wallet_pull']).nullable(),
    assetId: z.string(),
    available: z.string().nullable(),
    held: z.string().nullable(),
  })
  .strict();

/** One partner-held hold as the card partner reports it now. */
export const partnerHoldReportOutput = z
  .object({
    test: z.boolean(),
    partnerRef: z.string(),
    mode: z.enum(['partner_holds', 'wallet_pull']),
    status: z.enum(['held', 'captured', 'released', 'expired']),
    amount: z.string(),
    captured: z.string(),
    released: z.string(),
    refunded: z.string(),
    open: z.string(),
    expiresAt: z.string().nullable(),
    /** The asset the partner holds it in, when it says. */
    assetId: z.string().optional(),
    /** A hold by a pay-from order (J-bank-29): the merchant's amount, the partner's rate and the rate's time. */
    conversion: z
      .object({ settlementAssetId: z.string(), settlementAmount: z.string(), rate: z.string(), rateAsOf: z.string() })
      .strict()
      .optional(),
  })
  .strict();

/** What this deployment's card programme is — including that it is not one. */
export const BANK_CARDS_PROGRAMME = defineProcedure({
  ...base,
  name: 'bank.cards.programme',
  kind: 'query',
  path: 'cards.programme',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ id: z.string(), simulated: z.boolean(), displayName: z.string() }),
  samples: [{ verdict: 'accept' }],
});

export const BANK_CARDS_CONTROLS_GET = defineProcedure({
  ...base,
  name: 'bank.cards.controls.get',
  kind: 'query',
  path: 'cards.controls.get',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ cardId: z.string().guid() }),
  output: cardControlsOutput,
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_CARDS_CONTROLS_BLOCK = defineProcedure({
  ...base,
  name: 'bank.cards.controls.block',
  kind: 'mutation',
  path: 'cards.controls.block',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ cardId: z.string().guid(), kind: z.enum(CARD_CONTROL_KINDS), value: z.string().min(1).max(64) }),
  output: cardControlsOutput,
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111', kind: 'category', value: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_CARDS_CONTROLS_LIFT = defineProcedure({
  ...base,
  name: 'bank.cards.controls.lift',
  kind: 'mutation',
  path: 'cards.controls.lift',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ cardId: z.string().guid(), controlId: z.string().guid() }),
  output: cardControlsOutput,
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111', controlId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Every decision taken on this card, approvals and declines alike.
 *
 * The declines are the point. "Why was I declined at the till" is the
 * question a card generates, and a history that only listed successful
 * purchases could not answer it.
 */
export const BANK_CARDS_AUTHORIZATIONS = defineProcedure({
  ...base,
  name: 'bank.cards.authorizations',
  kind: 'query',
  path: 'cards.authorizations',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({
    cardId: z.string().guid(),
    /**
     * Page size. Optional so omit reaches `bank.card_authorizations_list_limit_unset`
     * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
     */
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.array(
    z.object({
      id: z.string(),
      authorizationRef: z.string(),
      /** WHAT MOVED, in the card's funding asset. */
      amount: amountString,
      merchantCategory: z.string().nullable(),
      /** The merchant and its country as the issuer named them; null when it named none. */
      merchant: z.string().nullable(),
      merchantCountry: z.string().nullable(),
      channel: z.enum(['card-present', 'online', 'contactless', 'atm', 'foreign']),
      /** The issuer flagged it as a merchant charging the card on file on an agreed schedule (J-bank-14 #6). */
      recurring: z.boolean(),
      decision: z.enum(['approved', 'declined']),
      declineCode: z.string().nullable(),
      status: z.string(),
      /**
       * THE MERCHANT'S REFUND of this payment (J-bank-14 #6), as recorded: the partner gives it back to the partner
       * balance on a partner-held capture, and our ledger posts nothing. Null when there is none.
       */
      refund: z.object({ amount: amountString, status: z.enum(['pending', 'settled', 'rejected']), at: z.string() }).nullable(),
      /** Whose book held it (OWNER 226): `ledger`, or `partner` (the card partner held it; our ledger posted nothing). */
      heldBy: z.enum(['ledger', 'partner']),
      /**
       * A payment taken by the person's pay-from order (J-bank-29 #3 to #7): the order the partner walked, and, once it
       * held, the asset it held from (`amount` is then in that asset; the rate and its time are `conversion`, as the
       * partner reported them), with what it captured and returned of the hold. Null on a payment in the card's own asset.
       */
      payFrom: z
        .object({
          order: z.array(z.string()),
          assetId: z.string().nullable(),
          captured: amountString.nullable(),
          returned: amountString.nullable(),
        })
        .nullable(),
      decidedAt: z.string(),
      /**
       * WHAT THE MERCHANT CHARGED, and the rate it converted at (§18).
       *
       * NULL where the card is charged in the asset it draws on — nothing
       * was converted, and rendering a rate of 1 would invent a
       * conversion that did not happen. Where it is present, the statement
       * can show the user the price they agreed at the till alongside the
       * units that actually left their balance, which is the pair a
       * converted spend is unreadable without.
       */
      conversion: z
        .object({
          settlementAssetId: z.string(),
          settlementAmount: amountString,
          rate: amountString,
          /** How the rate was derived — `MarkQuality` from the loan book. */
          rateQuality: z.string(),
          rateAsOf: z.string(),
        })
        .nullable(),
    }),
  ),
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * THE CARD'S RECURRING PAYMENTS, one row per merchant (J-bank-14 #6; BK-cpay-02): the approved payments the issuer
 * flagged as a merchant charging the card on file, grouped by merchant, newest first. Reads only.
 */
export const BANK_CARDS_RECURRING = defineProcedure({
  ...base,
  name: 'bank.cards.recurring',
  kind: 'query',
  path: 'cards.recurring',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ cardId: z.string().guid(), limit: z.number().int().min(1).max(200).optional() }),
  output: z.array(
    z.object({
      merchant: z.string().nullable(),
      merchantCountry: z.string().nullable(),
      payments: z.number().int(),
      firstAt: z.string(),
      lastAt: z.string(),
      lastAmount: amountString,
    }),
  ),
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Captured payments a single-use or n-use card has used. */
export const BANK_CARDS_USES = defineProcedure({
  ...base,
  name: 'bank.cards.uses',
  kind: 'query',
  path: 'cards.uses',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ cardId: z.string().guid() }),
  output: z.object({ cardId: z.string(), usesAllowed: z.number().int().nullable(), usesMade: z.number().int() }),
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Change the delivery address before print (`ship-update:<cardId>:<requestId>`); refused once produced. */
export const BANK_CARDS_UPDATE_SHIPPING = defineProcedure({
  ...base,
  name: 'bank.cards.updateShipping',
  kind: 'mutation',
  path: 'cards.updateShipping',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    cardId: z.string().guid(),
    requestId: z.string().guid(),
    address: shippingAddressInput,
    stepUpApprovalId: stepUpApprovalField,
  }),
  output: deliveryOutput,
  samples: [
    {
      verdict: 'accept',
      input: {
        cardId: '11111111-1111-4111-8111-111111111111',
        requestId: '11111111-1111-4111-8111-111111111111',
        address: { name: 'USDC', line1: 'USDC', city: 'USDC', postalCode: 'USDC', country: 'en' },
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** A physical card's delivery: design, speed, the estimate, state, tracking, the address and its history. */
export const BANK_CARDS_DELIVERY = defineProcedure({
  ...base,
  name: 'bank.cards.delivery',
  kind: 'query',
  path: 'cards.delivery',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ cardId: z.string().guid() }),
  output: deliveryOutput,
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Activate a card that arrived (BK-cissue-04). Always behind a fresh step-up: with the owner's step-up rule off this
 * refuses `bank.step_up_unavailable`, as revealing card details does, and the card stays inactive.
 */
export const BANK_CARDS_ACTIVATE = defineProcedure({
  ...base,
  name: 'bank.cards.activate',
  kind: 'mutation',
  path: 'cards.activate',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ cardId: z.string().guid(), stepUpApprovalId: stepUpApprovalField }),
  output: cardOutput,
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Close this card and issue another with the same asset, ceilings and channels.
 * `replacementId` is the idempotency key.
 */
export const BANK_CARDS_REPLACE = defineProcedure({
  ...base,
  name: 'bank.cards.replace',
  kind: 'mutation',
  path: 'cards.replace',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    cardId: z.string().guid(),
    replacementId: z.string().guid(),
    reason: z.enum(['lost', 'stolen', 'damaged']),
  }),
  output: cardOutput,
  samples: [
    {
      verdict: 'accept',
      input: { cardId: '11111111-1111-4111-8111-111111111111', replacementId: '11111111-1111-4111-8111-111111111111', reason: 'lost' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Cashback by rank card tier (RC-bank-02, J-bank-13 #7): the caller's tier and its rate, every tier's rate, the asset
 * it is paid in, and what their card spend was paid (each payment a reward record with its ledger transaction).
 */
export const BANK_CARDS_CASHBACK = defineProcedure({
  ...base,
  name: 'bank.cards.cashback',
  kind: 'query',
  path: 'cards.cashback',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    tier: z.enum(CARD_TIERS),
    rateBps: z.number().int().nullable(),
    assetId: z.string(),
    rates: z.array(z.object({ tier: z.enum(CARD_TIERS), bps: z.number().int() })),
    paid: amountString,
    unpaid: amountString,
    refused: amountString,
    /** Owed by INTAFACED on partner-held spend and paid to the person's own wallet; never spendable here. */
    toWallet: amountString,
    payments: z.array(
      z.object({
        authorizationId: z.string(),
        cardId: z.string(),
        amount: amountString,
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
  samples: [{ verdict: 'accept' }],
});

/**
 * Pay from (J-bank-29 #1 and #2; BK-ccrypto-01): the owner's spendable assets and any other the person's cards draw on,
 * each offered, "not offered by the partner" or "not known", from the card partner's own list; how the partner spends
 * (it holds the crypto, or the card pulls from the person's own wallet); for each offered asset the partner's balance
 * and the rate with its time, or null ("not known"); the saved order; and the account kinds a card never pays from. No
 * owner list refuses `bank.card_spend_assets_unset`. Reads only.
 */
export const BANK_CARDS_PAY_FROM = defineProcedure({
  ...base,
  name: 'bank.cards.payFrom',
  kind: 'query',
  path: 'cards.payFrom',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: payFromOutput,
  samples: [{ verdict: 'accept' }],
});

/**
 * Save the pay-from order (J-bank-29 #2): each asset once, each one the owner lists and the partner can spend from. No
 * owner list refuses `bank.card_spend_assets_unset`; another asset refuses `bank.card_pay_from_not_offered`. Saving the
 * same order again changes nothing. Moves no value.
 */
export const BANK_CARDS_SET_PAY_FROM_ORDER = defineProcedure({
  ...base,
  name: 'bank.cards.setPayFromOrder',
  kind: 'mutation',
  path: 'cards.setPayFromOrder',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      assetIds: z
        .array(z.string().regex(/^[A-Z0-9]{2,16}$/))
        .min(1)
        .max(50),
    })
    .strict(),
  output: payFromOutput,
  samples: [
    { verdict: 'accept', input: { assetIds: ['USDC'] } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The product list for a country: eligibility with its reason, the count limits, the terms, designs and speeds. */
export const BANK_CARDS_CATALOGUE = defineProcedure({
  ...base,
  name: 'bank.cards.catalogue',
  kind: 'query',
  path: 'cards.catalogue',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/),
  }),
  output: z.object({
    programme: z.object({ id: z.string(), simulated: z.boolean(), displayName: z.string() }),
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
    speeds: z.array(z.object({ speed: z.enum(DELIVERY_SPEEDS), days: z.number().int() })),
    deliveryCountries: z.array(z.string()),
  }),
  samples: [
    { verdict: 'accept', input: { country: 'en' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Accept the cardholder terms shown (`consent:<userId>:<version>`); accepting again returns the first acceptance. */
export const BANK_CARDS_ACCEPT_TERMS = defineProcedure({
  ...base,
  name: 'bank.cards.acceptTerms',
  kind: 'mutation',
  path: 'cards.acceptTerms',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ termsVersion: z.string().min(1).max(64), textHash: z.string().min(1).max(100) }),
  output: z.object({ id: z.string(), version: z.string(), acceptedAt: z.string() }),
  samples: [
    { verdict: 'accept', input: { termsVersion: 'USDC', textHash: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Order a card: virtual (optionally single-use or n-use) or physical with a design, a delivery speed and an address.
 * `cardId` is the request, so a retry is the same card. Step-up, when the owner's rule is on, binds every term of the
 * order (`bank.step_up.cards.order`).
 */
export const BANK_CARDS_ORDER = defineProcedure({
  ...base,
  name: 'bank.cards.order',
  kind: 'mutation',
  path: 'cards.order',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    cardId: z.string().guid(),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/),
    termsVersion: z.string().min(1).max(64),
    assetId: z.string().min(1).max(16),
    perAuthorizationLimit: amountString,
    cardType: z.enum(['virtual', 'physical']),
    usesAllowed: z.number().int().min(1).max(1000).nullable().optional(),
    designId: z.string().min(1).max(32).optional(),
    deliverySpeed: z.enum(DELIVERY_SPEEDS).optional(),
    shippingAddress: shippingAddressInput.optional(),
    stepUpApprovalId: stepUpApprovalField,
  }),
  output: cardOutput,
  samples: [
    {
      verdict: 'accept',
      input: {
        cardId: '11111111-1111-4111-8111-111111111111',
        country: 'en',
        termsVersion: 'USDC',
        assetId: 'USDC',
        perAuthorizationLimit: '1',
        cardType: 'virtual',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_CARDS_THREE_DS_LIST = defineProcedure({
  ...base,
  name: 'bank.cards.threeDS.list',
  kind: 'query',
  path: 'cards.threeDS.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ cardId: z.string().guid() }),
  output: z.object({ challenges: z.array(threeDSChallengeOutput) }),
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_CARDS_THREE_DS_ANSWER = defineProcedure({
  ...base,
  name: 'bank.cards.threeDS.answer',
  kind: 'mutation',
  path: 'cards.threeDS.answer',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    cardId: z.string().guid(),
    challengeId: z.string().guid(),
    /** Omitted only to finish an approved challenge whose authorisation was never written. */
    code: z
      .string()
      .regex(/^\d{4,8}$/)
      .optional(),
  }),
  output: threeDSChallengeOutput,
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111', challengeId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_CARDS_FRAUD_LIST = defineProcedure({
  ...base,
  name: 'bank.cards.fraud.list',
  kind: 'query',
  path: 'cards.fraud.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ cardId: z.string().guid() }),
  output: z.object({ reports: z.array(fraudReportOutput) }),
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_CARDS_FRAUD_REPORT = defineProcedure({
  ...base,
  name: 'bank.cards.fraud.report',
  kind: 'mutation',
  path: 'cards.fraud.report',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ cardId: z.string().guid(), authorizationId: z.string().guid() }),
  output: fraudReportOutput,
  samples: [
    {
      verdict: 'accept',
      input: { cardId: '11111111-1111-4111-8111-111111111111', authorizationId: '11111111-1111-4111-8111-111111111111' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Which of card details, PIN and phone wallets the issuer offers, and whether they are TEST (J-bank-14 #3, #4). */
export const BANK_CARDS_SECRETS_OFFERED = defineProcedure({
  ...base,
  name: 'bank.cards.secretsOffered',
  kind: 'query',
  path: 'cards.secretsOffered',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ details: z.boolean(), pin: z.boolean(), wallet: z.boolean(), test: z.boolean(), walletNotOffered: z.boolean() }),
  samples: [{ verdict: 'accept' }],
});

/**
 * PAN, expiry and CVV from a live issuer. Step-up every time. Not stored.
 * card-sim refuses `bank.card_pan_issuer_unset` before step-up. With step-up
 * not `required`, the call refuses `bank.step_up_unavailable` and the issuer is not called.
 */
export const BANK_CARDS_REVEAL = defineProcedure({
  ...base,
  name: 'bank.cards.reveal',
  kind: 'mutation',
  path: 'cards.reveal',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ cardId: z.string().guid(), revealId: z.string().guid(), stepUpApprovalId: stepUpApprovalField }),
  output: z.object({ pan: z.string(), expiry: z.string(), cvv: z.string(), expiresAt: z.string(), test: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111', revealId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_CARDS_PIN_REVEAL = defineProcedure({
  ...base,
  name: 'bank.cards.pin.reveal',
  kind: 'mutation',
  path: 'cards.pin.reveal',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ cardId: z.string().guid(), revealId: z.string().guid(), stepUpApprovalId: stepUpApprovalField }),
  output: z.object({ pin: z.string(), expiresAt: z.string(), test: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111', revealId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_CARDS_PIN_SET = defineProcedure({
  ...base,
  name: 'bank.cards.pin.set',
  kind: 'mutation',
  path: 'cards.pin.set',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    cardId: z.string().guid(),
    commandId: z.string().guid(),
    pin: z.string().min(1).max(64),
    stepUpApprovalId: stepUpApprovalField,
  }),
  output: z.object({ ok: z.literal(true) }),
  samples: [
    {
      verdict: 'accept',
      input: { cardId: '11111111-1111-4111-8111-111111111111', commandId: '11111111-1111-4111-8111-111111111111', pin: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The phone wallets this card was added to: `added`, `paused` while the card is frozen, or `closed` (J-bank-14 #4). */
export const BANK_CARDS_WALLET_TOKENS = defineProcedure({
  ...base,
  name: 'bank.cards.walletTokens',
  kind: 'query',
  path: 'cards.walletTokens',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ cardId: z.string().guid() }),
  output: z.object({
    test: z.boolean(),
    tokens: z.array(
      z.object({
        id: z.string(),
        wallet: z.enum(['apple', 'google']),
        state: z.enum(['added', 'paused', 'closed']),
        addedAt: z.string(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Opaque push-provisioning payload, and one wallet token row per card and wallet (J-bank-14 #4). Refuses until
 * socket.live-issuer can produce one, except on the TEST partner adapter with `secrets: "test"`, whose payload says TEST.
 */
export const BANK_CARDS_WALLET_PROVISION = defineProcedure({
  ...base,
  name: 'bank.cards.walletProvision',
  kind: 'mutation',
  path: 'cards.walletProvision',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    cardId: z.string().guid(),
    provisionId: z.string().guid(),
    wallet: z.enum(['apple', 'google']),
    nonce: z.string().min(1).max(4096),
  }),
  output: z.object({ payload: z.string(), expiresAt: z.string(), test: z.boolean() }),
  samples: [
    {
      verdict: 'accept',
      input: {
        cardId: '11111111-1111-4111-8111-111111111111',
        provisionId: '11111111-1111-4111-8111-111111111111',
        wallet: 'apple',
        nonce: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_CARDS_LIST = defineProcedure({
  ...base,
  name: 'bank.cards.list',
  kind: 'query',
  path: 'cards.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    .object({
      /**
       * Page size. Optional so omit reaches `bank.cards_list_limit_unset`
       * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
       */
      limit: z.number().int().min(1).max(200).optional(),
    })
    .optional(),
  output: z.array(cardOutput),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_CARDS_PARTNER_HELD = defineProcedure({
  ...base,
  name: 'bank.cards.partnerHeld',
  kind: 'query',
  path: 'cards.partnerHeld',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ cardId: z.string().guid(), limit: z.number().int().min(1).max(200).optional() }),
  output: z.object({
    heldBy: z.enum(['ledger', 'partner', 'none']),
    figures: partnerFiguresOutput.nullable(),
    authorizations: z.array(
      z.object({
        authorizationId: z.string(),
        authorizationRef: z.string(),
        amount: amountString,
        report: partnerHoldReportOutput.nullable(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: { cardId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
