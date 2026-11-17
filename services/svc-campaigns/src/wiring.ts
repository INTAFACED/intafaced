import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from 'postgres';
import { parseAmount } from '@intafaced/ledger-client';
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
import { RiskService } from './risk.js';
import { RewardPayer, rewardsPaidToWallet } from './reward-payer.js';
import { ledgerPostingEnabled, testRewardChain } from './test-chain.js';
import { TaskService } from './tasks.js';
import { createVenueDepositSource } from './venue-deposits.js';
import { VoucherService } from './vouchers.js';
import { WatchService } from './watch.js';
import { DropService } from './drops.js';
import { env } from './env.js';
import type { CampaignServices } from './router.js';
import type { Pass } from './passes.js';
import { campaignSubscriptions, type SubscriptionGroup } from './subscriptions.js';
import { parseTgeSchedule } from './tge.js';

/**
 * svc-campaigns' composition: every service built from its owner values, the recurring passes, the bus subscriptions,
 * the readiness report and the boot warnings. `index.ts` is only the process around it (HTTP, the bus connection,
 * shutdown), so a new service, pass or subscription is a change here and in its own module, never in `index.ts`
 * (project-state#2730).
 *
 * Holds no balance. Value moves only in the reward saga (`payouts.ts`: `rewardPay` and `sweepFeesToRewards`). A blank
 * CAMPAIGNS_TGE_SCHEDULE_JSON boots and refuses every TGE claim `launch.schedule_unset`; a blank
 * CAMPAIGNS_PLATFORM_TIME_ZONE boots and refuses every activation and join `campaigns.timezone_unset`.
 */
export interface CampaignWiring {
  services: CampaignServices & Required<Pick<CampaignServices, 'risk'>>;
  passes: Pass[];
  /** Subscribed in order once the bus connects; the first is attached with the connection and the rest on their own. */
  subscriptions: SubscriptionGroup[];
  /** The owner values `/ready` reports, set or the typed refusal each blank one gives. */
  readiness: () => Record<string, string>;
  /** Logged once after listening, one line per missing wire. */
  warnings: string[];
  summary: { participants: boolean; ledger: boolean; payer: boolean };
}

export function wireCampaigns(deps: {
  sql: Sql;
  log: FastifyBaseLogger;
  s2sKey: Parameters<typeof createParticipantClient>[2];
}): CampaignWiring {
  const { sql, log, s2sKey } = deps;
  const warn = (msg: string, detail: Record<string, unknown>) => log.warn({ ...detail }, msg);

  const tgeSchedule = parseTgeSchedule(env.CAMPAIGNS_TGE_SCHEDULE_JSON);
  const drops = new DropService({ sql, tgeSchedule: () => tgeSchedule });
  const timeZone = parseTimeZone(env.CAMPAIGNS_PLATFORM_TIME_ZONE);
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
  // The risk review (J-campaigns-18): every reward passes its account check before anything is owed or posted.
  const risk = new RiskService({
    sql,
    ledger,
    participants: participantsWired ? participants : null,
    threshold: env.CAMPAIGNS_RISK_SIGNAL_THRESHOLD ?? null,
    appealWindowSeconds: env.CAMPAIGNS_RISK_APPEAL_WINDOW_SECONDS ?? null,
  });
  const saga = ledger ? new PayoutSaga({ sql, ledger, reconcileAfterSeconds, rewardCeiling, gate: risk }) : null;
  if (saga) risk.useSaga(saga);
  const markets = env.TRADE_URL ? createMarketNames({ tradeUrl: env.TRADE_URL }) : null;
  // svc-trade's reads (fills, equity, tier passes): TRADE_URL and INTERNAL_SERVICE_SECRET; unset, every read is unread.
  const tradeReads =
    env.TRADE_URL && env.INTERNAL_SERVICE_SECRET
      ? { tradeUrl: env.TRADE_URL, internalSecret: env.INTERNAL_SERVICE_SECRET, ...(s2sKey ? { s2s: s2sKey } : {}) }
      : null;
  // The welcome deposit task's reads (J-campaigns-04 #2): the person's connected wallets and the venue's deposits.
  const venueDeposits = env.PROTOCOL_URL && tradeReads ? createVenueDepositSource({ protocolUrl: env.PROTOCOL_URL, ...tradeReads }) : null;
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
  const payTo = (accountId: string, forwarded: Parameters<TaskService['recordPayTo']>[1]) => tasks.recordPayTo(accountId, forwarded);
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
  const vouchers = new VoucherService({ sql, participants, campaigns, saga, attemptLimits: () => attemptLimits, payTo });

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
   * Trading competitions (J-campaigns-11): volume read from svc-trade's read of the venue's own fills (unset, every read
   * is unread and nothing settles), prizes owed and paid through the saga and the payer.
   */
  const competitions = new CompetitionService({
    sql,
    saga,
    fills: tradeReads ? createCompetitionFillSource(tradeReads) : null,
    wallets: venueDeposits ? (forwarded) => venueDeposits.wallets(forwarded) : null,
    payTo,
    log: warn,
  });

  /**
   * Lucky draws (J-campaigns-12): chances read from the same venue fills, capped by the verification level svc-identity
   * reports. Running one waits for the owner's decision and pays nothing.
   */
  const draws = new DrawService({
    sql,
    fills: tradeReads ? createCompetitionFillSource(tradeReads) : null,
    participants,
    log: warn,
  });

  /**
   * Airdrop distributions and reward pools (J-campaigns-13): venue equity and fills read through svc-trade (unset, every
   * read is unread and nothing is owed), shares rounded to the paying token's decimals, owed and paid through the saga
   * and the payer.
   */
  const equity = tradeReads ? createEquitySource(tradeReads) : null;
  const payDecimals = env.CAMPAIGNS_TEST_CHAIN_TOKEN_DECIMALS ?? null;
  const distributions = new DistributionService({ sql, saga, equity, payTo, payDecimals, log: warn });
  const pools = new PoolService({
    sql,
    saga,
    fills: tradeReads ? createCompetitionFillSource(tradeReads) : null,
    equity,
    payTo,
    payDecimals,
    log: warn,
  });

  // VIP trial passes (J-campaigns-14): granted here, held by svc-trade (unset, a grant refuses
  // `campaigns.trial_pass_unreachable`).
  const trialPasses = new TrialPassService({ sql, door: tradeReads ? createTierPassDoor(tradeReads) : null });

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

  const caught = (what: string) => (err: unknown) => log.error({ err }, what);
  const TICK_MS = 5_000;
  const passes: Pass[] = [];
  // The reconciler: releases held rewards whose hold ended, decides locked rewards and bonuses that are due, then posts
  // open rewards, outcomes and fundings again under their own keys. Blank owner value: none runs, and a held reward stays
  // held and a locked one locked.
  if (saga && reconcileAfterSeconds) {
    passes.push({
      name: 'reward reconcile pass',
      everyMs: reconcileAfterSeconds * 1000,
      run: () =>
        tasks
          .releaseHolds()
          .catch(caught('reward hold release failed'))
          .then(() => tasks.settleLocks())
          .catch(caught('locked reward settle failed'))
          .then(() => saga.reconcile())
          .catch(caught('reward reconcile failed')),
    });
  }
  if (payer && env.CAMPAIGNS_REWARD_PAY_INTERVAL_MS) {
    passes.push({ name: 'reward payment pass', everyMs: env.CAMPAIGNS_REWARD_PAY_INTERVAL_MS, run: () => payer.pass() });
  }
  passes.push(
    // Voucher expiry (J-campaigns-08): marks each claimed voucher whose use-by passed `expired`, once, and drops code
    // attempts older than the attempt window, which nothing counts any more. It moves no value, so it runs whether or
    // not the ledger is connected; a redemption after the use-by refuses whether or not it has run. Expired export files
    // are deleted, and a job a stopped runner left queued is run (J-campaigns-17 #6).
    {
      name: 'voucher expiry and export sweep',
      everyMs: 15_000,
      run: () =>
        Promise.all([
          vouchers.expire().catch(caught('voucher expiry failed')),
          vouchers.pruneAttempts().catch(caught('voucher attempt prune failed')),
          watch.sweepExports().catch(caught('export sweep failed')),
        ]),
    },
    // Competitions (J-campaigns-11): each live one's entrants are read from the venue and their milestones queued; each
    // closed one is settled once.
    { name: 'competition pass', everyMs: TICK_MS, run: () => competitions.tick() },
    // Draws (J-campaigns-12): each open one's entrants are read from the venue and their chances counted. Nothing is drawn.
    { name: 'draw pass', everyMs: TICK_MS, run: () => draws.tick() },
    // Airdrops (J-campaigns-13): each one past its snapshot time is read and its shares owed once. Reward pools: each
    // ended day is settled once.
    { name: 'distribution or pool pass', everyMs: TICK_MS, run: () => Promise.all([distributions.tick(), pools.tick()]) },
  );

  const warnings: string[] = [];
  if (!participantsWired) {
    warnings.push('IDENTITY_URL or INTERNAL_SERVICE_SECRET is unset: campaigns with exclusions or a region list read unread');
  }
  if (!markets) warnings.push('TRADE_URL is unset: a task step that names a market counts no fill');
  if (!venueDeposits) warnings.push('PROTOCOL_URL, TRADE_URL or INTERNAL_SERVICE_SECRET is unset: the welcome deposit task reads unread');
  if (!saga) {
    warnings.push(
      'LEDGER_URL or INTERNAL_SERVICE_SECRET is unset: every claim refuses campaigns.reward_saga_unwired and no earning rule pays',
    );
  }
  if (!payer) warnings.push('no reward payer: an owed reward stays owed (campaigns.reward_payout_unavailable)');

  return {
    services: { drops, campaigns, tasks, vouchers, watch, referrals, competitions, draws, distributions, pools, trialPasses, risk },
    passes,
    subscriptions: campaignSubscriptions({ tasks, referrals, sagaWired: saga !== null, log }),
    readiness: () => ({
      tgeSchedule: tgeSchedule ? 'set' : 'launch.schedule_unset',
      timeZone: timeZone ?? 'campaigns.timezone_unset',
      ruleLimits: ruleLimits.depth && ruleLimits.size ? 'set' : 'campaigns.rule_limits_unset',
      voucherAttempts: attemptLimits ? 'set' : 'campaigns.attempt_limit_unset',
      ledger: saga ? 'set' : 'campaigns.reward_saga_unwired',
      reconciler: saga && reconcileAfterSeconds ? 'set' : 'campaigns.reconcile_unset',
      riskThreshold: risk.threshold === null ? 'campaigns.risk_threshold_unset' : 'set',
      appealWindow: risk.appealWindowSeconds === null ? 'campaigns.appeal_window_unset' : 'set',
    }),
    warnings,
    summary: { participants: participantsWired, ledger: Boolean(saga), payer: Boolean(payer) },
  };
}
