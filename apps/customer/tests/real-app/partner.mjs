import { api } from './stack.mjs';
import { venueBalance, venueRecord } from './venue.mjs';
import { STACK_PORTS } from '../../../../tooling/scripts/local-test-facts.mjs';

/** The TEST partner bank's own record, on loopback (svc-bank src/partner/test-partner-record.ts). */
const PARTNER_BOOK = `http://127.0.0.1:${STACK_PORTS.bank}/test-partner`;
/** The TEST pay-in ramp partner's own record, on loopback (crates/svc-bank/src/ramps/onramp/payin.rs). */
const RAMP_PARTNER_BOOK = `http://127.0.0.1:${STACK_PORTS.bank}/test-ramp-partner`;

/** What the TEST partner's own book says `userId` holds of `assetId` on their main balance there. */
export async function partnerMainBalance(userId, assetId = 'USDT') {
  return (await venueBalance(userId, assetId, PARTNER_BOOK)).total;
}

/** Every move on `userId`'s record at the TEST partner, oldest first, as the partner's own book lists it. */
export async function partnerBookMoves(userId) {
  return (await venueRecord(userId, '/moves', {}, PARTNER_BOOK, null)).value;
}

/** Every account the TEST partner holds for `userId`, main balances and spaces, with the amount in each, as its own book lists them. */
export async function partnerBookAccounts(userId) {
  return (await venueRecord(userId, '/accounts', {}, PARTNER_BOOK, null)).value;
}

/** The TEST ramp partner's own order report, read on loopback straight from the stand-in: orders by state, health and expiries. */
export async function rampPartnerReport(readerId) {
  return (await venueRecord(readerId, '/report', {}, RAMP_PARTNER_BOOK, null)).value;
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

/**
 * Sets some of `who`'s switches through their own bank API and returns them all, as the partner now behaves. A person
 * with an authenticator app passes `code`, which gives a fresh code for each sign-in.
 */
export async function setPartner(who, change, { code } = {}) {
  const session = await api(who, code ? { totpCode: await code() } : {});
  const res = await session.post('/api/bank/trpc/testPartner.set', change);
  if (res.status !== 200) throw new Error(`testPartner.set refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}

/** Runs `fn` with `who`'s partner switched as `change` says, and puts every switch back off after, even when `fn` fails. */
export async function withPartner(who, change, fn, { code } = {}) {
  const now = await setPartner(who, change, { code });
  try {
    return await fn(now);
  } finally {
    await setPartner(who, PARTNER_OFF, { code });
  }
}

/** `who`'s bank money held at the TEST partner from now on (the launch money model: INTAFACED holds no customer money), through their own bank API. */
export async function holdAtPartner(who) {
  const now = await setPartner(who, { custody: 'off' });
  if (now.custody !== 'off') throw new Error(`testPartner.set left ${who.email}'s money off the partner: ${JSON.stringify(now)}`);
  return now;
}

/** TEST money paid in at the partner for `who`, once per `fundId`, through their own bank API; the partner's new balance. */
export async function fundAtPartner(who, fundId, assetId, amount) {
  const session = await api(who);
  const res = await session.post('/api/bank/trpc/testPartner.fund', { fundId, assetId, amount });
  if (res.status !== 200)
    throw new Error(`testPartner.fund ${amount} ${assetId} refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}
