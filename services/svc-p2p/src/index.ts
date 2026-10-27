import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { buildEdgeContext } from './edge-context.js';
import { JetStreamEventBus } from '@intafaced/events';
import { env } from './env.js';
import { s2sFromEnv } from '@intafaced/contracts';
import { installP2pS2sRawBody, p2pInternalServiceOf } from './s2s-auth.js';
import { registerClosureCheck } from './closure/closure-check.js';
import {
  P2pService,
  publishedDisputeEscalationRecheckSeconds,
  publishedDisputeSlaSeconds,
  publishedEscrowDeadlineSeconds,
  publishedInstrumentRetentionDays,
  publishedPaymentDeadlineSeconds,
  publishedReleaseDeadlineSeconds,
  publishedSweepIntervalSeconds,
} from './p2p-service.js';
import { InstrumentService } from './instrument-service.js';
import { describeLimits, limitsConfigured, offerLimitsFromEnv, offerLimitsPosture } from './merchant-limits.js';
import { createLedgerClient } from './ledger-client.js';
import { createAffiliateAccrueClient } from './affiliate-accrue.js';
import { createAffiliatePayoutClient } from './affiliate-payout.js';
import type { MerchantStatus } from './merchant-programme.js';
import { programmeVouch, reputationOnPublicDoor } from './merchant-programme.js';
import { MerchantService } from './merchant-service.js';
import { createIdentityApprovalClient, unwiredApprovalConsumer } from './action-approval-consume.js';
import { createTakeStepUp } from './take-step-up.js';
import { createReleaseStepUp } from './release-step-up.js';
import { createInstrumentStepUp } from './instrument-step-up.js';
import { createIdentityHolderNameRule } from './holder-name.js';
import { createIdentityPublicProfile } from './public-profile.js';
import { OpsReads } from './ops/ops-reads.js';
import { createP2pRouter, type P2pRouter } from './router.js';
import { BlockRfqService } from './block-rfq.js';
import { SqlBlockQuoteStore } from './block-rfq-store.js';
import { isModerationConfigured, parseModeratorUserIds } from './moderation-auth.js';
import { moderationOnPublicDoor } from './moderation-honesty.js';
import { P2pErasure } from './erasure.js';
import { assertNoLocalTestFixtures } from '@intafaced/config';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { instrumentKeyHealth } from './instrument-key-provider.js';
import { parseVerificationLimits } from './verification-limits.js';
import { parseActiveOrderCap, parseBuyerCancelLimit, parsePairLimits } from './take-limits.js';
import { parseReminderPolicy } from './seller-reminders.js';
import { parseToleranceBps } from './amount-mismatch.js';
import { parseAdContentRules } from './ad-content-rules.js';
import { parsePostingThresholds } from './posting-eligibility.js';
import { AdvertiserTermsAcceptances, advertiserTermsVersion, createAdvertiserTerms } from './advertiser-terms.js';
import { createLocalTestKeyProvider } from './local-test-kms.js';
import { createIdentityContactReader, createTakeGate, unwiredContactReader } from './take-eligibility.js';

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

// Local-test stand-ins refuse unless APP_ENV is exactly dev/test. Unset is not dev.
assertNoLocalTestFixtures(process.env);

/**
 * svc-p2p — peer-to-peer trading with escrow (§6.2).
 *
 * Two things start here that are not optional, and both are the same promise
 * from different ends:
 *
 *   · the TIMEOUT sweep, which acts on any trade whose deadline has passed
 *     (re-drive / refund / open dispute / escalate-and-rearm — never auto-rule
 *     a disputed release; that holds until a human moderator decides);
 *   · the SETTLEMENT sweep, which posts any resolution that was decided but
 *     not yet acted on (decide-then-post; late is OK, unexecuted is not).
 *
 * Together they keep funds from stranding without a path: every non-disputed
 * live clock eventually disposes or re-drives; every committed decision is
 * re-posted until stamped. Disputed escrow is held on purpose until a natural
 * person rules. If this process does not run the sweeps, the other states can
 * strand — so they are started before the HTTP listener, not after.
 */

const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  connection: { search_path: 'p2p,public', application_name: env.SERVICE_NAME },
  onnotice: () => undefined,
});

await sql`SELECT 1 FROM p2p.p2p_trades LIMIT 1`.catch(() => {
  throw new Error('p2p schema is missing — run migrations before starting svc-p2p');
});
await sql`SELECT 1 FROM p2p.block_quotes LIMIT 1`.catch(() => {
  throw new Error('p2p.block_quotes is missing — run migrations before starting svc-p2p');
});

const bus = await JetStreamEventBus.connect({
  servers: env.NATS_URL,
  producer: env.SERVICE_NAME,
  streamPrefix: env.NATS_STREAM_PREFIX,
  ownedStreams: ['p2p'],
});

// Escrowed value lives in svc-ledger's `escrow` accounts, never in this
// service's tables (Doctrine §0.6). This client is the only path.
// Per-service keys (S2S v3): unset S2S_AUTH_MODE leaves the ledger call on the shared secret alone.
const s2s = s2sFromEnv(env, 'svc-p2p');
const s2sKey = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;
const ledger = createLedgerClient(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET, { s2s: s2sKey });
// The same switch for the inbound internal doors: unset keeps them on the shared secret alone.
const doorS2s = s2s.serviceVerifier && s2s.s2sMode ? { verifier: s2s.serviceVerifier, mode: s2s.s2sMode } : undefined;

// Where the buyer is told to send the fiat, and the record of who ever looked.
// Constructed before P2pService because a P2pService without one would lock
// escrow against a payment nobody could make.
// A set local-test flag that misses a check throws here and the process exits.
// Unset returns null: no provider, no key file, no log line.
const instrumentKeyProvider = createLocalTestKeyProvider(process.env);
const instrumentKey = instrumentKeyHealth(instrumentKeyProvider?.kind);

const instruments = new InstrumentService(sql, {
  retentionDays: publishedInstrumentRetentionDays(env.P2P_INSTRUMENT_RETENTION_DAYS),
  keyProvider: instrumentKeyProvider,
  // P-ads-merchant-18: a destination with an account-holder field is in the person's verified legal name, or refused.
  ...(env.IDENTITY_URL ? { holderNames: createIdentityHolderNameRule(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, s2sKey) } : {}),
});

/**
 * Offer ceilings by merchant standing (TRK-p2p.merchants Stage 2).
 *
 * Unset still refuses nothing (pre-Stage-2 behaviour). The literal `unlimited`
 * is owner confirmation of that choice. Numbers are open product law and are
 * not invented here. `limitPosture` below says which of unset / unlimited /
 * configured this deployment is in, rather than leaving a client to infer it
 * from an offer that did or did not refuse.
 */
const offerLimits = offerLimitsFromEnv(env);
const limitPosture = describeLimits(offerLimits);

const p2p: P2pService = new P2pService(sql, ledger, bus, {
  instruments,
  feeBps: env.P2P_FEE_BPS,
  tradingEnabled: env.P2P_TRADING_ENABLED,
  offerLimits,
  appealReviewHours: env.P2P_APPEAL_REVIEW_HOURS,
  reviewEditWindowSeconds: env.P2P_REVIEW_EDIT_WINDOW_SECONDS,
  exportPolicy: {
    maxRangeDays: env.P2P_EXPORT_MAX_RANGE_DAYS,
    maxRows: env.P2P_EXPORT_MAX_ROWS,
    receiptDailyQuota: env.P2P_RECEIPT_DAILY_QUOTA,
    receiptPerTradeQuota: env.P2P_RECEIPT_PER_TRADE_QUOTA,
  },
  /**
   * Resolved per call, not at construction. `merchants` is built FROM `p2p`
   * below, so the two cannot both exist at the same instant; this closure only
   * runs when an offer is created, by which point both do.
   *
   * Reading standing fresh each time is required anyway: a suspension has to
   * take the higher ceiling away from the very next offer, not from the next
   * time this process boots.
   */
  merchantStatusOf: async (userId: string): Promise<MerchantStatus | null> => (await merchants.get(userId))?.status ?? null,
  affiliateAccrue: env.IDENTITY_URL ? createAffiliateAccrueClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, s2sKey) : undefined,
  affiliatePayout: env.IDENTITY_URL ? createAffiliatePayoutClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, s2sKey) : undefined,
  verificationLimits: parseVerificationLimits(env.P2P_VERIFICATION_LIMITS),
  securityChangeLockSeconds: env.P2P_SECURITY_CHANGE_LOCK_SECONDS,
  takeLimits: {
    activeOrderCap: parseActiveOrderCap(env.P2P_ACTIVE_ORDER_CAP),
    pairLimits: parsePairLimits(env.P2P_PAIR_LIMITS),
    buyerCancels: parseBuyerCancelLimit(env.P2P_BUYER_CANCEL_LIMIT, env.P2P_BUYER_CANCEL_WINDOW_HOURS),
  },
  reminders: parseReminderPolicy(env.P2P_REMIND_WAIT_SECONDS, env.P2P_REMIND_MAX),
  mismatchToleranceBps: parseToleranceBps(env.P2P_MISMATCH_TOLERANCE_BPS),
  // P-ads-merchant-01: every new ad needs the published advertiser terms accepted (blank refuses every post), and a
  // sell ad's total is checked against the maker's free balance. Nothing is reserved at post.
  advertiserTerms: createAdvertiserTerms({
    acceptances: new AdvertiserTermsAcceptances(sql),
    version: advertiserTermsVersion(env.P2P_ADVERTISER_TERMS_VERSION),
  }),
  sellBalanceAtPost: true,
  adContentRules: parseAdContentRules(env.P2P_AD_CONTENT_RULES),
  postingThresholds: parsePostingThresholds(env.P2P_POSTING_THRESHOLDS),
  deadlines: {
    escrowSeconds: publishedEscrowDeadlineSeconds(env.P2P_ESCROW_DEADLINE_SECONDS),
    paymentSeconds: publishedPaymentDeadlineSeconds(env.P2P_PAYMENT_DEADLINE_SECONDS),
    releaseSeconds: publishedReleaseDeadlineSeconds(env.P2P_RELEASE_DEADLINE_SECONDS),
    disputeSeconds: publishedDisputeSlaSeconds(env.P2P_DISPUTE_SLA_SECONDS),
    escalationRecheckSeconds: publishedDisputeEscalationRecheckSeconds(env.P2P_DISPUTE_ESCALATION_RECHECK_SECONDS),
  },
  // No reference price source yet: floating offers are refused rather than
  // priced from a stale number. svc-trade owns pricing (§5.2) and supplies this
  // when its mark-price surface lands.
});

// §0.9. Stage 1: self-only, refuses while any escrow is live, and names what
// it retained and why. Nothing else in the platform calls it yet — svc-p2p
// subscribes to no events, so there is no account-deletion signal to hear.
const erasure = new P2pErasure(sql);

const moderatorUserIds = parseModeratorUserIds(env.P2P_MODERATOR_USER_IDS);

/**
 * The merchant programme (TRK-p2p.merchants Stage 1).
 *
 * Membership only — badges and limit enforcement are Stage 2 and read this
 * table. Nothing here holds a balance: escrow still moves every coin through
 * ledger recipes, for merchants exactly as for anyone else (§0.6).
 */
const merchants: MerchantService = new MerchantService(sql, p2p);

const blockRfq = new BlockRfqService(new SqlBlockQuoteStore(sql), {
  isTradingEnabled: () => p2p.isTradingEnabled(),
});

// P-trade-orders-02: contact is read from identity as the person of the request. Without IDENTITY_URL contact is
// unknown and every take refuses. No risk notice gates a take (owner decision 2026-10-27, until launch prep).
const takeGate = createTakeGate({
  contact: env.IDENTITY_URL ? createIdentityContactReader({ identityUrl: env.IDENTITY_URL }) : unwiredContactReader(),
});

const actionApprovals = env.IDENTITY_URL
  ? createIdentityApprovalClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET)
  : unwiredApprovalConsumer();

// P-trade-orders-07: a take is confirmed with identity's single-use same-person approval; without IDENTITY_URL
// no confirmation can be spent and every take refuses.
const takeStepUp = createTakeStepUp({ sql, approvals: actionApprovals });
// P-trade-orders-07 and -16: a release is confirmed the same way; one confirmation covers that session's releases for ten minutes.
const releaseStepUp = createReleaseStepUp({ sql, approvals: actionApprovals });
const instrumentStepUp = createInstrumentStepUp({ sql, approvals: actionApprovals });

export const appRouter = createP2pRouter(
  p2p,
  instruments,
  erasure,
  {
    moderatorUserIds,
    offerLimits,
    blockRfq,
    approvals: actionApprovals,
    instrumentKeyProvider: instrumentKey.instrumentKeyProvider,
    opsReads: new OpsReads(sql),
    disputeResolveRequiresApproval: env.P2P_DISPUTE_RESOLVE_REQUIRES_APPROVAL,
    takeGate,
    takeStepUp,
    releaseStepUp,
    instrumentStepUp,
    // The other side of an order by their handle; without IDENTITY_URL reputation.get says the profile is unwired.
    ...(env.IDENTITY_URL ? { publicProfile: createIdentityPublicProfile(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, s2sKey) } : {}),
  },
  merchants,
);
export type AppRouter = typeof appRouter;

// Built before the listener opens: a service that cannot authenticate the edge
// must fail to start, not start and serve every request as anonymous.
const edgeContext = buildEdgeContext(env);

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });
installP2pS2sRawBody(app);
registerClosureCheck(app, { sql, secret: env.INTERNAL_SERVICE_SECRET, s2s: doorS2s });

const moderationPublic = moderationOnPublicDoor(isModerationConfigured(moderatorUserIds));

app.get('/health', async () => ({
  ok: true,
  service: env.SERVICE_NAME,
  ...moderationPublic,
  /** False until env ceilings arm Stage 2 — badge must not imply a higher limit when none is set. */
  offerLimitsConfigured: limitsConfigured(offerLimits),
  offerLimitsPosture: offerLimitsPosture(offerLimits),
  /** False until OWNER KMS is wired. A local-test seal is not that KMS. */
  ...instrumentKey,
}));
app.get('/ready', async () => ({
  ready: true,
  tradingEnabled: env.P2P_TRADING_ENABLED,
  ...moderationPublic,
  offerLimitsConfigured: limitsConfigured(offerLimits),
  offerLimitsPosture: offerLimitsPosture(offerLimits),
  ...instrumentKey,
}));

/**
 * Doctrine §0.6, as an endpoint. Compares this service's view of what is in
 * escrow against the ledger's, per trade. Drift here is an operator
 * alarm, not a metric — it means a trade's terms and its value disagree.
 */
app.get('/internal/escrow-integrity', async (req, reply) => {
  if (p2pInternalServiceOf(req, env.INTERNAL_SERVICE_SECRET, env.INTERNAL_SERVICE_BODY_BIND, doorS2s) === null) {
    return reply.code(401).send({ error: 'service credentials required', code: 'p2p.unauthenticated' });
  }
  const result = await p2p.escrowIntegrity();
  if (!result.ok) reply.status(500);
  return result;
});

/**
 * THE MODERATION BACKLOG, as an endpoint.
 *
 * Nothing disposes of a dispute on a timer any more, so this number is real: it
 * grows when nobody is working the queue and it does not quietly drain into
 * refunds. `neverSeen` is the sharp one — disputes no moderator has ever been
 * served, which is what "the moderation path is unreachable" actually looks
 * like from the outside.
 */
app.get('/internal/moderation-backlog', async (req, reply) => {
  if (p2pInternalServiceOf(req, env.INTERNAL_SERVICE_SECRET, env.INTERNAL_SERVICE_BODY_BIND, doorS2s) === null) {
    return reply.code(401).send({ error: 'service credentials required', code: 'p2p.unauthenticated' });
  }
  return p2p.moderationBacklog();
});

app.get<{ Params: { userId: string } }>('/internal/reputation/:userId', async (req, reply) => {
  if (p2pInternalServiceOf(req, env.INTERNAL_SERVICE_SECRET, env.INTERNAL_SERVICE_BODY_BIND, doorS2s) === null) {
    return reply.code(401).send({ error: 'service credentials required', code: 'p2p.unauthenticated' });
  }
  const snapshot = await p2p.reputationOf(req.params.userId);
  const record = await merchants.get(req.params.userId);
  // Same door tRPC reputation.get uses: derived badges + freeze, never a
  // second scorecard and never an invented p2pLimitMultiplier.
  return reputationOnPublicDoor(snapshot, programmeVouch(record?.status, true));
});

// ── The sweeps ───────────────────────────────────────────────────────────────

let sweeping = false;

async function sweep(): Promise<void> {
  // Never overlap: two concurrent sweeps would contend on the same row locks
  // and turn a slow ledger into a lock storm.
  if (sweeping) return;
  sweeping = true;
  try {
    const settled = await p2p.sweepSettlements(100);
    const swept = await p2p.sweepDeadlines(undefined, 100);
    // Buyer-paid notices the fast path did not hand over (a crash after commit, the bus down). Its own catch: a
    // notice that cannot be read must not cost the settlement and timeout lines below their log, or the purge its run.
    const notices = await p2p.sweepFiatSentNotices(100).catch((err: unknown) => {
      app.log.error({ err, sweep: 'fiat_sent_notice' }, 'p2p buyer-paid notice sweep failed — sellers may not be told yet');
      return { sent: 0, failures: [] };
    });
    // Seller reminders the fast path did not hand over, on their own catch for the same reason.
    const reminders = await p2p.sweepReminders(100).catch((err: unknown) => {
      app.log.error({ err, sweep: 'trade_reminder' }, 'p2p seller reminder sweep failed — sellers may not be told yet');
      return { sent: 0, failures: [] };
    });
    // Ad-paused notices (a removed payment method) the fast path did not hand over, on their own catch likewise.
    const pauses = await p2p.sweepOfferPauses(100).catch((err: unknown) => {
      app.log.error({ err, sweep: 'offer_paused' }, 'p2p ad-paused notice sweep failed — makers may not be told yet');
      return { sent: 0, failures: [] };
    });
    // Remark-case notices (a reported payment note) the fast path did not hand over, on their own catch likewise.
    const remarks = await p2p.sweepRemarkCases(100).catch((err: unknown) => {
      app.log.error({ err, sweep: 'remark_case' }, 'p2p remark-case notice sweep failed — reported parties may not be told yet');
      return { sent: 0, failures: [] };
    });

    // Data retention, on the same tick. It runs last on purpose: it only ever
    // touches trades that are already terminal, so it can never take work away
    // from the two sweeps that keep escrow moving.
    const purged = await instruments.purgeExpiredSnapshots(500);
    if (purged.purged > 0) {
      app.log.info({ purged: purged.purged }, 'p2p purged payment details from closed trades past the retention window');
    }

    // EVERY FAILURE, WITH ITS REASON, ONE LINE EACH. The sweep used to return
    // a count and discard the error object, so "2 failed" was the whole story
    // an operator got — and the two failures could have been a transient
    // ledger timeout or a guard refusing something that will never succeed on
    // its own. Those need different people out of bed.
    for (const f of settled.failures) {
      app.log.error({ ...f, sweep: 'settlement' }, 'p2p settlement failed — a decision is committed and the value is late');
    }
    for (const f of notices.failures) {
      app.log.error(
        { ...f, sweep: 'fiat_sent_notice' },
        'p2p buyer-paid notice could not be handed to the bus — the seller is not told yet',
      );
    }
    for (const f of reminders.failures) {
      app.log.error({ ...f, sweep: 'trade_reminder' }, 'p2p seller reminder could not be handed to the bus — the seller is not told yet');
    }
    for (const f of pauses.failures) {
      app.log.error({ ...f, sweep: 'offer_paused' }, 'p2p ad-paused notice could not be handed to the bus — the maker is not told yet');
    }
    for (const f of remarks.failures) {
      app.log.error(
        { ...f, sweep: 'remark_case' },
        'p2p remark-case notice could not be handed to the bus — the reported party is not told yet',
      );
    }
    for (const f of swept.failures) {
      app.log.error({ ...f, sweep: 'timeout' }, 'p2p timeout sweep could not act on a trade');
    }
    if (swept.escalated > 0) {
      // NOT a retryable failure. These are disputes past their moderator SLA
      // that nobody has ruled on, and the only thing that clears them is a
      // person. Logged every tick on purpose: an alarm that stops sounding
      // because the condition persisted is the alarm that let the old backstop
      // refund seven days of escrow with nobody watching.
      const backlog = await p2p.moderationBacklog();
      app.log.warn({ escalated: swept.escalated, backlog }, 'p2p disputes past the moderator SLA — escrow held, awaiting a human ruling');
    }
  } catch (err) {
    // Never let a sweep failure kill the interval. The one thing worse than a
    // failing sweep is a sweep that stopped running.
    app.log.error({ err }, 'p2p sweep failed');
  } finally {
    sweeping = false;
  }
}

const sweepTimer = setInterval(() => void sweep(), publishedSweepIntervalSeconds(env.P2P_SWEEP_INTERVAL_SECONDS) * 1000);
sweepTimer.unref();
await sweep();

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    // The edge terminates auth and forwards the resolved principal; this
    // service never parses a token itself (§4.1 owns that). It does verify the
    // edge's signature over that principal — see packages/contracts/src/edge.ts
    // for why an unsigned header makes every scope check decorative.
    createContext: ({ req }) => edgeContext(req),
  } satisfies FastifyTRPCPluginOptions<P2pRouter>['trpcOptions'],
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info({ port: env.HTTP_PORT, tradingEnabled: env.P2P_TRADING_ENABLED, feeBps: env.P2P_FEE_BPS }, 'svc-p2p ready');

// Said out loud at boot, at `warn` when nothing is configured. A deployment
// where the merchant badge buys nothing is a legitimate posture — it is the
// default — but it must not be one an operator has to discover by watching an
// offer fail to refuse.
app.log[limitPosture.level]({ offerLimits: limitPosture.summary }, limitPosture.summary);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      clearInterval(sweepTimer);
      await app.close();
      await bus.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
