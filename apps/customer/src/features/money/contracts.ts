import { z } from 'zod';
import { transferQuoteSchema } from '../pay/schemas';
import { decimalSchema as money, parseAmount, signedDecimalSchema } from '../../shared/money';
import { spaceSchema } from './client';
import { businessListSchema, businessSchema } from './business-schema';

export const scheduleSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  amount: money,
  cadence: z.string(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  nextRunAt: z.string(),
  status: z.string(),
  revision: z.number().int().positive(),
  /** The person's own space the order pays from. */
  fromSpaceId: z.string().optional(),
  /** The person's own space it pays into, or null when it pays another person. */
  toSpaceId: z.string().nullable().optional(),
});
export const poolSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  kind: z.enum(['flexible', 'fixed']),
  name: z.string(),
  aprBps: z.number().int(),
  termDays: z.number().int().nullable(),
  minDeposit: money,
});
export const positionSchema = z.object({
  id: z.string(),
  poolId: z.string(),
  assetId: z.string(),
  principal: money,
  openedAt: z.string(),
  maturesAt: z.string().nullable(),
  /** The pool's recorded rate when the position opened; null when it opened before the pool's first record. */
  rateAtOpenBps: z.number().int().nullable(),
  /** The UTC midnight the position first earns from (BK-earn-01): a day pays positions opened before it began. */
  accruesFrom: z.string(),
  accrual: z.enum(['waiting', 'accruing', 'pool_closed', 'below_unit']),
  /** A fixed-term saving the saver asked to renew when its term ends (BK-earn-03). */
  autoRenew: z.boolean(),
  /** How many new terms auto-renew has started; `maturesAt` is the end of the current one. */
  renewals: z.number().int().nonnegative(),
  /** The next UTC day the bank pays this saving's interest (a date); null when no day pays it. */
  nextPayoutOn: z.string().date().nullable(),
});
/**
 * What a pool publishes beyond its rate and term (svc-bank `earn.router.ts`, BK-earn-02 and BK-earn-05): how interest is
 * paid, in which asset, from where, and the owner tables that may be blank. A null is a figure nobody published.
 */
export const poolFacts = {
  payoutEvery: z.literal('day'),
  compounding: z.literal('simple'),
  rewardAssetId: z.string(),
  yieldSource: z.literal('pool_reserve'),
  rateBands: z.array(z.object({ from: money, rateBps: z.number().int() })).nullable(),
  commissionBps: z.number().int().nullable(),
  capacity: money.nullable(),
};
export const earnPoolSchema = poolSchema.extend(poolFacts);
export const earnPoolPageSchema = earnPoolSchema.extend({ status: z.enum(['open', 'closed']) });
export const rateHistorySchema = z.object({
  poolId: z.string(),
  currentBps: z.number().int(),
  changes: z.array(z.object({ rateBps: z.number().int(), effectiveAt: z.string(), reason: z.string().nullable() })),
  earlier: z.boolean(),
});
export const productSchema = z.object({
  id: z.string(),
  name: z.string(),
  debtAssetId: z.string(),
  collateralAssetId: z.string(),
  quoteAssetId: z.string(),
  aprBps: z.number().int(),
  maxLtvBps: z.number().int(),
  marginCallLtvBps: z.number().int(),
  liquidationLtvBps: z.number().int(),
  minPrincipal: money,
});
export const loanSchema = z.object({
  id: z.string(),
  productId: z.string(),
  debtAssetId: z.string(),
  collateralAssetId: z.string(),
  principal: money,
  outstandingPrincipal: money,
  outstandingInterest: money,
  collateral: money,
  aprBps: z.number().int(),
  status: z.string(),
  marginCalledAt: z.string().nullable(),
});
/** `bank.loans.projection` (BK-loan-06): the accrual rule run forward by the bank. A projection, never a schedule. */
export const loanProjectionSchema = z.object({
  loanId: z.string(),
  kind: z.literal('projection'),
  obligation: z.literal(false),
  aprBps: z.number().int(),
  days: z.number().int(),
  openingPrincipal: money,
  openingInterest: money,
  extraApplied: money.nullable(),
  rows: z.array(z.object({ date: z.string(), basis: money, interest: money, principal: money, debt: money })),
});
export type LoanProjection = z.infer<typeof loanProjectionSchema>;
/** `bank.loans.payoffQuote` (BK-loan-06): what clears the loan now, re-priced on every read and never stored. */
export const payoffQuoteSchema = z.object({
  loanId: z.string(),
  principal: money,
  interest: money,
  fee: money,
  total: money,
  assetId: z.string(),
  interestThrough: z.string(),
  validUntil: z.string(),
});
export type PayoffQuote = z.infer<typeof payoffQuoteSchema>;
/** A signed statement file from `bank.statements.export`: the whole account, or one space (BK-pots-02). */
export const statementFileSchema = z.object({
  format: z.enum(['csv', 'pdf']),
  filename: z.string(),
  contentType: z.string(),
  bodyBase64: z.string(),
  sha256: z.string(),
  rowCount: z.number().int().nonnegative(),
});
/** `bank.loans.statement` (BK-loan-06): one loan's signed CSV over a period; a month still running is provisional. */
export const loanStatementSchema = z.object({
  format: z.literal('csv'),
  filename: z.string(),
  contentType: z.string(),
  bodyBase64: z.string(),
  sha256: z.string(),
  signature: z.string(),
  rowCount: z.number().int().nonnegative(),
  provisional: z.boolean(),
  openingPrincipal: money,
  openingInterest: money,
  closingPrincipal: money,
  closingInterest: money,
  generatedAt: z.string(),
});
export type LoanStatement = z.infer<typeof loanStatementSchema>;
/** `bank.loans.interestRows` (LOAN-05): each accrual day as written, each approved correction with its reason, and their totals. */
export const loanInterestRowsSchema = z.object({
  loanId: z.string(),
  assetId: z.string(),
  days: z.array(z.object({ date: z.string(), rateBps: z.number().int(), basis: money, interest: money })),
  earlierDays: z.number().int().nonnegative(),
  corrections: z.array(z.object({ id: z.string(), at: z.string(), amount: signedDecimalSchema, reason: z.string() })),
  accrued: money,
  corrected: signedDecimalSchema,
  paid: money,
  owed: money,
});
export type LoanInterestRows = z.infer<typeof loanInterestRowsSchema>;
/** `bank.loans.ledgerCheck` (LOAN-05): this loan's settled rows against the ledger's own transactions, leg by leg. */
export const loanLedgerCheckSchema = z.object({
  loanId: z.string(),
  status: z.enum(['agrees', 'differs', 'pending']),
  checked: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  collateralHeld: money,
  collateralExpected: signedDecimalSchema,
  mismatches: z.array(z.object({ kind: z.string(), ref: z.string(), problem: z.string() })),
  checkedAt: z.string(),
});
export type LoanLedgerCheck = z.infer<typeof loanLedgerCheckSchema>;
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
  status: z.enum(['active', 'frozen', 'closed']),
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
});
export const rampProgrammeSchema = programmeSchema.extend({
  cryptoRail: z.string().nullable(),
  fiatLeg: z.literal('socket.psp-partners'),
  fiatVia: z.literal('svc-pay.RailAdapter'),
});
const rampBase = z.object({
  id: z.string(),
  assetId: z.string(),
  amount: money,
  kind: z.enum(['crypto', 'fiat']),
  rail: z.string(),
  simulated: z.boolean(),
  status: z.string(),
  createdAt: z.string(),
});
export const onrampSchema = rampBase.extend({ railRef: z.string(), ledgerTxId: z.string().nullable() });
export const offrampSchema = rampBase.extend({
  destinationRef: z.string(),
  clientRef: z.string(),
  holdLedgerTxId: z.string().nullable(),
  settleLedgerTxId: z.string().nullable(),
});
/** Shared pots (BK-acct-09, J-bank-07 #6): who shares which pot, invites with their lifetime, from the bank. */
const sharedPotRoleSchema = z.enum(['contributor', 'viewer']);
const sharedPotPersonSchema = z.object({ userId: z.string(), handle: z.string().nullable() });
const sharedPotMemberSchema = sharedPotPersonSchema.extend({ role: sharedPotRoleSchema, joinedAt: z.string() });
const sharedPotInviteSchema = z.object({
  inviteId: z.string(),
  spaceId: z.string(),
  role: sharedPotRoleSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  expired: z.boolean(),
});
const sharedPotSchema = z.object({ id: z.string(), name: z.string(), assetId: z.string() });
/** The owner's card linked to a pot so its holders can freeze it: four digits and its status, never a number. */
export const sharedPotCardSchema = z.object({
  cardId: z.string(),
  panTail: z.string(),
  status: z.enum(['active', 'frozen', 'closed']),
  /** Who froze it; `operator` is the bank, and only the bank lifts that. */
  frozenBy: z.enum(['owner', 'holder', 'operator']).nullable(),
});
export const sharedPotsSchema = z.object({
  terms: z.object({ inviteMinutes: z.number().int().nullable(), peopleCap: z.number().int().nullable() }),
  owned: z.array(
    z.object({
      pot: sharedPotSchema,
      card: sharedPotCardSchema.nullable(),
      members: z.array(sharedPotMemberSchema),
      invites: z.array(sharedPotInviteSchema.extend({ invitee: sharedPotPersonSchema })),
    }),
  ),
  shared: z.array(
    z.object({
      pot: sharedPotSchema.extend({ balance: money }),
      card: sharedPotCardSchema.nullable(),
      owner: sharedPotPersonSchema,
      role: sharedPotRoleSchema,
      members: z.array(sharedPotMemberSchema),
    }),
  ),
  invites: z.array(sharedPotInviteSchema.extend({ pot: sharedPotSchema.omit({ id: true }), owner: sharedPotPersonSchema })),
});
export const sharedPotActivitySchema = z.object({
  id: z.string(),
  kind: z.enum([
    'invited',
    'cancelled',
    'joined',
    'declined',
    'left',
    'removed',
    'card_linked',
    'card_unlinked',
    'card_frozen',
    'card_unfrozen',
  ]),
  actor: sharedPotPersonSchema,
  subject: sharedPotPersonSchema.nullable(),
  role: sharedPotRoleSchema.nullable(),
  card: z.object({ cardId: z.string(), panTail: z.string() }).nullable(),
  at: z.string(),
});

/** One income sorter (BK-pots-03): whole basis points of each payment from another person into the person's own spaces. */
export const sorterSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  status: z.enum(['active', 'cancelled']),
  legs: z.array(z.object({ spaceId: z.string(), shareBp: z.number().int() })),
  createdAt: z.string(),
  cancelledAt: z.string().nullable(),
});
export const sorterListSchema = z.object({
  terms: z.discriminatedUnion('state', [
    z.object({ state: z.literal('set'), minCredit: money }),
    z.object({ state: z.literal('not_set'), code: z.literal('bank.sorter_terms_unset') }),
  ]),
  /** Each leg names its space and says whether it was archived since: its share then stays in the account. */
  sorters: z.array(
    sorterSchema.extend({
      legs: z.array(z.object({ spaceId: z.string(), shareBp: z.number().int(), spaceName: z.string(), archived: z.boolean() })),
    }),
  ),
});
/** What one sorted payment came to: each split's amount and what became of it. */
export const sorterRunSchema = z.object({
  id: z.string(),
  creditTransferId: z.string(),
  creditTxId: z.string(),
  creditAmount: money,
  /** When the payment posted; `createdAt` is when it was sorted. */
  creditPostedAt: z.string(),
  /** Recorded and not split: under the bank's smallest sorted payment, or no terms stood. */
  skippedReason: z.enum(['below_minimum', 'terms_unset']).nullable(),
  createdAt: z.string(),
  legs: z.array(
    z.object({
      position: z.number().int(),
      spaceId: z.string(),
      amount: money,
      status: z.enum(['pending', 'settled', 'rejected']),
      ledgerTxId: z.string().nullable(),
      rejectionCode: z.string().nullable(),
    }),
  ),
});
export const ruleSchema = z.object({
  id: z.string(),
  kind: z.enum(['threshold_sweep', 'dca', 'card_roundup']),
  assetId: z.string(),
  threshold: money.nullable(),
  targetPoolId: z.string().nullable(),
  /** A card round-up into one of the person's own spaces (BK-pots-02). */
  targetSpaceId: z.string().nullable().optional(),
  buyAssetId: z.string().nullable(),
  amount: money.nullable(),
  cadence: z.enum(['daily', 'weekly', 'monthly']).nullable(),
  nextRunAt: z.string().nullable(),
  status: z.enum(['active', 'paused', 'cancelled']),
  createdAt: z.string(),
});
export { businessSchema } from './business-schema';
export const memberRoleSchema = z.enum(['admin', 'maker', 'checker']);
export const approvalSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  makerUserId: z.string(),
  checkerUserId: z.string().nullable(),
  fromSpaceId: z.string(),
  toSpaceId: z.string(),
  assetId: z.string(),
  amount: money,
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
  transferId: z.string().nullable(),
  holdLedgerTxId: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  createdAt: z.string(),
});
/** A waiting payment as `business.pending` reads it: the people are named by handle where identity can name them. */
export const pendingApprovalSchema = approvalSchema.extend({
  makerHandle: z.string().nullable(),
  makerHandleReason: z.enum(['handle_unresolved']).nullable(),
  receiverOwnerHandle: z.string().nullable(),
  receiverOwnerHandleReason: z.enum(['handle_unresolved']).nullable(),
  receiverOwnerName: z.string().nullable(),
});
export const teamSchema = z.object({
  members: z.array(z.object({ accountId: z.string(), userId: z.string(), role: memberRoleSchema, handle: z.string() })),
});
export const recipientSpaceSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({ found: z.literal(true), handle: z.string(), assetId: z.string(), spaceId: z.string().guid().nullable() }),
]);
export const analyticsSchema = z.object({
  assetId: z.string(),
  from: z.string(),
  to: z.string(),
  outflowByCategory: z.record(z.string(), money),
  totalOutflow: money,
  totalInflow: money,
  net: signedDecimalSchema,
  movements: z.number().int().nonnegative(),
});
export const destinationSchema = z.object({
  destinationId: z.string(),
  label: z.string().nullable(),
  kind: z.enum(['crypto', 'bank']),
  ref: z.string(),
  addedAt: z.string(),
  coolingOffEndsAt: z.string().nullable(),
  coolingBlocker: z.literal('bank.offramp_cooling_unset').nullable(),
  // The bank also returns which asset and network an entry is for and where it stands; optional so an older answer still reads.
  assetId: z.string().nullable().optional(),
  network: z.string().nullable().optional(),
  tag: z.string().nullable().optional(),
  state: z.enum(['pending', 'cooling', 'active', 'blocked', 'archived']).optional(),
  // `customer`: an address-book entry; `legacy`: the one-per-kind slot an older withdrawal wrote.
  origin: z.enum(['legacy', 'customer']).optional(),
  // When the customer confirmed this address is not the saved one it looks like (W-withdraw-03).
  lookalikeConfirmedAt: z.string().nullable().optional(),
  // Whether the customer has proved they control this wallet by signing a message (W-withdraw-17), from the latest proof.
  ownership: z
    .object({
      state: z.enum(['none', 'pending', 'verified', 'expired']),
      verifiedAt: z.string().nullable(),
      validUntil: z.string().nullable(),
      offerExpiresAt: z.string().nullable(),
    })
    .optional(),
  // A new address waits (`pending`) until approved by an emailed link or from another signed-in device (W-withdraw-09).
  approvedAt: z.string().nullable().optional(),
  approvedBy: z.enum(['link', 'device']).nullable().optional(),
  // Until when the newest emailed approval link works, while one is open.
  approvalLinkExpiresAt: z.string().nullable().optional(),
});
export type Destination = z.infer<typeof destinationSchema>;
/** svc-bank `bank.ramps.destinations.approval.requestMail`: the approval link was asked for, and works until `expiresAt`. */
export const approvalMailAskedSchema = z.object({ destinationId: z.string(), expiresAt: z.string() });
/** A message the bank offers to sign, proving the customer controls a saved wallet. */
export const walletProofStartedSchema = z.object({
  proofId: z.string(),
  destinationId: z.string(),
  message: z.string(),
  expiresAt: z.string(),
});
/** A checked wallet proof. */
export const walletProofVerifiedSchema = z.object({
  proofId: z.string(),
  destinationId: z.string(),
  state: z.enum(['none', 'pending', 'verified', 'expired']),
  verifiedAt: z.string().nullable(),
  validUntil: z.string().nullable(),
});
/** One asset an address may be saved for, with the networks it is sent on (the bank's read of the ledger's asset list). */
export const withdrawAssetSchema = z.object({
  assetId: z.string(),
  precision: z.number().int(),
  networks: z.array(z.object({ networkId: z.string(), label: z.string() })),
  defaultNetworkId: z.string().nullable(),
});
export type WithdrawAsset = z.infer<typeof withdrawAssetSchema>;
export const destinationRemovedSchema = z.object({ destinationId: z.string(), removed: z.literal(true) });
/** svc-bank `bank.ramps.destinations.readiness`: whether money may be sent to one saved address now, or what stands first. */
export const destinationReadinessSchema = z.object({
  destinationId: z.string(),
  state: z.enum(['ready', 'locked', 'blocked', 'approval_pending', 'cooling_unset', 'cooling']),
  coolingOffEndsAt: z.string().nullable(),
  lockUnlocksAt: z.string().nullable(),
  approvalLinkExpiresAt: z.string().nullable().optional(),
});
export type DestinationReadiness = z.infer<typeof destinationReadinessSchema>;
/** svc-bank `bank.ramps.destinations.check`: whether the bank takes an address as typed, before any confirmation. */
export const destinationCheckSchema = z.object({
  address: z.enum(['ok', 'invalid', 'checksum_mismatch']),
  lookalike: z.object({ destinationId: z.string(), label: z.string().nullable(), refMasked: z.string() }).nullable(),
  /** On the owner's fraud list for the network asked (W-withdraw-03); the bank refuses it on save. An older bank sends none. */
  fraudListed: z.boolean().optional(),
});
export type DestinationCheck = z.infer<typeof destinationCheckSchema>;
const detailSetSchema = z.object({
  id: z.string(),
  accountNumber: z.string().nullable(),
  sortCode: z.string().nullable(),
  routingNumber: z.string().nullable(),
  bsb: z.string().nullable(),
  iban: z.string().nullable(),
  bic: z.string().nullable(),
  partnerBank: z.string(),
  restrictions: z.array(z.string()),
});
export const accountDetailsRowSchema = z.object({
  currency: z.string(),
  state: z.enum(['unavailable', 'pending_user', 'requirements_fulfilled', 'done']),
  blocker: z.literal('rail.bank').nullable(),
  sets: z.array(detailSetSchema),
});
export type AccountDetailsRow = z.infer<typeof accountDetailsRowSchema>;
export type AccountDetailSet = z.infer<typeof detailSetSchema>;
export const eligibilitySchema = z.object({
  rules: z.object({
    countries: z.array(z.string()),
    entityTypes: z.array(z.string()),
    productRestrictions: z.array(z.object({ product: z.string(), restriction: z.string() })),
  }),
  verdict: z
    .object({
      region: z.string(),
      status: z.enum(['open', 'restricted', 'blocked']),
      minTier: z.string(),
      notes: z.string().nullable(),
      source: z.literal('JURISDICTION_MATRIX'),
      listed: z.boolean(),
    })
    .nullable(),
});
export type Eligibility = z.infer<typeof eligibilitySchema>;
/** svc-bank `bank.accounts.features`: the owner's base-tier terms, figures as published decimal strings (BK-acct-01). */
export const accountTermsSchema = z.object({
  tier: z.string(),
  version: z.string(),
  currency: z.string(),
  monthlyFee: money,
  minimumBalance: money,
  overdraftFee: money.nullable(),
  included: z.array(z.string()),
});
export type AccountTerms = z.infer<typeof accountTermsSchema>;
const accountCurrencySchema = z.object({ assetId: z.string(), spaceId: z.string(), balance: money });
export type AccountCurrency = z.infer<typeof accountCurrencySchema>;
/** svc-bank `bank.currencies.list`: the currencies on the account, and what the owner lets the customer add. */
export const currencySetSchema = z.object({
  currencies: z.array(accountCurrencySchema),
  addable: z.array(z.string()).nullable(),
  addableBlocker: z.literal('bank.account_currencies_unset').nullable(),
});
/** svc-bank `bank.accounts.profile`: the profile in view, proved held by the person, with their role in a business. */
export const bankProfileSchema = z.object({
  profile: z.string(),
  kind: z.enum(['personal', 'business']),
  business: z.object({ accountId: z.string(), name: z.string(), role: z.string() }).nullable(),
});
/** svc-bank `bank.addMoney.*` (J-bank-02): the ways to pay in with their quotes, and the customer's add-money requests. */
export const ADD_MONEY_METHODS = ['bank_transfer', 'pay_by_bank', 'card', 'wallet_pay'] as const;
export type AddMoneyMethod = (typeof ADD_MONEY_METHODS)[number];
const addMoneyQuoteSchema = z.object({
  quoteId: z.string(),
  assetId: z.string(),
  amount: money,
  method: z.enum(ADD_MONEY_METHODS),
  payAmount: money,
  fee: money,
  payCurrency: z.string(),
  expiresAt: z.string(),
  deliveryEstimate: z.string().nullable(),
});
export const addMoneyMethodsSchema = z.object({
  methods: z.array(
    z.object({
      method: z.enum(ADD_MONEY_METHODS),
      rail: z.enum(['rail.bank', 'rail.card']),
      quote: addMoneyQuoteSchema.nullable(),
      blocker: z.string().nullable(),
      // The TEST stand-in's label when the local stack's rate stand-in priced this way to pay.
      standIn: z.string().nullable().default(null),
    }),
  ),
});
export type AddMoneyOption = z.infer<typeof addMoneyMethodsSchema>['methods'][number];
export const addMoneyRequestSchema = z.object({
  requestId: z.string(),
  assetId: z.string(),
  amount: money,
  method: z.enum(ADD_MONEY_METHODS),
  country: z.string(),
  rail: z.enum(['rail.bank', 'rail.card']),
  status: z.enum(['opening', 'refused', 'opened']),
  refusalCode: z.string().nullable(),
  onramp: z
    .object({
      onrampId: z.string(),
      payAmount: money,
      fee: money,
      payCurrency: z.string(),
      status: z.literal('pending_payment'),
      hostedUrl: z.string().nullable(),
      bankInstructions: z.object({ reference: z.string(), accountName: z.string(), accountRef: z.string() }).nullable(),
    })
    .nullable(),
  createdAt: z.string(),
});
export type AddMoneyRequest = z.infer<typeof addMoneyRequestSchema>;
/** svc-bank `bank.linkedAccounts.*` (J-bank-02 #6): the person's own accounts at other banks, each with its state. */
export const linkedAccountSchema = z.object({
  accountId: z.string(),
  label: z.string(),
  holderName: z.string(),
  ibanMasked: z.string(),
  country: z.string(),
  state: z.enum(['unverified', 'verified']),
  usable: z.boolean(),
  blocker: z.enum(['bank.linked_account_unverified', 'bank.offramp_cooling_unset', 'bank.offramp_cooling_active']).nullable(),
  verificationRail: z.literal('rail.bank').nullable(),
  linkedAt: z.string(),
  coolingOffEndsAt: z.string().nullable(),
});
export type LinkedAccount = z.infer<typeof linkedAccountSchema>;
export const linkedAccountWrites = {
  link: z.object({ account: linkedAccountSchema, created: z.boolean() }),
  remove: z.object({ accountId: z.string(), removed: z.literal(true) }),
};
/** svc-bank `bank.directDebits.*` (J-bank-06 #4, BK-xfer-11): mandates, their collections and refund requests. */
export const directDebitCollectionSchema = z.object({
  id: z.string(),
  mandateId: z.string(),
  collectionId: z.string(),
  creditorName: z.string(),
  assetId: z.string(),
  amount: money,
  dueAt: z.string(),
  status: z.enum(['upcoming', 'processing', 'collected', 'failed', 'rejected']),
  failureCode: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  presentedAt: z.string(),
  settledAt: z.string().nullable(),
  failureFee: z.null(),
  failureFeeBlocker: z.literal('bank.dd_failure_fee_unset').nullable(),
  refund: z.object({
    state: z.enum(['none', 'available', 'requested', 'closed', 'unset']),
    endsAt: z.string().nullable(),
    requestedAt: z.string().nullable(),
  }),
});
export type DirectDebitCollection = z.infer<typeof directDebitCollectionSchema>;
export const directDebitMandateSchema = z.object({
  id: z.string(),
  creditorId: z.string(),
  creditorName: z.string(),
  reference: z.string(),
  assetId: z.string(),
  status: z.enum(['active', 'blocked']),
  blockedAt: z.string().nullable(),
  createdAt: z.string(),
  upcoming: z.array(directDebitCollectionSchema),
});
export type DirectDebitMandate = z.infer<typeof directDebitMandateSchema>;
export const directDebitsViewSchema = z.object({
  scheme: z.object({
    status: z.enum(['unset', 'live']),
    standIn: z.string().nullable(),
    guaranteeDays: z.number().int().nullable(),
    blocker: z.literal('rail.bank').nullable(),
  }),
  mandates: z.array(directDebitMandateSchema),
  collections: z.array(directDebitCollectionSchema),
});
export type DirectDebitsView = z.infer<typeof directDebitsViewSchema>;
export const directDebitWrites = {
  block: z.object({
    mandate: directDebitMandateSchema,
    rejected: z.array(z.string()),
    tooLate: z.array(z.object({ collectionId: z.string(), code: z.literal('bank.dd_too_late') })),
  }),
  unblock: z.object({ mandate: directDebitMandateSchema }),
  requestRefund: z.object({ collection: directDebitCollectionSchema, created: z.boolean() }),
};
/** svc-bank `bank.calendar.window` (J-bank-06 #5, BK-acct-10): what is dated in a window, and how each source answered. */
export const calendarSources = ['standing_orders', 'bills', 'direct_debits', 'loans', 'earn'] as const;
export type CalendarSource = (typeof calendarSources)[number];
export const calendarItemSchema = z.object({
  source: z.enum(calendarSources),
  refId: z.string(),
  key: z.string(),
  date: z.string(),
  label: z.string().nullable(),
  assetId: z.string(),
  amount: money.nullable(),
  status: z.enum(['upcoming', 'paused', 'done', 'failed', 'skipped', 'refused']),
  reasonCode: z.string().nullable(),
});
export type CalendarItem = z.infer<typeof calendarItemSchema>;
export const calendarViewSchema = z.object({
  from: z.string(),
  to: z.string(),
  items: z.array(calendarItemSchema),
  sources: z.array(
    z.object({
      source: z.enum(calendarSources),
      state: z.enum(['ok', 'not_set', 'refused', 'unavailable']),
      count: z.number().int(),
      code: z.string().nullable(),
      complete: z.boolean(),
    }),
  ),
});
export type CalendarView = z.infer<typeof calendarViewSchema>;
/** svc-bank `bank.rules.*` (J-bank-06 #6, BK-acct-10): the payment reminder rule, and money rules waiting on the owner. */
export const reminderLeadChoices = [24, 48, 72, 168] as const;
export const reminderRuleSchema = z.object({
  ruleKey: z.string(),
  leadHours: z.literal(reminderLeadChoices).nullable(),
  revision: z.number().int(),
  updatedAt: z.string(),
});
export type ReminderRule = z.infer<typeof reminderRuleSchema>;
export const rulesViewSchema = z.object({
  reminder: reminderRuleSchema.nullable(),
  leadChoices: z.array(z.number().int()),
  moneyRules: z.object({ state: z.literal('not_set'), code: z.string() }),
});
export type RulesView = z.infer<typeof rulesViewSchema>;
export const rulesWrites = {
  setReminder: reminderRuleSchema,
  createMoneyRule: z.never(),
};
/** svc-bank `bank.cashOut.*` (J-bank-03): cash out to a linked bank account, with what stands in the way. */
export const cashOutQuoteSchema = z.object({
  assetId: z.string(),
  amount: money,
  available: money,
  account: linkedAccountSchema,
  rail: z.literal('rail.bank'),
  fee: money.nullable(),
  receiveAmount: money.nullable(),
  receiveCurrency: z.string().nullable().default(null),
  /** What stands in the way, or null when the bank's partner can take it. */
  blocker: z.string().nullable(),
  /** The TEST label when the partner pricing it is the local stack's stand-in. */
  standIn: z.string().nullable().default(null),
});
export type CashOutQuote = z.infer<typeof cashOutQuoteSchema>;
export const CASH_OUT_STATUSES = ['refused', 'processing', 'completed', 'failed', 'returned'] as const;
export const cashOutRequestSchema = z.object({
  requestId: z.string(),
  assetId: z.string(),
  amount: money,
  linkedAccountId: z.string(),
  rail: z.literal('rail.bank'),
  status: z.enum(CASH_OUT_STATUSES),
  refusalCode: z.string().nullable(),
  fee: money.nullable().default(null),
  receiveAmount: money.nullable().default(null),
  receiveCurrency: z.string().nullable().default(null),
  payoutRef: z.string().nullable().default(null),
  ledgerTxId: z.string().nullable().default(null),
  failureCode: z.string().nullable().default(null),
  returnedAmount: money.nullable().default(null),
  remainsPaidOut: money.nullable().default(null),
  createdAt: z.string(),
  completedAt: z.string().nullable().default(null),
  failedAt: z.string().nullable().default(null),
  returnedAt: z.string().nullable().default(null),
});
export type CashOutRequest = z.infer<typeof cashOutRequestSchema>;
export const cashOutReceiptSchema = z.object({
  fileName: z.string(),
  text: z.string(),
  ledgerTxId: z.string(),
  sha256: z.string(),
  signature: z.string(),
});
export type CashOutReceipt = z.infer<typeof cashOutReceiptSchema>;
/** svc-bank `bank.railSends.*` (J-bank-04 #1): send to a bank account over a bank rail, each rail with its own form. */
export const BANK_RAILS = ['ach', 'wire', 'instant', 'sepa', 'proxy'] as const;
export const railRequirementsSchema = z.object({
  rails: z.array(
    z.object({
      rail: z.enum(BANK_RAILS),
      fields: z.array(z.object({ name: z.string(), required: z.boolean(), choices: z.array(z.string()).nullable() })),
      // Null while no banking partner carries the rail; the blocker names what is missing.
      partner: z.string().nullable(),
      blocker: z.string().nullable(),
    }),
  ),
  // The countries the recipient book takes (J-bank-04 #2), each with the rails its forms come from.
  countries: z.array(z.object({ country: z.string(), rails: z.array(z.enum(BANK_RAILS)) })),
});
export type RailRequirements = z.infer<typeof railRequirementsSchema>;
export const railSendSchema = z.object({
  requestId: z.string(),
  fromSpaceId: z.string(),
  assetId: z.string(),
  amount: money,
  rail: z.enum(BANK_RAILS),
  recipient: z.string(),
  status: z.literal('refused'),
  refusalCode: z.string(),
  createdAt: z.string(),
});
export type RailSend = z.infer<typeof railSendSchema>;
export const railSendCheckSchema = z.object({ assetId: z.string(), amount: money, available: money });
/** svc-bank `bank.railSends.payees` (J-bank-04 #2): the recipient book, each with its name check and cooling-off. */
export const railPayeeSchema = z.object({
  payeeId: z.string(),
  nickname: z.string(),
  country: z.string(),
  rail: z.enum(BANK_RAILS),
  recipient: z.string(),
  verification: z.literal('cannot_check'),
  verificationRail: z.string(),
  addedAt: z.string(),
  cooling: z.object({ state: z.enum(['unset', 'active', 'open']), endsAt: z.string().nullable() }),
});
export type RailPayee = z.infer<typeof railPayeeSchema>;
export const railPayeeRemovedSchema = z.object({ payeeId: z.string(), removed: z.literal(true) });
export const railPayeeCheckSchema = z.object({
  nickname: z.string(),
  country: z.string(),
  rail: z.enum(BANK_RAILS),
  recipient: z.string(),
});
/** svc-bank `bank.activity.list` lines read for incoming payments (J-bank-02 #7). Unknown fields are dropped. */
export const incomingLineSchema = z.object({
  id: z.string(),
  // Only the kinds asked for: anything else is refused, never shown as a deposit.
  kind: z.enum(['deposit', 'welcome_funds', 'transfer_in']),
  direction: z.literal('in'),
  asset: z.string(),
  amount: money,
  postedAt: z.string(),
  txId: z.string(),
  counterparty: z.object({ handle: z.string() }).nullable(),
});
export type IncomingLine = z.infer<typeof incomingLineSchema>;
export const currencyWrites = {
  add: accountCurrencySchema,
  remove: z.object({ assetId: z.string(), removed: z.literal(true) }),
};
/** A ledger balance of a dead owner's account, as the heir's claim room shows it (RC-identity-08). */
const recoveryAccountSchema = z.object({
  ownerType: z.enum(['user', 'subaccount']),
  assetId: z.string(),
  kind: z.string(),
  spaceId: z.string().nullable(),
  spaceName: z.string().nullable(),
  amount: signedDecimalSchema,
});
export type RecoveryAccount = z.infer<typeof recoveryAccountSchema>;
const recoveryClaimSchema = z.object({
  claimId: z.string(),
  status: z.enum(['open', 'executed']),
  round: z.number().int(),
  createdAt: z.string(),
  executedAt: z.string().nullable(),
});
export const recoveryEstateSchema = z.object({
  userId: z.string(),
  handle: z.string(),
  threshold: z.number().int().min(1),
  liveKeys: z.number().int().min(0),
  claim: recoveryClaimSchema.nullable(),
  sweepable: z.array(recoveryAccountSchema),
  /** Held for an order, withdrawal, stake or collateral: stays until released. */
  held: z.array(recoveryAccountSchema),
  /** Debts: any of these stops a sweep. */
  blockers: z.array(recoveryAccountSchema),
});
export type RecoveryEstate = z.infer<typeof recoveryEstateSchema>;
const recoverySweepSchema = z.object({
  round: z.number().int(),
  ownerType: z.enum(['user', 'subaccount']),
  spaceId: z.string().nullable(),
  assetId: z.string(),
  amount: money,
  status: z.enum(['pending', 'posted', 'refused']),
  ledgerTxId: z.string().nullable(),
  refusalCode: z.string().nullable(),
});
export type RecoverySweep = z.infer<typeof recoverySweepSchema>;
export const recoveryWrites = {
  open: recoveryClaimSchema.extend({
    ownerUserId: z.string(),
    handle: z.string(),
    threshold: z.number().int(),
    liveKeys: z.number().int(),
    message: z.string(),
  }),
  execute: z.object({ claim: recoveryClaimSchema, round: z.number().int().nullable(), sweeps: z.array(recoverySweepSchema) }),
};
export const bankReads = {
  'accounts.features': accountTermsSchema,
  'accounts.profile': bankProfileSchema,
  'addMoney.methods': addMoneyMethodsSchema,
  'addMoney.requests': z.array(addMoneyRequestSchema),
  'currencies.list': currencySetSchema,
  'accountDetails.list': z.object({ currencies: z.array(accountDetailsRowSchema) }),
  'eligibility.get': eligibilitySchema,
  'linkedAccounts.list': z.object({ accounts: z.array(linkedAccountSchema) }),
  'directDebits.list': directDebitsViewSchema,
  'recovery.estates': z.object({ estates: z.array(recoveryEstateSchema) }),
  'calendar.window': calendarViewSchema,
  'rules.get': rulesViewSchema,
  'sorter.list': sorterListSchema,
  'sorter.runs': z.array(sorterRunSchema),
  'sharedPots.list': sharedPotsSchema,
  'sharedPots.activity': z.array(sharedPotActivitySchema),
  'cashOut.quote': cashOutQuoteSchema,
  // The same wire shape Pay reads (J-bank-04 #3): one definition of `bank.transfers.quote`.
  'transfers.quote': transferQuoteSchema,
  'cashOut.requests': z.array(cashOutRequestSchema),
  'railSends.requirements': railRequirementsSchema,
  'railSends.list': z.array(railSendSchema),
  'railSends.payees': z.array(railPayeeSchema),
  'activity.list': z.object({ items: z.array(incomingLineSchema), nextCursor: z.string().nullable() }),
  'spaces.list': z.array(spaceSchema),
  'spaces.unnamed': z.array(z.object({ assetId: z.string(), balance: money })),
  'transfers.listSchedules': z.array(scheduleSchema),
  'transfers.executions': z.array(
    z.object({
      occurrence: z.number().int(),
      amount: money,
      status: z.string(),
      ledgerTxId: z.string().nullable(),
      rejectionCode: z.string().nullable(),
    }),
  ),
  'earn.pools': z.array(earnPoolSchema),
  'earn.pool': earnPoolPageSchema,
  'earn.rateHistory': rateHistorySchema,
  'earn.positions': z.array(positionSchema),
  'earn.interestHistory': z.object({
    days: z.array(z.object({ date: z.string(), rateBps: z.number().int(), amount: money, ledgerTxId: z.string() })),
    total: money,
    unitemisedDays: z.number().int(),
  }),
  'loans.products': z.array(productSchema),
  'loans.list': z.array(loanSchema),
  'loans.projection': loanProjectionSchema,
  'loans.payoffQuote': payoffQuoteSchema,
  'loans.interestRows': loanInterestRowsSchema,
  'loans.ledgerCheck': loanLedgerCheckSchema,
  /** `bank.loans.releasable` (BK-loan-05): the most collateral `releaseExcess` would release now, under the product's max LTV. */
  'loans.releasable': z.object({
    loanId: z.string(),
    held: money,
    releasable: money,
    maxLtvBps: z.number().int(),
    ltvBps: z.number().int(),
  }),
  'loans.health': z.object({
    debtValue: money,
    collateralValue: money,
    portfolioLtvBps: z.number().int().nonnegative().safe(),
    loans: z.array(z.object({ loanId: z.string(), debtValue: money, collateralValue: money, ltvBps: z.number().int() })),
  }),
  'cards.programme': programmeSchema,
  'cards.list': z.array(cardSchema),
  'cards.authorizations': z.array(
    z.object({
      id: z.string(),
      authorizationRef: z.string(),
      amount: money,
      merchantCategory: z.string().nullable(),
      decision: z.enum(['approved', 'declined']),
      declineCode: z.string().nullable(),
      status: z.string(),
      decidedAt: z.string(),
      conversion: z
        .object({ settlementAssetId: z.string(), settlementAmount: money, rate: money, rateQuality: z.string(), rateAsOf: z.string() })
        .nullable(),
    }),
  ),
  'ramps.programme': rampProgrammeSchema,
  'ramps.fiatSettle': z.object({ canSettle: z.literal(true), onrampRailId: z.string(), offrampRailId: z.string() }),
  'ramps.onramps': z.array(onrampSchema),
  'ramps.offramps': z.array(offrampSchema),
  // svc-bank `bank.ramps.destinations.list`: the customer's own saved wallets and bank accounts. No asset or network field.
  'ramps.destinations.list': z.array(destinationSchema),
  'ramps.destinations.networks': z.array(withdrawAssetSchema),
  'autoInvest.policy': z.object({
    enabled: z.boolean(),
    convertWired: z.boolean(),
    dcaRequiresConvert: z.literal(true),
    inventsRates: z.literal(false),
  }),
  'autoInvest.list': z.array(ruleSchema),
  'analytics.spend': analyticsSchema,
  'business.list': businessListSchema,
  'business.pending': z.array(pendingApprovalSchema),
  'business.members': teamSchema,
  'business.myRole': z.object({ role: memberRoleSchema }),
  'business.resolveRecipientSpace': recipientSpaceSchema,
} as const;
export type BankRead = keyof typeof bankReads;
/** A space's goal and lock after its owner changed one (BK-pots-02). `unlocksAt` is an early unlock still waiting. */
export const spaceLockStateSchema = z.object({
  id: z.string(),
  goalTarget: money.nullable(),
  lockedUntil: z.string().datetime({ offset: true }).nullable(),
  unlocksAt: z.string().datetime({ offset: true }).nullable(),
  unlockRequestedAt: z.string().datetime({ offset: true }).nullable(),
});
export const bankWrites = {
  'spaces.create': z.object({ id: z.string(), name: z.string() }),
  'ramps.destinations.rename': destinationSchema,
  'spaces.archive': z.object({ archived: z.literal(true) }),
  'spaces.setGoal': spaceLockStateSchema,
  'spaces.setLock': spaceLockStateSchema,
  'spaces.requestUnlock': spaceLockStateSchema,
  'spaces.cancelUnlock': spaceLockStateSchema,
  // The bills pot (BK-pots-03): the space that pays bills, and whether a standing order from it tops it up from the account.
  'spaces.setBillsPot': z.object({ spaceId: z.string(), assetId: z.string(), fallback: z.boolean() }),
  'spaces.clearBillsPot': z.object({ spaceId: z.string(), billsPot: z.null() }),
  'transfers.create': z.object({ ledgerTxId: z.string(), amount: money }),
  // A personal send echoes the note and reference it stored, so the review can be checked against them.
  'transfers.toUser': z.object({ ledgerTxId: z.string(), amount: money, note: z.string().nullable(), reference: z.string().nullable() }),
  'transfers.schedule': z.object({ id: z.string(), nextRunAt: z.string() }),
  'transfers.scheduleToUser': z.object({ id: z.string(), nextRunAt: z.string() }),
  'transfers.pause': z.object({ status: z.string(), nextRunAt: z.string() }),
  'transfers.resume': z.object({ status: z.string(), nextRunAt: z.string(), skipped: z.array(z.number().int()) }),
  'transfers.cancel': z.object({ cancelled: z.literal(true) }),
  'transfers.updateSchedule': z.object({
    id: z.string(),
    revision: z.number().int(),
    amount: money,
    endsAt: z.string().nullable(),
    nextRunAt: z.string(),
  }),
  'earn.deposit': z.object({ positionId: z.string(), maturesAt: z.string().nullable() }),
  'earn.withdraw': z.object({ positionId: z.string(), principal: money }),
  'earn.setAutoRenew': z.object({ positionId: z.string(), autoRenew: z.boolean(), maturesAt: z.string().nullable() }),
  'loans.open': z.object({ loanId: z.string(), status: z.string(), ltvBps: z.number().int(), drawLedgerTxId: z.string() }),
  'loans.addCollateral': z.object({ ledgerTxId: z.string(), sequence: z.number().int() }),
  'loans.releaseExcess': z.object({ ledgerTxId: z.string(), sequence: z.number().int() }),
  'loans.repay': z.object({
    ledgerTxId: z.string(),
    interestPaid: money,
    principalPaid: money,
    remainingPrincipal: money,
    remainingInterest: money,
    closed: z.boolean(),
  }),
  'loans.close': z.object({ released: money, ledgerTxId: z.string().nullable() }),
  'cards.setStatus': z.object({ id: z.string(), status: z.string() }),
  'cards.issue': cardSchema,
  'cards.setLimits': cardSchema,
  'cards.setChannels': cardSchema,
  'autoInvest.createDca': ruleSchema,
  'autoInvest.createThresholdSweep': ruleSchema,
  'autoInvest.createRoundUp': ruleSchema,
  'autoInvest.pause': ruleSchema,
  'autoInvest.resume': ruleSchema,
  'autoInvest.cancel': z.object({ ok: z.literal(true) }),
  'sorter.create': sorterSchema,
  'sorter.cancel': sorterSchema,
  'sharedPots.invite': sharedPotInviteSchema.extend({ invitee: sharedPotPersonSchema }),
  'sharedPots.cancelInvite': z.object({ cancelled: z.literal(true) }),
  'sharedPots.accept': z.object({ spaceId: z.string(), role: sharedPotRoleSchema }),
  'sharedPots.decline': z.object({ declined: z.literal(true) }),
  'sharedPots.leave': z.object({ left: z.literal(true) }),
  'sharedPots.remove': z.object({ removed: z.literal(true) }),
  'sharedPots.linkCard': sharedPotCardSchema,
  'sharedPots.unlinkCard': z.object({ unlinked: z.literal(true) }),
  'sharedPots.freezeCard': sharedPotCardSchema,
  'ramps.setWithdrawDestination': z.object({ kind: z.string(), ref: z.string() }),
  'ramps.offramp': offrampSchema,
  'business.create': businessSchema,
  'business.addMember': z.object({ accountId: z.string(), userId: z.string(), role: memberRoleSchema }),
  'business.proposeTransfer': z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('posted'), transferId: z.string(), ledgerTxId: z.string() }),
    z.object({ kind: z.literal('pending'), approval: approvalSchema }),
  ]),
  'business.approve': z.object({ transferId: z.string(), ledgerTxId: z.string() }),
  'business.setMemberRole': z.object({ accountId: z.string(), userId: z.string(), role: memberRoleSchema }),
  'business.removeMember': z.object({ accountId: z.string(), userId: z.string(), removed: z.literal(true) }),
  'business.reject': z.object({ ok: z.literal(true) }),
  'business.cancel': z.object({ ok: z.literal(true) }),
  'business.runPayroll': z.object({
    payrollId: z.string(),
    accountId: z.string(),
    fromSpaceId: z.string(),
    assetId: z.string(),
    ledgerTxId: z.string(),
    recipients: z.array(z.object({ toSpaceId: z.string(), amount: money })),
    createdAt: z.string(),
  }),
} as const;
export type BankWrite = keyof typeof bankWrites;

/** Bind only fields that the mounted service returns. No invented ID echo or
 * browser-calculated maturity, accrued interest or collateral release. */
export function bankWriteForReview(procedure: BankWrite, input: Record<string, unknown>): z.ZodType<unknown> {
  const exact = (returned: string | null, sent: unknown) =>
    returned !== null && typeof sent === 'string' && money.safeParse(sent).success && parseAmount(returned) === parseAmount(sent);
  return (bankWrites[procedure] as z.ZodType<unknown>).refine((data) => {
    if (
      procedure === 'autoInvest.createDca' ||
      procedure === 'autoInvest.createThresholdSweep' ||
      procedure === 'autoInvest.createRoundUp' ||
      procedure === 'autoInvest.pause' ||
      procedure === 'autoInvest.resume'
    ) {
      const row = data as z.infer<typeof ruleSchema>;
      if (
        !z.string().guid().safeParse(row.id).success ||
        !z.string().datetime({ offset: true }).safeParse(row.createdAt).success ||
        (row.kind === 'dca' ? !z.string().datetime({ offset: true }).safeParse(row.nextRunAt).success : row.nextRunAt !== null)
      )
        return false;
    }
    switch (procedure) {
      case 'earn.deposit':
      case 'earn.withdraw':
        return (data as { positionId: string }).positionId === input.positionId;
      case 'earn.setAutoRenew': {
        const row = data as z.infer<(typeof bankWrites)['earn.setAutoRenew']>;
        return row.positionId === input.positionId && row.autoRenew === input.on && row.maturesAt !== null;
      }
      case 'autoInvest.createDca': {
        const row = data as z.infer<typeof ruleSchema>;
        return (
          row.kind === 'dca' &&
          row.status === 'active' &&
          row.assetId === input.spendAssetId &&
          row.buyAssetId === input.buyAssetId &&
          exact(row.amount, input.amount) &&
          row.cadence === input.cadence &&
          row.threshold === null &&
          row.targetPoolId === null &&
          row.nextRunAt !== null &&
          z.string().datetime({ offset: true }).safeParse(row.nextRunAt).success &&
          typeof input.startsAt === 'string' &&
          Date.parse(row.nextRunAt) === Date.parse(input.startsAt)
        );
      }
      case 'autoInvest.createThresholdSweep':
      case 'autoInvest.createRoundUp': {
        const row = data as z.infer<typeof ruleSchema>,
          threshold = procedure === 'autoInvest.createThresholdSweep';
        return (
          row.kind === (threshold ? 'threshold_sweep' : 'card_roundup') &&
          row.status === 'active' &&
          row.assetId === input.assetId &&
          row.targetPoolId === (input.targetPoolId ?? null) &&
          (row.targetSpaceId ?? null) === (input.targetSpaceId ?? null) &&
          (threshold
            ? exact(row.threshold, input.threshold) && row.amount === null
            : exact(row.amount, input.granularity) && row.threshold === null) &&
          row.buyAssetId === null &&
          row.cadence === null &&
          row.nextRunAt === null
        );
      }
      case 'sorter.create': {
        const row = data as z.infer<typeof sorterSchema>,
          legs = Array.isArray(input.legs) ? (input.legs as Array<{ spaceId: unknown; shareBp: unknown }>) : [];
        return (
          row.id === input.sorterId &&
          row.status === 'active' &&
          row.assetId === input.assetId &&
          row.legs.length === legs.length &&
          row.legs.every((leg, i) => leg.spaceId === legs[i]!.spaceId && leg.shareBp === legs[i]!.shareBp)
        );
      }
      case 'spaces.setBillsPot': {
        const row = data as z.infer<(typeof bankWrites)['spaces.setBillsPot']>;
        return row.spaceId === input.spaceId && row.fallback === input.fallback;
      }
      case 'spaces.clearBillsPot':
        return (data as z.infer<(typeof bankWrites)['spaces.clearBillsPot']>).spaceId === input.spaceId;
      case 'sharedPots.linkCard':
        return (data as z.infer<typeof sharedPotCardSchema>).cardId === input.cardId;
      case 'sharedPots.freezeCard':
        return (data as z.infer<typeof sharedPotCardSchema>).status === 'frozen';
      case 'sharedPots.invite': {
        const row = data as z.infer<(typeof bankWrites)['sharedPots.invite']>;
        return row.inviteId === input.inviteId && row.spaceId === input.spaceId && row.role === input.role;
      }
      case 'sorter.cancel': {
        const row = data as z.infer<typeof sorterSchema>;
        return row.id === input.sorterId && row.status === 'cancelled';
      }
      case 'autoInvest.pause':
      case 'autoInvest.resume': {
        const row = data as z.infer<typeof ruleSchema>;
        return row.id === input.ruleId && row.status === (procedure === 'autoInvest.pause' ? 'paused' : 'active');
      }
      case 'loans.open': {
        const row = data as z.infer<(typeof bankWrites)['loans.open']>;
        return (
          row.loanId === input.loanId &&
          ['pending', 'active', 'margin_call', 'liquidating', 'repaid', 'liquidated'].includes(row.status) &&
          Number.isSafeInteger(row.ltvBps) &&
          row.ltvBps >= 0 &&
          row.drawLedgerTxId.trim().length > 0
        );
      }
      case 'loans.addCollateral':
      case 'loans.releaseExcess': {
        const row = data as z.infer<(typeof bankWrites)['loans.addCollateral']>;
        return row.ledgerTxId.trim().length > 0 && Number.isSafeInteger(row.sequence) && row.sequence >= 0;
      }
      case 'loans.repay': {
        const row = data as z.infer<(typeof bankWrites)['loans.repay']>,
          paid = parseAmount(row.interestPaid) + parseAmount(row.principalPaid);
        return (
          row.ledgerTxId.trim().length > 0 &&
          typeof input.amount === 'string' &&
          paid > 0n &&
          paid <= parseAmount(input.amount) &&
          (parseAmount(row.remainingPrincipal) !== 0n || parseAmount(row.remainingInterest) !== 0n || row.closed)
        );
      }
      case 'transfers.updateSchedule': {
        const row = data as z.infer<(typeof bankWrites)['transfers.updateSchedule']>;
        return (
          row.id === input.scheduleId &&
          typeof input.revision === 'number' &&
          row.revision === input.revision + 1 &&
          exact(row.amount, input.amount) &&
          (input.endsAt === null
            ? row.endsAt === null
            : row.endsAt !== null && typeof input.endsAt === 'string' && Date.parse(row.endsAt) === Date.parse(input.endsAt))
        );
      }
      case 'loans.close': {
        const row = data as z.infer<(typeof bankWrites)['loans.close']>;
        return parseAmount(row.released) > 0n ? row.ledgerTxId !== null && row.ledgerTxId.trim().length > 0 : row.ledgerTxId === null;
      }
      default:
        return true;
    }
  });
}
