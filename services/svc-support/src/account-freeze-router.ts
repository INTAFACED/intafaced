import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { SUPPORT_ACCOUNT_FREEZE_RECORDS, SUPPORT_REQUEST_ACCOUNT_FREEZE } from '@intafaced/contracts/support-account-freeze';
import type { AccountFreezes } from './account-freeze.js';
import { supportRefusal } from './record-refusal.js';
import { requireSupportOps } from './support-service.js';

/**
 * `requestAccountFreeze` (J-support-public-20 #7): the desk's (`support:ops`) only, by request. svc-identity records the
 * freeze; the answer is its record. `accountFreezeRecords` reads the request's audit rows back from svc-identity. There
 * is no procedure that lifts it.
 */
export function accountFreezeProcedures(freezes: AccountFreezes) {
  return {
    requestAccountFreeze: mountRecord(
      SUPPORT_REQUEST_ACCOUNT_FREEZE,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return freezes.request(ctx.principal.userId, input);
      },
      supportRefusal,
    ),
    accountFreezeRecords: mountRecord(
      SUPPORT_ACCOUNT_FREEZE_RECORDS,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return freezes.records(ctx.principal.userId, input);
      },
      supportRefusal,
    ),
  };
}
