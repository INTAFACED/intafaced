import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { edgeTrustFromEnv } from '@intafaced/config';
import { createEdgeContext, s2sFromEnv } from '@intafaced/contracts';
import { JetStreamEventBus } from '@intafaced/events';
import { parseAmount } from '@intafaced/ledger-client';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { CampaignService, parseTimeZone } from './campaigns.js';
import { createCompetitionFillSource } from './competition-fills.js';
import { CompetitionService } from './competitions.js';
import { DrawService } from './draws.js';
import { DistributionService } from './distributions.js';
import { PoolService } from './pools.js';
import { createEquitySource } from './venue-equity.js';
import { TrialPassService, createTierPassDoor } from './trial-passes.js';
import { parseRuleLimit } from './rules.js';
import { createLedgerClient } from './ledger-client.js';
import { createMarketNames } from './markets.js';
import { ReferralService } from './referrals.js';
import { createParticipantClient } from './participants.js';
import { PayoutSaga } from './payouts.js';
import { RewardPayer, rewardsPaidToWallet } from './reward-payer.js';
import { ledgerPostingEnabled, testRewardChain } from './test-chain.js';
import { TaskService } from './tasks.js';
import { createVenueDepositSource } from './venue-deposits.js';
import { VoucherService } from './vouchers.js';
import { WatchService } from './watch.js';
import { DropService } from './drops.js';
import { env } from './env.js';
import { createCampaignsRouter, type CampaignsRouter } from './router.js';
import { parseTgeSchedule } from './tge.js';

registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-campaigns: campaigns and joining them, task campaigns and their rewards, seasons, limited drops and the TGE claim.
 * Holds no balance. Value moves only in the reward saga (`payouts.ts`: `rewardPay` and `sweepFeesToRewards`). A blank CAMPAIGNS_TGE_SCHEDULE_JSON boots and refuses every TGE claim `launch.schedule_unset`; a blank
 * CAMPAIGNS_PLATFORM_TIME_ZONE boots and refuses every activation and join `campaigns.timezone_unset`.
 */
const tgeSchedule = parseTgeSchedule(env.CAMPAIGNS_TGE_SCHEDULE_JSON);
const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  onnotice: () => undefined,
});
const drops = new DropService({ sql, tgeSchedule: () => tgeSchedule });
const timeZone = parseTimeZone(env.CAMPAIGNS_PLATFORM_TIME_ZONE);
const s2s = s2sFromEnv(env, 'svc-campaigns');
const s2sKey = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;
const participantsWired = Boolean(env.IDENTITY_URL && env.INTERNAL_SERVICE_SECRET);
const participants = participantsWired
  ? createParticipantClient(env.IDENTITY_URL!, env.INTERNAL_SERVICE_SECRET!, s2sKey)
  : { read: async () => null };
const ruleLimits = {
  depth: parseRuleLimit('CAMPAIGNS_RULE_DEPTH_LIMIT', env.CAMPAIGNS_RULE_DEPTH_LIMIT),
  size: parseRuleLimit('CAMPAIGNS_RULE_SIZE_LIMIT', env.CAMPAIGNS_RULE_SIZE_LIMIT),
};
const campaigns = new CampaignService({ sql, timeZone: () => timeZone, participants, ruleLimits: () => ruleLimits });
const ledger =
  env.LEDGER_URL && env.INTERNAL_SERVICE_SECRET ? createLedgerClient(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET, s2sKey) : null;
const reconcileAfterSeconds = env.CAMPAIGNS_RECONCILE_AFTER_SECONDS ?? null;
const ceilingOf = (raw: string | undefined) => (raw === undefined ? null : parseAmount(raw));
// The owner's reward ceiling (OWNER 288). Blank stays blank: every Owe refuses `ledger.reward_ceiling_unset`.
const rewardCeiling = {
  perCampaign: ceilingOf(env.CAMPAIGNS_REWARD_CEILING_PER_CAMPAIGN),
  total: ceilingOf(env.CAMPAIGNS_REWARD_CEILING_TOTAL),
};
const saga = ledger ? new PayoutSaga({ sql, ledger, reconcileAfterSeconds, rewardCeiling }) : null;
const markets = env.TRADE_URL ? createMarketNames({ tradeUrl: env.TRADE_URL }) : null;
// The welcome deposit task's reads (J-campaigns-04 #2): the person's connected wallets and the venue's deposits.
const venueDeposits =
  env.PROTOCOL_URL && env.TRADE_URL && env.INTERNAL_SERVICE_SECRET
    ? createVenueDepositSource({
        protocolUrl: env.PROTOCOL_URL,
        tradeUrl: env.TRADE_URL,
        internalSecret: env.INTERNAL_SERVICE_SECRET,
        ...(s2sKey ? { s2s: s2sKey } : {}),
      })
    : null;
const tasks = new TaskService({
  venueDeposits,
  // What we have paid each wallet as rewards (J-campaigns-04 #3): a deposit counts only above it.
  rewardsPaidTo: rewardsPaidToWallet(sql),
  sql,
  participants,
  saga,
  markets,
  timeZone: () => timeZone,
  rollbackWindowSeconds: env.CAMPAIGNS_ROLLBACK_WINDOW_SECONDS ?? null,
});
/** Referral programmes (CM-referral-02): each invitee once, and their own events that count towards qualifying. */
const referrals = new ReferralService({ sql, markets });

const attemptLimits =
  env.CAMPAIGNS_VOUCHER_ATTEMPTS_PER_ACCOUNT && env.CAMPAIGNS_VOUCHER_ATTEMPTS_PER_ADDRESS && env.CAMPAIGNS_VOUCHER_ATTEMPT_WINDOW_SECONDS
    ? {
        perAccount: env.CAMPAIGNS_VOUCHER_ATTEMPTS_PER_ACCOUNT,
        perAddress: env.CAMPAIGNS_VOUCHER_ATTEMPTS_PER_ADDRESS,
        windowSeconds: env.CAMPAIGNS_VOUCHER_ATTEMPT_WINDOW_SECONDS,
      }
    : null;
const vouchers = new VoucherService({
  sql,
  participants,
  campaigns,
  saga,
  attemptLimits: () => attemptLimits,
  payTo: (accountId, forwarded) => tasks.recordPayTo(accountId, forwarded),
});

// The watch desk's owner values (J-campaigns-17); each blank refuses what needs it, never a default.
const watchLimits = {
  codeBatchMax: env.CAMPAIGNS_CODE_BATCH_MAX ?? null,
  exportLinkSeconds: env.CAMPAIGNS_EXPORT_LINK_SECONDS ?? null,
  alerts: {
    budget_low: env.CAMPAIGNS_ALERT_BUDGET_LEFT_PERCENT ?? null,
    redemptions_spike: env.CAMPAIGNS_ALERT_REDEMPTIONS_PER_HOUR ?? null,
  },
};
const watch = new WatchService({ sql, campaigns, limits: () => watchLimits });

/**
 * Trading competitions (J-campaigns-11): volume read from svc-trade's read of the venue's own fills (TRADE_URL and
 * INTERNAL_SERVICE_SECRET; unset, every read is unread and nothing settles), prizes owed and paid through the saga and
 * the payer.
 */
const competitions = new CompetitionService({
  sql,
  saga,
  fills:
    env.TRADE_URL && env.INTERNAL_SERVICE_SECRET
      ? createCompetitionFillSource({
          tradeUrl: env.TRADE_URL,
          internalSecret: env.INTERNAL_SERVICE_SECRET,
          ...(s2sKey ? { s2s: s2sKey } : {}),
        })
      : null,
  wallets: venueDeposits ? (forwarded) => venueDeposits.wallets(forwarded) : null,
  payTo: (accountId, forwarded) => tasks.recordPayTo(accountId, forwarded),
  log: (msg, detail) => app.log.warn({ ...detail }, msg),
});

/**
 * Lucky draws (J-campaigns-12): chances read from the same venue fills (TRADE_URL and INTERNAL_SERVICE_SECRET), capped by
 * the verification level svc-identity reports. Running one waits for the owner's decision and pays nothing.
 */
const draws = new DrawService({
  sql,
  fills:
    env.TRADE_URL && env.INTERNAL_SERVICE_SECRET
      ? createCompetitionFillSource({
          tradeUrl: env.TRADE_URL,
          internalSecret: env.INTERNAL_SERVICE_SECRET,
          ...(s2sKey ? { s2s: s2sKey } : {}),
        })
      : null,
  participants,
  log: (msg, detail) => app.log.warn({ ...detail }, msg),
});

/**
 * Airdrop distributions and reward pools (J-campaigns-13): venue equity and fills read through svc-trade (TRADE_URL and
 * INTERNAL_SERVICE_SECRET; unset, every read is unread and nothing is owed), shares rounded to the paying token's
 * decimals, owed and paid through the saga and the payer.
 */
const tradeReads =
  env.TRADE_URL && env.INTERNAL_SERVICE_SECRET
    ? { tradeUrl: env.TRADE_URL, internalSecret: env.INTERNAL_SERVICE_SECRET, ...(s2sKey ? { s2s: s2sKey } : {}) }
    : null;
const equity = tradeReads ? createEquitySource(tradeReads) : null;
const distributions = new DistributionService({
  sql,
  saga,
  equity,
  payTo: (accountId, forwarded) => tasks.recordPayTo(accountId, forwarded),
  payDecimals: env.CAMPAIGNS_TEST_CHAIN_TOKEN_DECIMALS ?? null,
  log: (msg, detail) => app.log.warn({ ...detail }, msg),
});
const pools = new PoolService({
  sql,
  saga,
  fills: tradeReads ? createCompetitionFillSource(tradeReads) : null,
  equity,
  payTo: (accountId, forwarded) => tasks.recordPayTo(accountId, forwarded),
  payDecimals: env.CAMPAIGNS_TEST_CHAIN_TOKEN_DECIMALS ?? null,
  log: (msg, detail) => app.log.warn({ ...detail }, msg),
});

// VIP trial passes (J-campaigns-14): granted here, held by svc-trade (TRADE_URL and INTERNAL_SERVICE_SECRET; unset, a
// grant refuses `campaigns.trial_pass_unreachable`).
const trialPasses = new TrialPassService({ sql, door: tradeReads ? createTierPassDoor(tradeReads) : null });

const appRouter = createCampaignsRouter(
  drops,
  campaigns,
  tasks,
  vouchers,
  watch,
  referrals,
  competitions,
  draws,
  distributions,
  pools,
  trialPasses,
);
// svc-trade's fee-saver ask (`service.feeSaver`, J-campaigns-09) is a service call: the caller is named by its own key,
// or by the shared secret where keys are not wired.
const edgeContext = createEdgeContext({
  secret: env.EDGE_PRINCIPAL_SECRET,
  ...edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  ...(s2s.serviceVerifier && s2s.s2sMode ? { serviceVerifier: s2s.serviceVerifier, s2sMode: s2s.s2sMode } : {}),
});

let bus: JetStreamEventBus | null = null;
const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));
app.get('/ready', async (_req, reply) => {
  try {
    await sql`SELECT 1`;
    return {
      ok: true,
      service: env.SERVICE_NAME,
      database: 'ok',
      tgeSchedule: tgeSchedule ? 'set' : 'launch.schedule_unset',
      timeZone: timeZone ?? 'campaigns.timezone_unset',
      ruleLimits: ruleLimits.depth && ruleLimits.size ? 'set' : 'campaigns.rule_limits_unset',
      voucherAttempts: attemptLimits ? 'set' : 'campaigns.attempt_limit_unset',
      ledger: saga ? 'set' : 'campaigns.reward_saga_unwired',
      reconciler: saga && reconcileAfterSeconds ? 'set' : 'campaigns.reconcile_unset',
      bus: bus ? 'attached' : 'unreachable',
    };
  } catch {
    return reply.code(503).send({ ok: false, service: env.SERVICE_NAME, database: 'unavailable' });
  }
});

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    // The voucher attempt limit counts per source address: the one svc-edge resolved and forwarded as x-real-ip.
    createContext: ({ req }) => {
      const forwarded = req.headers['x-real-ip'];
      return { ...edgeContext(req), sourceAddress: (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.trim() || null };
    },
  } satisfies FastifyTRPCPluginOptions<CampaignsRouter>['trpcOptions'],
});

/**
 * Task progress reads settled spot fills. svc-campaigns owns no stream: svc-trade creates `trade`'s. A failed connect or
 * attach is logged, not fatal, and tried again: the durable consumer picks the events up from the stream once it attaches.
 */
const BUS_RETRY_MS = 15_000;
let busRetry: NodeJS.Timeout | null = null;
let stopping = false;
async function attachBus(): Promise<void> {
  let connected: JetStreamEventBus | null = null;
  try {
    connected = await JetStreamEventBus.connect({
      servers: env.NATS_URL,
      producer: env.SERVICE_NAME,
      streamPrefix: env.NATS_STREAM_PREFIX,
    });
    await connected.subscribe(
      'fillSettled',
      async (fill) => {
        await tasks.onFill(fill);
      },
      { durable: 'campaigns-task-fill-settled' },
    );
    // Earning rules on crypto deposits (CM-rewards-hub-05): one intent per deposit per rule, keyed by the deposit id.
    await connected.subscribe(
      'payDepositCreditPosted',
      async (deposit) => {
        if (!saga) app.log.warn({ depositId: deposit.depositId }, 'earning skipped: campaigns.reward_saga_unwired');
        await tasks.onEarningEvent({
          trigger: 'pay.deposit_credit.posted',
          eventId: deposit.depositId,
          userId: deposit.userId,
          at: deposit.creditedAt,
          values: { amount: deposit.amount },
          assets: { amount: deposit.assetId },
        });
      },
      { durable: 'campaigns-earn-deposit-credited' },
    );
    bus = connected;
    void attachWelcome(connected);
    void attachCardCashback(connected);
  } catch (err) {
    app.log.error({ err }, 'svc-campaigns could not attach to trade.fill.settled: task progress waits, trying again');
    await connected?.close().catch(() => undefined);
    if (!stopping) {
      busRetry = setTimeout(() => void attachBus(), BUS_RETRY_MS);
      busRetry.unref();
    }
  }
}
/**
 * The welcome checklist (CM-rewards-hub-03): each account's sign-up opens its window, and its first verification and
 * spot fill tick its tasks. Its deposit task is read from the venue, not the bus (J-campaigns-04 #2; tasks.ts
 * `readWelcomeDeposit`): a credit svc-pay posts to an account in our book is not a deposit into the person's venue account. Each event is kept once, by account and kind, so a redelivery is a no-op. These
 * read `identity`'s stream too, so they attach on their own: if that stream is missing they are tried again, and task
 * progress and earning rules above keep running.
 */
let welcomeRetry: NodeJS.Timeout | null = null;
async function attachWelcome(connected: JetStreamEventBus): Promise<void> {
  try {
    await connected.subscribe(
      'userCreated',
      async (user, envelope) => {
        await tasks.onSignUp({ userId: user.userId, eventId: envelope.idempotencyKey, at: envelope.occurredAt });
      },
      { durable: 'campaigns-welcome-user-created' },
    );
    await connected.subscribe(
      'kycApproved',
      async (kyc, envelope) => {
        await tasks.onWelcomeEvent({
          userId: kyc.userId,
          event: 'identity.verified',
          eventId: envelope.idempotencyKey,
          at: envelope.occurredAt,
        });
      },
      { durable: 'campaigns-welcome-kyc-approved' },
    );
    await connected.subscribe(
      'fillSettled',
      async (fill) => {
        await tasks.onWelcomeEvent({ userId: fill.userId, event: 'trade.fill', eventId: fill.fillId, at: fill.ts });
      },
      { durable: 'campaigns-welcome-fill-settled' },
    );
    // Referral progress (CM-referral-02): each invitee once from their attach, then their own verify, deposit and fills,
    // each kept once by its event id. Each has its own durable consumer, so one that fails is tried again on its own.
    await connected.subscribe(
      'referralCreated',
      async (edge) => {
        await referrals.onAttached(edge);
      },
      { durable: 'campaigns-referral-attached' },
    );
    await connected.subscribe(
      'kycApproved',
      async (kyc, envelope) => {
        await referrals.onVerified({ userId: kyc.userId, tier: kyc.tier, eventId: envelope.idempotencyKey, at: envelope.occurredAt });
      },
      { durable: 'campaigns-referral-kyc-approved' },
    );
    await connected.subscribe(
      'payDepositCreditPosted',
      async (deposit) => {
        await referrals.onDeposit({
          userId: deposit.userId,
          depositId: deposit.depositId,
          asset: deposit.assetId,
          amount: deposit.amount,
          at: deposit.creditedAt,
        });
      },
      { durable: 'campaigns-referral-deposit-credited' },
    );
    await connected.subscribe(
      'fillSettled',
      async (fill) => {
        await referrals.onFill({
          userId: fill.userId,
          fillId: fill.fillId,
          marketId: fill.marketId,
          quoteAmount: fill.quoteAmount,
          at: fill.ts,
        });
      },
      { durable: 'campaigns-referral-fill-settled' },
    );
  } catch (err) {
    app.log.error({ err }, 'svc-campaigns could not attach the welcome checklist events: it waits, trying again');
    if (!stopping && bus === connected) {
      welcomeRetry = setTimeout(() => void attachWelcome(connected), BUS_RETRY_MS);
      welcomeRetry.unref();
    }
  }
}
/**
 * Cashback earned on card spend the card partner holds (J-bank-13 #7): svc-bank announces it once per authorisation, and
 * an earning rule on `bank.card_cashback.earned` owes it in USDC and the payer pays it to the person's own wallet. Keyed
 * by the authorisation, so a redelivery owes nothing twice. It reads `bank`'s stream, so it attaches on its own and is
 * tried again if that stream is missing; everything above keeps running.
 */
let cashbackRetry: NodeJS.Timeout | null = null;
async function attachCardCashback(connected: JetStreamEventBus): Promise<void> {
  try {
    await connected.subscribe(
      'bankCardCashbackEarned',
      async (earned) => {
        if (!saga) app.log.warn({ authorizationId: earned.authorizationId }, 'earning skipped: campaigns.reward_saga_unwired');
        await tasks.onEarningEvent({
          trigger: 'bank.card_cashback.earned',
          eventId: earned.authorizationId,
          userId: earned.userId,
          at: earned.earnedAt,
          values: { amount: earned.spend, cashback: earned.cashback },
          assets: { amount: earned.assetId, cashback: earned.assetId },
        });
      },
      { durable: 'campaigns-earn-card-cashback' },
    );
  } catch (err) {
    app.log.error({ err }, 'svc-campaigns could not attach bank.card_cashback.earned: card cashback waits, trying again');
    if (!stopping && bus === connected) {
      cashbackRetry = setTimeout(() => void attachCardCashback(connected), BUS_RETRY_MS);
      cashbackRetry.unref();
    }
  }
}
await attachBus();

// The reconciler: releases held rewards whose hold ended, decides locked rewards and bonuses that are due, then posts
// open rewards, outcomes and fundings again under their own keys. Blank owner value: none runs, and a held reward stays
// held and a locked one locked.
const reconciler =
  saga && reconcileAfterSeconds
    ? setInterval(() => {
        tasks
          .releaseHolds()
          .catch((err: unknown) => app.log.error({ err }, 'reward hold release failed'))
          .then(() => tasks.settleLocks())
          .catch((err: unknown) => app.log.error({ err }, 'locked reward settle failed'))
          .then(() => saga.reconcile())
          .catch((err: unknown) => app.log.error({ err }, 'reward reconcile failed'));
      }, reconcileAfterSeconds * 1000)
    : null;
reconciler?.unref();

// Paying owed rewards to the customer's own wallet (J-campaigns-03 #2 #3): from our own-funds place, on the LOCAL TEST
// chain only. Any owner value or TEST chain fact blank: none runs, and an owed reward stays owed.
const payWallet = /^(.+)=(0x[0-9a-fA-F]{40})$/.exec(env.CAMPAIGNS_REWARD_PAY_WALLET ?? '');
const payer =
  ledger &&
  env.LEDGER_URL &&
  payWallet &&
  env.CAMPAIGNS_REWARD_PAY_INTERVAL_MS &&
  env.CAMPAIGNS_TEST_CHAIN_RPC_URL &&
  env.CAMPAIGNS_TEST_CHAIN_TOKEN &&
  env.CAMPAIGNS_TEST_CHAIN_TOKEN_DECIMALS !== undefined &&
  env.CAMPAIGNS_TEST_CHAIN_ID
    ? new RewardPayer({
        sql,
        ledger,
        chain: testRewardChain({
          rpcUrl: env.CAMPAIGNS_TEST_CHAIN_RPC_URL,
          token: env.CAMPAIGNS_TEST_CHAIN_TOKEN,
          chainId: env.CAMPAIGNS_TEST_CHAIN_ID,
        }),
        wallet: { walletId: payWallet[1]!, address: payWallet[2]!, tokenDecimals: env.CAMPAIGNS_TEST_CHAIN_TOKEN_DECIMALS },
        postingEnabled: ledgerPostingEnabled(env.LEDGER_URL),
      })
    : null;
let paying = false;
const payTimer = payer
  ? setInterval(() => {
      if (paying) return;
      paying = true;
      payer
        .pass()
        .catch((err: unknown) => app.log.error({ err }, 'reward payment pass failed'))
        .finally(() => {
          paying = false;
        });
    }, env.CAMPAIGNS_REWARD_PAY_INTERVAL_MS)
  : null;
payTimer?.unref();

// Voucher expiry (J-campaigns-08): marks each claimed voucher whose use-by passed `expired`, once, and drops code
// attempts older than the attempt window, which nothing counts any more. It moves no value, so
// it runs whether or not the ledger is connected; a redemption after the use-by refuses whether or not it has run.
const VOUCHER_EXPIRY_MS = 15_000;
const voucherExpiry = setInterval(() => {
  vouchers.expire().catch((err: unknown) => app.log.error({ err }, 'voucher expiry failed'));
  vouchers.pruneAttempts().catch((err: unknown) => app.log.error({ err }, 'voucher attempt prune failed'));
  // Expired export files are deleted, and a job a stopped runner left queued is run (J-campaigns-17 #6).
  watch.sweepExports().catch((err: unknown) => app.log.error({ err }, 'export sweep failed'));
}, VOUCHER_EXPIRY_MS);
voucherExpiry.unref();

// Competitions (J-campaigns-11): each live one's entrants are read from the venue and their milestones queued; each closed
// one is settled once. Only one pass runs at a time.
const COMPETITION_TICK_MS = 5_000;
let competing = false;
const competitionTick = setInterval(() => {
  if (competing) return;
  competing = true;
  competitions
    .tick()
    .catch((err: unknown) => app.log.error({ err }, 'competition pass failed'))
    .finally(() => {
      competing = false;
    });
}, COMPETITION_TICK_MS);
competitionTick.unref();

// Draws (J-campaigns-12): each open one's entrants are read from the venue and their chances counted. Nothing is drawn.
let drawing = false;
const drawTick = setInterval(() => {
  if (drawing) return;
  drawing = true;
  draws
    .tick()
    .catch((err: unknown) => app.log.error({ err }, 'draw pass failed'))
    .finally(() => {
      drawing = false;
    });
}, COMPETITION_TICK_MS);
drawTick.unref();

// Airdrops (J-campaigns-13): each one past its snapshot time is read and its shares owed once. Reward pools: each ended
// day is settled once.
let distributing = false;
const distributionTick = setInterval(() => {
  if (distributing) return;
  distributing = true;
  Promise.all([distributions.tick(), pools.tick()])
    .catch((err: unknown) => app.log.error({ err }, 'distribution or pool pass failed'))
    .finally(() => {
      distributing = false;
    });
}, COMPETITION_TICK_MS);
distributionTick.unref();
voucherExpiry.unref();

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
if (!participantsWired) {
  app.log.warn('IDENTITY_URL or INTERNAL_SERVICE_SECRET is unset: campaigns with exclusions or a region list read unread');
}
if (!markets) app.log.warn('TRADE_URL is unset: a task step that names a market counts no fill');
if (!venueDeposits) app.log.warn('PROTOCOL_URL, TRADE_URL or INTERNAL_SERVICE_SECRET is unset: the welcome deposit task reads unread');
if (!saga)
  app.log.warn(
    'LEDGER_URL or INTERNAL_SERVICE_SECRET is unset: every claim refuses campaigns.reward_saga_unwired and no earning rule pays',
  );
if (!payer) app.log.warn('no reward payer: an owed reward stays owed (campaigns.reward_payout_unavailable)');
app.log.info({ port: env.HTTP_PORT, participants: participantsWired, ledger: Boolean(saga), payer: Boolean(payer) }, 'svc-campaigns ready');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      stopping = true;
      if (reconciler) clearInterval(reconciler);
      if (payTimer) clearInterval(payTimer);
      clearInterval(voucherExpiry);
      clearInterval(competitionTick);
      clearInterval(drawTick);
      clearInterval(distributionTick);
      if (busRetry) clearTimeout(busRetry);
      if (welcomeRetry) clearTimeout(welcomeRetry);
      if (cashbackRetry) clearTimeout(cashbackRetry);
      await app.close();
      await bus?.close();
      await sql.end({ timeout: 2 });
      process.exit(0);
    })();
  });
}
