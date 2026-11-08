// World: stack
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT, journeyState, tool } from './stack.mjs';
import { businessReadyPerson, openBusiness, paidCardPayment, payApiOf, signInWithCode, verifiedBusiness } from './merchant.mjs';

// J-merchant-18, in the running app (docs/roadmap/journeys.json): a customer disputes a payment. One test per step,
// titled "J-merchant-18 #<n>". #5 runs on a verified TEST business of its own: two TEST card payments, one dispute lost
// with a real shortfall and one won, each reported by the TEST acquirer (`local-test-stack.mjs card-dispute`), read on
// the case pages, on Money's balance line and through the service. Steps #1 to #4 and #6 are not written here yet.
const J = 'J-merchant-18';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

const saved = (who) => ({ handle: who.handle, email: who.email, password: who.password, secret: who.secret, step: who.step });

/** A decimal string as hundredths, exactly (USDT here is shown at 2 places); a figure with more places fails loudly. */
function cents(value) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) throw new Error(`not a decimal amount: ${value}`);
  const frac = (m[2] ?? '').padEnd(2, '0');
  if (/[^0]/.test(frac.slice(2))) throw new Error(`more than 2 places: ${value}`);
  return BigInt(m[1]) * 100n + BigInt(frac.slice(0, 2));
}
const shown = (c) => `${c / 100n}.${String(c % 100n).padStart(2, '0')} USDT`;

/** A section of a pay room by its heading. */
const section = (page, name) => page.getByTestId('pay-section').filter({ has: page.getByRole('heading', { name, level: 2 }) });

test(`${J} #5 the case is won or lost: returned equals taken on a win, a loss is not taken twice, the balance line matches the partner's figure, who covers a shortfall reads "not known"`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const owner = await businessReadyPerson(page, 'md');
  const merchantId = await openBusiness(page, owner);
  await verifiedBusiness(page, owner, merchantId);
  run.reset({ owner: saved(owner), merchantId });
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = { ...owner, totp };
  const api = await payApiOf(who, (step) => (who.step = step));
  const funds = (disputeId) => api.query('merchantOps.disputes.funds', { disputeId });
  const dispute = (paymentId, outcome, disputeId, amount, ...more) =>
    tool('local-test-stack.mjs', 'card-dispute', paymentId, outcome, disputeId, '--amount', amount, ...more);

  // The business's USDT balance line, as svc-pay reads it: clearing and available, each as the partner reported the
  // payments and disputes that moved it. The balances follow events, so the read is retried until it shows `want`.
  const usdt = async () => {
    const { balances } = await api.query('merchantMetrics.snapshot', { merchantId, window: { kind: 'preset', preset: 'rolling_30d' } });
    const row = balances.find((b) => b.assetCode === 'USDT') ?? { clearing: '0', available: '0' };
    return { clearing: cents(row.clearing), available: cents(row.available), total: cents(row.clearing) + cents(row.available) };
  };
  const balanceIs = async (want, why) => {
    await expect.poll(async () => (await usdt()).total, { message: why, timeout: 60_000 }).toBe(want);
  };

  // Payment A: the TEST acquirer captures TEST 40.00.
  const a = await paidCardPayment(api, merchantId, { key: `${J}:payment:a:${merchantId}`, amount: '40.00' });
  expect(a.status).toBe('captured');
  await balanceIs(4000n, 'payment A brings in 40.00');

  // Dispute A: the partner disputes TEST 60.00 against A's 40.00 and the business loses. It held 40.00, so the opening
  // takes back 40.00 once, nothing comes from the house, and 20.00 stays not yet taken.
  const lostId = `TEST-dp-lost-${merchantId.slice(0, 8)}`;
  dispute(a.id, 'opened', lostId, '60.00');
  dispute(a.id, 'lost', lostId, '60.00');
  const lost = await funds(lostId);
  expect(lost).toMatchObject({ disputeId: lostId, assetId: 'USDT', status: 'lost', openingBooked: true, ledgerTxIds: { shortfall: null } });
  expect([lost.disputed, lost.takenAtOpening, lost.returned, lost.notYetTaken, lost.shortfall].map(cents)).toEqual([
    6000n,
    4000n,
    0n,
    2000n,
    0n,
  ]);
  await balanceIs(0n, 'the lost dispute took back the 40.00 the business held');

  // Payment B brings in TEST 25.00. Then the partner sends A's loss again under a new delivery id: the loss is not
  // taken twice, and the 20.00 nobody covers is not taken from B's money.
  const b = await paidCardPayment(api, merchantId, { key: `${J}:payment:b:${merchantId}`, amount: '25.00' });
  expect(b.status).toBe('captured');
  await balanceIs(2500n, 'payment B brings in 25.00');
  dispute(a.id, 'lost', lostId, '60.00', '--resend', '1');
  expect(await funds(lostId)).toEqual(lost);
  expect((await usdt()).total, 'a loss sent again takes nothing more').toBe(2500n);

  // Dispute B: the partner disputes B's whole TEST 25.00, then the business wins. What comes back equals what the
  // opening took, as the partner reported both.
  const wonId = `TEST-dp-won-${merchantId.slice(0, 8)}`;
  dispute(b.id, 'opened', wonId, '25.00');
  const opened = await funds(wonId);
  expect(opened).toMatchObject({ status: 'open', openingBooked: true });
  expect([opened.takenAtOpening, opened.returned, opened.notYetTaken].map(cents)).toEqual([2500n, 0n, 0n]);
  await balanceIs(0n, 'the opening took B’s 25.00');
  dispute(b.id, 'won', wonId, '25.00');
  const won = await funds(wonId);
  expect(won).toMatchObject({ status: 'won', openingBooked: true });
  expect(cents(won.returned), 'returned equals taken at opening').toBe(cents(won.takenAtOpening));
  expect(cents(won.takenAtOpening)).toBe(2500n);
  await balanceIs(2500n, 'the win gave back the 25.00 the opening took');
  dispute(b.id, 'won', wonId, '25.00', '--resend', '1');
  expect(await funds(wonId)).toEqual(won);
  expect((await usdt()).total, 'a win sent again gives nothing more').toBe(2500n);

  // Who covers the 20.00 shortfall: the TEST partner has not said, so the service answers "not known".
  expect((await api.query('merchantMetrics.partnerTerms', { merchantId })).shortfallCover).toEqual({ known: false });

  // The balance line on Money is the service's figure, to the cent: available and clearing.
  const line = await usdt();
  await signInWithCode(page, who, '/pay/money');
  const usdtRow = page
    .getByRole('region', { name: 'All balances' })
    .getByRole('rowgroup')
    .last()
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: 'USDT', exact: true }) });
  await expect(usdtRow.getByRole('cell')).toHaveText(['USDT', shown(line.available), shown(line.clearing)]);

  // The lost case's page: each figure as the partner reported it, the loss taken once, and who covers the rest "not
  // known", with INTAFACED not covering it.
  await page.goto(`/pay/disputes/${encodeURIComponent(lostId)}`);
  const lostMoney = section(page, 'Where the money is');
  await expect(lostMoney.getByRole('definition')).toHaveText(['60.00 USDT', '40.00 USDT', '0.00 USDT', '20.00 USDT', /lost/i]);
  await expect(lostMoney).toContainText('Your balance held less than the dispute, so the rest was not taken.');
  await expect(lostMoney.getByTestId('dispute-funds-outcome')).toHaveText(
    'You lost: what was taken at opening stays taken. Nothing more is taken for this dispute.',
  );
  const cover = section(page, 'If the dispute is lost');
  await expect(cover.getByTestId('partner-term')).toHaveText('Who covers a shortfall: not known');
  await expect(cover).toContainText('Until they say, INTAFACED doesn’t cover it.');

  // The won case's page: returned equals taken at opening.
  await page.goto(`/pay/disputes/${encodeURIComponent(wonId)}`);
  const wonMoney = section(page, 'Where the money is');
  await expect(wonMoney.getByRole('definition')).toHaveText(['25.00 USDT', '25.00 USDT', '25.00 USDT', '0.00 USDT', /won/i]);
  await expect(wonMoney.getByTestId('dispute-funds-outcome')).toHaveText('You won: what was taken at opening came back.');
});
