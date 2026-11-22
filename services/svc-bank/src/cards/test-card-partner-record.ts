import type { CardIssuerAdapter, TestCardPartnerBook } from './issuer.js';
import type { PartnerCardHolds } from './partner-card-holds.js';

/**
 * LOCAL TEST: the TEST card partner's own book on loopback (J-bank-27 #3 #4), as `partner/test-partner-record.ts` is the
 * TEST partner bank's.
 *
 * At launch a card's money, a dispute's provisional credit and who bears a loss are the card partner's (OWNER 226), so a
 * journey proves the app shows what the partner itself recorded by reading the partner's record, never the app's figure
 * back through our own doors. On the stack the partner is the simulator (`card-sim`, `issuer.ts`), so this is its book for
 * one cardholder, read from the adapter's `testRecord` and never through `CardService`, Edge or a customer procedure. Its
 * `/holds` is the TEST partner card's own held and captured per asset for that cardholder (J-bank-26 #5), and `/terms` and
 * `/funding` are the programme's, whatever cardholder is named: the funder, reserve, programme figures, funding stablecoin
 * and offers it reports, and the funding instructions it took (J-bank-26 #6). It
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
export const TEST_CARD_PARTNER_RECORD_PATHS = ['/venue', '/balances', '/credits', '/terms', '/holds', '/funding'] as const;

type Recorder = Pick<CardIssuerAdapter, 'programme'> & {
  testRecord(userId: string): TestCardPartnerBook;
  /** The TEST partner card's holds, when the stack runs them (card-sim with the TEST partner); absent, `/holds` lists none. */
  holds?: Pick<PartnerCardHolds, 'figures' | 'captured'> | null;
};

/** One request's answer: `[status, body]`. `path` is below the base. */
export async function answerTestCardPartnerRecord(
  issuer: Recorder,
  method: string,
  path: string,
  body: unknown,
): Promise<[number, unknown]> {
  if (path === '/venue') {
    if (method !== 'GET') return [405, { error: 'GET only' }];
    return [200, { label: 'TEST', venue: { id: TEST_CARD_PARTNER_RECORD_ID, displayName: issuer.programme.displayName } }];
  }
  if (!(TEST_CARD_PARTNER_RECORD_PATHS as readonly string[]).includes(path)) return [404, { error: 'no such path' }];
  if (method !== 'POST') return [405, { error: 'POST only' }];
  const account = (body as { account?: { venueId?: unknown; owner?: unknown; subAccount?: unknown } } | null)?.account;
  if (account?.venueId !== TEST_CARD_PARTNER_RECORD_ID) return [400, { error: `account.venueId must be ${TEST_CARD_PARTNER_RECORD_ID}` }];
  if (typeof account.owner !== 'string' || account.owner.length === 0) return [400, { error: 'account.owner (a user id) is required' }];
  if (account.subAccount !== null && account.subAccount !== undefined) return [400, { error: 'the card partner keeps no sub-accounts' }];
  const book = issuer.testRecord(account.owner);
  if (path === '/credits') return [200, { label: 'TEST', value: book.credits }];
  // Its terms as it reports them; each null is "not reported".
  if (path === '/terms') return [200, { label: 'TEST', value: book.terms }];
  if (path === '/funding') return [200, { label: 'TEST', value: book.funding }];
  if (path === '/holds') {
    // What the partner card holds open and has captured for this cardholder, per asset it keeps a book in: an asset it
    // reports nothing for is left out, never 0.
    const value = [];
    for (const asset of Object.keys(book.balances ?? {})) {
      const figures = await issuer.holds?.figures({ userId: account.owner, assetId: asset });
      const captured = await issuer.holds?.captured?.({ userId: account.owner, assetId: asset });
      if (figures?.held == null || captured == null) continue;
      value.push({ asset, held: figures.held, captured });
    }
    return [200, { label: 'TEST', value }];
  }
  // What the partner reports the cardholder can spend, in the venue read's row shape: an asset it reports nothing for is
  // left out, never 0.
  const value = Object.entries(book.balances ?? {}).map(([asset, amount]) => ({ asset, free: amount, locked: '0', total: amount }));
  return [200, { label: 'TEST', value }];
}
