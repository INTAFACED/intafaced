import { z } from 'zod';
import { decimalSchema as money, parseAmount } from '../../shared/money';
import { accountsReads } from './contracts-accounts';
import { paymentsReads, paymentsWrites } from './contracts-payments';
import { spacesReads, spacesWrites } from './contracts-spaces';
import { earnReads, earnWrites } from './contracts-earn';
import { loansReads, loansWrites } from './contracts-loans';
import { cardsReads, cardsWrites } from './contracts-cards';
import { rampsReads, rampsWrites } from './contracts-ramps';
import { analyticsReads, analyticsWrites } from './contracts-analytics';
import { businessReads, businessWrites } from './contracts-business';
import type { ruleSchema } from './contracts-earn';
import type { sharedPotCardSchema, sorterSchema } from './contracts-spaces';

/**
 * The bank's wire shapes, one file per area (contracts-<area>.ts). This file only composes each area's reads and writes
 * and checks a write's reply against what was sent. A new shape or procedure goes in its area's file and that area's
 * `<area>Reads` or `<area>Writes`, never here (contracts-compose.test.ts fails otherwise).
 */
export * from './contracts-accounts';
export * from './contracts-payments';
export * from './contracts-spaces';
export * from './contracts-earn';
export * from './contracts-loans';
export * from './contracts-statements';
export * from './contracts-cards';
export * from './contracts-ramps';
export * from './contracts-analytics';
export * from './contracts-business';

export const bankReads = {
  ...accountsReads,
  ...paymentsReads,
  ...spacesReads,
  ...earnReads,
  ...loansReads,
  ...cardsReads,
  ...rampsReads,
  ...analyticsReads,
  ...businessReads,
} as const;
export type BankRead = keyof typeof bankReads;
export const bankWrites = {
  ...paymentsWrites,
  ...spacesWrites,
  ...earnWrites,
  ...loansWrites,
  ...cardsWrites,
  ...rampsWrites,
  ...analyticsWrites,
  ...businessWrites,
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
