import { router } from '@intafaced/contracts/trpc';
import { IDENTITY_SERVER_TIME } from '@intafaced/contracts/identity-server-time-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from './record-refusal.js';

/**
 * `serverTime` (I-signin-sessions-13): this service's clock, for the customer's "my codes do not work" check. Public and
 * read-only: it says what time it is here and nothing else.
 */
export function createServerTimeRouter(now: () => Date = () => new Date()) {
  return router({
    serverTime: mountRecord(IDENTITY_SERVER_TIME, () => ({ now: now().toISOString() }), codedRefusal),
  });
}
