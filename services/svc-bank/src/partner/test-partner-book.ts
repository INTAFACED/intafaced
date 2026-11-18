import { randomBytes } from 'node:crypto';
import type { Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { partnerPayInsAccount, type PartnerAccountRef, type PartnerMove } from './partner-bank.js';

/**
 * THE TEST PARTNER'S BOOK: the one owner of what the TEST partner holds. Every account it holds,
 * every move it made and every id it gives live here; a capability (the bank, purchases, direct debits, compliance) reads
 * and changes it only through this, so no capability keeps a second balance. It holds no money: TEST figures only.
 */

export const TEST_PARTNER_LABEL = 'TEST partner bank';

/**
 * The most moves the TEST book keeps. Past it a move refuses `bank.partner_unavailable` (nothing moves) rather than
 * forget one: money state is never evicted. A restart empties the book, as it puts every switch back off.
 */
export const MAX_MOVES = 200_000;

export function accountKey(ref: PartnerAccountRef): string {
  return `${ref.userId}|${ref.assetId}|${ref.spaceId ?? 'main'}`;
}

/** The account an `accountKey` names. */
export function accountOf(key: string): PartnerAccountRef {
  const [userId, assetId, space] = key.split('|') as [string, string, string];
  return { userId, assetId, spaceId: space === 'main' ? null : space };
}

export function sameAccount(a: PartnerAccountRef, b: PartnerAccountRef): boolean {
  return accountKey(a) === accountKey(b);
}

export function partnerDown(): BankError {
  return new BankError('The partner bank is not answering. Nothing was sent or changed.', 'bank.partner_unavailable');
}

export function moveConflict(key: string): BankError {
  return new BankError(`The partner already holds a different move under ${key}, so this one was not made.`, 'bank.partner_move_conflict');
}

export type TestPartnerIdKind = 'move' | 'quote' | 'payment';

export interface TestPartnerBook {
  /** Scaled bigint per partner account (`accountKey`). An account the partner holds and nobody has paid into holds 0. */
  readonly held: Map<string, bigint>;
  /** Every instructed move, by its key: one key is one move. */
  readonly byKey: Map<string, PartnerMove>;
  /** Each person's moves and pay-ins, oldest first; a move between two people is on both lists. */
  readonly byPerson: Map<string, PartnerMove[]>;
  /** What an account holds now. */
  amount(account: PartnerAccountRef): bigint;
  /** Adds `delta` (negative to take) to an account, in one step. */
  add(account: PartnerAccountRef, delta: bigint): void;
  /** A fresh id of this kind, unique to this process. */
  nextId(kind: TestPartnerIdKind): string;
  /** Puts an instructed move on the book under its key, and on each of its people's records. */
  remember(move: PartnerMove): void;
  /** A move the partner itself makes from `from` to `to` under `key`, recorded once; the caller checks it may be made. */
  transfer(key: string, from: PartnerAccountRef, to: PartnerAccountRef, amount: Amount): PartnerMove;
  /** Puts an entry on one person's record only, never under a move key: a pay-in or its return, which nobody instructed. */
  note(userId: string, entry: PartnerMove): void;
  /** A pay-in into `account` on the partner's record under `key`, credited; listed only to a reader that asks for pay-ins. */
  payIn(account: PartnerAccountRef, key: string, amount: Amount): string;
}

export function testPartnerBook(): TestPartnerBook {
  const held = new Map<string, bigint>();
  const byKey = new Map<string, PartnerMove>();
  const byPerson = new Map<string, PartnerMove[]>();
  let seq = 0;
  /**
   * Unique to this process, so a move reference is never reused after a restart: a note kept in svc-bank's database
   * against an earlier process's move must never attach to a new move with the same sequence number.
   */
  const boot = randomBytes(6).toString('hex');

  const amount = (account: PartnerAccountRef) => held.get(accountKey(account)) ?? 0n;
  const add = (account: PartnerAccountRef, delta: bigint) => {
    held.set(accountKey(account), amount(account) + delta);
  };
  const nextId = (kind: TestPartnerIdKind) => {
    seq += 1;
    return `test-partner-${kind}-${boot}-${String(seq).padStart(12, '0')}`;
  };
  const note = (userId: string, entry: PartnerMove) => {
    const list = byPerson.get(userId) ?? [];
    list.push(entry);
    byPerson.set(userId, list);
  };
  const remember = (move: PartnerMove) => {
    byKey.set(move.key, move);
    for (const userId of new Set([move.from.userId, move.to.userId])) note(userId, move);
  };
  return {
    held,
    byKey,
    byPerson,
    amount,
    add,
    nextId,
    remember,
    note,
    transfer(key, from, to, value) {
      const move: PartnerMove = Object.freeze({
        id: nextId('move'),
        key,
        from: Object.freeze({ ...from }),
        to: Object.freeze({ ...to }),
        amount: value,
        movedAt: new Date(),
        label: TEST_PARTNER_LABEL,
      });
      add(from, -value);
      add(to, value);
      remember(move);
      return move;
    },
    payIn(account, key, value) {
      const id = nextId('move');
      add(account, value);
      note(
        account.userId,
        Object.freeze({
          id,
          key,
          from: Object.freeze(partnerPayInsAccount(account.assetId)),
          to: Object.freeze({ ...account }),
          amount: value,
          movedAt: new Date(),
          label: TEST_PARTNER_LABEL,
        }),
      );
      return id;
    },
  };
}
