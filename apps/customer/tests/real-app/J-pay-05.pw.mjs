import { test, expect } from './journey.mjs';
import { api, fund, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-pay-05, in the running app (docs/roadmap/journeys.json): ask someone for money, and pay or decline the request. One test
// per step, titled "J-pay-05 #<n>", run in order on two TEST accounts: the payee asks, the payer (funded with TEST 30 USDT)
// pays or declines. Every figure on screen is checked against what each person's own svc-bank API answers.
const J = 'J-pay-05';
const AMOUNT = '12';
const NOTE = 'Concert tickets, TEST';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'serial' });

/** A tRPC answer through the person's own session, or a thrown error naming what was refused. */
async function trpc(who, method, route, input) {
  const session = await api(who);
  const path = `/api/${route}`;
  const res =
    method === 'GET' ? await session.get(`${path}?input=${encodeURIComponent(JSON.stringify(input))}`) : await session.post(path, input);
  if (res.status !== 200) throw new Error(`${route} refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}

/** The same call, answering the refusal instead of throwing: `{ status, code }`. */
async function refusal(who, route, input) {
  const res = await (await api(who)).post(`/api/${route}`, input);
  return { status: res.status, code: res.body?.error?.data?.code ?? res.body?.error?.json?.data?.code ?? null, body: res.body };
}

const usdt = async (who) => {
  const spaces = await trpc(who, 'GET', 'bank/trpc/spaces.list', { limit: 200 });
  const main = spaces.find((space) => space.assetId === 'USDT' && space.kind === 'primary');
  return main ? toUnits(main.balance) : 0n;
};

const request = (who, requestId) => trpc(who, 'GET', 'bank/trpc/personalRequest.get', { requestId });

function people() {
  const { payee, payer } = run.read();
  if (!payee || !payer) throw new Error(`${J} made no accounts, so this step has no one to act as`);
  return { payee, payer };
}

/** A `datetime-local` value `ms` from now, in the browser's own time zone (the test runs the browser in UTC). */
const localInput = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 16);

test.use({ timezoneId: 'UTC' });

/** The payee asks the payer on /pay/request and sends it; returns the request id svc-bank gave. */
async function ask(page, { amount = AMOUNT, note = NOTE, payBy = localInput(2 * 86_400_000) } = {}) {
  const { payee, payer } = people();
  await signIn(page, payee);
  await page.goto('/pay/request');
  const form = page.getByTestId('ask-person');
  await form.getByLabel('Who to ask').fill(payer.handle);
  await form.getByLabel('Coin').selectOption('USDT');
  await form.getByLabel('Amount').fill(amount);
  if (note) await form.getByLabel('Note (optional)').fill(note);
  await form.getByLabel('Pay by').fill(payBy);
  await form.getByTestId('ask-review-button').click();
  const review = form.getByTestId('ask-review');
  await expect(review).toContainText(`@${payer.handle}`);
  await expect(review).toContainText(`${amount} USDT`);
  if (note) await expect(review).toContainText(note);
  await expect(review).toContainText('No money moves until they pay.');
  await review.getByTestId('ask-send').click();
  const made = form.getByTestId('ask-made');
  await expect(made).toBeVisible();
  return made.getAttribute('data-request-id');
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  if (run.read().payer) return;
  const page = await browser.newPage();
  const payee = await signUp(page, 'rq5e');
  await verify(page, payee);
  const payer = await signUp(page, 'rq5r');
  await verify(page, payer);
  expect(fund(payer.email, 'USDT', '30').tx, 'the payer was not funded with TEST 30 USDT').toBeTruthy();
  run.write({ payee, payer });
  await page.close();
});

test(`${J} #1 the payee asks a person for TEST 12 USDT with a note: a review, then a created request, and no money moved`, async ({
  page,
}) => {
  const { payee, payer } = people();
  const before = { payee: await usdt(payee), payer: await usdt(payer) };
  const requestId = await ask(page);
  expect(requestId, 'the page named no request').toMatch(/^[0-9a-f-]{36}$/);
  // svc-bank holds it as waiting, for both people, with what was typed.
  const mine = await request(payee, requestId);
  expect(mine).toMatchObject({ status: 'open', assetId: 'USDT', amount: AMOUNT, note: NOTE, payerHandle: payer.handle, ledgerTxId: null });
  expect((await request(payer, requestId)).status).toBe('open');
  // Asking moved nothing.
  expect(await usdt(payee)).toBe(before.payee);
  expect(await usdt(payer)).toBe(before.payer);
  run.write({ ...run.read(), first: requestId });
});

test(`${J} #2 the payer opens the notice: the request page shows the amount, the note, and Pay and Decline`, async ({ page }) => {
  const { payer } = people();
  const { first } = run.read();
  if (!first) throw new Error(`${J} #1 made no request`);
  await signIn(page, payer);
  await page.goto('/notifications');
  const notice = page.locator(`a[data-testid="nf-row"][href="/pay/request/${first}"]`);
  await expect(notice, 'the payer has no notice for the request').toHaveCount(1);
  await notice.click();
  await expect(page).toHaveURL(new RegExp(`/pay/request/${first}$`));
  const room = page.getByTestId('person-request');
  await expect(room).toHaveAttribute('data-status', 'open');
  await expect(room.getByTestId('person-request-amount')).toHaveText(`${AMOUNT} USDT`);
  await expect(room.getByTestId('person-request-note')).toHaveText(NOTE);
  await expect(room.getByTestId('person-request-status')).toHaveText('Waiting');
  await expect(room.getByTestId('person-request-pay')).toBeEnabled();
  await expect(room.getByTestId('person-request-decline')).toBeEnabled();
});

test(`${J} #3 the payer pays: one transfer, Paid for both, a notice to the payee, and paying twice returns the first receipt`, async ({
  page,
}) => {
  const { payee, payer } = people();
  const { first } = run.read();
  if (!first) throw new Error(`${J} #1 made no request`);
  const before = { payee: await usdt(payee), payer: await usdt(payer) };
  await signIn(page, payer);
  await page.goto(`/pay/request/${first}`);
  const room = page.getByTestId('person-request');
  const sent = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/bank/trpc/transfers.toUser')) sent.push(req.postDataJSON());
  });
  await room.getByTestId('person-request-pay').click();
  await expect(room).toHaveAttribute('data-status', 'paid');
  await expect(room.getByTestId('person-request-status')).toHaveText('Paid');
  await expect(room.getByTestId('person-request-pay')).toHaveCount(0);
  expect(sent, 'the page sent no transfer, or more than one').toHaveLength(1);
  expect(sent[0]).toMatchObject({ requestId: first, toUserId: (await request(payee, first)).payeeUserId, amount: AMOUNT });

  // One transfer: the request names one ledger transaction, Paid for both, and each balance moved by exactly the amount.
  const paid = await request(payer, first);
  expect(paid.status).toBe('paid');
  expect(paid.ledgerTxId).toBeTruthy();
  expect(await request(payee, first)).toMatchObject({ status: 'paid', ledgerTxId: paid.ledgerTxId });
  expect(await usdt(payer)).toBe(before.payer - toUnits(AMOUNT));
  expect(await usdt(payee)).toBe(before.payee + toUnits(AMOUNT));

  // Paying twice: the same send again returns the first receipt and moves nothing more; a new send for it is refused.
  const again = await trpc(payer, 'POST', 'bank/trpc/transfers.toUser', sent[0]);
  expect(again.ledgerTxId).toBe(paid.ledgerTxId);
  const other = await refusal(payer, 'bank/trpc/transfers.toUser', { ...sent[0], transferId: crypto.randomUUID() });
  expect(other.code, `a second send for a paid request was not refused: ${JSON.stringify(other.body).slice(0, 300)}`).toBe(
    'bank.personal_request_closed',
  );
  expect(await usdt(payer)).toBe(before.payer - toUnits(AMOUNT));
  expect(await usdt(payee)).toBe(before.payee + toUnits(AMOUNT));

  // The payee is told, and the notice opens the same request, which reads Paid.
  await signIn(page, payee);
  await page.goto('/notifications');
  const notices = page.locator(`a[data-testid="nf-row"][href="/pay/request/${first}"]`);
  await expect(notices.filter({ hasText: /paid/i }), 'the payee was not told the request was paid').toHaveCount(1);
  await page.goto(`/pay/request/${first}`);
  await expect(page.getByTestId('person-request-status')).toHaveText('Paid');
});

test(`${J} #4 the payee reminds on a second request: once per window, and over the cap it refuses with the next allowed time`, async ({
  page,
}) => {
  const { payer } = people();
  const second = await ask(page, { amount: '5', note: 'Second, TEST' });
  run.write({ ...run.read(), second });
  const noticesOf = async () => {
    await signIn(page, payer);
    await page.goto('/notifications');
    return page.locator(`a[data-testid="nf-row"][href="/pay/request/${second}"]`);
  };
  await expect(await noticesOf(), 'the payer was not told of the second request').toHaveCount(1);

  // The payee reminds once: it goes out, and the payer has a second notice for the same request.
  const { payee } = people();
  await signIn(page, payee);
  await page.goto(`/pay/request/${second}`);
  const room = page.getByTestId('person-request');
  const pressedAt = Date.now();
  await room.getByTestId('person-request-remind').click();
  await expect(room.getByTestId('person-request-reminded')).toHaveText('Reminder sent.');
  // A second reminder in the same window is over the cap: refused by its code, naming when the next one is allowed.
  await room.getByTestId('person-request-remind').click();
  const refused = room.getByTestId('person-request-refused');
  await expect(refused).toContainText('bank.personal_request_remind_capped');
  const next = /next reminder is allowed at (\S+?)\s*\(/.exec(await refused.innerText())?.[1];
  expect(next, 'the refusal names no next allowed time').toBeTruthy();
  // The stack's TEST terms are one reminder an hour, so the next is allowed an hour after the first.
  const nextAt = Date.parse(next);
  expect(nextAt).toBeGreaterThanOrEqual(pressedAt + 3_600_000 - 60_000);
  expect(nextAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
  await expect(await noticesOf(), 'the reminder did not go out exactly once').toHaveCount(2);
  expect((await request(payer, second)).status).toBe('open');
});

test(`${J} #5 the payer declines a third request with Report and block: Declined, a case and an active block; the payee sees only Declined`, async () => {
  throw new Error(`${J} #5: no service opens a case or a block from a declined request`);
});

test(`${J} #6 a fourth request's period passes: both lists show Expired, and a pay racing a decline lets exactly one win`, async () => {
  throw new Error(`${J} #6: not built in the app yet`);
});
