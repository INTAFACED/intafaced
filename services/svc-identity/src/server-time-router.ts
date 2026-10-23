import { publicProcedure, router, serverTimeSchema } from '@intafaced/contracts';

/**
 * `serverTime` (I-signin-sessions-13): this service's clock, for the customer's "my codes do not work" check. Public and
 * read-only: it says what time it is here and nothing else.
 */
export function createServerTimeRouter(now: () => Date = () => new Date()) {
  return router({
    serverTime: publicProcedure.output(serverTimeSchema).query(() => ({ now: now().toISOString() })),
  });
}
