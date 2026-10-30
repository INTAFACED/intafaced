/**
 * Trade identity doors for one sub-account freeze flag, a frozen read of
 * the caller's own fill, account close while the book is flat, and a dead
 * staff session that must not unfreeze a customer.
 *
 * Orders, escrow and fills live in other services. When that reader is
 * absent this module refuses by name. It does not invent a flat book or a fill.
 */
import type { Sql } from 'postgres';
import { generateToken, hashToken } from './passwords.js';

export type TradeIdentityAuthCode =
  | 'auth.parent_key_required'
  | 'auth.sub_account_frozen_param'
  | 'auth.sub_account_denied'
  | 'auth.sub_account_revoked'
  | 'auth.account_frozen'
  | 'auth.close_book_unwired'
  | 'auth.close_open_book'
  | 'auth.close_withdrawal_required'
  | 'auth.not_found'
  | 'auth.session_revoked'
  | 'auth.frozen_fills_unwired'
  | 'auth.frozen_read_denied'
  | 'auth.fill_not_found';

export class TradeIdentityAuthError extends Error {
  constructor(
    message: string,
    readonly code: TradeIdentityAuthCode,
  ) {
    super(message);
    this.name = 'TradeIdentityAuthError';
  }
}

export type FrozenFlag = 0 | 1;
export type AccountStatus = 'active' | 'frozen' | 'closed';

/** Read scopes a frozen account keeps. Place (`trade:write`) is not one of them. */
export const FROZEN_READ_SCOPES = ['identity:read', 'ledger:read', 'trade:read'] as const;

export interface SubAccountRow {
  id: string;
  parentUserId: string;
  revoked: boolean;
  frozen: FrozenFlag;
}

export interface ApiKeyRow {
  id: string;
  userId: string;
  revoked: boolean;
}

export interface SessionRow {
  id: string;
  userId: string;
  revoked: boolean;
}

export interface UserRow {
  id: string;
  status: AccountStatus;
}

export interface TradeIdentityStore {
  getApiKey(id: string): Promise<ApiKeyRow | null>;
  getSubAccount(id: string): Promise<SubAccountRow | null>;
  setSubAccountFrozen(id: string, frozen: FrozenFlag): Promise<void>;
  getUser(id: string): Promise<UserRow | null>;
  closeUser(id: string): Promise<boolean>;
  getSession(id: string): Promise<SessionRow | null>;
  revokeLiveSessions(userId: string): Promise<number>;
  insertReadOnlySession(userId: string): Promise<{ id: string }>;
  listApiKeys(userId: string): Promise<Array<{ id: string; revoked: boolean }>>;
  revokeLiveApiKeys(userId: string): Promise<number>;
}

export interface CloseBook {
  openOrders: number;
  openPositions: number;
  payEscrow: number;
  pendingDeposits: number;
  pendingWithdrawals: number;
  payRequests: number;
  chargebacks: number;
  restingQuotes: number;
  /** Exact available balance. Only a canonical zero is flat. */
  available: string;
  /** Held with the open order. Close must return this string unchanged. */
  orderHold: string;
}

export interface CloseResult {
  completed: boolean;
  status: AccountStatus;
  code: TradeIdentityAuthCode | null;
  blockedBy: string | null;
  orderHold: string;
  debited: false;
  apiKeysRevoked: number;
  makerKeyCanPlace: boolean;
  repeated: boolean;
}

export interface OwnFill {
  id: string;
  orderId: string;
  userId: string;
  qty: string;
}

export interface RestingOrder {
  id: string;
  userId: string;
  status: 'open';
}

const READ_ONLY_SESSION_MS = 15 * 60 * 1000;

function frozenFlag(value: number): FrozenFlag {
  if (value !== 0 && value !== 1) {
    throw new TradeIdentityAuthError('frozen is 0 or 1', 'auth.sub_account_frozen_param');
  }
  return value;
}

function asStatus(value: string): AccountStatus {
  if (value === 'active' || value === 'frozen' || value === 'closed') return value;
  throw new TradeIdentityAuthError('Account status is not a known value', 'auth.not_found');
}

/** True only for an unsigned canonical zero (`0`, `0.00`). Anything else still needs a withdrawal. */
export function availableIsFlat(available: string): boolean {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(available)) return false;
  const [whole, frac = ''] = available.split('.');
  return /^0+$/.test(whole ?? '') && /^0*$/.test(frac);
}

function countOrRefuse(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TradeIdentityAuthError(`Close book ${name} is not a whole count`, 'auth.close_book_unwired');
  }
}

function blocker(book: CloseBook): { code: TradeIdentityAuthCode; blockedBy: string } | null {
  countOrRefuse('openOrders', book.openOrders);
  countOrRefuse('openPositions', book.openPositions);
  countOrRefuse('payEscrow', book.payEscrow);
  countOrRefuse('pendingDeposits', book.pendingDeposits);
  countOrRefuse('pendingWithdrawals', book.pendingWithdrawals);
  countOrRefuse('payRequests', book.payRequests);
  countOrRefuse('chargebacks', book.chargebacks);
  countOrRefuse('restingQuotes', book.restingQuotes);
  if (book.openOrders > 0) return { code: 'auth.close_open_book', blockedBy: 'open_order' };
  if (book.openPositions > 0) return { code: 'auth.close_open_book', blockedBy: 'position' };
  if (book.payEscrow > 0) return { code: 'auth.close_open_book', blockedBy: 'escrow' };
  if (book.pendingDeposits > 0) return { code: 'auth.close_open_book', blockedBy: 'deposit' };
  if (book.pendingWithdrawals > 0) return { code: 'auth.close_open_book', blockedBy: 'withdrawal' };
  if (book.payRequests > 0) return { code: 'auth.close_open_book', blockedBy: 'pay_request' };
  if (book.chargebacks > 0) return { code: 'auth.close_open_book', blockedBy: 'chargeback' };
  if (book.restingQuotes > 0) return { code: 'auth.close_open_book', blockedBy: 'quote' };
  if (!availableIsFlat(book.available)) return { code: 'auth.close_withdrawal_required', blockedBy: 'balance' };
  return null;
}

async function makerCanPlace(store: TradeIdentityStore, userId: string, status: AccountStatus): Promise<boolean> {
  if (status !== 'active') return false;
  const keys = await store.listApiKeys(userId);
  return keys.some((key) => key.revoked === false);
}

/**
 * Parent sets Bybit `frozen` to 1 or 0 on one live sub-account id.
 * The same id comes back. A repeat of the current value does not write.
 * A call without that parent's live API key is refused.
 */
export async function setSubAccountFrozen(
  store: TradeIdentityStore,
  input: {
    parentUserId: string;
    parentApiKeyId: string | null | undefined;
    subAccountId: string;
    frozen: number;
  },
): Promise<{ id: string; frozen: FrozenFlag; changed: boolean }> {
  const keyId = typeof input.parentApiKeyId === 'string' ? input.parentApiKeyId.trim() : '';
  if (!keyId) {
    throw new TradeIdentityAuthError('A freeze call needs the parent API key', 'auth.parent_key_required');
  }
  const frozen = frozenFlag(input.frozen);
  const key = await store.getApiKey(keyId);
  if (!key || key.revoked || key.userId !== input.parentUserId) {
    throw new TradeIdentityAuthError('A freeze call needs the parent API key', 'auth.parent_key_required');
  }
  const row = await store.getSubAccount(input.subAccountId);
  if (!row || row.parentUserId !== input.parentUserId) {
    throw new TradeIdentityAuthError('Sub-account not found or not owned by the parent', 'auth.sub_account_denied');
  }
  if (row.revoked) {
    throw new TradeIdentityAuthError('Sub-account is revoked', 'auth.sub_account_revoked');
  }
  if (row.frozen === frozen) {
    return { id: row.id, frozen: row.frozen, changed: false };
  }
  await store.setSubAccountFrozen(row.id, frozen);
  return { id: row.id, frozen, changed: true };
}

/**
 * Self-serve or operator deletion. Refuses while any order, position, pay
 * lock, pending cash movement, chargeback, resting quote, or available
 * balance remains. Never posts a debit. A second call after close does not
 * debit either. A missing book reader refuses; it is not treated as flat.
 */
export async function requestAccountDeletion(
  store: TradeIdentityStore,
  input: { userId: string; book: CloseBook | null },
): Promise<CloseResult> {
  const user = await store.getUser(input.userId);
  if (!user) throw new TradeIdentityAuthError('User not found', 'auth.not_found');
  if (user.status === 'closed') {
    return {
      completed: true,
      status: 'closed',
      code: null,
      blockedBy: null,
      orderHold: input.book?.orderHold ?? '',
      debited: false,
      apiKeysRevoked: 0,
      makerKeyCanPlace: false,
      repeated: true,
    };
  }
  if (input.book === null) {
    return {
      completed: false,
      status: user.status,
      code: 'auth.close_book_unwired',
      blockedBy: 'book',
      orderHold: '',
      debited: false,
      apiKeysRevoked: 0,
      makerKeyCanPlace: await makerCanPlace(store, user.id, user.status),
      repeated: false,
    };
  }
  const hold = input.book.orderHold;
  const blocked = blocker(input.book);
  if (blocked) {
    return {
      completed: false,
      status: user.status,
      code: blocked.code,
      blockedBy: blocked.blockedBy,
      orderHold: hold,
      debited: false,
      apiKeysRevoked: 0,
      makerKeyCanPlace: await makerCanPlace(store, user.id, user.status),
      repeated: false,
    };
  }
  const closed = await store.closeUser(user.id);
  const apiKeysRevoked = await store.revokeLiveApiKeys(user.id);
  const after = await store.getUser(user.id);
  return {
    completed: closed || after?.status === 'closed',
    status: 'closed',
    code: null,
    blockedBy: null,
    orderHold: hold,
    debited: false,
    apiKeysRevoked,
    makerKeyCanPlace: false,
    repeated: false,
  };
}

/**
 * A frozen account's revoked session is replaced by a session whose access
 * token carries trade:read and not trade:write. The old session stays revoked.
 */
export async function replaceRevokedSessionWithFrozenRead(
  store: TradeIdentityStore,
  input: { userId: string; revokedSessionId: string },
): Promise<{ sessionId: string; scopes: readonly string[]; readOnly: true }> {
  const user = await store.getUser(input.userId);
  if (!user) throw new TradeIdentityAuthError('User not found', 'auth.not_found');
  if (user.status === 'closed') {
    throw new TradeIdentityAuthError('Closed accounts cannot open a read session', 'auth.account_frozen');
  }
  if (user.status !== 'frozen') {
    throw new TradeIdentityAuthError('A read-only replacement is only for a frozen account', 'auth.frozen_read_denied');
  }
  const session = await store.getSession(input.revokedSessionId);
  if (!session || session.userId !== input.userId || !session.revoked) {
    throw new TradeIdentityAuthError('The session to replace must already be revoked', 'auth.frozen_read_denied');
  }
  const inserted = await store.insertReadOnlySession(input.userId);
  return { sessionId: inserted.id, scopes: [...FROZEN_READ_SCOPES], readOnly: true };
}

/** The fill the frozen read session is allowed to load. Place is a different door. */
export async function fillsForOrderWhileFrozen(input: {
  userId: string;
  orderId: string;
  scopes: readonly string[];
  accountStatus: string;
  readFill: ((userId: string, orderId: string) => Promise<OwnFill | null>) | null;
}): Promise<OwnFill> {
  if (input.accountStatus !== 'frozen') {
    throw new TradeIdentityAuthError('Fills while frozen require a frozen account', 'auth.frozen_read_denied');
  }
  if (!input.scopes.includes('trade:read')) {
    throw new TradeIdentityAuthError('trade:read is required to load a fill', 'auth.frozen_read_denied');
  }
  if (!input.readFill) {
    throw new TradeIdentityAuthError(
      'Fill reader is not wired — trade.fills stays in svc-trade, so this door refuses instead of inventing a fill',
      'auth.frozen_fills_unwired',
    );
  }
  const fill = await input.readFill(input.userId, input.orderId);
  if (!fill || fill.userId !== input.userId || fill.orderId !== input.orderId) {
    throw new TradeIdentityAuthError('Fill not found for that order', 'auth.fill_not_found');
  }
  return fill;
}

/** New order admission for a frozen account. Always refused. Does not cancel resting orders. */
export function admitNewOrderWhileFrozen(accountStatus: string): { admitted: false; code: 'auth.account_frozen' } {
  if (accountStatus !== 'frozen') {
    throw new TradeIdentityAuthError('This door only answers a frozen account', 'auth.frozen_read_denied');
  }
  return { admitted: false, code: 'auth.account_frozen' };
}

export async function logoutAllSessions(store: TradeIdentityStore, userId: string): Promise<number> {
  return store.revokeLiveSessions(userId);
}

/** A staff unfreeze requires a live session row. Logout leaves the row revoked. */
export async function assertStaffSessionLive(store: TradeIdentityStore, sessionId: string, officerUserId: string): Promise<void> {
  const session = await store.getSession(sessionId);
  if (!session || session.userId !== officerUserId || session.revoked) {
    throw new TradeIdentityAuthError('A revoked staff session cannot unfreeze a customer', 'auth.session_revoked');
  }
}

/**
 * Officer logout, then the lost device's unfreeze. The customer stays frozen.
 * Resting orders are not an argument of logout, and this function does not write them.
 */
export async function lostPhoneCannotUnfreeze(
  store: TradeIdentityStore,
  input: {
    officerUserId: string;
    officerSessionId: string;
    customerUserId: string;
    orders: readonly RestingOrder[];
  },
): Promise<{
  customerStatus: AccountStatus;
  code: 'auth.session_revoked';
  firstLogout: number;
  secondLogout: number;
  orders: readonly RestingOrder[];
}> {
  const before = input.orders.map((order) => ({ ...order }));
  const firstLogout = await logoutAllSessions(store, input.officerUserId);
  const secondLogout = await logoutAllSessions(store, input.officerUserId);
  let refused = false;
  try {
    await assertStaffSessionLive(store, input.officerSessionId, input.officerUserId);
  } catch (err) {
    if (!(err instanceof TradeIdentityAuthError) || err.code !== 'auth.session_revoked') throw err;
    refused = true;
  }
  if (!refused) {
    throw new TradeIdentityAuthError('The lost session was still live', 'auth.session_revoked');
  }
  const customer = await store.getUser(input.customerUserId);
  if (!customer) throw new TradeIdentityAuthError('User not found', 'auth.not_found');
  if (JSON.stringify(input.orders) !== JSON.stringify(before)) {
    throw new TradeIdentityAuthError('Officer logout must not change customer orders', 'auth.account_frozen');
  }
  return {
    customerStatus: customer.status,
    code: 'auth.session_revoked',
    firstLogout,
    secondLogout,
    orders: before,
  };
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return n;
}

export function createSqlTradeIdentityStore(sql: Sql): TradeIdentityStore {
  return {
    async getApiKey(id) {
      const rows = await sql<Array<{ id: string; user_id: string; revoked: boolean }>>`
        SELECT id, user_id, revoked FROM api_keys WHERE id = ${id} LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return { id: row.id, userId: row.user_id, revoked: row.revoked };
    },
    async getSubAccount(id) {
      const rows = await sql<Array<{ id: string; parent_user_id: string; revoked: boolean; frozen: number | string }>>`
        SELECT id, parent_user_id, revoked, frozen FROM sub_accounts WHERE id = ${id} LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        parentUserId: row.parent_user_id,
        revoked: row.revoked,
        frozen: frozenFlag(num(row.frozen)),
      };
    },
    async setSubAccountFrozen(id, frozen) {
      await sql`UPDATE sub_accounts SET frozen = ${frozen} WHERE id = ${id}`;
    },
    async getUser(id) {
      const rows = await sql<Array<{ id: string; status: string }>>`
        SELECT id, status FROM users WHERE id = ${id} LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return { id: row.id, status: asStatus(row.status) };
    },
    async closeUser(id) {
      const result = await sql`
        UPDATE users
        SET status = 'closed', identity_control_version = identity_control_version + 1, updated_at = now()
        WHERE id = ${id} AND status <> 'closed'
      `;
      return result.count > 0;
    },
    async getSession(id) {
      const rows = await sql<Array<{ id: string; user_id: string; revoked: boolean }>>`
        SELECT id, user_id, revoked FROM sessions WHERE id = ${id} LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return { id: row.id, userId: row.user_id, revoked: row.revoked };
    },
    async revokeLiveSessions(userId) {
      const result = await sql`UPDATE sessions SET revoked = true WHERE user_id = ${userId} AND revoked = false`;
      return result.count;
    },
    async insertReadOnlySession(userId) {
      const refreshHash = hashToken(generateToken(48));
      const expiresAt = new Date(Date.now() + READ_ONLY_SESSION_MS);
      const rows = await sql<Array<{ id: string }>>`
        INSERT INTO sessions (user_id, refresh_hash, mfa, expires_at)
        VALUES (${userId}, ${refreshHash}, false, ${expiresAt})
        RETURNING id
      `;
      const row = rows[0];
      if (!row) throw new TradeIdentityAuthError('Read session was not stored', 'auth.not_found');
      return { id: row.id };
    },
    async listApiKeys(userId) {
      const rows = await sql<Array<{ id: string; revoked: boolean }>>`
        SELECT id, revoked FROM api_keys WHERE user_id = ${userId}
      `;
      return rows.map((row) => ({ id: row.id, revoked: row.revoked }));
    },
    async revokeLiveApiKeys(userId) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = 'account_closed' WHERE user_id = ${userId} AND revoked = false RETURNING id
      `;
      return rows.length;
    },
  };
}
