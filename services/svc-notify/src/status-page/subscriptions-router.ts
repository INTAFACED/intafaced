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
import { StatusSubscriptionError, type StatusSubscriptions } from './subscriptions.js';

const REFUSED = new Set(['status.challenge_failed', 'status.webhook_target_refused', 'status.component_unknown']);

/**
 * Status subscriptions (SP-status-04). Everything a visitor does is public and signed out: the signed link is the
 * credential. `find` is a founder read under the notice board's scope.
 */
export function statusSubscriptionsRouter(subscriptions?: StatusSubscriptions) {
  async function call<T>(run: (s: StatusSubscriptions) => Promise<T>): Promise<T> {
    if (!subscriptions) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.status_subscriptions_unavailable' });
    try {
      return await run(subscriptions);
    } catch (err) {
      if (err instanceof StatusSubscriptionError) {
        const code =
          err.code === 'status.rate_limited'
            ? 'TOO_MANY_REQUESTS'
            : err.code === 'status.subscription_link_invalid' || err.code === 'status.subscriber_unknown'
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
    find: scopedProcedure('admin:write', { module: 'notify' })
      .input(z.object({ email: z.string().min(3).max(254) }))
      .output(
        statusSubscriptionSchema
          .extend({
            deliveries: z.array(
              z.object({
                key: z.string(),
                subscriberId: z.string(),
                event: z.string(),
                channel: z.enum(['email', 'webhook']),
                status: z.enum(['pending', 'accepted', 'failed', 'refused']),
                refusalCode: z.string().nullable(),
                attempts: z.number().int(),
              }),
            ),
          })
          .nullable(),
      )
      .query(({ input }) =>
        call(async (s) => {
          const found = await s.find(input.email);
          return found === null ? null : { ...found, deliveries: [...found.deliveries] };
        }),
      ),
  });
}
