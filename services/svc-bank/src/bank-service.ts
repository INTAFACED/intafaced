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
import { AddMoneyService } from './ramps/add-money.js';
import { LinkedAccountService } from './linked-accounts/linked-accounts.js';
import { CashOutService } from './cash-out/cash-out.js';
import type { CashOutPartner } from './cash-out/payout-sim.js';
import { RailSendService } from './rail-sends/rail-sends.js';
import { BANK_PAYEE_COOLING_HOURS_ENV, PayeeService } from './rail-sends/payees.js';
import { BANK_ADDRESS_BOOK_CAP_ENV } from './withdraw-destination.js';
import { BANK_OFFRAMP_COOLING_HOURS_ENV } from './offramp-cooling.js';
import {
  BANK_DEPOSIT_ADDRESS_CAP_ENV,
  BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS_ENV,
  DepositService,
  type DepositServiceOptions,
} from './deposits/deposit-service.js';
import { listSupportedAssets, withdrawNetworksFrom, type AssetRegistryReads, type SupportedAssetView } from './assets/supported-assets.js';
import { AutoInvestService, type AutoInvestServiceOptions } from './auto-invest/auto-invest-service.js';
import { IncomeSorterService } from './sorter/income-sorter.js';
import { SharedPotService } from './spaces/shared-pots.js';
import { RecoveryClaimService } from './recovery/recovery-claims.js';
import { unconfiguredIdentityRecovery, type IdentityRecoveryPort } from './recovery/identity-recovery.js';
import { BillsPotService } from './spaces/bills-pot.js';
import { BusinessService } from './business/business-service.js';
import { BusinessLookupLimiter, unconfiguredBusinessDirectory, type BusinessDirectoryPort } from './business/business-directory.js';
import { PortfolioService, type PortfolioServiceOptions } from './portfolio/portfolio-service.js';
import { ActivityService, type ActivityServiceOptions } from './activity/activity-service.js';
import { ActivityRecordService } from './activity/activity-records.js';
import { StatementService } from './statements/statement-service.js';
import { AccountDetailsService, type AccountDetailsOptions } from './account-details/account-details.js';
import { parseAccountTerms, type AccountTerms } from './account-home/account-terms.js';
import { CurrencyService } from './account-home/currencies.js';
import { ProfileService } from './account-home/profile.js';
import { PersonalPayService } from './transfers/personal-pay.js';
import type { PartyHandlePort } from './transfers/party-handles.js';
import type { PersonalRequestNotices } from './transfers/request-notices.js';
import type { PersonalTransferNotices } from './transfers/transfer-notices.js';
import type { LedgerHistory } from './analytics/ledger-history.js';
import type { RecipientStatePort } from './recipient-state.js';
import { BillPayService } from './personal-pay/bills.js';
import { GlobalSendService } from './personal-pay/global.js';
import { DirectDebitService } from './direct-debits/direct-debits.js';
import { CalendarService } from './calendar/calendar.js';
import { ScheduledNoticeService, type ScheduledNoticeSink } from './rules/scheduled-notices.js';
import { unsetDirectDebitScheme, type DirectDebitScheme } from './direct-debits/scheme.js';
import { BANK_GLOBAL_HOLD_CANCEL_HOURS_ENV, GlobalHoldService } from './personal-pay/holds.js';
import { SpendFiguresReader } from './insufficient-funds.js';
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
  /** BK-pots-03: payments from other people split across the person's own spaces. */
  readonly sorter: IncomeSorterService;
  /** The person's bills pot per asset, and whether a standing order from it may top it up from the main account. */
  readonly billsPots: BillsPotService;
  readonly sharedPots: SharedPotService;
  /** RC-identity-08: the heir's claim on a dead owner's balances, swept once the owner's recovery keys sign it. */
  readonly recovery: RecoveryClaimService;
  readonly earn: EarnService;
  readonly analytics: SpendAnalytics;
  readonly portfolio: PortfolioService;
  readonly activity: ActivityService;
  readonly activityRecords: ActivityRecordService;
  readonly statements: StatementService;
  readonly accountDetails: AccountDetailsService;
  /** The owner's base-tier account terms (BK-acct-01). Blank refuses `bank.account_terms_unset`. */
  readonly accountTerms: () => AccountTerms;
  /** The currencies on an account: labels over ledger accounts (BK-acct-01). */
  readonly currencies: CurrencyService;
  /** Which profile a bank call is for, proved against the caller's own business memberships (J-bank-01 #7). */
  readonly profiles: ProfileService;
  readonly loans: LoanService;
  /** Desk pause of new borrow and new supply per asset (BK-loan-07). */
  readonly assetPauses: AssetPauseService;
  readonly cards: CardService;
  readonly ramps: RampService;
  /** Add money: the ways to pay in with their quotes, and the customer's requests (J-bank-02). */
  readonly addMoney: AddMoneyService;
  /** BK-acct-02: the customer's own accounts at other banks. Kept unverified until a banking partner verifies them. */
  readonly linkedAccounts: LinkedAccountService;
  /** BK-ord-01: cash out to a linked bank account. Kept refused with its reason; nothing is held or posted. */
  readonly cashOut: CashOutService;
  /** BK-xfer-02: send to a bank account over a bank rail. Kept refused with `rail.bank`; nothing is held or posted. */
  readonly railSends: RailSendService;
  /** BK-xfer-06: the recipient book for bank rails, with the owner's cooling-off on a new recipient. */
  readonly railPayees: PayeeService;
  readonly deposits: DepositService;
  /** W-balances-05: svc-ledger's supported asset and network list, every state, as customers read it. */
  readonly supportedAssets: { list(): Promise<SupportedAssetView[]> };
  readonly autoInvest: AutoInvestService;
  readonly business: BusinessService;
  readonly bills: BillPayService;
  readonly globalSend: GlobalSendService;
  readonly globalHolds: GlobalHoldService;
  /** BK-xfer-11: Direct Debit mandates and collections. Every control refuses `rail.bank` while no scheme is wired. */
  readonly directDebits: DirectDebitService;
  /** BK-acct-10: one read of what is dated, merged from svc-bank's own sources. Reads only. */
  readonly calendar: CalendarService;
  /** BK-acct-10: the payment reminder rule and the standing-order notice outbox. Posts nothing. */
  readonly scheduledNotices: ScheduledNoticeService;
  /** RC-wallet-09: figures for a refused spend. Reads only. */
  readonly spendFigures: SpendFiguresReader;
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
  /** `BANK_PAYEE_COOLING_HOURS`: how long a new bank-rail recipient waits. Blank refuses; zero is no wait. */
  payeeCoolingHours?: string;
  /** `BANK_SCHEDULE_EDIT_CUTOFF_MINUTES`: how close to its next run a standing order may still be edited. Blank refuses. */
  scheduleEditCutoffMinutes?: string;
  /** `BANK_GLOBAL_HOLD_CANCEL_HOURS`: how long a global send may stay on hold before it is cancelled. Blank, never. */
  holdCancelHours?: string;
  /** The service secret a global-send or cash-out receipt's signing key is derived from. Blank, no receipt is made. */
  receiptSecret?: string;
  /** Who pays out cash-outs to bank accounts. Unset: every cash-out is kept refused `bank.fiat_ramp_socket`. */
  cashOutPartner?: CashOutPartner | null;
  /** `BANK_GLOBAL_REFUND_FEE`: the fee on refunding a global send the rail returned. Blank refuses; only zero refunds. */
  refundFee?: string;
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
   * svc-ledger's asset and network registry (W-balances-05). The customer's supported-asset list reads it, and the
   * deposit catalogue is narrowed to it. Unset refuses both with `bank.asset_registry_unavailable`.
   */
  assetRegistry?: AssetRegistryReads | null;
  /**
   * Account details and the eligibility statement (BK-acct-03). The currencies and the rule set are the owner's and have no
   * default; the banking partner is not wired today, so details refuse `rail.bank`.
   */
  accountDetails?: AccountDetailsOptions;
  /** Owner-published base-tier account terms as JSON (`BANK_ACCOUNT_TERMS_JSON`). No default: blank refuses. */
  accountTerms?: string | undefined;
  /** Owner-published staking risk wording as JSON (`BANK_EARN_RISK_WORDING_JSON`, BK-earn-04). No default: blank refuses. */
  earnRiskWording?: string | undefined;
  /** Owner-published currencies an account may hold (`BANK_ACCOUNT_CURRENCIES`). No default: blank refuses an add. */
  accountCurrencies?: string | undefined;
  /** Owner-published number of live named spaces per account (`BANK_SPACE_LIMIT`). No default: blank refuses a create. */
  spaceLimit?: string | undefined;
  /** Owner-set hours an early pot unlock waits (`BANK_SPACE_UNLOCK_WAIT_HOURS`). No default: blank refuses the ask. */
  spaceUnlockWaitHours?: string | undefined;
  /** Owner-set smallest payment the income sorter splits (`BANK_INCOME_SORTER_MIN_CREDIT`). No default: blank refuses a sorter. */
  incomeSorterMinCredit?: string | undefined;
  /** Owner-set minutes a shared pot invite lasts (`BANK_SHARED_POT_INVITE_MINUTES`). No default: blank refuses sharing. */
  sharedPotInviteMinutes?: string | undefined;
  /** Owner-set people one pot may be shared with (`BANK_SHARED_POT_PEOPLE_CAP`). No default: blank refuses sharing. */
  sharedPotPeopleCap?: string | undefined;
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
  /** Identity's recovery claim doors (RC-identity-08). Unset = every claim refuses `bank.recovery_unavailable`. */
  identityRecovery?: IdentityRecoveryPort;
  /** Merged money history: the ledger page port and the cursor secret. Unset = `bank.activity.list` refuses, never answers empty. */
  activity?: ActivityServiceOptions;
  /** Public handles for receipts. Unset = receipts name `bank.party_handles_unset` and requests refuse. */
  handles?: PartyHandlePort;
  /** Inbox events for payment requests. Unset = the request is stored and the notice names `bank.pay_request_notify_unwired`. */
  requestNotices?: PersonalRequestNotices;
  /** Inbox events for a posted personal send (both people). Unset = no notice; the send is unaffected. */
  transferNotices?: PersonalTransferNotices;
  /** Standing-order reminders and failure notices. Unset = owed notices stay owed and the job names `bank.scheduled_notify_unwired`. */
  scheduledNotices?: ScheduledNoticeSink;
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
  /** Who speaks for the direct debit scheme. Unset unless the TEST stand-in was chosen (`BANK_DD_SCHEME=dd-sim`). */
  directDebitScheme?: DirectDebitScheme;
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
  const spaces = new SpaceService(sql, ledger, options.recipients, {
    spaceLimit: () => options.spaceLimit,
    unlockWaitHours: () => options.spaceUnlockWaitHours,
  });
  const billsPots = new BillsPotService(sql, spaces);
  const transfers = new TransferService(sql, ledger, spaces, { editCutoffMinutes: options.scheduleEditCutoffMinutes }, billsPots);
  const sorter = new IncomeSorterService(sql, ledger, spaces, { minCredit: () => options.incomeSorterMinCredit });
  // One lookup budget per caller for every door that asks the directory for a person: business and shared pots.
  const directoryLookups = options.directoryLookups ?? new BusinessLookupLimiter();
  const sharedPots = new SharedPotService(
    sql,
    spaces,
    options.directory ?? unconfiguredBusinessDirectory(),
    {
      inviteMinutes: () => options.sharedPotInviteMinutes,
      peopleCap: () => options.sharedPotPeopleCap,
      // Read at call time: the card service is made below.
      cardProgramme: () => cards.programme(),
    },
    directoryLookups,
  );
  const personalPay = new PersonalPayService(sql, ledger, transfers, spaces, {
    handles: options.handles,
    notices: options.requestNotices,
    transferNotices: options.transferNotices,
    onCreditPosted: (credit) => sorter.sortCredit(credit),
    securityLock: options.ramps?.securityLock,
  });
  const assetPauses = new AssetPauseService(sql);
  // The supply pause lives in the deposit path so auto-invest cannot go around it.
  const earn = new EarnService(sql, ledger, {
    nativeAssetId: options.nativeAssetId ?? 'IFC',
    supplyGate: assetPauses,
    accounts: options.recipients,
    riskWording: options.earnRiskWording,
  });
  const analytics = new SpendAnalytics(spaces, history);
  const portfolio = new PortfolioService(ledger, spaces, {
    ...(options.portfolio ?? {}),
    assets: options.portfolio?.assets ?? options.assetRegistry ?? null,
  });
  const activityRecords = new ActivityRecordService(sql);
  const activity = new ActivityService(spaces, {
    ...(options.activity ?? {}),
    records: activityRecords,
    transferFacts: { forTransfers: (userId, txIds) => personalPay.factsFor(userId, txIds) },
  });
  const statements = new StatementService(activity, options.activity?.cursorSecret, spaces);
  // No banking partner = every currency answers unavailable with `rail.bank`; no details are made up.
  const accountDetails = new AccountDetailsService(options.accountDetails ?? {});
  const accountTerms = () => parseAccountTerms(options.accountTerms);
  const currencies = new CurrencyService(sql, ledger, spaces, { currencies: options.accountCurrencies });
  const profiles = new ProfileService(sql);
  // No price source configured = no marks = no liquidations, and every LTV read
  // fails with `bank.mark_missing`. The correct posture for a deployment that has
  // not decided where its prices come from.
  const loanBase = options.loans ?? { priceSource: fixedPriceSource({}) };
  // The payoff fee and window come from env (index.ts); unset or blank refuses.
  const loans = new LoanService(sql, ledger, {
    ...loanBase,
    statementSecret: loanBase.statementSecret !== undefined ? loanBase.statementSecret : options.activity?.cursorSecret,
  });
  // No convert port = DCA refuses rates-unset; threshold sweeps still work.
  // Constructed before cards so the capture hook can call applyRoundUp without
  // a setter or a circular constructor.
  const autoInvest = new AutoInvestService(sql, ledger, earn, spaces, options.autoInvest ?? {});
  // No issuer configured = no card programme, and every card procedure refuses
  // by name rather than simulating one. See `cards/issuer.ts`.
  const cards = new CardService(sql, ledger, {
    ...(options.cards ?? {}),
    onCaptureSettled: options.cards?.onCaptureSettled ?? ((event) => autoInvest.applyRoundUp(event)),
    // A card linked to a shared pot: every change of its status is a line in the pot's log, in the card's transaction.
    onStatusChanged: options.cards?.onStatusChanged ?? ((tx, change) => sharedPots.noteCardStatus(tx, change)),
  });
  // No ramp programme = every ramp procedure refuses `bank.no_ramp_rail`.
  // One registry: the address book reads the same one as deposits and the supported-asset list unless a test passes its own.
  const assetRegistry = options.assetRegistry ?? null;
  const ramps = new RampService(sql, ledger, {
    ...options.ramps,
    withdrawNetworks: options.ramps?.withdrawNetworks ?? (assetRegistry ? withdrawNetworksFrom(assetRegistry) : null),
  });
  const addMoney = new AddMoneyService(sql, ramps);
  // The same owner values as the crypto address book: its cap, and the payout cooling-off window.
  const linkedAccounts = new LinkedAccountService(sql, {
    // Resolved as RampService resolves them: a value passed in wins, otherwise the live env.
    addressBookCap: () =>
      options.ramps?.addressBookCap !== undefined ? options.ramps.addressBookCap : process.env[BANK_ADDRESS_BOOK_CAP_ENV],
    offrampCoolingHours: () =>
      options.ramps?.offrampCoolingHours !== undefined ? options.ramps.offrampCoolingHours : process.env[BANK_OFFRAMP_COOLING_HOURS_ENV],
  });
  // The owner's extra-address cap and expiry window (W-deposit-02): a value passed in wins, otherwise the live env.
  const deposits = new DepositService(
    sql,
    {
      ...options.deposits,
      addressCap: options.deposits?.addressCap ?? (() => process.env[BANK_DEPOSIT_ADDRESS_CAP_ENV]),
      addressExpiryDays: options.deposits?.addressExpiryDays ?? (() => process.env[BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS_ENV]),
    },
    assetRegistry,
  );
  const supportedAssets = { list: () => listSupportedAssets(assetRegistry) };
  // The owner's window for a new recipient: a value passed in wins, otherwise the live env. Blank refuses a send.
  const railPayees = new PayeeService(sql, () =>
    options.payeeCoolingHours !== undefined ? options.payeeCoolingHours : process.env[BANK_PAYEE_COOLING_HOURS_ENV],
  );
  const business = new BusinessService(
    sql,
    ledger,
    spaces,
    transfers,
    options.directory ?? unconfiguredBusinessDirectory(),
    directoryLookups,
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
    options.receiptSecret,
    options.refundFee,
  );
  const globalHolds = new GlobalHoldService(sql, globalSend, options.proofLimits, () =>
    options.holdCancelHours !== undefined ? options.holdCancelHours : process.env[BANK_GLOBAL_HOLD_CANCEL_HOURS_ENV],
  );
  globalSend.screenWith((sendId) => globalHolds.screen(sendId));
  const directDebits = new DirectDebitService(sql, ledger, spaces, options.directDebitScheme ?? unsetDirectDebitScheme);

  const recovery = new RecoveryClaimService(sql, ledger, spaces, options.identityRecovery ?? unconfiguredIdentityRecovery());

  return {
    spaces,
    sorter,
    billsPots,
    sharedPots,
    recovery,
    transfers,
    personalPay,
    earn,
    analytics,
    portfolio,
    activity,
    activityRecords,
    statements,
    accountDetails,
    accountTerms,
    currencies,
    profiles,
    assetPauses,
    loans,
    cards,
    ramps,
    addMoney,
    linkedAccounts,
    cashOut: new CashOutService(
      sql,
      ledger,
      { available: (userId, assetId) => ramps.availableOf(userId, assetId), linked: linkedAccounts },
      { partner: options.cashOutPartner ?? null, receiptSecret: options.receiptSecret, securityLock: options.ramps?.securityLock },
    ),
    railSends: new RailSendService(sql, spaces, railPayees),
    railPayees,
    deposits,
    supportedAssets,
    autoInvest,
    business,
    bills,
    globalSend,
    globalHolds,
    directDebits,
    calendar: new CalendarService({
      sql,
      transfers,
      bills,
      directDebits,
      earn,
      loans,
      log: (source, err) =>
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'svc-bank',
            event: 'bank.calendar_source_failed',
            source,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
    }),
    scheduledNotices: new ScheduledNoticeService(sql, {
      sink: options.scheduledNotices,
      log: (event, detail) => console.error(JSON.stringify({ level: 'error', service: 'svc-bank', event, detail })),
    }),
    spendFigures: new SpendFiguresReader(sql, ledger),
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
