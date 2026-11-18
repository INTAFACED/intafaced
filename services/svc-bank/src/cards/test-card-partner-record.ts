import type { CardIssuerAdapter, TestCardPartnerBook } from './issuer.js';

/**
 * LOCAL TEST: the TEST card partner's own book on loopback (J-bank-27 #3 #4), as `partner/test-partner-record.ts` is the
 * TEST partner bank's.
 *
 * At launch a card's money, a dispute's provisional credit and who bears a loss are the card partner's (OWNER 226), so a
 * journey proves the app shows what the partner itself recorded by reading the partner's record, never the app's figure
 * back through our own doors. On the stack the partner is the simulator (`card-sim`, `issuer.ts`), so this is its book for
 * one cardholder, read from the adapter's `testRecord` and never through `CardService`, Edge or a customer procedure. It
 * answers in the shape the journeys' outside-record read speaks (apps/customer/tests/real-app/venue.mjs `venueRecord`):
 * `GET <base>/venue` names it, and `POST <base>/<path>` takes `{ account: { venueId, owner } }`, with `owner` the
 * cardholder's user id and amounts as decimal strings. The simulator keeps its credits in its process only, so a restart
 * of svc-bank starts its book of credits empty.
 *
 * Mounted only when the adapter has a `testRecord` (the simulator, which refuses to run in a live posture), and only for a
 * caller on loopback. Never part of a real environment.
 */

/** Where svc-bank serves the TEST card partner's record. */
export const TEST_CARD_PARTNER_RECORD_BASE = '/test-card-partner';
/** The TEST card partner's id in its own record. */
export const TEST_CARD_PARTNER_RECORD_ID = 'test-card-partner';
/** The paths below the base. */
export const TEST_CARD_PARTNER_RECORD_PATHS = ['/venue', '/balances', '/credits', '/terms'] as const;

type Recorder = Pick<CardIssuerAdapter, 'programme'> & { testRecord(userId: string): TestCardPartnerBook };

/** One request's answer: `[status, body]`. `path` is below the base. */
export function answerTestCardPartnerRecord(issuer: Recorder, method: string, path: string, body: unknown): [number, unknown] {
  if (path === '/venue') {
    if (method !== 'GET') return [405, { error: 'GET only' }];
    return [200, { label: 'TEST', venue: { id: TEST_CARD_PARTNER_RECORD_ID, displayName: issuer.programme.displayName } }];
  }
  if (path !== '/balances' && path !== '/credits' && path !== '/terms') return [404, { error: 'no such path' }];
  if (method !== 'POST') return [405, { error: 'POST only' }];
  const account = (body as { account?: { venueId?: unknown; owner?: unknown; subAccount?: unknown } } | null)?.account;
  if (account?.venueId !== TEST_CARD_PARTNER_RECORD_ID) return [400, { error: `account.venueId must be ${TEST_CARD_PARTNER_RECORD_ID}` }];
  if (typeof account.owner !== 'string' || account.owner.length === 0) return [400, { error: 'account.owner (a user id) is required' }];
  if (account.subAccount !== null && account.subAccount !== undefined) return [400, { error: 'the card partner keeps no sub-accounts' }];
  const book = issuer.testRecord(account.owner);
  if (path === '/credits') return [200, { label: 'TEST', value: book.credits }];
  // Who bears a loss under its terms, as the partner reports it; null is "not reported".
  if (path === '/terms') return [200, { label: 'TEST', value: { lossLiability: book.lossLiability } }];
  // What the partner reports the cardholder can spend, in the venue read's row shape: an asset it reports nothing for is
  // left out, never 0.
  const value = Object.entries(book.balances ?? {}).map(([asset, amount]) => ({ asset, free: amount, locked: '0', total: amount }));
  return [200, { label: 'TEST', value }];
}
