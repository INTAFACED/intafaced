/** The account itself: its terms, profile, currencies and details, adding money, linked accounts, incoming payments and an estate's recovery. */
import { z } from 'zod';
import { decimalSchema as money, signedDecimalSchema } from '../../shared/money';

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
  /**
   * Null when the plan has no overdraft; `bank.overdraft_switched_off` when it publishes one, as no overdraft engine
   * exists. Absent from a bank that predates it: an overdraft is then still shown switched off, as none can be booked.
   */
  overdraftBlocker: z.literal('bank.overdraft_switched_off').nullable().optional(),
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
      // The TEST pay-in stand-in's label when the local stack's TEST partner opens this way to pay.
      payStandIn: z.string().nullable().default(null),
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
  status: z.enum(['opening', 'refused', 'opened', 'pending', 'credited', 'returned', 'delivered']),
  refusalCode: z.string().nullable(),
  onramp: z
    .object({
      onrampId: z.string(),
      // What the person receives: the quote's receive amount, in this asset.
      assetId: z.string(),
      amount: money,
      payAmount: money,
      fee: money,
      payCurrency: z.string(),
      status: z.literal('pending_payment'),
      hostedUrl: z.string().nullable(),
      bankInstructions: z.object({ reference: z.string(), accountName: z.string(), accountRef: z.string() }).nullable(),
    })
    .nullable(),
  createdAt: z.string(),
  // When the partner opened the payment, the payer approved it, and the money was credited; null until each happened.
  openedAt: z.string().nullable().default(null),
  pendingAt: z.string().nullable().default(null),
  creditedAt: z.string().nullable().default(null),
  // What the ledger credited: the quote's receive amount, never anything else. Null until credited.
  creditedAmount: money.nullable().default(null),
  // When the partner said the payment was sent back and the credit was taken out once; null unless it was returned.
  returnedAt: z.string().nullable().default(null),
  // Buy to wallet (J-dex-protocol-05 #4): the person's own wallet the partner delivers to, or null for a balance here; when
  // it delivered and its on-chain transfer, null until then. Nothing is credited here for a wallet purchase.
  walletAddress: z.string().nullable().default(null),
  deliveredAt: z.string().nullable().default(null),
  deliveryTx: z.string().nullable().default(null),
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

/** This area's reads of svc-bank `bank.*`, composed into `bankReads` in contracts.ts. */
/** `bank.salary.*` (J-bank-30): the details salary is paid to, the employer form, and the salary credits. */
export const salaryDetailsSchema = z.object({
  partnerBank: z.string(),
  network: z.string(),
  holderName: z.string().nullable(),
  currencies: z.array(accountDetailsRowSchema),
});
export const salaryFormSchema = z.object({
  currency: z.string(),
  holderName: z.string(),
  partnerBank: z.string(),
  accountNumber: z.string().nullable(),
  sortCode: z.string().nullable(),
  routingNumber: z.string().nullable(),
  iban: z.string().nullable(),
  bic: z.string().nullable(),
  reference: z.string(),
  text: z.string(),
});
export const salaryCreditSchema = z.object({
  networkId: z.string(),
  assetId: z.string(),
  amount: money,
  originatorName: z.string(),
  state: z.enum(['pending', 'received', 'returned', 'reversed']),
  refusalCode: z.string().nullable(),
  creditMoveId: z.string().nullable(),
  reversalMoveId: z.string().nullable(),
  createdAt: z.string(),
  receivedAt: z.string().nullable(),
  reversedAt: z.string().nullable(),
  legs: z.array(
    z.object({
      position: z.number().int(),
      spaceId: z.string(),
      amount: money,
      status: z.enum(['pending', 'settled', 'rejected', 'unsplit']),
      moveId: z.string().nullable(),
      rejectionCode: z.string().nullable(),
      unsplitMoveId: z.string().nullable(),
    }),
  ),
});
export type SalaryCredit = z.infer<typeof salaryCreditSchema>;

export const accountsReads = {
  'salary.details': salaryDetailsSchema,
  'salary.form': salaryFormSchema,
  'salary.credits': z.array(salaryCreditSchema),
  'accounts.features': accountTermsSchema,
  'accounts.profile': bankProfileSchema,
  'addMoney.methods': addMoneyMethodsSchema,
  'addMoney.requests': z.array(addMoneyRequestSchema),
  'addMoney.request': addMoneyRequestSchema,
  'currencies.list': currencySetSchema,
  'accountDetails.list': z.object({ currencies: z.array(accountDetailsRowSchema) }),
  'eligibility.get': eligibilitySchema,
  'linkedAccounts.list': z.object({ accounts: z.array(linkedAccountSchema) }),
  'recovery.estates': z.object({ estates: z.array(recoveryEstateSchema) }),
  'activity.list': z.object({ items: z.array(incomingLineSchema), nextCursor: z.string().nullable() }),
} as const;
