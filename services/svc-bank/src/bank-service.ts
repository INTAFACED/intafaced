import { AssetPauseService } from './ops/asset-pause.js';
import type { Sql } from 'postgres';
import type { LedgerClient } from '@intafaced/ledger-client';
import { SpaceService } from './spaces/space-service.js';
import { TransferService } from './transfers/transfer-service.js';
import { EarnService } from './earn/earn-service.js';
import { SpendAnalytics } from './analytics/spend.js';
import { LoanService, type LoanServiceOptions } from './loans/loan-service.js';
import { fixedPriceSource } from './loans/prices.js';
import { CardService, type CardServiceOptions } from './cards/card-service.js';
import { RampService, type RampServiceOptions } from './ramps/ramp-service.js';
import { DepositService, type DepositServiceOptions } from './deposits/deposit-service.js';
import { AutoInvestService, type AutoInvestServiceOptions } from './auto-invest/auto-invest-service.js';
import { BusinessService } from './business/business-service.js';
import { unconfiguredBusinessDirectory, type BusinessDirectoryPort, type BusinessLookupLimiter } from './business/business-directory.js';
import { PortfolioService, type PortfolioServiceOptions } from './portfolio/portfolio-service.js';
import { ActivityService, type ActivityServiceOptions } from './activity/activity-service.js';
import { ActivityRecordService } from './activity/activity-records.js';
import { StatementService } from './statements/statement-service.js';
import { AccountDetailsService, type AccountDetailsOptions } from './account-details/account-details.js';
import { PersonalPayService } from './transfers/personal-pay.js';
import type { PartyHandlePort } from './transfers/party-handles.js';
import type { PersonalRequestNotices } from './transfers/request-notices.js';
import type { LedgerHistory } from './analytics/ledger-history.js';
import type { RecipientStatePort } from './recipient-state.js';
import { BillPayService } from './personal-pay/bills.js';
import { GlobalSendService } from './personal-pay/global.js';
import { GlobalHoldService } from './personal-pay/holds.js';
import { emptyBillPorts, emptyGlobalPorts, type BillPorts, type GlobalPorts } from './personal-pay/ports.js';

/**
 * svc-bank — MULTI-CURRENCY ACCOUNTS OVER THE LEDGER (§8.1).
 *
 * This service is a PROJECTION, not a source of truth. It stores names,
 * policies, instructions and records of completed jobs. It stores no balance,
 * anywhere, and the three services below are wired so that it cannot start:
 * every "how much" question they answer goes to `LedgerClient`, and nothing in
 * this service writes a figure that a later read could mistake for one.
 *
 * The composition root is one function so the wiring is visible in one place —
 * including that `SpendAnalytics` gets a READ port over the ledger and no
 * writer at all.
 */

export interface BankServices {
  readonly spaces: SpaceService;
  readonly transfers: TransferService;
  readonly personalPay: PersonalPayService;
  readonly earn: EarnService;
  readonly analytics: SpendAnalytics;
  readonly portfolio: PortfolioService;
  readonly activity: ActivityService;
  readonly activityRecords: ActivityRecordService;
  readonly statements: StatementService;
  readonly accountDetails: AccountDetailsService;
  readonly loans: LoanService;
  /** Desk pause of new borrow and new supply per asset (BK-loan-07). */
  readonly assetPauses: AssetPauseService;
  readonly cards: CardService;
  readonly ramps: RampService;
  readonly deposits: DepositService;
  readonly autoInvest: AutoInvestService;
  readonly business: BusinessService;
  readonly bills: BillPayService;
  readonly globalSend: GlobalSendService;
  readonly globalHolds: GlobalHoldService;
  /**
   * Operator transfer reads. The same connection the services use.
   * The procedures only SELECT. They do not post.
   */
  readonly transferOps: {
    readonly sql: Sql;
    readonly handles?: PartyHandlePort;
  };
}

export interface BankServiceOptions {
  /** Refused by earn pools — svc-token owns native staking (§8.1). */
  nativeAssetId?: string;
  /**
   * Loan wiring: where LTV marks come from, who buys seized collateral, and where
   * a margin call is delivered.
   *
   * Injected rather than constructed here, and deliberately not defaulted to a
   * live feed. svc-trade has no index price today — only best bid/ask and last
   * trade — so the adapter in use decides whether a liquidation may happen at
   * all. `loans/prices.ts` sets out what that costs and what would fix it. A
   * default that quietly reached for `last` would bury the most important caveat
   * in this module inside a composition root nobody reads.
   */
  loans?: LoanServiceOptions;
  /**
   * Card wiring: which issuer, if any.
   *
   * Not defaulted to `cardSim()`, and the omission is the same shape as the
   * price source above. The dangerous default here is the plausible one — fall
   * back to the simulator and an environment somebody believes is live starts
   * approving authorisations against a counterparty that does not exist. With no
   * issuer configured every card procedure refuses with `bank.no_card_issuer`,
   * which is the correct posture for a deployment that has not been given a card
   * programme (and none has one: the live rail is `socket.live-issuer`).
   */
  cards?: CardServiceOptions;
  /**
   * Ramp wiring: crypto ledger half, if any.
   *
   * Not defaulted to crypto-ledger. Silence is no programme; every ramp money
   * path refuses `bank.no_ramp_rail`. Kind fiat refuses `bank.fiat_ramp_socket`
   * before any row or ledger post.
   */
  ramps?: RampServiceOptions;
  /**
   * Custody port for deposit addresses. Unset refuses `bank.deposit_custody_unset`.
   * This service does not derive an address.
   */
  deposits?: DepositServiceOptions;
  /**
   * Account details and the eligibility statement (BK-acct-03). The currencies and the rule set are the owner's and have no
   * default; the banking partner is not wired today, so details refuse `rail.bank`.
   */
  accountDetails?: AccountDetailsOptions;
  /**
   * Auto-invest wiring: optional convert port for DCA.
   *
   * Not defaulted. Absent convert = every DCA create/run refuses
   * `bank.auto_invest_rate_unset` rather than inventing a §8 rate. Threshold
   * sweeps need no convert (same-asset earn deposit).
   */
  autoInvest?: AutoInvestServiceOptions;
  /**
   * Portfolio valuation: where prices come from (svc-trade's public tickers).
   * Not defaulted. Without a source, `portfolio.summary` answers users who hold
   * only USDT/USDC/USD and refuses `bank.prices_unavailable` for anyone else.
   */
  portfolio?: PortfolioServiceOptions;
  /**
   * Who may be credited: asks svc-identity whether a recipient is frozen or closed.
   *
   * Not defaulted to "everyone may receive". With no port every credit to another
   * user refuses `bank.recipient_check_unset`; moves between a user's own spaces
   * need no check and still work. See `recipient-state.ts`.
   */
  recipients?: RecipientStatePort;
  /** Merged money history: the ledger page port and the cursor secret. Unset = `bank.activity.list` refuses, never answers empty. */
  activity?: ActivityServiceOptions;
  /** Public handles for receipts. Unset = receipts name `bank.party_handles_unset` and requests refuse. */
  handles?: PartyHandlePort;
  /** Inbox events for payment requests. Unset = the request is stored and the notice names `bank.pay_request_notify_unwired`. */
  requestNotices?: PersonalRequestNotices;
  /**
   * Public handles and exact recipient lookup. Unset refuses team, approval
   * history and recipient-space reads. It does not invent a handle.
   */
  directory?: BusinessDirectoryPort;
  /** Recipient-lookup budget. Default is 30 per minute per caller. */
  directoryLookups?: BusinessLookupLimiter;
  /**
   * Bill-pay ports. Unset refuses search, lookup, pay and recurring create.
   * Nothing here invents a biller, an amount due or a PSP.
   */
  bills?: BillPorts;
  /**
   * Global-send ports. Unset refuses corridors, quotes and sends.
   * Travel-rule `decision()` null means Nitro/Phantom have not decided.
   */
  global?: GlobalPorts;
  /** Owner-published purpose, source-of-funds and reference rules for a global send (JSON). Blank refuses. */
  sendFieldRules?: string | undefined;
  /** Owner-published payee controls (JSON). Blank refuses every global send. */
  payeeControls?: string | undefined;
  /** Owner-published exchange payment allowance (JSON). Blank refuses every global send. */
  exchangeAllowance?: string | undefined;
  /** Owner-published proof-upload limits (JSON). Blank refuses an upload. */
  proofLimits?: string | undefined;
}

export function createBankServices(sql: Sql, ledger: LedgerClient, history: LedgerHistory, options: BankServiceOptions = {}): BankServices {
  const spaces = new SpaceService(sql, ledger, options.recipients);
  const transfers = new TransferService(sql, ledger, spaces);
  const personalPay = new PersonalPayService(sql, ledger, transfers, spaces, {
    handles: options.handles,
    notices: options.requestNotices,
  });
  const earn = new EarnService(sql, ledger, { nativeAssetId: options.nativeAssetId ?? 'IFC' });
  const analytics = new SpendAnalytics(spaces, history);
  const portfolio = new PortfolioService(ledger, spaces, options.portfolio ?? {});
  const activityRecords = new ActivityRecordService(sql);
  const activity = new ActivityService(spaces, {
    ...(options.activity ?? {}),
    records: activityRecords,
    transferFacts: { forTransfers: (userId, txIds) => personalPay.factsFor(userId, txIds) },
  });
  const statements = new StatementService(activity, options.activity?.cursorSecret);
  // No banking partner = every currency answers unavailable with `rail.bank`; no details are made up.
  const accountDetails = new AccountDetailsService(options.accountDetails ?? {});
  // No price source configured = no marks = no liquidations, and every LTV read
  // fails with `bank.mark_missing`. The correct posture for a deployment that has
  // not decided where its prices come from.
  const loans = new LoanService(sql, ledger, options.loans ?? { priceSource: fixedPriceSource({}) });
  const assetPauses = new AssetPauseService(sql);
  // No convert port = DCA refuses rates-unset; threshold sweeps still work.
  // Constructed before cards so the capture hook can call applyRoundUp without
  // a setter or a circular constructor.
  const autoInvest = new AutoInvestService(sql, ledger, earn, spaces, options.autoInvest ?? {});
  // No issuer configured = no card programme, and every card procedure refuses
  // by name rather than simulating one. See `cards/issuer.ts`.
  const cards = new CardService(sql, ledger, {
    ...(options.cards ?? {}),
    onCaptureSettled: options.cards?.onCaptureSettled ?? ((event) => autoInvest.applyRoundUp(event)),
  });
  // No ramp programme = every ramp procedure refuses `bank.no_ramp_rail`.
  const ramps = new RampService(sql, ledger, options.ramps ?? {});
  const deposits = new DepositService(sql, options.deposits ?? {});
  const business = new BusinessService(
    sql,
    ledger,
    spaces,
    transfers,
    options.directory ?? unconfiguredBusinessDirectory(),
    options.directoryLookups,
  );

  const bills = new BillPayService(sql, ledger, spaces, options.bills ?? emptyBillPorts());
  const globalSend = new GlobalSendService(
    sql,
    ledger,
    spaces,
    options.global ?? emptyGlobalPorts(),
    options.sendFieldRules,
    options.payeeControls,
    options.exchangeAllowance,
  );
  const globalHolds = new GlobalHoldService(sql, globalSend, options.proofLimits);

  return {
    spaces,
    transfers,
    personalPay,
    earn,
    analytics,
    portfolio,
    activity,
    activityRecords,
    statements,
    accountDetails,
    assetPauses,
    loans,
    cards,
    ramps,
    deposits,
    autoInvest,
    business,
    bills,
    globalSend,
    globalHolds,
    transferOps: { sql, handles: options.handles },
  };
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
  BusinessService,
};
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
