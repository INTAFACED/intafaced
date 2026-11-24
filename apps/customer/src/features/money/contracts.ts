import { z } from 'zod';
import { decimalSchema as money, parseAmount } from '../../shared/money';
import type { ruleSchema } from './contracts-earn';
import type { sharedPotCardSchema, sorterSchema } from './contracts-spaces';
import { BANK_EARN_SET_AUTO_RENEW } from '@intafaced/contracts/bank-earn-procedures';
import { BANK_TRANSFERS_UPDATE_SCHEDULE } from '@intafaced/contracts/bank-transfers-2-procedures';
import { BANK_SPACES_CLEAR_BILLS_POT, BANK_SPACES_SET_BILLS_POT } from '@intafaced/contracts/bank-spaces-procedures';
import { BANK_SHARED_POTS_INVITE } from '@intafaced/contracts/bank-shared-pots-procedures';
import {
  BANK_LOANS_OPEN,
  BANK_LOANS_ADD_COLLATERAL,
  BANK_LOANS_REPAY,
  BANK_LOANS_CLOSE,
} from '@intafaced/contracts/bank-loans-3-procedures';

/**
 * The bank's wire shapes, one file per area (contracts-<area>.ts). This file only re-exports the areas and checks a
 * write's reply against what was sent. A new shape goes in its area's file, never here (contracts-compose.test.ts fails
 * otherwise); a new call is a record in @intafaced/contracts, never a schema keyed by its name.
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

/**
 * Empty: no bank call goes by name any more. Each is a record in @intafaced/contracts, and `useBankRecord` and `ActionSpec`
 * take only a record. garden/compose-only (.oxlintrc.json) lets these two hold only spreads of the areas this file
 * imports, so a schema keyed by a call's name fails here, and contracts-compose.test.ts holds them empty.
 */
export const bankReads = {} as const;
export const bankWrites = {} as const;

/** Bind only fields that the mounted service returns. No invented ID echo or
 * browser-calculated maturity, accrued interest or collateral release. */
export function bankWriteForReview(
  procedure: string,
  input: Record<string, unknown>,
  /** The answer's shape when a caller parses it here; `api.call` has the record parse it first. */
  answer: z.ZodType<unknown> = z.unknown(),
): z.ZodType<unknown> {
  const exact = (returned: string | null, sent: unknown) =>
    returned !== null && typeof sent === 'string' && money.safeParse(sent).success && parseAmount(returned) === parseAmount(sent);
  return answer.refine((data) => {
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
        const row = data as z.infer<(typeof BANK_EARN_SET_AUTO_RENEW)['output']>;
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
        const row = data as z.infer<(typeof BANK_SPACES_SET_BILLS_POT)['output']>;
        return row.spaceId === input.spaceId && row.fallback === input.fallback;
      }
      case 'spaces.clearBillsPot':
        return (data as z.infer<(typeof BANK_SPACES_CLEAR_BILLS_POT)['output']>).spaceId === input.spaceId;
      case 'sharedPots.linkCard':
        return (data as z.infer<typeof sharedPotCardSchema>).cardId === input.cardId;
      case 'sharedPots.freezeCard':
        return (data as z.infer<typeof sharedPotCardSchema>).status === 'frozen';
      case 'sharedPots.invite': {
        const row = data as z.infer<(typeof BANK_SHARED_POTS_INVITE)['output']>;
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
        const row = data as z.infer<(typeof BANK_LOANS_OPEN)['output']>;
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
        const row = data as z.infer<(typeof BANK_LOANS_ADD_COLLATERAL)['output']>;
        return row.ledgerTxId.trim().length > 0 && Number.isSafeInteger(row.sequence) && row.sequence >= 0;
      }
      case 'loans.repay': {
        const row = data as z.infer<(typeof BANK_LOANS_REPAY)['output']>,
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
        const row = data as z.infer<(typeof BANK_TRANSFERS_UPDATE_SCHEDULE)['output']>;
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
        const row = data as z.infer<(typeof BANK_LOANS_CLOSE)['output']>;
        return parseAmount(row.released) > 0n ? row.ledgerTxId !== null && row.ledgerTxId.trim().length > 0 : row.ledgerTxId === null;
      }
      default:
        return true;
    }
  });
}
