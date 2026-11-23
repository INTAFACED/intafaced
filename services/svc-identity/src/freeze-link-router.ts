import { router, TRPCError } from '@intafaced/contracts/trpc';
import type { AuthService } from './auth/auth-service.js';
import { FreezeLinkError } from './auth/freeze-link.js';
import { toTrpcError } from './router.js';
import { userCopy } from './user-copy.js';
import { IDENTITY_FREEZE_LINK_REDEEM } from '@intafaced/contracts/identity-freeze-link-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from './record-refusal.js';

/**
 * Top-level `freezeLink` (I-account-lifecycle-08, J-identity-11 #2). `redeem` is the signed-out page a security notice's
 * freeze link opens: the token is the proof. A dead link is 401 with one code, whatever made it dead.
 */
export function createFreezeLinkRouter(auth: Pick<AuthService, 'redeemFreezeLink'>) {
  return router({
    freezeLink: router({
      redeem: mountRecord(
        IDENTITY_FREEZE_LINK_REDEEM,
        async ({ input }) => {
          try {
            const done = await auth.redeemFreezeLink({ token: input.token });
            return { frozen: true as const, since: done.since.toISOString(), firstUse: done.firstUse, frozenNow: done.frozenNow };
          } catch (err) {
            if (err instanceof FreezeLinkError) {
              throw new TRPCError({ code: 'UNAUTHORIZED', message: `${userCopy(err.code)} [${err.code}]`, cause: err });
            }
            throw toTrpcError(err);
          }
        },
        codedRefusal,
      ),
    }),
  });
}
