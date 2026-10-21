// hand-declared-ok: the subAccounts.delete answers are declared in svc-identity, not in packages/contracts yet
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';

export { closureCheck as deleteCheck, BLOCKER_KEYS, isSixDigits } from './close-account';

export const deleteResult = z.object({ deleted: z.literal(true), changed: z.boolean() });

export const SUB_ACCOUNT_DELETE_SCOPE = 'identity.step_up.sub_account_delete';

/** The body of `stepUp.begin` for deleting one sub-account: the two fields the service re-hashes, the sub-account id as target. */
export function deleteStepUp(subAccountId: string, clientRequestId: string) {
  return {
    scope: SUB_ACCOUNT_DELETE_SCOPE,
    purpose: 'account.subAccount.delete',
    target: subAccountId,
    fields: { subAccountId, clientRequestId },
  };
}

/** Typed refusals the card words itself; any other code falls through to the shared failure view. */
export const DELETE_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  'identity.sub_account_delete_blocked': 'refusedBlocked',
  'identity.sub_account_check_unavailable': 'refusedCheck',
  'identity.sub_account_not_found': 'refusedNotFound',
  'identity.sub_account_delete_delegated': 'refusedDelegated',
};

/**
 * A revoke or delete answer that the service gave before it changed anything: the two refusals that come from the assets and
 * open-orders read. Lets the revoke journal close its record instead of holding the sub-account as "not confirmed".
 */
export function isDeleteRefusal(answer: ApiResult<unknown>): boolean {
  return (
    !answer.ok &&
    answer.status === 412 &&
    (answer.code === 'identity.sub_account_delete_blocked' || answer.code === 'identity.sub_account_check_unavailable')
  );
}
