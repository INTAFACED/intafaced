import type { Sql } from 'postgres';
import { createSqlTradeIdentityStore, type SubAccountRow } from './trade-identity-auth.js';

export interface SubAccountOwnershipBody {
  id: string;
  parentUserId: string;
  revoked: boolean;
}

export type FrozenSubAccountGate =
  | { status: 200; body: SubAccountOwnershipBody }
  | { status: 423; body: { error: 'sub-account is frozen'; code: 'identity.sub_account_frozen' } }
  | { status: 500; body: { error: 'sub-account freeze could not be read'; code: 'identity.sub_account_unavailable' } };

const unread: FrozenSubAccountGate = {
  status: 500,
  body: { error: 'sub-account freeze could not be read', code: 'identity.sub_account_unavailable' },
};

/**
 * After the ownership 404. Frozen is 423 so svc-trade refuses the order.
 * A read that throws, or a row that is not frozen 0, refuses. Never 200.
 */
export async function gateFrozenSubAccount(sql: Sql, ownership: SubAccountOwnershipBody): Promise<FrozenSubAccountGate> {
  let row: SubAccountRow | null;
  try {
    row = await createSqlTradeIdentityStore(sql).getSubAccount(ownership.id);
  } catch {
    return unread;
  }
  if (!row) return unread;
  if (row.frozen === 1) {
    return { status: 423, body: { error: 'sub-account is frozen', code: 'identity.sub_account_frozen' } };
  }
  if (row.frozen !== 0) return unread;
  return { status: 200, body: ownership };
}
