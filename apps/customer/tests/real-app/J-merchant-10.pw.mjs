// World: stack
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT, journeyState, tool } from './stack.mjs';
import { businessReadyPerson, openBusiness, payApiOf, signInWithCode, verifiedBusiness } from './merchant.mjs';

// J-merchant-10, in the running app (docs/roadmap/journeys.json): hold several currencies, move between them, and get
// paid out fast. One test per step, titled "J-merchant-10 #<n>", run in order on one verified TEST business. Built so far:
// the TEST acquirer's switches the steps' words name (CUSTODY-DELTA §4 row "TEST acquirer"; §1.3; OWNER 226): #1's "a
// currency the partner doesn't offer reads 'not offered by the partner'" and #4's partner fee "not known" and "with no
// instant rail at the partner, 'not offered by the partner'". There is no Currencies room yet, so #1 reads the per-asset
// rows on Money. The steps' other parts, and steps #2, #3 and #5, are not written here yet.
const J = 'J-merchant-10';
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

test(`${J} #1 opens Currencies: a currency the partner doesn't offer reads "not offered by the partner"`, async ({ page }) => {
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
});

test(`${J} #4 sends an instant payout: the partner's fee "not known", never zero; with no instant rail at the partner, "not offered by the partner"`, async ({
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
});
