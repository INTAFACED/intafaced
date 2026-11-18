import type { Sql } from 'postgres';
import type { LedgerClient } from '@intafaced/ledger-client';
import { BANK_AREAS, type BankAreaOptions, type BankAreaServices } from './areas.js';
import { composeBankRoot, type BankRootOptions } from './bank-root.js';
import type { LedgerHistory } from './analytics/ledger-history.js';
import { SpaceService } from './spaces/space-service.js';
import { TransferService } from './transfers/transfer-service.js';
import { PersonalPayService } from './transfers/personal-pay.js';
import { EarnService } from './earn/earn-service.js';
import { SpendAnalytics } from './analytics/spend.js';
import { LoanService } from './loans/loan-service.js';
import { CardService } from './cards/card-service.js';
import { RampService } from './ramps/ramp-service.js';
import { DepositService } from './deposits/deposit-service.js';
import { AutoInvestService } from './auto-invest/auto-invest-service.js';

/**
 * svc-bank — MULTI-CURRENCY ACCOUNTS OVER THE LEDGER (§8.1).
 *
 * This service is a PROJECTION, not a source of truth. It stores names,
 * policies, instructions and records of completed jobs. It stores no balance,
 * anywhere, and its services are wired so that it cannot start: every "how
 * much" question they answer goes to `LedgerClient`, and nothing in this
 * service writes a figure that a later read could mistake for one.
 *
 * The root every area shares is `bank-root.ts`; the areas, in order, are
 * `areas.ts`; each area is made in its own folder's `compose.ts`
 * (`area-chain.ts`). This file only joins them and does not change for a new
 * area or service (project-state #2826; `bank-service.compose.test.ts`).
 */

/** Every service svc-bank makes: the services of every area in `areas.ts`. */
export interface BankServices extends BankAreaServices {}

/** Every option svc-bank reads: the shared root's (`bank-root.ts`) and every area's own. */
export interface BankServiceOptions extends BankRootOptions, BankAreaOptions {}

export function createBankServices(
  sql: Sql,
  bookLedger: LedgerClient,
  history: LedgerHistory,
  options: BankServiceOptions = {},
): BankServices {
  return BANK_AREAS.compose(composeBankRoot(sql, bookLedger, history, options), options);
}

export { PortfolioService, httpTickerSource, type TickerSource } from './portfolio/portfolio-service.js';
export { ActivityService, type ActivityServiceOptions } from './activity/activity-service.js';
export {
  SpaceService,
  TransferService,
  PersonalPayService,
  EarnService,
  SpendAnalytics,
  LoanService,
  CardService,
  RampService,
  DepositService,
  AutoInvestService,
};
export { BusinessService } from './business/business-service.js';
export { BankError, type BankErrorCode } from './errors.js';
export {
  createIdentityRecipientState,
  memoryRecipientState,
  unconfiguredRecipientState,
  RecipientStateUnavailableError,
  type RecipientStatePort,
  type RecipientStatus,
} from './recipient-state.js';
export { accountForSpace, type SpaceRecord, type SpaceView } from './spaces/space-service.js';
export { planDue, occurrenceStart, dueOccurrence, type Cadence } from './transfers/schedule.js';
export { PAUSED_SKIP_REASON, type ResumeReport, type ScheduleRecord } from './transfers/transfer-service.js';
export { dailyInterest, planAccrual, accrualDate } from './earn/interest.js';
export {
  DEFAULT_LIQUIDATION_POLICY,
  RiskError,
  accrualDay,
  assertPolicyCoherent,
  dailyLoanInterest,
  daysToAccrue,
  describeLtv,
  ltvBps,
  markPortfolio,
  planLiquidation,
  splitProceeds,
  type LiquidationPolicy,
  type Mark,
  type PortfolioMark,
} from './loans/risk.js';
export {
  DEFAULT_MARK_POLICY,
  acceptableForLiquidation,
  acceptableForMarking,
  fixedPriceSource,
  tickerPriceSource,
  type MarkPolicy,
  type MarkQuality,
  type PriceSource,
  type QuotedMark,
} from './loans/prices.js';
export {
  marketMakerVenue,
  recordOnlyMarginCallSink,
  type LiquidationVenue,
  type LoanDebt,
  type LoanProductRecord,
  type LoanRecord,
  type LoanServiceOptions,
  type MarginCallSink,
} from './loans/loan-service.js';
export {
  cardSim,
  cashbackOn,
  noCardIssuer,
  type AuthorizationOutcome,
  type CardIssuerAdapter,
  type CardProgramme,
  type IssuedCardHandle,
} from './cards/issuer.js';
export {
  type AuthorizationRecord,
  type CardRecord,
  type CardServiceOptions,
  type CaptureResult,
  type CashbackOutcome,
  type ConversionRecord,
  type RoundUpOutcome,
} from './cards/card-service.js';
export {
  DEFAULT_CARD_CONVERSION_POLICY,
  fundingFor,
  noConversionRates,
  quoteConversion,
  type CardConversionPolicy,
  type ConversionQuote,
} from './cards/conversion.js';
export { rampProgrammeFor, BANK_CRYPTO_LEDGER_RAIL, RAMP_SETTINGS, type RampProgramme, type RampSetting } from './ramps/rails.js';
export { type OnrampRecord, type OfframpRecord, type RampKind, type RampServiceOptions } from './ramps/ramp-service.js';
export { categorise, SPEND_CATEGORIES, type SpendCategory, type SpendSummary } from './analytics/spend.js';
export { memoryLedgerHistory, type LedgerHistory, type LedgerEntryRecord } from './analytics/ledger-history.js';
