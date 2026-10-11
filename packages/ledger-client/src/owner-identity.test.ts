import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryLedger } from './memory-ledger.js';
import { parseAmount as amt } from './money.js';
import { assertOwnerIdentifierSpace, assertValidPost } from './client.js';
import {
  burnAccount,
  houseFees,
  merchantClearing,
  moduleAccount,
  orderHoldAccount,
  railBoundary,
  subAccountAvailable,
  userAvailable,
  venueBoundary,
} from './accounts.js';
import {
  OwnerIdentitySpaceError,
  accountRefSchema,
  entryInputSchema,
  isValidOwnerId,
  ownerIdSpace,
  postRequestSchema,
  type AccountRef,
  type OwnerType,
} from './types.js';

/**
 * THE ADAPTER TEST (§4.2, ADR 2026-08-02 "adopt the vendored product, keep our
 * ledger").
 *
 * The ADR keeps the vendored product's money controllers and redirects only
 * their balance writes into our ledger through an adapter. Their member ids are
 * `bigint`; ours are `uuid`; `ledger.accounts.owner_id` was `text` and took
 * either.
 *
 * That combination has no failure mode. It has a SILENCE mode. An adapter that
 * passes the wrong identifier opens a second, individually perfect account for
 * a human who already has one: the transaction sums to zero, the hash chain
 * verifies, reconciliation replays without drift, the non-negative CHECK holds
 * on both rows, and every gate in the repo reports clean. Nothing in the book
 * records that the two owners are one person, because nothing in the book was
 * ever told what an owner id IS.
 *
 * These tests fail on the pre-fix code by PASSING the post. That is the whole
 * point: the bug's signature is a green result, so the test has to assert a
 * refusal.
 */

/** A real `identity.users.id`, taken from the shape Postgres emits. */
const USER_UUID = '0007e7f3-2e25-4dc9-88b4-146db6d491f0';
const OTHER_UUID = '4286702e-ae18-4d68-8764-62d4b53cc145';

/** What the vendored `Member.id` (a `Long`) looks like once it crosses a wire. */
const VENDORED_MEMBER_ID = String(1042n);

function deposit(account: AccountRef, key: string) {
  return {
    idempotencyKey: key,
    module: 'adapter',
    reason: 'vendor.balance.increase',
    entries: [
      { account, direction: 'debit' as const, amount: amt('100') },
      { account: railBoundary('vendor', account.assetId), direction: 'credit' as const, amount: amt('100') },
    ],
  };
}

describe('owner identifier space — the adapter must be refused, not silently accepted', () => {
  let ledger: MemoryLedger;

  beforeEach(() => {
    ledger = new MemoryLedger();
  });

  it('refuses a post that opens a user account from a vendored bigint member id', async () => {
    const request = deposit(userAvailable(VENDORED_MEMBER_ID, 'USDT'), 'deposit:vendor:member:1042');

    await expect(ledger.post(request)).rejects.toThrow(OwnerIdentitySpaceError);
    await expect(ledger.post(request)).rejects.toThrow(/1042/);
  });

  it('opens NO account when it refuses — the refusal is of the creation, not just the movement', async () => {
    await expect(ledger.post(deposit(userAvailable(VENDORED_MEMBER_ID, 'USDT'), 'deposit:vendor:member:1042'))).rejects.toThrow(
      OwnerIdentitySpaceError,
    );

    // The failure being guarded is a SECOND row for one human. If a refused
    // post still left the row behind, the dual book would exist anyway and only
    // the balance would be missing.
    expect(await ledger.balances('user', VENDORED_MEMBER_ID)).toEqual([]);
    const balance = await ledger.balance(userAvailable(VENDORED_MEMBER_ID, 'USDT'));
    expect(balance.accountId).toBe('');
    expect(balance.amount).toBe(0n);
  });

  it('the same human does not end up with two books', async () => {
    await ledger.post(deposit(userAvailable(USER_UUID, 'USDT'), 'deposit:rail:real-user'));

    // The adapter now writes for what it believes is a different owner. Before
    // this fix that post succeeded and this expectation would have been `2`.
    await expect(ledger.post(deposit(userAvailable(VENDORED_MEMBER_ID, 'USDT'), 'deposit:vendor:member:1042'))).rejects.toThrow(
      OwnerIdentitySpaceError,
    );

    expect(await ledger.balances('user', USER_UUID)).toHaveLength(1);
    expect(await ledger.balances('user', VENDORED_MEMBER_ID)).toHaveLength(0);
  });

  it('refuses the mix-up in the other direction — a user UUID in a platform account', () => {
    // A UUID beginning with a hex letter satisfies the platform slug grammar on
    // its own, so this is not hypothetical.
    const hexLeadingUuid = 'a50e8400-e29b-41d4-a716-446655440000';
    expect(isValidOwnerId('house', hexLeadingUuid)).toBe(false);
    expect(isValidOwnerId('treasury', OTHER_UUID)).toBe(false);
    expect(isValidOwnerId('module', VENDORED_MEMBER_ID)).toBe(false);
  });

  it('refuses an uppercase UUID — one human, two spellings, two rows', async () => {
    const upper = USER_UUID.toUpperCase();
    expect(isValidOwnerId('user', upper)).toBe(false);

    await ledger.post(deposit(userAvailable(USER_UUID, 'USDT'), 'deposit:rail:canonical'));
    await expect(ledger.post(deposit(userAvailable(upper, 'USDT'), 'deposit:rail:shouted'))).rejects.toThrow(OwnerIdentitySpaceError);
  });

  it('binds every entry, not only the first', () => {
    expect(() =>
      assertOwnerIdentifierSpace([
        { account: userAvailable(USER_UUID, 'USDT'), direction: 'debit', amount: amt('1') },
        { account: userAvailable(VENDORED_MEMBER_ID, 'USDT'), direction: 'credit', amount: amt('1') },
      ]),
    ).toThrow(OwnerIdentitySpaceError);
  });

  it('binds an AccountRef assembled inline, not only the named constructors', () => {
    const inline: AccountRef = { ownerType: 'user', ownerId: VENDORED_MEMBER_ID, assetId: 'USDT', kind: 'available' };
    expect(() => assertOwnerIdentifierSpace([{ account: inline, direction: 'debit', amount: amt('1') }])).toThrow(OwnerIdentitySpaceError);
  });

  it('runs before the balance checks — a wrong owner is not a rounding problem', () => {
    // Entries that do NOT sum to zero AND carry a wrong-space owner. The owner
    // error must surface, because "your entries are off by 1" would send an
    // adapter author looking in entirely the wrong place.
    expect(() =>
      assertValidPost({
        idempotencyKey: 'vendor:increase:1042',
        module: 'adapter',
        reason: 'vendor.balance.increase',
        entries: [
          { account: userAvailable(VENDORED_MEMBER_ID, 'USDT'), direction: 'debit', amount: amt('100') },
          { account: railBoundary('vendor', 'USDT'), direction: 'credit', amount: amt('99') },
        ],
      }),
    ).toThrow(OwnerIdentitySpaceError);
  });

  it('carries its own error code, so an adapter can tell "wrong id" from "our bug"', () => {
    const err = new OwnerIdentitySpaceError('user', VENDORED_MEMBER_ID);
    expect(err.code).toBe('ledger.owner_identity_space');
    expect(err.ownerType).toBe('user');
    expect(err.ownerId).toBe(VENDORED_MEMBER_ID);
  });
});

describe('owner identifier space — the accounts every module already opens still open', () => {
  const accepted: Array<[string, AccountRef]> = [
    ['user available', userAvailable(USER_UUID, 'USDT')],
    ['user order hold', orderHoldAccount(USER_UUID, 'USDT', '52ea6a49-3b4a-8966-a083-116c46aa71bc')],
    ['sub-account', subAccountAvailable(OTHER_UUID, 'BTC')],
    ['house fees', houseFees('trade', 'USDT')],
    ['house burn', burnAccount('IFC')],
    ['module', moduleAccount('bank', 'loan-reserve', 'USDT')],
    ['merchant clearing (a UUID in a later segment)', merchantClearing(OTHER_UUID, 'USD')],
    ['treasury rail', railBoundary('card-sandbox', 'USDT')],
    ['treasury venue (uppercase venue code)', venueBoundary('BINANCE', 'BTC')],
  ];

  for (const [label, ref] of accepted) {
    it(`accepts ${label}`, () => {
      expect(isValidOwnerId(ref.ownerType, ref.ownerId)).toBe(true);
      expect(() => assertOwnerIdentifierSpace([{ account: ref, direction: 'debit', amount: amt('1') }])).not.toThrow();
    });
  }

  it('declares a space for every owner type — a new owner type cannot be left undeclared', () => {
    const types: OwnerType[] = ['user', 'subaccount', 'module', 'house', 'treasury'];
    for (const t of types) expect(['uuid', 'platform']).toContain(ownerIdSpace(t));
  });
});

describe('owner identifier space — the wire edge refuses it too', () => {
  it('rejects a wrong-space ownerId in accountRefSchema, naming the field', () => {
    const result = accountRefSchema.safeParse({
      ownerType: 'user',
      ownerId: VENDORED_MEMBER_ID,
      assetId: 'USDT',
      kind: 'available',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['ownerId']);
    }
  });

  it('rejects it inside a whole post request', () => {
    const result = postRequestSchema.safeParse({
      idempotencyKey: 'vendor:increase:1042',
      module: 'adapter',
      reason: 'vendor.balance.increase',
      entries: [
        {
          account: { ownerType: 'user', ownerId: VENDORED_MEMBER_ID, assetId: 'USDT', kind: 'available' },
          direction: 'debit',
          amount: '100',
        },
        {
          account: { ownerType: 'treasury', ownerId: 'rail:vendor', assetId: 'USDT', kind: 'available' },
          direction: 'credit',
          amount: '100',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('still accepts a well-formed post', () => {
    const result = postRequestSchema.safeParse({
      idempotencyKey: 'vendor:increase:adapter-mapped',
      module: 'adapter',
      reason: 'vendor.balance.increase',
      entries: [
        { account: { ownerType: 'user', ownerId: USER_UUID, assetId: 'USDT', kind: 'available' }, direction: 'debit', amount: '100' },
        {
          account: { ownerType: 'treasury', ownerId: 'rail:vendor', assetId: 'USDT', kind: 'available' },
          direction: 'credit',
          amount: '100',
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('entry amount — integer digit string length on the wire', () => {
  const account = { ownerType: 'user' as const, ownerId: USER_UUID, assetId: 'USDT', kind: 'available' as const };

  function parsed(amount: string) {
    return entryInputSchema.safeParse({ account, direction: 'debit', amount });
  }

  it('parses an ordinary amount and one with 18 fractional digits', () => {
    expect(parsed('1000').success).toBe(true);
    expect(parsed('1000.000000000000000001').success).toBe(true);
    expect(parsed(`${'9'.repeat(20)}.${'9'.repeat(18)}`).success).toBe(true);
    expect(parsed(`1.${'1'.repeat(18)}`).success).toBe(true);
  });

  it('refuses an integer digit string past that width, including a multi-megabyte one', () => {
    expect(parsed('9'.repeat(21)).success).toBe(false);
    expect(parsed('1'.repeat(2 * 1024 * 1024)).success).toBe(false);
  });

  it('refuses more than 18 fractional digits', () => {
    expect(parsed(`1.${'1'.repeat(19)}`).success).toBe(false);
  });
});
