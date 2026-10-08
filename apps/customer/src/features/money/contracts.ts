import { z } from 'zod';
import { decimalSchema as money, signedDecimalSchema } from '../../shared/money';
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
export const bankReads = {
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
    portfolioLtvBps: z.number().int(),
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
  'autoInvest.policy': z.object({
    enabled: z.boolean(),
    convertWired: z.boolean(),
    dcaRequiresConvert: z.literal(true),
    inventsRates: z.literal(false),
  }),
  'autoInvest.list': z.array(ruleSchema),
  'analytics.spend': analyticsSchema,
  'business.list': z.array(businessSchema),
  'business.pending': z.array(approvalSchema),
} as const;
export type BankRead = keyof typeof bankReads;
export const bankWrites = {
  'spaces.create': z.object({ id: z.string(), name: z.string() }),
  'spaces.archive': z.object({ archived: z.literal(true) }),
  'transfers.create': z.object({ ledgerTxId: z.string(), amount: money }),
  'transfers.toUser': z.object({ ledgerTxId: z.string(), amount: money }),
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
  'autoInvest.createDca': ruleSchema,
  'autoInvest.createThresholdSweep': ruleSchema,
  'autoInvest.createRoundUp': ruleSchema,
  'autoInvest.pause': ruleSchema,
  'autoInvest.resume': ruleSchema,
  'autoInvest.cancel': z.object({ ok: z.literal(true) }),
  'ramps.setWithdrawDestination': z.object({ kind: z.string(), ref: z.string() }),
  'business.create': businessSchema,
  'business.addMember': z.object({ accountId: z.string(), userId: z.string(), role: z.enum(['admin', 'maker', 'checker']) }),
  'business.proposeTransfer': z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('posted'), transferId: z.string(), ledgerTxId: z.string() }),
    z.object({ kind: z.literal('pending'), approval: approvalSchema }),
  ]),
  'business.approve': z.object({ transferId: z.string(), ledgerTxId: z.string() }),
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
