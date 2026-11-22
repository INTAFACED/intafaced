import { api, STACK_PORTS } from './stack.mjs';
import { venueBalance, venueRecord } from './venue.mjs';

/** The TEST partner bank's own record, on loopback (svc-bank src/partner/test-partner-record.ts). */
const PARTNER_RECORD = `http://127.0.0.1:${STACK_PORTS.bank}/test-partner`;

/** What the TEST partner bank's own book says `userId` holds in `asset`, read on loopback, never through our doors. */
export async function partnerHolds(userId, asset) {
  return (await venueBalance(userId, asset, PARTNER_RECORD)).total;
}

/** Every move on `userId`'s record at the TEST partner, oldest first, as the partner's own book lists it. */
export async function partnerBookMoves(userId) {
  return (await venueRecord(userId, '/moves', {}, PARTNER_RECORD, null)).value;
}

/**
 * The TEST partner bank and ramp's switches for one person (CUSTODY-DELTA §4; svc-bank `partner/test-partner.ts`). The
 * stack runs the TEST partner (`BANK_TEST_PARTNER=test`); each switch is that person's only and starts off.
 */
const PARTNER_OFF = Object.freeze({
  notOffered: [],
  fee: 'known',
  reserve: 'none',
  down: false,
  figures: 'live',
  rampQuote: 'live',
  rampFee: 'known',
  accountDetails: 'none',
});

/** Sets some of `who`'s switches through their own bank API and returns them all, as the partner now behaves. */
export async function setPartner(who, change) {
  const session = await api(who);
  const res = await session.post('/api/bank/trpc/testPartner.set', change);
  if (res.status !== 200) throw new Error(`testPartner.set refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}

/** Runs `fn` with `who`'s partner switched as `change` says, and puts every switch back off after, even when `fn` fails. */
export async function withPartner(who, change, fn) {
  const now = await setPartner(who, change);
  try {
    return await fn(now);
  } finally {
    await setPartner(who, PARTNER_OFF);
  }
}
