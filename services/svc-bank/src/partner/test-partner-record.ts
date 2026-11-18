import { formatAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { PartnerAccountRef, PartnerMove } from './partner-bank.js';
import type { PartnerDirectDebitRefund } from './partner-direct-debits.js';
import { type TestPartner } from './test-partner.js';
import { TEST_PARTNER_LABEL } from './test-partner-book.js';

/**
 * LOCAL TEST: the TEST partner bank's own book, read straight from the stand-in on loopback (J-bank-03 #4/#5).
 *
 * At launch a partner-held person's money and its moves are the partner's (OWNER 226), so a journey proves the app shows
 * what the partner itself recorded by reading the partner's record, never the app's figure back through our own doors.
 * On the stack the partner is the TEST stand-in (`test-partner.ts`), so this is the stand-in's statement: its book for one
 * person, read from `TestPartner.record` and never through `PartnerBank` (no switch shapes it), Edge or a customer
 * procedure. It answers in the shape the journeys' outside-record read speaks (apps/customer/tests/real-app/venue.mjs
 * `venueRecord`): `GET <base>/venue` names it, and `POST <base>/<path>` takes `{ account: { venueId, owner } }`, with
 * `owner` the person's user id and amounts as decimal strings. `POST <base>/direct-debits` answers its direct debit book
 * (J-bank-28 #4), and `POST <base>/dd-refund` with `{ owner, mandateId, collectionId }` is the stand-in giving a collected
 * debit back under the scheme's refund guarantee, once.
 *
 * Mounted only with the TEST partner (`BANK_TEST_PARTNER=test`, which refuses to start outside `dev`/`test`), and only
 * for a caller on loopback. Never part of a real environment.
 */

/** Where svc-bank serves the stand-in's record. */
export const TEST_PARTNER_RECORD_BASE = '/test-partner';
/** The stand-in's id in its own record. */
export const TEST_PARTNER_RECORD_ID = 'test-partner-bank';

const ref = (a: PartnerAccountRef) => ({ owner: a.userId, assetId: a.assetId, spaceId: a.spaceId });
const moveLine = (m: PartnerMove) => ({
  id: m.id,
  key: m.key,
  from: ref(m.from),
  to: ref(m.to),
  amount: formatAmount(m.amount),
  movedAt: m.movedAt.toISOString(),
});

const refundLine = (r: PartnerDirectDebitRefund) => ({
  owner: r.userId,
  mandateId: r.mandateId,
  collectionId: r.collectionId,
  assetId: r.assetId,
  amount: formatAmount(r.amount),
  moveId: r.moveId,
  refundedAt: r.refundedAt.toISOString(),
});

/** The stand-in's own direct debit book (J-bank-28 #4): its mandates, its refusals and its refunds. */
function directDebitLines(partner: TestPartner) {
  const report = partner.directDebitReport();
  return {
    mandates: report.mandates.map((m) => ({
      owner: m.userId,
      mandateId: m.mandateId,
      state: m.state,
      blockedAt: m.blockedAt ? m.blockedAt.toISOString() : null,
    })),
    failures: report.failures.map((f) => ({ owner: f.userId, mandateId: f.mandateId, collectionId: f.collectionId, code: f.code })),
    refunds: report.refunds.map(refundLine),
  };
}

/** One request's answer: `[status, body]`. `path` is below the base (`/venue`, `/balances`, `/moves`). */
export function answerTestPartnerRecord(partner: TestPartner, method: string, path: string, body: unknown): [number, unknown] {
  if (path === '/venue') {
    if (method !== 'GET') return [405, { error: 'GET only' }];
    return [200, { label: 'TEST', venue: { id: TEST_PARTNER_RECORD_ID, displayName: TEST_PARTNER_LABEL } }];
  }
  if (path === '/direct-debits') {
    if (method !== 'POST') return [405, { error: 'POST only' }];
    return [200, { label: 'TEST', value: directDebitLines(partner) }];
  }
  if (path === '/dd-refund') {
    if (method !== 'POST') return [405, { error: 'POST only' }];
    const ask = (body ?? {}) as { owner?: unknown; mandateId?: unknown; collectionId?: unknown };
    if (typeof ask.owner !== 'string' || typeof ask.mandateId !== 'string' || typeof ask.collectionId !== 'string') {
      return [400, { error: 'owner, mandateId and collectionId are required' }];
    }
    try {
      const r = partner.refundDirectDebit(ask.owner, ask.mandateId, ask.collectionId);
      return [200, { label: 'TEST', value: refundLine(r) }];
    } catch (err) {
      if (err instanceof BankError) return [409, { error: err.message, code: err.code }];
      throw err;
    }
  }
  if (path !== '/balances' && path !== '/moves') return [404, { error: 'no such path' }];
  if (method !== 'POST') return [405, { error: 'POST only' }];
  const account = (body as { account?: { venueId?: unknown; owner?: unknown; subAccount?: unknown } } | null)?.account;
  if (account?.venueId !== TEST_PARTNER_RECORD_ID) return [400, { error: `account.venueId must be ${TEST_PARTNER_RECORD_ID}` }];
  if (typeof account.owner !== 'string' || account.owner.length === 0) return [400, { error: 'account.owner (a user id) is required' }];
  if (account.subAccount !== null && account.subAccount !== undefined) return [400, { error: 'the partner keeps no sub-accounts' }];
  const book = partner.record(account.owner);
  if (path === '/moves') return [200, { label: 'TEST', value: book.moves.map(moveLine) }];
  // The person's main balance in each currency, in the venue read's row shape: nothing is locked at the partner.
  const value = book.accounts
    .filter((a) => a.account.spaceId === null)
    .map((a) => ({ asset: a.account.assetId, free: formatAmount(a.amount), locked: '0', total: formatAmount(a.amount) }));
  return [200, { label: 'TEST', value }];
}

/** A caller on this machine's loopback, the only one the record answers. */
export function onLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
