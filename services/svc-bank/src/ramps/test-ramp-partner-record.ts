import { z } from 'zod';
import { rampMetricsView } from '../ops/ramp-metrics.js';
import type { RampPartnerBook } from './ramp-partner-book.js';

/**
 * LOCAL TEST: the TEST ramp partner's own report on loopback (J-bank-28 #3), as `partner/test-partner-record.ts` is the
 * TEST partner bank's book.
 *
 * Ramp orders are the partner's, never svc-bank's, so a journey proves the finance desk's ramp metrics are the partner's own by
 * reading the partner's report, never the app's figure back through our own doors. On the stack the partner is the TEST
 * pay-in stand-in (`payin-sim.ts`), so this is its book (`ramp-partner-book.ts`), read from `RampPartnerBook.report` and
 * never through `ops.rampMetrics`, Edge or a customer procedure. It answers in the shape the journeys' outside-record
 * read speaks (apps/customer/tests/real-app/venue.mjs `venueRecord`): `GET <base>/venue` names it, and
 * `POST <base>/report` takes `{ account: { venueId, owner } }` and answers the partner's whole report: the partner
 * reports its ramp orders as one book, so `owner` (the user id of the person whose orders the journey opened) names the
 * reader and narrows nothing. `POST <base>/age` is the stand-in's TEST clock door for one order.
 *
 * Mounted only with the pay-in stand-in, which refuses to start outside `dev`/`test`, and only for a caller on loopback.
 * Never part of a real environment.
 */

/** Where svc-bank serves the stand-in's report. */
export const TEST_RAMP_PARTNER_RECORD_BASE = '/test-ramp-partner';
/** The stand-in's id in its own record. */
export const TEST_RAMP_PARTNER_RECORD_ID = 'test-ramp-partner';
/** The paths below the base. */
export const TEST_RAMP_PARTNER_RECORD_PATHS = ['/venue', '/report', '/age'] as const;

const ageAsk = z.object({ orderId: z.string(), seconds: z.number() });
const reportAsk = z.object({
  account: z.object({ venueId: z.unknown(), owner: z.unknown(), subAccount: z.unknown().optional() }),
});

/** One request to the record: `path` is below the base. */
export interface TestRampPartnerAsk {
  readonly book: RampPartnerBook;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** One request's answer: `[status, body]`. */
export function answerTestRampPartnerRecord({ book, method, path, body }: TestRampPartnerAsk): [number, unknown] {
  const report = book.report();
  if (path === '/venue') {
    if (method !== 'GET') return [405, { error: 'GET only' }];
    return [200, { label: 'TEST', venue: { id: TEST_RAMP_PARTNER_RECORD_ID, displayName: report.label } }];
  }
  if (path === '/age') {
    if (method !== 'POST') return [405, { error: 'POST only' }];
    const ask = ageAsk.safeParse(body);
    if (!ask.success) return [400, { error: 'orderId and seconds are required' }];
    return book.age(ask.data.orderId, Math.round(ask.data.seconds * 1000))
      ? [200, { label: 'TEST', aged: true }]
      : [404, { error: 'no such order' }];
  }
  if (path !== '/report') return [404, { error: 'no such path' }];
  if (method !== 'POST') return [405, { error: 'POST only' }];
  const ask = reportAsk.safeParse(body);
  const account = ask.success ? ask.data.account : null;
  if (account?.venueId !== TEST_RAMP_PARTNER_RECORD_ID) return [400, { error: `account.venueId must be ${TEST_RAMP_PARTNER_RECORD_ID}` }];
  if (!account || typeof account.owner !== 'string' || account.owner.length === 0)
    return [400, { error: 'account.owner (a user id) is required' }];
  if (account.subAccount !== null && account.subAccount !== undefined) return [400, { error: 'the ramp partner keeps no sub-accounts' }];
  return [200, { label: 'TEST', value: rampMetricsView(report).partner }];
}
