import { z } from 'zod';
import { decimalSchema as money, parseAmount, signedDecimalSchema } from '../../shared/money';
import { spaceSchema } from './client';

export const scheduleSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  amount: money,
  cadence: z.string(),
  nextRunAt: z.string(),
  status: z.string(),
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
  maturesAt: z.string().nullable(),
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
export const ruleSchema = z.object({
  id: z.string(),
  kind: z.enum(['threshold_sweep', 'dca', 'card_roundup']),
  assetId: z.string(),
  threshold: money.nullable(),
  targetPoolId: z.string().nullable(),
  buyAssetId: z.string().nullable(),
  amount: money.nullable(),
  cadence: z.enum(['daily', 'weekly', 'monthly']).nullable(),
  nextRunAt: z.string().nullable(),
  status: z.enum(['active', 'paused', 'cancelled']),
  createdAt: z.string(),
});
export const businessSchema = z.object({
  id: z.string(),
  name: z.string(),
  assetId: z.string(),
  spendThreshold: money,
  status: z.enum(['active', 'closed']),
  createdAt: z.string(),
});
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
  z.object({ found: z.literal(true), handle: z.string(), assetId: z.string(), spaceId: z.string().uuid().nullable() }),
]);
export const analyticsSchema = z.object({
  assetId: z.string(),
  from: z.string(),
  to: z.string(),
  outflowByCategory: z.record(money),
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
});
export type Destination = z.infer<typeof destinationSchema>;
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
export const bankReads = {
  'accountDetails.list': z.object({ currencies: z.array(accountDetailsRowSchema) }),
  'eligibility.get': eligibilitySchema,
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
  'earn.pools': z.array(poolSchema),
  'earn.positions': z.array(positionSchema),
  'loans.products': z.array(productSchema),
  'loans.list': z.array(loanSchema),
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
  'autoInvest.policy': z.object({
    enabled: z.boolean(),
    convertWired: z.boolean(),
    dcaRequiresConvert: z.literal(true),
    inventsRates: z.literal(false),
  }),
  'autoInvest.list': z.array(ruleSchema),
  'analytics.spend': analyticsSchema,
  'business.list': z.array(businessSchema),
  'business.pending': z.array(pendingApprovalSchema),
  'business.members': teamSchema,
  'business.myRole': z.object({ role: memberRoleSchema }),
  'business.resolveRecipientSpace': recipientSpaceSchema,
} as const;
export type BankRead = keyof typeof bankReads;
export const bankWrites = {
  'spaces.create': z.object({ id: z.string(), name: z.string() }),
  'ramps.destinations.rename': destinationSchema,
  'spaces.archive': z.object({ archived: z.literal(true) }),
  'transfers.create': z.object({ ledgerTxId: z.string(), amount: money }),
  // A personal send echoes the note and reference it stored, so the review can be checked against them.
  'transfers.toUser': z.object({ ledgerTxId: z.string(), amount: money, note: z.string().nullable(), reference: z.string().nullable() }),
  'transfers.schedule': z.object({ id: z.string(), nextRunAt: z.string() }),
  'transfers.scheduleToUser': z.object({ id: z.string(), nextRunAt: z.string() }),
  'transfers.pause': z.object({ status: z.string(), nextRunAt: z.string() }),
  'transfers.resume': z.object({ status: z.string(), nextRunAt: z.string(), skipped: z.array(z.number().int()) }),
  'transfers.cancel': z.object({ cancelled: z.literal(true) }),
  'earn.deposit': z.object({ positionId: z.string(), maturesAt: z.string().nullable() }),
  'earn.withdraw': z.object({ positionId: z.string(), principal: money }),
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
        !z.string().uuid().safeParse(row.id).success ||
        !z.string().datetime({ offset: true }).safeParse(row.createdAt).success ||
        (row.kind === 'dca' ? !z.string().datetime({ offset: true }).safeParse(row.nextRunAt).success : row.nextRunAt !== null)
      )
        return false;
    }
    switch (procedure) {
      case 'earn.deposit':
      case 'earn.withdraw':
        return (data as { positionId: string }).positionId === input.positionId;
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
          row.targetPoolId === input.targetPoolId &&
          (threshold
            ? exact(row.threshold, input.threshold) && row.amount === null
            : exact(row.amount, input.granularity) && row.threshold === null) &&
          row.buyAssetId === null &&
          row.cadence === null &&
          row.nextRunAt === null
        );
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
      case 'loans.close': {
        const row = data as z.infer<(typeof bankWrites)['loans.close']>;
        return parseAmount(row.released) > 0n ? row.ledgerTxId !== null && row.ledgerTxId.trim().length > 0 : row.ledgerTxId === null;
      }
      default:
        return true;
    }
  });
}
