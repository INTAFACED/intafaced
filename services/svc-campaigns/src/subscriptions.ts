import type { FastifyBaseLogger } from 'fastify';
import type { JetStreamEventBus } from '@intafaced/events';
import type { ReferralService } from './referrals.js';
import type { TaskService } from './tasks.js';

/**
 * One set of bus subscriptions that attaches, or fails and is tried again, as a unit. svc-campaigns owns no stream: each
 * group reads streams other services create, so a group whose stream is missing waits on its own and every other group
 * keeps running. Each subscription has its own durable consumer and is keyed by its event, so a redelivery is a no-op.
 * A new subscription is a line in its group here, or a new group, never a hand-written retry in `index.ts`
 * (project-state#2730).
 */
export interface SubscriptionGroup {
  /** Logged when the group cannot attach: `svc-campaigns could not attach <what>`. */
  what: string;
  attach: (bus: JetStreamEventBus) => Promise<void>;
}

export function campaignSubscriptions(deps: {
  tasks: TaskService;
  referrals: ReferralService;
  sagaWired: boolean;
  log: FastifyBaseLogger;
}): SubscriptionGroup[] {
  const { tasks, referrals, sagaWired, log } = deps;
  return [
    {
      // Task progress reads settled spot fills from `trade`'s stream, which svc-trade creates.
      what: 'to trade.fill.settled: task progress waits, trying again',
      attach: async (bus) => {
        await bus.subscribe(
          'fillSettled',
          async (fill) => {
            await tasks.onFill(fill);
          },
          { durable: 'campaigns-task-fill-settled' },
        );
        // Earning rules on crypto deposits (CM-rewards-hub-05): one intent per deposit per rule, keyed by the deposit id.
        await bus.subscribe(
          'payDepositCreditPosted',
          async (deposit) => {
            if (!sagaWired) log.warn({ depositId: deposit.depositId }, 'earning skipped: campaigns.reward_saga_unwired');
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
      },
    },
    {
      /**
       * The welcome checklist (CM-rewards-hub-03): each account's sign-up opens its window, and its first verification
       * and spot fill tick its tasks. Its deposit task is read from the venue, not the bus (J-campaigns-04 #2; tasks.ts
       * `readWelcomeDeposit`): a credit svc-pay posts to an account in our book is not a deposit into the person's venue
       * account. Each event is kept once, by account and kind. These read `identity`'s stream too.
       */
      what: 'the welcome checklist events: it waits, trying again',
      attach: async (bus) => {
        await bus.subscribe(
          'userCreated',
          async (user, envelope) => {
            await tasks.onSignUp({ userId: user.userId, eventId: envelope.idempotencyKey, at: envelope.occurredAt });
          },
          { durable: 'campaigns-welcome-user-created' },
        );
        await bus.subscribe(
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
        await bus.subscribe(
          'fillSettled',
          async (fill) => {
            await tasks.onWelcomeEvent({ userId: fill.userId, event: 'trade.fill', eventId: fill.fillId, at: fill.ts });
          },
          { durable: 'campaigns-welcome-fill-settled' },
        );
        // Referral progress (CM-referral-02): each invitee once from their attach, then their own verify, deposit and
        // fills, each kept once by its event id.
        await bus.subscribe(
          'referralCreated',
          async (edge) => {
            await referrals.onAttached(edge);
          },
          { durable: 'campaigns-referral-attached' },
        );
        await bus.subscribe(
          'kycApproved',
          async (kyc, envelope) => {
            await referrals.onVerified({ userId: kyc.userId, tier: kyc.tier, eventId: envelope.idempotencyKey, at: envelope.occurredAt });
          },
          { durable: 'campaigns-referral-kyc-approved' },
        );
        await bus.subscribe(
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
        await bus.subscribe(
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
      },
    },
    {
      /**
       * Cashback earned on card spend the card partner holds (J-bank-13 #7): svc-bank announces it once per
       * authorisation, and an earning rule on `bank.card_cashback.earned` owes it in USDC and the payer pays it to the
       * person's own wallet. Keyed by the authorisation, so a redelivery owes nothing twice. It reads `bank`'s stream.
       */
      what: 'bank.card_cashback.earned: card cashback waits, trying again',
      attach: async (bus) => {
        await bus.subscribe(
          'bankCardCashbackEarned',
          async (earned) => {
            if (!sagaWired) log.warn({ authorizationId: earned.authorizationId }, 'earning skipped: campaigns.reward_saga_unwired');
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
      },
    },
  ];
}
