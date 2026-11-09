import { api } from './stack.mjs';

/**
 * The TEST partner bank and ramp's switches for one person (CUSTODY-DELTA §4; svc-bank `partner/test-partner.ts`). The
 * stack runs the TEST partner (`BANK_TEST_PARTNER=test`); each switch is that person's only and starts off.
 */
export const PARTNER_OFF = Object.freeze({
  notOffered: [],
  fee: 'known',
  reserve: 'none',
  down: false,
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
