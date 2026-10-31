import type { z } from 'zod';
import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { edgeTrustFromEnv } from '@intafaced/config';
import {
  createEdgeContext,
  createPayCustodyDepositClient,
  rawBodyOf,
  retainRawBody,
  s2sFromEnv,
  verifyServiceHeaders,
  verifyServiceRequest,
  type HttpServiceRequest,
} from '@intafaced/contracts';
import { JetStreamEventBus } from '@intafaced/events';
import { env } from './env.js';
import { readBankWatermark } from './restore-watermark.js';
import { createBankServices, createIdentityRecipientState, unconfiguredRecipientState } from './bank-service.js';
import { createIdentityBusinessDirectory, unconfiguredBusinessDirectory } from './business/business-directory.js';
import { tradeConvertPort, usableTradeConvertUrl } from './auto-invest/trade-convert-port.js';
import { bankHttpReady } from './ready.js';
import { createPayCustodyDepositPort } from './deposits/pay-custody-port.js';
import { cardIssuerFor } from './cards/issuer.js';
import { globalPortsFor } from './personal-pay/global-sim.js';
import { onrampStandInFor } from './ramps/onramp-sim.js';
import { cashOutPartnerFor } from './cash-out/payout-sim.js';
import { payoutFailedBody, payoutPaidBody, payoutReturnedBody, payoutVerifyBody, redriveBody } from './cash-out/job-bodies.js';
import { directDebitSchemeFor } from './direct-debits/scheme.js';
import { ddRunBody, ddSimCollectionBody, ddSimMandateBody } from './direct-debits/job-bodies.js';
import { scheduledNoticesBody } from './rules/job-bodies.js';
import { incomeSorterBody } from './sorter/income-sorter.js';
import { rampProgrammeFor } from './ramps/rails.js';
import { destinationSanctions } from './ramps/sanctions-list.js';
import { eventMarginCallSink } from './loans/margin-call-publisher.js';
import { createIdentityPartyHandles } from './transfers/party-handles.js';
import { createIdentitySecurityLock, unconfiguredSecurityLock } from './security-lock.js';
import { createIdentityApprovalMail, unconfiguredApprovalMail } from './ramps/address-approval.js';
import { createIdentityTrustedDevices, unconfiguredTrustedDevices } from './ramps/trusted-devices.js';
import { createIdentityRecovery, unconfiguredIdentityRecovery } from './recovery/identity-recovery.js';
import { eventPersonalRequestNotices } from './transfers/request-notices.js';
import { eventPersonalTransferNotices } from './transfers/transfer-notices.js';
import { eventScheduledNotices } from './rules/scheduled-notices.js';
import { tickerPriceSource } from './loans/prices.js';
import { httpTickerSource } from './portfolio/portfolio-service.js';
import { httpCloseSeries } from './portfolio/candles.js';
import {
  createLedgerAssetRegistry,
  createLedgerClient,
  createLedgerHistory,
  createLedgerHistoryPages,
  createLedgerHoldingsHistory,
} from './ledger-client.js';
import { createAffiliateAccrueClient } from './affiliate-accrue.js';
import { createAffiliatePayoutClient } from './affiliate-payout.js';
import { createBankRouter, type BankRouter } from './router.js';
import { createStepUpGate } from './step-up/step-up-gate.js';
import { SqlStepUpUseStore } from './step-up/step-up-store.js';
import { createIdentityApprovalClient, unwiredApprovalConsumer } from './action-approval-consume.js';
import { BankError } from './errors.js';
import {
  assertAutoInvestBatchLimit,
  assertEarnResumePendingLimit,
  assertLoanAccrueBatchLimit,
  assertLoanResumePendingLimit,
} from './job-batch-limit.js';
import { requireInternalJobHmac } from './internal-job-hmac.js';
import { registerClosureCheck } from './closure/closure-check.js';
import { registerAgentsTeamMembership, teamMembershipFor } from './agents/team-membership.js';
import { recoveryCounts, startBankRecoveryJobs } from './recovery-jobs.js';
import { withSpan } from './tracing.js';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';

// §9 — register the TracerProvider before the first span is created.
// `@opentelemetry/api` alone is a no-op: without this call every span in
// ./tracing.ts is built, tagged and then discarded before it reaches the
// collector. Tracers grabbed at module scope resolve lazily through the proxy
// provider, so registering here still captures them.
registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-bank — multi-currency accounts over the ledger (§8.1).
 *
 * Boot order: env → db → ledger → bus → services → server.
 *
 * The bus connection is new, and it exists for one subject. `bankMarginCalled`
 * had a complete svc-notify consumer and no publisher anywhere, so a margin call
 * started a grace clock that gates liquidation and the borrower was never told —
 * the outcome `loans/risk.ts` argues against at length. `ownedStreams: ['bank']`
 * is what creates `INTAFACED_BANK`, which has never existed, and until it does
 * the consumer on the other side cannot attach at all.
 */

const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  connection: { search_path: 'bank,public', application_name: env.SERVICE_NAME },
  onnotice: () => undefined,
});

await sql`SELECT 1 FROM bank.spaces LIMIT 1`.catch(() => {
  throw new Error('bank schema is missing — run migrations before starting svc-bank');
});

// Value moves through svc-ledger, never through this service's own tables
// (Doctrine §0.6). This client is the only path.
// Per-service keys (S2S v3): unset S2S_AUTH_MODE leaves the ledger, identity and trade calls on the shared secret alone.
const s2s = s2sFromEnv(env, 'svc-bank');
const doorS2s = s2s.serviceVerifier && s2s.s2sMode ? { verifier: s2s.serviceVerifier, mode: s2s.s2sMode } : undefined;
const ledgerS2s = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;
const ledger = createLedgerClient(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET, ledgerS2s);
const history = createLedgerHistory(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET, ledgerS2s);

/**
 * `ownedStreams: ['bank']` — this process is responsible for creating
 * `INTAFACED_BANK`. It carries no money: the only subject on it announces that a
 * call was RAISED, and value continues to move through svc-ledger and nowhere
 * else (§0.6). Publishing is not a value movement.
 */
const bus = await JetStreamEventBus.connect({
  servers: env.NATS_URL,
  producer: env.SERVICE_NAME,
  streamPrefix: env.NATS_STREAM_PREFIX,
  ownedStreams: ['bank'],
});

const assetRegistry = createLedgerAssetRegistry(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET, ledgerS2s);
const bank = createBankServices(sql, ledger, history, {
  nativeAssetId: env.TOKEN_ASSET_ID,
  // Recovery claims (RC-identity-08): identity says which accounts a heir may claim and whether a claim's signatures
  // count. No IDENTITY_URL refuses every claim with `bank.recovery_unavailable`, never "claimable".
  identityRecovery: env.IDENTITY_URL
    ? createIdentityRecovery(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, undefined, ledgerS2s)
    : unconfiguredIdentityRecovery(),
  payeeCoolingHours: env.BANK_PAYEE_COOLING_HOURS,
  scheduleEditCutoffMinutes: env.BANK_SCHEDULE_EDIT_CUTOFF_MINUTES,
  holdCancelHours: env.BANK_GLOBAL_HOLD_CANCEL_HOURS,
  receiptSecret: env.INTERNAL_SERVICE_SECRET,
  refundFee: env.BANK_GLOBAL_REFUND_FEE,
  // Deposit catalogue and addresses come from svc-pay over the signed seam. With no PAY_URL every answer is "not published"
  // and the doors refuse `bank.deposit_custody_unset`; svc-bank derives no key.
  deposits: {
    custody: createPayCustodyDepositPort(createPayCustodyDepositClient({ payUrl: env.PAY_URL, secret: env.INTERNAL_SERVICE_SECRET })),
    addressCap: () => env.BANK_DEPOSIT_ADDRESS_CAP,
    addressExpiryDays: () => env.BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS,
  },
  // svc-ledger's asset and network registry (W-balances-05), the one list: the customer's supported-asset list, the deposit
  // catalogue narrowed to it, and the address book's assets and networks.
  assetRegistry,
  // Frozen/closed recipients are refused before any posting. Identity owns that
  // state; with no IDENTITY_URL every credit to ANOTHER user refuses
  // `bank.recipient_check_unset` (see the boot warning below). No default of
  // "everyone may receive".
  recipients: env.IDENTITY_URL
    ? createIdentityRecipientState(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, undefined, undefined, ledgerS2s)
    : unconfiguredRecipientState(),
  handles: env.IDENTITY_URL ? createIdentityPartyHandles(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, undefined, ledgerS2s) : undefined,
  requestNotices: eventPersonalRequestNotices(bus),
  transferNotices: eventPersonalTransferNotices(bus),
  scheduledNotices: eventScheduledNotices(bus),
  // Handles and exact recipient lookup. No IDENTITY_URL refuses those reads
  // with bank.business_directory_unset. A 404 from identity is the same refusal:
  // the directory route is not published. No invented handle.
  directory: env.IDENTITY_URL
    ? createIdentityBusinessDirectory(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, undefined, ledgerS2s)
    : unconfiguredBusinessDirectory(),
  // `bank.activity.list`: svc-ledger `historyPage` (read-only), cursors signed under the service secret.
  activity: {
    pages: createLedgerHistoryPages(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET, ledgerS2s),
    cursorSecret: env.INTERNAL_SERVICE_SECRET,
  },
  loans: {
    // Marks are READ from svc-trade's public REST. svc-trade belongs to another
    // stream; nothing here imports it, shares a table with it, or writes to it.
    // What loans actually need from it — an index price rather than a last
    // trade, a depth read, and eventually collateral-funded orders — is written
    // out in `loans/prices.ts` rather than assumed to exist.
    priceSource: tickerPriceSource({ baseUrl: env.TRADE_URL }),
    // The half that was missing. Without this the risk sweep raises calls into
    // a database column and svc-notify's finished consumer never sees one.
    marginCalls: eventMarginCallSink(bus),
    moduleEnabled: env.BANK_LOANS_ENABLED,
    payoffFee: env.BANK_LOAN_PAYOFF_FEE,
    originationFeeBps: env.BANK_LOAN_ORIGINATION_FEE_BPS,
    payoffWindowMinutes: env.BANK_LOAN_PAYOFF_WINDOW_MINUTES,
    affiliateAccrue: env.IDENTITY_URL ? createAffiliateAccrueClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, ledgerS2s) : undefined,
    affiliatePayout: env.IDENTITY_URL ? createAffiliatePayoutClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, ledgerS2s) : undefined,
  },
  /**
   * THE OTHER HALF THAT WAS MISSING, and it was missing in the same shape.
   *
   * `cards` was never passed here at all, so `CardService` took `noCardIssuer`
   * in every deployment and the card procedures the router mounts refused
   * `bank.no_card_issuer` for a reason no operator could act on. The adapter,
   * the simulator and 36 tests were on main and nothing outside a test file had
   * ever constructed one — reachable in the suite, unreachable over HTTP.
   *
   * `cardIssuerFor` is a total mapping over a closed set, so `none` is still
   * what a deployment gets by saying nothing. It just is no longer what a
   * deployment gets by SAYING ANYTHING.
   */
  cards: {
    issuer: cardIssuerFor(env.BANK_CARD_ISSUER, { APP_ENV: env.APP_ENV, NODE_ENV: process.env.NODE_ENV }),
    /**
     * THE JIT CONVERSION RATE (§18), and what this wiring does NOT claim.
     *
     * The same read of svc-trade's public ticker the loan book marks against —
     * reused rather than rebuilt, because a second rate interface meaning the
     * same thing is how two subsystems come to disagree about what a stale price
     * is. It is a CRYPTO BOOK. It can quote one listed asset in another, and it
     * has nothing at all to say about a fiat settlement currency, because this
     * platform has no FX source and never had one — the shell deleted the rate
     * it had invented for exactly this reason.
     *
     * So a card whose settlement asset is fiat refuses every authorisation with
     * `bank.mark_missing`, in production, today. That is the honest state and it
     * is not a bug to be papered over with a hardcoded number: the missing piece
     * is a rate counterparty, which lands on `socket.psp-partners` alongside the
     * fiat ramp leg. Cards charged in the asset they draw on are unaffected —
     * they consult no rate at all.
     */
    rates: tickerPriceSource({ baseUrl: env.TRADE_URL }),
    moduleEnabled: env.BANK_CARDS_ENABLED,
  },
  /**
   * AUTO-INVEST — threshold / round-up / refuse-closed DCA.
   *
   * `enabled` is the same flag as the HTTP/tRPC runner kill. The capture hook
   * has no other door; without this a flipped AUTO_INVEST_ENABLED would still
   * sweep spare change on every card capture.
   *
   * ConvertPort was the other missing half (same shape as cards / ramps):
   * createDca already refused `bank.auto_invest_rate_unset` when convert was
   * null, tests injected a stub, and `index.ts` never passed one — so every
   * deployment stayed refuse-closed. `trade.convert` (quote + execute) is the
   * rate counterparty. Unusable TRADE_URL keeps convert unwired. Convert
   * failure still refuses — this service does not invent a §8 mid.
   */
  /**
   * PORTFOLIO — "Est. total value" prices from svc-trade's public tickers, the
   * same TRADE_URL the loan marks read. A read; nothing is written back.
   */
  portfolio: {
    tickers: httpTickerSource({ baseUrl: env.TRADE_URL }),
    // The entries behind a balance: svc-ledger `historyPage`, read only.
    pages: createLedgerHistoryPages(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET, ledgerS2s),
    // Value over time: svc-ledger `holdingsHistory` and svc-trade's public candles, both read only.
    history: createLedgerHoldingsHistory(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET, ledgerS2s),
    closes: httpCloseSeries({ baseUrl: env.TRADE_URL }),
  },
  autoInvest: {
    enabled: env.AUTO_INVEST_ENABLED,
    ...(usableTradeConvertUrl(env.TRADE_URL)
      ? {
          convert: tradeConvertPort({
            baseUrl: env.TRADE_URL,
            serviceSecret: env.INTERNAL_SERVICE_SECRET,
            s2s: ledgerS2s,
            marketsLimit: env.CONVERT_MARKETS_LIMIT,
          }),
        }
      : {}),
  },
  /** Who answers a global send: unset ports unless the TEST stand-in was chosen, which refuses to boot outside dev/test. */
  global: globalPortsFor(env.BANK_GLOBAL_PARTNER, env.BANK_GLOBAL_SIM_JSON, {
    APP_ENV: process.env.APP_ENV,
    NODE_ENV: process.env.NODE_ENV,
  }),
  /** Who pays cash-outs out: unset unless the TEST stand-in was chosen, which refuses to boot outside dev/test. */
  cashOutPartner: cashOutPartnerFor(
    env.BANK_PAYOUT_PARTNER,
    env.BANK_PAYOUT_SIM_JSON,
    { APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV },
    env.BANK_PAYOUT_SIM_RECORDS_DIR?.trim() || undefined,
  ),
  /** Who speaks for the direct debit scheme: unset unless the TEST stand-in was chosen, which refuses to boot outside dev/test. */
  directDebitScheme: directDebitSchemeFor(env.BANK_DD_SCHEME, env.BANK_DD_SIM_JSON, {
    APP_ENV: process.env.APP_ENV,
    NODE_ENV: process.env.NODE_ENV,
  }),
  /** Purpose, source-of-funds and reference rules of a global send: the owner's table, blank refuses. */
  sendFieldRules: env.BANK_SEND_FIELD_RULES_JSON,
  /** Payee block list of a global send, and the file types and size a proof upload may have: the owner's, blank refuses. */
  payeeControls: env.BANK_PAYEE_CONTROLS_JSON,
  exchangeAllowance: env.BANK_EXCHANGE_ALLOWANCE_JSON,
  proofLimits: env.BANK_PROOF_LIMITS_JSON,
  /** Base-tier account terms, the currencies an account may hold and the space limit: the owner's, blank refuses. */
  accountTerms: env.BANK_ACCOUNT_TERMS_JSON,
  /** The staking risk wording (BK-earn-04): the owner's, blank refuses. */
  earnRiskWording: env.BANK_EARN_RISK_WORDING_JSON,
  accountCurrencies: env.BANK_ACCOUNT_CURRENCIES,
  spaceLimit: env.BANK_SPACE_LIMIT,
  spaceUnlockWaitHours: env.BANK_SPACE_UNLOCK_WAIT_HOURS,
  incomeSorterMinCredit: env.BANK_INCOME_SORTER_MIN_CREDIT,
  sharedPotInviteMinutes: env.BANK_SHARED_POT_INVITE_MINUTES,
  sharedPotPeopleCap: env.BANK_SHARED_POT_PEOPLE_CAP,
  /** Account details and the eligibility statement: owner-published lists, no banking partner wired (`rail.bank`). */
  accountDetails: {
    currencies: env.BANK_ACCOUNT_DETAILS_CURRENCIES,
    eligibilityJson: env.BANK_ELIGIBILITY_JSON,
  },
  /**
   * RAMPS — same missing-wiring shape as cards.
   *
   * Silence is `none` (`BANK_RAMP_MODE` default). `crypto-ledger` turns on the
   * crypto ledger half. Kind fiat refuses `bank.fiat_ramp_socket` before any
   * row or ledger post. `simulated` is always true.
   */
  ramps: {
    programme: rampProgrammeFor(env.BANK_RAMP_MODE),
    offrampCoolingHours: env.BANK_OFFRAMP_COOLING_HOURS,
    addressBookCap: env.BANK_ADDRESS_BOOK_CAP,
    // The owner's destination sanctions list: blank refuses every address save (bank.destination_sanctions_unset).
    sanctions: destinationSanctions(() => env.BANK_DESTINATION_SANCTIONS),
    walletProofWindowMinutes: env.BANK_WALLET_PROOF_WINDOW_MINUTES,
    addressApprovalLinkMinutes: env.BANK_ADDRESS_APPROVAL_LINK_MINUTES,
    walletProofValidDays: env.BANK_WALLET_PROOF_VALID_DAYS,
    // The owner's security lock (W-withdraw-09): identity owns it, bank asks per request. No IDENTITY_URL refuses every
    // address change and send with `bank.security_lock_unset` rather than acting as if no lock were set.
    securityLock: env.IDENTITY_URL
      ? createIdentitySecurityLock(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, undefined, undefined, ledgerS2s)
      : unconfiguredSecurityLock(),
    // New-address approval links are mailed by identity, which holds the customer's address, and identity says whether a
    // device may approve one from another device (W-withdraw-09). No IDENTITY_URL refuses both.
    approvalMail: env.IDENTITY_URL
      ? createIdentityApprovalMail(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, undefined, ledgerS2s)
      : unconfiguredApprovalMail(),
    trustedDevices: env.IDENTITY_URL
      ? createIdentityTrustedDevices(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, undefined, ledgerS2s)
      : unconfiguredTrustedDevices(),
    /** The TEST add-money rate stand-in: none unless chosen, and it refuses to boot outside dev/test. It opens no payment. */
    onrampStandIn: onrampStandInFor(env.BANK_ONRAMP_RATES, env.BANK_ONRAMP_SIM_JSON, {
      APP_ENV: process.env.APP_ENV,
      NODE_ENV: process.env.NODE_ENV,
    }),
  },
});

/**
 * What this process will tell anyone who asks what its card programme is.
 *
 * Read once at boot from the one adapter that exists, rather than re-derived
 * from the env var anywhere else: `/ready`, the boot log and
 * `bank.cards.programme` are then three renderings of a single fact, and they
 * cannot drift into disagreeing about whether this deployment issues real cards.
 */
const cardProgramme = bank.cards.programme();
const rampProgramme = bank.ramps.programmeInfo();

const approvalConsumer = env.IDENTITY_URL
  ? createIdentityApprovalClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET)
  : unwiredApprovalConsumer();

export const appRouter = createBankRouter(bank, {
  scheduledTransfersEnabled: env.SCHEDULED_TRANSFERS_ENABLED,
  interestAccrualEnabled: env.INTEREST_ACCRUAL_ENABLED,
  loanAccrualEnabled: env.LOAN_ACCRUAL_ENABLED,
  loanRiskSweepEnabled: env.LOAN_RISK_SWEEP_ENABLED,
  autoInvestEnabled: env.AUTO_INVEST_ENABLED,
  autoInvestConvertWired: usableTradeConvertUrl(env.TRADE_URL),
  approvals: approvalConsumer,
  stepUp: createStepUpGate({ mode: env.BANK_STEP_UP_MONEY_OUT, approvals: approvalConsumer, store: new SqlStepUpUseStore(sql) }),
});
export type AppRouter = typeof appRouter;

// Built before the listener opens: a service that cannot authenticate the edge
// must fail to start, not start and serve every request as anonymous.
const internalSecret = env.INTERNAL_SERVICE_SECRET;
const edgeContext = createEdgeContext({
  secret: env.EDGE_PRINCIPAL_SECRET,
  ...edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
  ...(internalSecret && internalSecret.length >= 32 ? { internalSecret } : {}),
});

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });
retainRawBody(app);
registerClosureCheck(app, { sql, ledger, secret: env.INTERNAL_SERVICE_SECRET, s2s: doorS2s });
registerAgentsTeamMembership(app, { secret: env.INTERNAL_SERVICE_SECRET, s2s: doorS2s, read: (u, b) => teamMembershipFor(sql, u, b) });

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));
app.get('/ready', async () =>
  bankHttpReady({
    scheduledTransfers: env.SCHEDULED_TRANSFERS_ENABLED,
    interestAccrual: env.INTEREST_ACCRUAL_ENABLED,
    loanAccrual: env.LOAN_ACCRUAL_ENABLED,
    // Surfaced because "are we liquidating today" is the first question anyone
    // asks about this service, and it should not require reading an env file.
    loanRiskSweep: env.LOAN_RISK_SWEEP_ENABLED,
    autoInvest: env.AUTO_INVEST_ENABLED,
    // Product kills — not the jobs. Accrual can be on while loans are off.
    loans: env.BANK_LOANS_ENABLED,
    cards: env.BANK_CARDS_ENABLED,
    autoInvestConvertWired: usableTradeConvertUrl(env.TRADE_URL),
    /**
     * WHETHER THIS DEPLOYMENT'S CARDS ARE REAL, ON THE READINESS ENDPOINT.
     *
     * The other flags here are booleans about jobs. This one is a claim about
     * whether a counterparty exists, and it is on `/ready` for the same reason the
     * risk sweep is: an operator asking "what is this process doing to money"
     * should not have to read an environment file to find out.
     *
     * `simulated` is never omitted and never inferred from `id`. There is no
     * arrangement of these three fields that lets a simulated programme read as a
     * live one — `none` says there is no programme, `card-sim` says it is a
     * simulator in its id AND its display name AND this boolean, and a live rail
     * cannot appear here at all because it is `socket.live-issuer`, a contract.
     */
    cardProgramme,
    /**
     * WHETHER THIS DEPLOYMENT'S BANK RAMP IS LIVE, ON THE READINESS ENDPOINT.
     *
     * `simulated` is never false here. Fiat is always named as the socket. An
     * operator asking "can this process move fiat / broadcast crypto" should not
     * have to read an env file to learn the answer is no.
     */
    rampProgramme,
  }),
);

/**
 * Service credentials on the job endpoints (§2).
 *
 * These two routes are the ONLY surface svc-bank serves — the tRPC router with
 * its 17 scoped procedures is built and never mounted. So the entire reachable
 * attack surface of this service was two unauthenticated POSTs that initiate
 * ledger posts on other people's accounts.
 *
 * Idempotency and the due-date check mean an attacker could not double-pay or
 * pull a transfer forward, so this is not theft. It is an unauthenticated
 * trigger for money movement and unbounded database work, which is enough.
 *
 * Third instance of this shape today, after `ledger.post` (#50) and
 * svc-matching's order writes (#55): a guard written on the tRPC layer while
 * the raw route beside it served the same capability unguarded.
 */
/**
 * Exact inbound bytes for S2S body-bind.
 *
 * `retainRawBody` owns `/internal/jobs`. tRPC's encapsulated parser keeps the
 * wire body as a string on `req.body` and never fills the WeakMap, so `/trpc`
 * reads that string rather than pretending the request had no body.
 */
function inboundRawBody(req: object & { body?: unknown }) {
  if (typeof req.body === 'string') return { retained: true as const, bytes: Buffer.from(req.body, 'utf8') };
  return rawBodyOf(req);
}

function requireService(req: object & { headers: Record<string, string | string[] | undefined>; body?: unknown }): boolean {
  return requireInternalJobHmac(req.headers, env.INTERNAL_SERVICE_SECRET, inboundRawBody(req), doorS2s ? { req, ...doorS2s } : undefined);
}

/** Who signed this request. Only called after `requireService` accepted it, so a null here is unreachable in practice. */
function callerService(req: object & { headers: Record<string, string | string[] | undefined>; body?: unknown }): string | null {
  if (doorS2s) {
    return verifyServiceRequest(req as HttpServiceRequest, {
      verifier: doorS2s.verifier,
      mode: doorS2s.mode,
      legacySecret: env.INTERNAL_SERVICE_SECRET,
      bodyBindMode: 'require',
    }).service;
  }
  return verifyServiceHeaders(req.headers, env.INTERNAL_SERVICE_SECRET, { rawBody: inboundRawBody(req), mode: 'require' }).service;
}

function bodyLimit(body: unknown): number | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  if (!('limit' in body)) return undefined;
  const limit = (body as { limit?: unknown }).limit;
  return typeof limit === 'number' ? limit : undefined;
}

function sendBankJobRefuse(reply: { code: (n: number) => { send: (body: unknown) => unknown } }, err: unknown) {
  if (err instanceof BankError) {
    return reply.code(400).send({ error: err.message, code: err.code });
  }
  throw err;
}

/**
 * The standing-order runner.
 *
 * Exposed as an endpoint rather than an internal timer so the scheduler is
 * external and observable: a cron that can be paused, inspected, and re-run by
 * an operator, instead of a `setInterval` inside a replica that nobody can see
 * and every replica duplicates. Duplication is safe here — that is the whole
 * point of the idempotency work — but "safe when it happens" is not a reason to
 * make it happen on every deploy.
 */
/**
 * The joint-restore position (OPS-ledger-desk-05): a read for svc-ops alone, signed like the job doors.
 * No credentials is 401; a valid service that is not svc-ops is 403.
 */
app.post('/internal/restore/watermark', async (req, reply) => {
  if (!requireService(req)) return reply.code(401).send({ error: 'service credentials required', code: 'bank.unauthenticated' });
  if (callerService(req) !== 'svc-ops') return reply.code(403).send({ error: 'caller not allowed', code: 'bank.caller_forbidden' });
  return readBankWatermark(sql);
});

app.post('/internal/jobs/run-due-transfers', async (req, reply) => {
  // 401 before the flag check: an unauthenticated caller must not be able to
  // learn which jobs are enabled by reading the difference between 401 and 503.
  if (!requireService(req)) {
    return reply.code(401).send({ error: 'service credentials required', code: 'bank.unauthenticated' });
  }
  if (!env.SCHEDULED_TRANSFERS_ENABLED) {
    return reply.code(503).send({ error: 'scheduled transfers are disabled', code: 'bank.transfers_disabled' });
  }
  return withSpan('bank.job.runDueTransfers', async () => bank.transfers.runDueTransfers({ limit: env.TRANSFER_BATCH_SIZE }));
});

app.post('/internal/jobs/accrue-interest', async (req, reply) => {
  if (!requireService(req)) {
    return reply.code(401).send({ error: 'service credentials required', code: 'bank.unauthenticated' });
  }
  if (!env.INTEREST_ACCRUAL_ENABLED) {
    // Same code string as ops.accrueInterest / BankErrorCode — alerts key on one name.
    return reply.code(503).send({ error: 'interest accrual is disabled', code: 'bank.interest_accrual_disabled' });
  }
  return withSpan('bank.job.accrueInterest', async () => {
    const report = await bank.earn.accrueAll();
    return {
      results: report.results.map((r) => ({
        poolId: r.poolId,
        date: r.date,
        recipients: r.recipients,
        alreadyAccrued: r.alreadyAccrued,
      })),
      failures: report.failures,
    };
  });
});

/**
 * LOAN INTEREST ACCRUAL (§8.1 "interest accrual daily recipe").
 *
 * Its own endpoint and its own flag rather than a branch inside the earn job,
 * because the two move money in opposite directions: earn accrual PAYS users out
 * of a funded reserve, loan accrual CHARGES borrowers. An operator halting a
 * runaway payout should not thereby stop charging every borrower on the book.
 *
 * This job posts NOTHING to the ledger. Loan interest capitalises — the day's
 * charge increases the debt and moves no value — so a re-run is guarded by
 * `unique(loan_id, accrual_date)` rather than by an idempotency key, and each day
 * is charged exactly once however many times this fires.
 */
app.post('/internal/jobs/accrue-loan-interest', async (req, reply) => {
  if (!requireService(req)) {
    return reply.code(401).send({ error: 'service credentials required', code: 'bank.unauthenticated' });
  }
  if (!env.LOAN_ACCRUAL_ENABLED) {
    return reply.code(503).send({ error: 'loan interest accrual is disabled', code: 'bank.loan_accrual_disabled' });
  }
  try {
    const limit = assertLoanAccrueBatchLimit(bodyLimit(req.body));
    return await withSpan('bank.job.accrueLoanInterest', async () => {
      const report = await bank.loans.accrueAll(new Date(), limit);
      return {
        results: report.results.map((r) => ({ loanId: r.loanId, days: r.days })),
        failures: report.failures,
      };
    });
  } catch (err) {
    return sendBankJobRefuse(reply, err);
  }
});

/**
 * THE RISK SWEEP — mark every open loan, call what needs calling, liquidate what
 * has been called and has run out of grace.
 *
 * Defaults to DISABLED (`LOAN_RISK_SWEEP_ENABLED`), unlike every other job here.
 * The others move a user's own money between the user's own accounts, or pay out
 * yield that was funded first. This one sells people's collateral, and a fresh
 * deployment whose price source, thresholds and liquidation venue have not been
 * checked by a human must not start doing that on its own.
 */
app.post('/internal/jobs/run-risk-sweep', async (req, reply) => {
  if (!requireService(req)) {
    return reply.code(401).send({ error: 'service credentials required', code: 'bank.unauthenticated' });
  }
  if (!env.LOAN_RISK_SWEEP_ENABLED) {
    // Same code string as ops.runRiskSweep / BankErrorCode — alerts key on one name.
    return reply.code(503).send({ error: 'the loan risk sweep is disabled', code: 'bank.loan_risk_sweep_disabled' });
  }
  return withSpan('bank.job.runRiskSweep', async () => bank.loans.runRiskSweep({ limit: env.LOAN_SWEEP_BATCH_SIZE }));
});

/**
 * Re-drive loans stuck between the collateral lock and the principal draw.
 *
 * The recovery half of the crash story. Both posts are idempotent on business
 * keys, so this is safe to run at any time and any number of times: a loan whose
 * collateral was locked before the crash does not lock it twice, and one whose
 * draw landed does not draw twice.
 */
app.post('/internal/jobs/resume-pending-loans', async (req, reply) => {
  if (!requireService(req)) {
    return reply.code(401).send({ error: 'service credentials required', code: 'bank.unauthenticated' });
  }
  try {
    const limit = assertLoanResumePendingLimit(bodyLimit(req.body));
    return await withSpan('bank.job.resumePendingLoans', async () => bank.loans.resumePending(limit));
  } catch (err) {
    return sendBankJobRefuse(reply, err);
  }
});

/**
 * Recover loan repayments and collateral releases whose ledger outcome is
 * unknown (a lost acknowledgement). Re-posts each pending row on its original
 * key, then closes loans whose debt is clear: collateral released once, loan
 * repaid. No borrower action needed; safe to fire on a schedule.
 */
app.post('/internal/jobs/recover-loan-repayments', async (req, reply) => {
  if (!requireService(req)) {
    return reply.code(401).send({ error: 'service credentials required', code: 'bank.unauthenticated' });
  }
  try {
    const limit = assertLoanResumePendingLimit(bodyLimit(req.body));
    return await withSpan('bank.job.recoverLoanRepayments', async () => bank.loans.recoverRepayments(limit));
  } catch (err) {
    return sendBankJobRefuse(reply, err);
  }
});

/**
 * Re-drive earn deposits stuck between the ledger post and activate.
 *
 * Mirror of resume-pending-loans for the earn claim window: row is `pending`,
 * funds may already be staked under bank.earn.deposit:<positionId>. Idempotent
 * re-post + activate; safe to fire on a schedule.
 */
app.post('/internal/jobs/resume-pending-earn', async (req, reply) => {
  if (!requireService(req)) {
    return reply.code(401).send({ error: 'service credentials required', code: 'bank.unauthenticated' });
  }
  try {
    const limit = assertEarnResumePendingLimit(bodyLimit(req.body));
    return await withSpan('bank.job.resumePendingEarn', async () => bank.earn.resumePending(limit));
  } catch (err) {
    return sendBankJobRefuse(reply, err);
  }
});

/**
 * AUTO-INVEST RUNNER — threshold sweeps and due DCA rules.
 *
 * Same external-scheduler shape as standing orders: an operator-visible POST
 * with its own kill switch, not a setInterval inside the replica. tRPC
 * `ops.runAutoInvest` and this route share `AUTO_INVEST_ENABLED` and the same
 * refusal code `bank.auto_invest_disabled` so neither is a back door past stop.
 */
app.post('/internal/jobs/run-auto-invest', async (req, reply) => {
  if (!requireService(req)) {
    return reply.code(401).send({ error: 'service credentials required', code: 'bank.unauthenticated' });
  }
  if (!env.AUTO_INVEST_ENABLED) {
    return reply.code(503).send({ error: 'auto-invest is disabled', code: 'bank.auto_invest_disabled' });
  }
  try {
    const limit = assertAutoInvestBatchLimit(bodyLimit(req.body));
    return await withSpan('bank.job.runAutoInvest', async () => bank.autoInvest.runDue({ limit }));
  } catch (err) {
    return sendBankJobRefuse(reply, err);
  }
});

/**
 * The banking partner's side of a cash-out (BK-xfer-08, BK-xfer-09, J-bank-03 #4/#5): it verifies a linked account, and
 * says a payout was paid, failed or came back. Signed job doors, never a customer or a staff session: with no partner
 * wired, every one refuses `rail.bank` and no cash-out is ever processing. The re-drive door (also a recovery-timer job)
 * picks up a cash-out left before its hold or the partner's acceptance.
 */
function jobDoor<T>(path: string, body: z.ZodType<T>, run: (input: T) => Promise<unknown>) {
  app.post(path, async (req, reply) => {
    if (!requireService(req)) return reply.code(401).send({ error: 'service credentials required', code: 'bank.unauthenticated' });
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'body not in shape', code: 'bank.validation_failed' });
    try {
      return await withSpan(`bank.job.${path.split('/').pop()}`, async () => run(parsed.data));
    } catch (err) {
      return sendBankJobRefuse(reply, err);
    }
  });
}
jobDoor('/internal/jobs/payout-sim/verify', payoutVerifyBody, (b) => bank.cashOut.verifyAccount(b.accountId));
jobDoor('/internal/jobs/payout-sim/paid', payoutPaidBody, (b) => bank.cashOut.complete(b.cashOutId));
jobDoor('/internal/jobs/payout-sim/failed', payoutFailedBody, (b) => bank.cashOut.fail(b.cashOutId, b.reason));
jobDoor('/internal/jobs/payout-sim/returned', payoutReturnedBody, (b) =>
  bank.cashOut.returned(b.cashOutId, { amount: b.amount, assetId: b.assetId, reason: b.reason }),
);
jobDoor('/internal/jobs/redrive-cash-outs', redriveBody, async (b) => recoveryCounts(await bank.cashOut.redrive(b.limit)));

/**
 * The direct debit scheme's side (BK-xfer-11): a creditor sets up a mandate and presents a collection. Signed job doors,
 * never a customer or a staff session: with no scheme wired they refuse `rail.bank`, and on the stack only the TEST
 * stand-in (`dd-sim`) answers. The collection run is the third door: it collects, fails or rejects every due collection.
 */
jobDoor('/internal/jobs/dd-sim/mandate', ddSimMandateBody, (b) => bank.directDebits.setUpMandate(b));
jobDoor('/internal/jobs/dd-sim/collection', ddSimCollectionBody, (b) => bank.directDebits.present(b));

/**
 * Standing-order notices (BK-acct-10): owe a reminder for each order inside its owner's lead time and a failure notice
 * for each refused run, then publish what is owed. A signed job door like the runner, called by the same scheduler;
 * a pass that runs twice tells nobody twice.
 */
jobDoor('/internal/jobs/run-scheduled-notices', scheduledNoticesBody, (b) => bank.scheduledNotices.run({ limit: b.limit }));
/**
 * Income sorter sweep (BK-pots-03): sort posted payments that reached an account with a live sorter but were never
 * sorted (the send crashed after its post), then drive every split whose outcome was unknown. Same keys as the send's
 * own sort, so a pass that runs twice moves nothing twice.
 */
jobDoor('/internal/jobs/run-income-sorter', incomeSorterBody, (b) => bank.sorter.sweep(b.limit));
app.post('/internal/jobs/run-due-direct-debits', async (req, reply) => {
  if (!requireService(req)) return reply.code(401).send({ error: 'service credentials required', code: 'bank.unauthenticated' });
  if (!env.BANK_DD_COLLECTIONS_ENABLED) {
    return reply.code(503).send({ error: 'the direct debit collection run is stopped', code: 'bank.dd_collections_disabled' });
  }
  const body = ddRunBody.safeParse(req.body ?? {});
  if (!body.success) return reply.code(400).send({ error: 'body not in shape', code: 'bank.validation_failed' });
  try {
    return await withSpan('bank.job.runDueDirectDebits', async () => bank.directDebits.runDue({ limit: body.data.limit }));
  } catch (err) {
    return sendBankJobRefuse(reply, err);
  }
});

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    // The edge terminates auth and forwards the resolved principal; this
    // service never parses a token itself (§4.1 owns that). It does verify the
    // edge's signature over that principal — see packages/contracts/src/edge.ts
    // for why an unsigned header makes every scope check decorative.
    createContext: ({ req }) => {
      const ctx = edgeContext(req);
      const { service } = verifyServiceRequest(req, {
        verifier: doorS2s?.verifier,
        mode: doorS2s?.mode,
        legacySecret: env.INTERNAL_SERVICE_SECRET,
        bodyBindMode: env.INTERNAL_SERVICE_BODY_BIND,
      });
      return { ...ctx, service };
    },
  } satisfies FastifyTRPCPluginOptions<BankRouter>['trpcOptions'],
});

/**
 * Lost ledger acknowledgements stay pending until these three jobs run.
 * The other money jobs stay operator endpoints. This timer is the caller.
 * Its lock client is a single connection, not a slot on the request pool:
 * the job bodies take their own loan locks on `sql`.
 */
const recoveryEnabled = env.BANK_RECOVERY_JOBS_INTERVAL_MS != null && env.BANK_RECOVERY_JOBS_BATCH_LIMIT != null;
const recoveryLock = recoveryEnabled
  ? postgres(env.DATABASE_URL, {
      max: 1,
      ssl: env.DATABASE_SSL ? 'require' : false,
      connection: { application_name: `${env.SERVICE_NAME}-recovery` },
      onnotice: () => undefined,
    })
  : undefined;
const recoveryJobs = startBankRecoveryJobs({
  config: { intervalMs: env.BANK_RECOVERY_JOBS_INTERVAL_MS, batchLimit: env.BANK_RECOVERY_JOBS_BATCH_LIMIT },
  lock: recoveryLock,
  loans: bank.loans,
  earn: bank.earn,
  transferNotices: { announceUnannounced: (limit) => bank.personalPay.announceUnannounced(limit) },
  cashOuts: bank.cashOut,
  onWarn: (message) => app.log.warn(message),
  onError: (name, err) => app.log.error({ err, job: name }, 'bank recovery job tick failed'),
  onResult: (name, counts) =>
    app.log.info({ job: name, scanned: counts.scanned, resolved: counts.resolved, stillUnknown: counts.stillUnknown }, 'bank recovery job'),
  onSkip: (message) => app.log.info(message),
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
if (!env.IDENTITY_URL) {
  app.log.warn(
    'IDENTITY_URL is unset: svc-bank cannot check whether a recipient is frozen or closed, so every payment to ANOTHER user refuses (bank.recipient_check_unset). Moves between your own spaces still work.',
  );
}
if (env.BANK_STEP_UP_MONEY_OUT === 'required' && !env.IDENTITY_URL) {
  app.log.warn(
    'BANK_STEP_UP_MONEY_OUT=required but IDENTITY_URL is unset: svc-bank cannot confirm step-up approvals, so every send to another person, business payment and card unfreeze/issue refuses (bank.step_up_unavailable).',
  );
}
app.log.info(
  {
    port: env.HTTP_PORT,
    scheduledTransfers: env.SCHEDULED_TRANSFERS_ENABLED,
    interestAccrual: env.INTEREST_ACCRUAL_ENABLED,
    autoInvest: env.AUTO_INVEST_ENABLED,
    stepUpMoneyOut: env.BANK_STEP_UP_MONEY_OUT,
    // In the boot line, not only on `/ready`: the first place anyone looks after
    // a deploy is the log, and "this deployment is running a card SIMULATOR" is
    // exactly the fact that must not be discovered later from a support ticket.
    cardProgramme: cardProgramme.id,
    cardProgrammeSimulated: cardProgramme.simulated,
    rampProgramme: rampProgramme.id,
    rampProgrammeSimulated: rampProgramme.simulated,
    rampFiatLeg: rampProgramme.fiatLeg,
    rampFiatVia: rampProgramme.fiatVia,
    recoveryJobs: recoveryJobs.list().length > 0,
  },
  'svc-bank ready',
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      recoveryJobs.stop();
      await app.close();
      await bus.close();
      if (recoveryLock) await recoveryLock.end({ timeout: 5 });
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
