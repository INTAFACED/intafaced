import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  admitNewOrderWhileFrozen,
  fillsForOrderWhileFrozen,
  lostPhoneCannotUnfreeze,
  replaceRevokedSessionWithFrozenRead,
  requestAccountDeletion,
  setSubAccountFrozen,
  type ApiKeyRow,
  type CloseBook,
  type SessionRow,
  type SubAccountRow,
  type TradeIdentityStore,
  type UserRow,
} from './trade-identity-auth.js';

const PARENT = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '55555555-5555-4555-8555-555555555555';
const OFFICER = '66666666-6666-4666-8666-666666666666';
const OFFICER_SESSION = '77777777-7777-4777-8777-777777777777';
const ORDER = '88888888-8888-4888-8888-888888888888';
const FILL = '99999999-9999-4999-8999-999999999999';
const MAKER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MAKER_KEY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REVOKED_SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** Illustrative figures are marked TEST. They are not balances a customer is shown. */
const TEST_HOLD = 'TEST:4.25';
const TEST_AVAILABLE = 'TEST:1.50';
const TEST_QTY = 'TEST:1';

function flat(over: Partial<CloseBook> = {}): CloseBook {
  return {
    openOrders: 0,
    openPositions: 0,
    payEscrow: 0,
    pendingDeposits: 0,
    pendingWithdrawals: 0,
    payRequests: 0,
    chargebacks: 0,
    restingQuotes: 0,
    available: '0',
    orderHold: '0',
    ...over,
  };
}

function memory() {
  const users = new Map<string, UserRow>();
  const keys = new Map<string, ApiKeyRow>();
  const subs = new Map<string, SubAccountRow>();
  const sessions = new Map<string, SessionRow>();
  let freezeWrites = 0;
  let nextSession = 0;
  const store: TradeIdentityStore = {
    async getApiKey(id) {
      return keys.get(id) ?? null;
    },
    async getSubAccount(id) {
      const row = subs.get(id);
      return row ? { ...row } : null;
    },
    async setSubAccountFrozen(id, frozen) {
      const row = subs.get(id);
      if (!row) return;
      freezeWrites += 1;
      row.frozen = frozen;
    },
    async getUser(id) {
      const row = users.get(id);
      return row ? { ...row } : null;
    },
    async closeUser(id) {
      const row = users.get(id);
      if (!row || row.status === 'closed') return false;
      row.status = 'closed';
      return true;
    },
    async getSession(id) {
      const row = sessions.get(id);
      return row ? { ...row } : null;
    },
    async revokeLiveSessions(userId) {
      let n = 0;
      for (const row of sessions.values()) {
        if (row.userId === userId && !row.revoked) {
          row.revoked = true;
          n += 1;
        }
      }
      return n;
    },
    async insertReadOnlySession(userId) {
      nextSession += 1;
      const id = `dddddddd-dddd-4ddd-8ddd-${String(nextSession).padStart(12, '0')}`;
      sessions.set(id, { id, userId, revoked: false });
      return { id };
    },
    async listApiKeys(userId) {
      return [...keys.values()].filter((key) => key.userId === userId).map((key) => ({ id: key.id, revoked: key.revoked }));
    },
    async revokeLiveApiKeys(userId) {
      let n = 0;
      for (const key of keys.values()) {
        if (key.userId === userId && !key.revoked) {
          key.revoked = true;
          n += 1;
        }
      }
      return n;
    },
  };
  return {
    store,
    users,
    keys,
    subs,
    sessions,
    freezeWrites: () => freezeWrites,
  };
}

function liveSub(box: ReturnType<typeof memory>, frozen: 0 | 1 = 0) {
  box.users.set(PARENT, { id: PARENT, status: 'active' });
  box.keys.set(KEY, { id: KEY, userId: PARENT, revoked: false });
  box.subs.set(SUB, { id: SUB, parentUserId: PARENT, revoked: false, frozen });
}

describe('TRD-0165 parent freezes one sub-account id and later unfreezes that same id', () => {
  it('sets frozen to 1 and later to 0 on the same id', async () => {
    const box = memory();
    liveSub(box);
    const frozen = await setSubAccountFrozen(box.store, {
      parentUserId: PARENT,
      parentApiKeyId: KEY,
      subAccountId: SUB,
      frozen: 1,
    });
    expect(frozen).toEqual({ id: SUB, frozen: 1, changed: true });
    expect(box.subs.get(SUB)?.frozen).toBe(1);
    const active = await setSubAccountFrozen(box.store, {
      parentUserId: PARENT,
      parentApiKeyId: KEY,
      subAccountId: SUB,
      frozen: 0,
    });
    expect(active).toEqual({ id: SUB, frozen: 0, changed: true });
    expect(active.id).toBe(SUB);
    expect(box.subs.get(SUB)?.id).toBe(SUB);
  });

  it('refuses a freeze call without the parent key and does not change the flag', async () => {
    const box = memory();
    liveSub(box);
    await expect(
      setSubAccountFrozen(box.store, { parentUserId: PARENT, parentApiKeyId: null, subAccountId: SUB, frozen: 1 }),
    ).rejects.toMatchObject({ code: 'auth.parent_key_required' });
    await expect(
      setSubAccountFrozen(box.store, { parentUserId: PARENT, parentApiKeyId: '  ', subAccountId: SUB, frozen: 1 }),
    ).rejects.toMatchObject({ code: 'auth.parent_key_required' });
    box.keys.set(OTHER, { id: OTHER, userId: CUSTOMER, revoked: false });
    await expect(
      setSubAccountFrozen(box.store, { parentUserId: PARENT, parentApiKeyId: OTHER, subAccountId: SUB, frozen: 1 }),
    ).rejects.toMatchObject({ code: 'auth.parent_key_required' });
    box.keys.set(KEY, { id: KEY, userId: PARENT, revoked: true });
    await expect(
      setSubAccountFrozen(box.store, { parentUserId: PARENT, parentApiKeyId: KEY, subAccountId: SUB, frozen: 1 }),
    ).rejects.toMatchObject({ code: 'auth.parent_key_required' });
    expect(box.subs.get(SUB)?.frozen).toBe(0);
    expect(box.freezeWrites()).toBe(0);
  });

  it('unfreeze uses the same id', async () => {
    const box = memory();
    liveSub(box, 1);
    const active = await setSubAccountFrozen(box.store, {
      parentUserId: PARENT,
      parentApiKeyId: KEY,
      subAccountId: SUB,
      frozen: 0,
    });
    expect(active.id).toBe(SUB);
    expect(box.subs.size).toBe(1);
  });

  it('freezing an already frozen id is a no-op on the frozen parameter', async () => {
    const box = memory();
    liveSub(box);
    await setSubAccountFrozen(box.store, { parentUserId: PARENT, parentApiKeyId: KEY, subAccountId: SUB, frozen: 1 });
    const again = await setSubAccountFrozen(box.store, {
      parentUserId: PARENT,
      parentApiKeyId: KEY,
      subAccountId: SUB,
      frozen: 1,
    });
    expect(again).toEqual({ id: SUB, frozen: 1, changed: false });
    expect(box.freezeWrites()).toBe(1);
    expect(box.subs.get(SUB)?.frozen).toBe(1);
  });
});

describe('TRD-0210 a frozen account can read its fill and cannot place', () => {
  it('returns the fill for that order and refuses a new order', async () => {
    const opened = await replaceRevokedSessionWithFrozenRead(liveFrozen().store, {
      userId: CUSTOMER,
      revokedSessionId: REVOKED_SESSION,
    });
    expect(opened.scopes).toEqual(['identity:read', 'ledger:read', 'trade:read']);
    expect(opened.readOnly).toBe(true);
    const fill = await fillsForOrderWhileFrozen({
      userId: CUSTOMER,
      orderId: ORDER,
      scopes: opened.scopes,
      accountStatus: 'frozen',
      readFill: async (userId, orderId) => ({ id: FILL, orderId, userId, qty: TEST_QTY }),
    });
    expect(fill).toEqual({ id: FILL, orderId: ORDER, userId: CUSTOMER, qty: TEST_QTY });
    expect(admitNewOrderWhileFrozen('frozen')).toEqual({ admitted: false, code: 'auth.account_frozen' });
  });

  it('replaces a revoked session with a read-only session that still loads the fill', async () => {
    const box = liveFrozen();
    const opened = await replaceRevokedSessionWithFrozenRead(box.store, {
      userId: CUSTOMER,
      revokedSessionId: REVOKED_SESSION,
    });
    expect(box.sessions.get(REVOKED_SESSION)?.revoked).toBe(true);
    expect(opened.sessionId).not.toBe(REVOKED_SESSION);
    expect(opened.scopes).not.toContain('trade:write');
    const fill = await fillsForOrderWhileFrozen({
      userId: CUSTOMER,
      orderId: ORDER,
      scopes: opened.scopes,
      accountStatus: 'frozen',
      readFill: async () => ({ id: FILL, orderId: ORDER, userId: CUSTOMER, qty: TEST_QTY }),
    });
    expect(fill.id).toBe(FILL);
    await expect(
      fillsForOrderWhileFrozen({
        userId: CUSTOMER,
        orderId: ORDER,
        scopes: opened.scopes,
        accountStatus: 'frozen',
        readFill: null,
      }),
    ).rejects.toMatchObject({ code: 'auth.frozen_fills_unwired' });
  });
});

function liveFrozen() {
  const box = memory();
  box.users.set(CUSTOMER, { id: CUSTOMER, status: 'frozen' });
  box.sessions.set(REVOKED_SESSION, { id: REVOKED_SESSION, userId: CUSTOMER, revoked: true });
  return box;
}

describe('TRD-0282 operator close is refused while an order or escrow remains', () => {
  it('does not complete deletion and leaves the order hold unchanged', async () => {
    const box = memory();
    box.users.set(CUSTOMER, { id: CUSTOMER, status: 'active' });
    const book = Object.freeze(flat({ openOrders: 1, orderHold: TEST_HOLD }));
    const result = await requestAccountDeletion(box.store, { userId: CUSTOMER, book });
    expect(result.completed).toBe(false);
    expect(result.code).toBe('auth.close_open_book');
    expect(result.blockedBy).toBe('open_order');
    expect(result.orderHold).toBe(TEST_HOLD);
    expect(result.debited).toBe(false);
    expect(book.orderHold).toBe(TEST_HOLD);
    expect(book.openOrders).toBe(1);
    expect(box.users.get(CUSTOMER)?.status).toBe('active');
  });

  it('refuses escrow, requires a withdrawal when available remains, and a second close does not debit', async () => {
    const box = memory();
    box.users.set(CUSTOMER, { id: CUSTOMER, status: 'active' });
    const escrow = await requestAccountDeletion(box.store, {
      userId: CUSTOMER,
      book: flat({ payEscrow: 1, orderHold: TEST_HOLD }),
    });
    expect(escrow.completed).toBe(false);
    expect(escrow.blockedBy).toBe('escrow');
    expect(escrow.debited).toBe(false);
    const owed = await requestAccountDeletion(box.store, {
      userId: CUSTOMER,
      book: flat({ available: TEST_AVAILABLE }),
    });
    expect(owed.code).toBe('auth.close_withdrawal_required');
    expect(owed.completed).toBe(false);
    expect(box.users.get(CUSTOMER)?.status).toBe('active');
    const first = await requestAccountDeletion(box.store, { userId: CUSTOMER, book: flat() });
    expect(first.completed).toBe(true);
    expect(first.debited).toBe(false);
    expect(first.status).toBe('closed');
    const second = await requestAccountDeletion(box.store, { userId: CUSTOMER, book: flat() });
    expect(second.repeated).toBe(true);
    expect(second.debited).toBe(false);
    expect(second.apiKeysRevoked).toBe(0);
    expect(box.users.get(CUSTOMER)?.status).toBe('closed');
  });

  it('refuses when the book reader is absent instead of treating the book as flat', async () => {
    const box = memory();
    box.users.set(CUSTOMER, { id: CUSTOMER, status: 'active' });
    const result = await requestAccountDeletion(box.store, { userId: CUSTOMER, book: null });
    expect(result).toMatchObject({ completed: false, code: 'auth.close_book_unwired', debited: false, status: 'active' });
  });
});

describe('TRD-0292 maker close is refused while a bid rests, and close revokes the maker key', () => {
  it('refuses the live bid, then a flat close leaves the key unable to place', async () => {
    const box = memory();
    box.users.set(MAKER, { id: MAKER, status: 'active' });
    box.keys.set(MAKER_KEY, { id: MAKER_KEY, userId: MAKER, revoked: false });
    const blocked = await requestAccountDeletion(box.store, {
      userId: MAKER,
      book: flat({ restingQuotes: 1, orderHold: TEST_HOLD }),
    });
    expect(blocked.completed).toBe(false);
    expect(blocked.blockedBy).toBe('quote');
    expect(blocked.makerKeyCanPlace).toBe(true);
    expect(box.keys.get(MAKER_KEY)?.revoked).toBe(false);
    const closed = await requestAccountDeletion(box.store, { userId: MAKER, book: flat({ available: '0.00' }) });
    expect(closed.completed).toBe(true);
    expect(closed.makerKeyCanPlace).toBe(false);
    expect(closed.debited).toBe(false);
    expect(box.keys.get(MAKER_KEY)?.revoked).toBe(true);
    expect(box.users.get(MAKER)?.status).toBe('closed');
    const again = await requestAccountDeletion(box.store, { userId: MAKER, book: flat() });
    expect(again.debited).toBe(false);
    expect(again.apiKeysRevoked).toBe(0);
  });
});

describe('TRD-0298 self-serve close is refused while an order remains', () => {
  it('does not complete deletion and the order remains', async () => {
    const box = memory();
    box.users.set(CUSTOMER, { id: CUSTOMER, status: 'active' });
    const order = { id: ORDER, status: 'open' as const };
    const result = await requestAccountDeletion(box.store, {
      userId: CUSTOMER,
      book: flat({ openOrders: 1, orderHold: TEST_HOLD }),
    });
    expect(result.completed).toBe(false);
    expect(result.code).toBe('auth.close_open_book');
    expect(order).toEqual({ id: ORDER, status: 'open' });
    expect(box.users.get(CUSTOMER)?.status).toBe('active');
    const owed = await requestAccountDeletion(box.store, {
      userId: CUSTOMER,
      book: flat({ available: '0.10' }),
    });
    expect(owed.blockedBy).toBe('balance');
    expect(owed.debited).toBe(false);
  });
});

describe('TRD-0309 a lost officer phone cannot unfreeze a customer', () => {
  it('refuses unfreeze after logoutAll, leaves the customer frozen, and does not touch resting orders', async () => {
    const box = memory();
    box.users.set(CUSTOMER, { id: CUSTOMER, status: 'frozen' });
    box.users.set(OFFICER, { id: OFFICER, status: 'active' });
    box.sessions.set(OFFICER_SESSION, { id: OFFICER_SESSION, userId: OFFICER, revoked: false });
    const orders = [{ id: ORDER, userId: CUSTOMER, status: 'open' as const }];
    const result = await lostPhoneCannotUnfreeze(box.store, {
      officerUserId: OFFICER,
      officerSessionId: OFFICER_SESSION,
      customerUserId: CUSTOMER,
      orders,
    });
    expect(result.code).toBe('auth.session_revoked');
    expect(result.customerStatus).toBe('frozen');
    expect(result.firstLogout).toBe(1);
    expect(result.secondLogout).toBe(0);
    expect(box.sessions.get(OFFICER_SESSION)?.revoked).toBe(true);
    expect(orders).toEqual([{ id: ORDER, userId: CUSTOMER, status: 'open' }]);
    expect(box.users.get(CUSTOMER)?.status).toBe('frozen');
  });
});

describe('close does not post a ledger entry', () => {
  it('the module source does not import the ledger client', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'trade-identity-auth.ts'), 'utf8');
    expect(src).not.toMatch(/ledger-client/);
    expect(src).not.toMatch(/ledger\.post/);
  });
});
