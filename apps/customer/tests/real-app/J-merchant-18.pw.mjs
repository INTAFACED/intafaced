// World: stack
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT, journeyState, tool } from './stack.mjs';
import { businessReadyPerson, openBusiness, paidCardPayment, payApiOf, signInWithCode, verifiedBusiness } from './merchant.mjs';

// J-merchant-18, in the running app (docs/roadmap/journeys.json): a customer disputes a payment. One test per step,
// titled "J-merchant-18 #<n>". Built so far: #5's "who covers a shortfall reads 'not known'", the TEST acquirer's switch
// (CUSTODY-DELTA §4 row "TEST acquirer"; §1.3 "Unknown, never zero"; OWNER 226). The step's other parts (returned equals
// the amount taken on a win, a loss not taken twice, the balance line against the partner's figure) and steps #1 to #4
// and #6 are not written here yet.
const J = 'J-merchant-18';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

const saved = (who) => ({ handle: who.handle, email: who.email, password: who.password, secret: who.secret, step: who.step });

test(`${J} #5 the case is won or lost: who covers a shortfall reads "not known"`, async ({ page }) => {
  test.setTimeout(300_000);
  // A verified TEST business with one paid TEST card payment, disputed and lost through the TEST acquirer.
  const owner = await businessReadyPerson(page, 'md');
  const merchantId = await openBusiness(page, owner);
  await verifiedBusiness(page, owner, merchantId);
  run.reset({ owner: saved(owner), merchantId });
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = { ...owner, totp };
  const api = await payApiOf(who, (step) => (who.step = step));
  const paid = await paidCardPayment(api, merchantId, { key: `${J}:payment:${merchantId}`, amount: '40.00' });
  expect(paid.status).toBe('captured');
  const disputeId = `TEST-dp-${merchantId.slice(0, 8)}`;
  tool('local-test-stack.mjs', 'card-dispute', paid.id, 'opened', disputeId);
  tool('local-test-stack.mjs', 'card-dispute', paid.id, 'lost', disputeId);

  // The service's answer: the TEST partner has not said who covers a shortfall on this business.
  expect((await api.query('merchantMetrics.partnerTerms', { merchantId })).shortfallCover).toEqual({ known: false });

  // The case page reads the same, in words, and never names the ledger or a zero as the cover.
  await signInWithCode(page, who, `/pay/disputes/${encodeURIComponent(disputeId)}`);
  const cover = page.getByTestId('pay-section').filter({ has: page.getByRole('heading', { name: 'If the dispute is lost', level: 2 }) });
  await expect(cover.getByTestId('partner-term')).toHaveText('Who covers a shortfall: not known');
  await expect(cover).toContainText('Until they say, INTAFACED doesn’t cover it.');
});
