import { z } from 'zod';
import {
  router,
  publicProcedure,
  scopedProcedure,
  TRPCError,
  statusChallengeSchema,
  statusLinkInputSchema,
  statusSubscribeInputSchema,
  statusSubscribeResultSchema,
  statusSubscriptionPolicySchema,
  statusSubscriptionSchema,
  statusSubscriptionUpdateInputSchema,
} from '@intafaced/contracts';
import type { NoticeBoard } from '../notices/board.js';
import { STATUS_IMPORT_MAX, StatusSubscriptionError, type StatusSubscriptions } from './subscriptions.js';

const REFUSED = new Set(['status.challenge_failed', 'status.webhook_target_refused', 'status.component_unknown', 'status.import_invalid']);

/**
 * Status subscriptions (SP-status-04). Everything a visitor does is public and signed out: the signed link is the
 * credential. `find`, `channels`, `list`, `deliveries`, `resend` and `import` are the founders' subscriber desk, under the
 * notice board's scope.
 */
export function statusSubscriptionsRouter(subscriptions?: StatusSubscriptions, notices?: NoticeBoard | null) {
  async function call<T>(run: (s: StatusSubscriptions) => Promise<T>): Promise<T> {
    if (!subscriptions) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.status_subscriptions_unavailable' });
    try {
      return await run(subscriptions);
    } catch (err) {
      if (err instanceof StatusSubscriptionError) {
        const code =
          err.code === 'status.rate_limited'
            ? 'TOO_MANY_REQUESTS'
            : err.code === 'status.subscription_link_invalid' ||
                err.code === 'status.subscriber_unknown' ||
                err.code === 'status.notice_unknown'
              ? 'NOT_FOUND'
              : REFUSED.has(err.code)
                ? 'BAD_REQUEST'
                : 'PRECONDITION_FAILED';
        throw new TRPCError({ code, message: err.code, cause: err });
      }
      throw err;
    }
  }
  const linked = statusSubscriptionSchema.extend({ manageToken: z.string() });
  const delivery = z.object({
    key: z.string(),
    subscriberId: z.string(),
    event: z.string(),
    channel: z.enum(['email', 'webhook']),
    status: z.enum(['pending', 'accepted', 'failed', 'refused']),
    refusalCode: z.string().nullable(),
    attempts: z.number().int(),
  });
  const founder = scopedProcedure('admin:write', { module: 'notify' });
  const eventRows = z.object({ rows: z.array(delivery.extend({ email: z.string() })), more: z.boolean() });
  const rowsOf = (found: Awaited<ReturnType<StatusSubscriptions['eventDeliveries']>>) => ({ rows: [...found.rows], more: found.more });
  return router({
    policy: publicProcedure.output(statusSubscriptionPolicySchema).query(() => call((s) => s.policy())),
    challenge: publicProcedure.output(statusChallengeSchema).mutation(() => call((s) => s.challenge())),
    subscribe: publicProcedure
      .input(statusSubscribeInputSchema)
      .output(statusSubscribeResultSchema)
      .mutation(({ input }) => call((s) => s.subscribe(input))),
    confirm: publicProcedure
      .input(statusLinkInputSchema)
      .output(linked)
      .mutation(({ input }) => call((s) => s.confirm(input.token))),
    get: publicProcedure
      .input(statusLinkInputSchema)
      .output(statusSubscriptionSchema)
      .query(({ input }) => call((s) => s.subscription(input.token))),
    update: publicProcedure
      .input(statusSubscriptionUpdateInputSchema)
      .output(statusSubscriptionSchema)
      .mutation(({ input }) => call((s) => s.updateSubscription(input))),
    unsubscribe: publicProcedure
      .input(statusLinkInputSchema)
      .output(statusSubscriptionSchema)
      .mutation(({ input }) => call((s) => s.unsubscribe(input.token))),
    find: founder
      .input(z.object({ email: z.string().min(3).max(254) }))
      .output(statusSubscriptionSchema.extend({ deliveries: z.array(delivery) }).nullable())
      .query(({ input }) =>
        call(async (s) => {
          const found = await s.find(input.email);
          return found === null ? null : { ...found, deliveries: [...found.deliveries] };
        }),
      ),

    /** How each channel leaves this deployment: a channel with no sender is named by its code. */
    channels: founder
      .output(
        z.object({
          email: z.object({ sender: z.enum(['gateway', 'local-outbox']).nullable(), notConnected: z.literal('vendor.email').nullable() }),
          sms: z.literal('vendor.sms'),
          push: z.literal('vendor.push'),
        }),
      )
      .query(() => call(async (s) => s.channels())),

    /** Subscribers newest first, in one state or all, with how their deliveries stand. */
    list: founder
      .input(z.object({ state: z.enum(['unconfirmed', 'active', 'unsubscribed']).nullable(), limit: z.number().int().min(1).max(200) }))
      .output(
        z.array(
          z.object({
            id: z.string(),
            email: z.string(),
            state: z.enum(['unconfirmed', 'active', 'unsubscribed']),
            componentIds: z.array(z.string()).nullable(),
            source: z.string().nullable(),
            webhook: z.boolean(),
            createdAt: z.string(),
            deliveries: z.object({
              pending: z.number().int(),
              accepted: z.number().int(),
              failed: z.number().int(),
              refused: z.number().int(),
            }),
          }),
        ),
      )
      .query(({ input }) =>
        call(async (s) =>
          (await s.list(input)).map((row) => ({
            ...row,
            componentIds: row.componentIds ? [...row.componentIds] : null,
            deliveries: { ...row.deliveries },
          })),
        ),
      ),

    /** The delivery rows of one published notice: one per subscriber and channel; `more` when there are more than shown. */
    deliveries: founder
      .input(z.object({ noticeId: z.string().guid() }))
      .output(eventRows)
      .query(({ input }) => call(async (s) => rowsOf(await s.eventDeliveries(input.noticeId)))),

    /**
     * Tries a published notice's pending and failed rows once more, for subscribers still active. Accepted and refused
     * rows are left, and no row is made for anyone the notice did not reach when it was published.
     */
    resend: founder
      .input(z.object({ noticeId: z.string().guid() }))
      .output(eventRows)
      .mutation(({ input }) =>
        call(async (s) => {
          const row = notices ? await notices.publishedForFanOut(input.noticeId) : null;
          if (!row) throw new StatusSubscriptionError('status.notice_unknown');
          await s.retry(row);
          return rowsOf(await s.eventDeliveries(input.noticeId));
        }),
      ),

    /** Founder import: addresses from another list, keyed by address and source; a duplicate makes one record. */
    import: founder
      .input(z.object({ source: z.string().min(1).max(40), emails: z.array(z.string().max(1000)).min(1).max(STATUS_IMPORT_MAX) }))
      .output(
        z.object({
          received: z.number().int(),
          distinct: z.number().int(),
          added: z.number().int(),
          alreadyKnown: z.number().int(),
          invalid: z.array(z.string()),
          limited: z.number().int(),
        }),
      )
      .mutation(({ input }) =>
        call(async (s) => {
          const result = await s.importSubscribers(input);
          return { ...result, invalid: [...result.invalid] };
        }),
      ),
  });
}
