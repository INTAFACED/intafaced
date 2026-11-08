// World: stack
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT, journeyState, tool } from './stack.mjs';
import { businessReadyPerson, openBusiness, payApiOf, signInWithCode, verifiedBusiness } from './merchant.mjs';

// J-merchant-10, in the running app (docs/roadmap/journeys.json): hold several currencies, move between them, and get
// paid out fast. One test per step, titled "J-merchant-10 #<n>", run in order on one verified TEST business. Each test
// checks every part of its step's words. Built so far: the TEST acquirer's switches the steps name (CUSTODY-DELTA §4 row
// "TEST acquirer"; §1.3; OWNER 226), which each test checks first. Steps that are written but not built yet fail at their
// first missing part, quickly (UNBUILT):
// - #1 reads the partner's "not offered" on Money's per-asset rows, then stops at the Currencies room, which does not
//   exist yet (its rows with available, held and an as-of, the stablecoin filter, and `pay.asset_not_enabled`). The
//   stack settles in one asset (`PAY_SETTLEMENT_ASSETS`), so the journey's "balances in two assets" needs a second one.
// - #4 reads the partner's instant payout terms on New payout, then stops at the instant payout itself: no payout is
//   sent on an instant rail yet (the partner's fee and net before confirming, step-up, the second approver).
// Steps #2, #3 and #5 are not written here yet.
const J = 'J-merchant-10';
const UNBUILT = { timeout: 5_000 };
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

const saved = (who) => ({ handle: who.handle, email: who.email, password: who.password, secret: who.secret, step: who.step });

async function owner() {
  const state = run.read();
  if (!state.owner?.secret) throw new Error(`${J} #1 made no business, so this step has no owner to act as`);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = { ...state.owner, totp };
  return { who, merchantId: state.merchantId, kept: (step) => run.write({ owner: { ...saved(who), step } }) };
}

/** A section of a pay room by its heading. */
const section = (page, name) => page.getByTestId('pay-section').filter({ has: page.getByRole('heading', { name, level: 2 }) });

/** The TEST partner reports its terms for this business (the stack's `card-terms`). */
const partnerSays = (merchantId, terms) => tool('local-test-stack.mjs', 'card-terms', merchantId, JSON.stringify(terms));

test(`${J} #1 opens Currencies: a row per asset with available and held and an as-of, a stablecoin filter, an asset not enabled refused, a currency the partner doesn't offer reads "not offered by the partner"`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const person = await businessReadyPerson(page, 'mc');
  const merchantId = await openBusiness(page, person);
  await verifiedBusiness(page, person, merchantId);
  run.reset({ owner: saved(person), merchantId });
  const { who, kept } = await owner();
  const api = await payApiOf(who, kept);
  const enabled = (await api.query('merchantMetrics.settlementAssets', { merchantId })).assets.map((a) => a.assetCode);
  expect(enabled.length, 'svc-pay names at least one asset a business settles in').toBeGreaterThan(0);

  // Before the partner gives its list, nothing is marked: silence is not "not offered".
  await signInWithCode(page, who, '/pay/money');
  const all = section(page, 'All balances');
  await expect(all.getByRole('row').first()).toBeVisible();
  await expect(all.getByTestId('partner-currency-not-offered')).toHaveCount(0);

  // The TEST partner offers every listed asset but the first: that one reads "not offered by the partner".
  const [missing, ...offered] = enabled;
  partnerSays(merchantId, { currencies: { known: true, offered } });
  expect((await api.query('merchantMetrics.partnerTerms', { merchantId })).currencies).toEqual({ known: true, offered });
  await page.reload();
  await expect(all.getByTestId('partner-currency-not-offered')).toHaveText([`${missing}: not offered by the partner`]);

  // Currencies: one row per asset the business settles in, from the partner, with available and held in exact decimals
  // and the time the partner's figures are as of. A new business holds nothing yet, so each figure is the partner's zero.
  await page.goto('/pay/currencies');
  await expect(page.getByRole('heading', { name: 'Currencies', level: 1 })).toBeVisible(UNBUILT);
  const rows = page.getByRole('region', { name: 'Currencies' }).getByRole('rowgroup').last().getByRole('row');
  await expect(rows).toHaveCount(enabled.length, UNBUILT);
  for (const [i, assetCode] of enabled.entries()) {
    const zero = new RegExp(`^0\\.0+\\s*${assetCode}$`);
    await expect(rows.nth(i).getByRole('cell')).toHaveText([assetCode, zero, zero, /\d/], UNBUILT);
  }
  await expect(page.getByRole('region', { name: 'Currencies' })).toContainText(/As of/, UNBUILT);
  // The asset the partner doesn't offer reads so on its row.
  await expect(rows.filter({ hasText: missing })).toContainText('not offered by the partner', UNBUILT);
  // The stablecoin filter keeps only the stablecoins.
  await page.getByRole('button', { name: 'Stablecoins' }).click(UNBUILT);
  await expect(page).toHaveURL(/[?&]kind=stablecoin\b/, UNBUILT);
  // An asset the business does not settle in is refused by svc-pay, by name, and the room says so in words.
  await expect(api.query('merchantMetrics.currencies', { merchantId, assetCode: 'XTEST' })).rejects.toThrow(/pay\.asset_not_enabled/);
  await page.goto('/pay/currencies/XTEST');
  await expect(page.getByTestId('failure')).toContainText('not enabled', UNBUILT);
});

test(`${J} #4 sends an instant payout: the partner's fee and net before confirming or "not known", never zero; step-up; a second approver at the threshold; with no instant rail at the partner, "not offered by the partner"`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { who, merchantId, kept } = await owner();
  const api = await payApiOf(who, kept);
  const line = section(page, 'Instant payout').getByTestId('partner-term');

  // The partner offers an instant payout but has not given its fee: the fee reads "not known", never 0.
  partnerSays(merchantId, { instantPayout: { known: true, offered: true, fee: { known: false } } });
  expect((await api.query('merchantMetrics.partnerTerms', { merchantId })).instantPayout).toEqual({
    known: true,
    offered: true,
    fee: { known: false },
  });
  await signInWithCode(page, who, '/pay/payouts/new');
  await expect(line).toHaveText('Instant payout: partner’s fee not known');

  // The partner has no instant rail for this business.
  partnerSays(merchantId, { instantPayout: { known: true, offered: false } });
  await page.reload();
  await expect(line).toHaveText('Instant payout: not offered by the partner');

  // The partner offers an instant payout with its TEST fee: New payout shows that fee as the partner gave it.
  partnerSays(merchantId, { instantPayout: { known: true, offered: true, fee: { known: true, amount: '1.50', assetCode: 'USDT' } } });
  await page.reload();
  await expect(line).toHaveText('Instant payout: partner’s fee 1.50 USDT');

  // Sending one: the review before confirming shows the partner's fee and the net, step-up is asked for, and at or above
  // the tier's approval threshold nothing is sent until a second person approves.
  await page.getByRole('radio', { name: /Instant payout/ }).check(UNBUILT);
  const review = page.getByRole('dialog', { name: /Review/ });
  await expect(review).toContainText('Partner’s fee', UNBUILT);
  await expect(review).toContainText('Net', UNBUILT);
  await expect(review.getByRole('textbox', { name: /code/i })).toBeVisible(UNBUILT);
  await expect(page.getByText('Waiting for a second approver')).toBeVisible(UNBUILT);
});
