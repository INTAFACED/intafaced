// World: none
import { test, expect } from './journey.mjs';
import { api, fund, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-pay-05, in the running app (docs/roadmap/journeys.json): ask someone for money, and pay or decline a request.
// One test per step, titled "J-pay-05 #<n>", run in order on TEST accounts: A (the payee) asks, B (the payer) is asked
// and holds TEST 30 USDT. Requests are svc-bank's (`bank.personalRequest.*`); a request moves no money until it is
// paid, and paying is one send under the request's own key (`request:<requestId>`). The stack publishes a TEST
// reminder rule (one reminder per request in 24 hours, tooling/profiles/test-owner-values/bank.json). Every figure is
// TEST money on the local stack, and each one on screen is checked against what the person's own API answers.
const J = 'J-pay-05';
const ASK = '12';
const NOTE = 'Concert tickets, TEST';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function people() {
  const { payee, payer } = run.read();
  if (!payee || !payer) throw new Error(`${J} #1 made no accounts, so this step has no one to act as`);
  return { payee, payer };
}

/** A tRPC answer through the person's own session, or a thrown error naming what was refused. */
async function trpc(session, method, path, input) {
  const res = await trpcRaw(session, method, path, input);
  if (res.status !== 200) throw new Error(`${path} refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}
function trpcRaw(session, method, path, input) {
  const route = `/api/${path}`;
  return method === 'GET'
    ? session.get(input === undefined ? route : `${route}?input=${encodeURIComponent(JSON.stringify(input))}`)
    : session.post(route, input);
}

const usdt = async (who) => (await (await api(who)).balances()).USDT?.free ?? '0';
const request = async (who, requestId) => trpc(await api(who), 'GET', 'bank/trpc/personalRequest.get', { requestId });

/** A asks B through A's own API: the setup for steps that start from a request already made. */
async function askByApi(amount, { note, seconds = 7 * 86_400, key } = {}) {
  const { payee, payer } = people();
  const a = await api(payee);
  return trpc(a, 'POST', 'bank/trpc/personalRequest.create', {
    payerUserId: payer.userId,
    assetId: 'USDT',
    amount,
    ...(note ? { note } : {}),
    expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
    idempotencyKey: key,
  });
}

/** B's main USDT space, the one a request is paid from. */
async function payerSpace() {
  const spaces = await trpc(await api(people().payer), 'GET', 'bank/trpc/spaces.list', { limit: 200 });
  const main = spaces.find((space) => space.assetId === 'USDT' && space.kind === 'primary');
  if (!main) throw new Error('B has no main USDT space');
  return main.id;
}

/** The inbox rows on /notifications whose text is exactly this. */
async function notices(page, text) {
  await page.goto('/notifications');
  await expect(page.getByRole('heading').first()).toBeVisible();
  return page.getByTestId('nf-row').filter({ hasText: text });
}

test(`${J} #1 the payee opens Request, picks a person, enters TEST 12 USDT and a note: a review and a created request, and no money moved`, async ({
  page,
}) => {
  // The start: two verified members. B, the payer, holds TEST 30 USDT. A holds TEST 1 USDT, so A's main USDT account
  // exists and Request offers USDT to be paid in.
  const payer = await signUp(page, 'jrb');
  await verify(page, payer);
  const payee = await signUp(page, 'jra');
  await verify(page, payee);
  expect(fund(payer.email, 'USDT', '30').tx).toBeTruthy();
  expect(fund(payee.email, 'USDT', '1').tx).toBeTruthy();
  payer.userId = (await api(payer)).userId;
  payee.userId = (await api(payee)).userId;
  run.reset({ payee, payer, before: { payee: await usdt(payee), payer: await usdt(payer) } });
  expect(run.read().before).toEqual({ payee: '1', payer: '30' });

  await signIn(page, payee);
  await page.goto('/pay');
  await page.getByRole('tab', { name: 'Request', exact: true }).click();
  const ask = page.getByRole('form', { name: 'Ask a person' });
  await ask.getByLabel('Who to ask').fill(`@${payer.handle}`);
  await ask.getByLabel('Coin').selectOption('USDT');
  await ask.getByLabel('Amount to ask for').fill(ASK);
  await ask.getByLabel('Note').fill(NOTE);
  await ask.getByRole('button', { name: 'Review request' }).click();

  // The review: who, how much, the note, and that nothing moves now.
  const review = page.getByRole('region', { name: 'Review your request' });
  await expect(review.getByTestId('request-review-to')).toHaveText(`@${payer.handle}`);
  await expect(review.getByTestId('request-review-amount')).toHaveText(`${ASK} USDT`);
  await expect(review.getByTestId('request-review-note')).toHaveText(NOTE);
  await expect(review.getByTestId('request-review-no-money')).toHaveText('No money moves now. You are paid only if they pay.');
  // Reviewing created nothing yet.
  expect(await trpc(await api(payee), 'GET', 'bank/trpc/personalRequest.list', { direction: 'outgoing', limit: 50 })).toEqual([]);

  await review.getByRole('button', { name: 'Send request' }).click();
  const sent = page.getByTestId('request-sent');
  await expect(sent).toContainText(`Request sent to @${payer.handle}`);
  await expect(sent).toContainText('No money has moved.');
  const requestId = await sent.getAttribute('data-request-id');
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

  // The bank holds one open request with these terms, and A's list shows it Pending.
  const made = await request(payee, requestId);
  expect(made).toMatchObject({
    payeeUserId: payee.userId,
    payerUserId: payer.userId,
    amount: ASK,
    assetId: 'USDT',
    note: NOTE,
    status: 'open',
  });
  const row = page.getByTestId('requests-outgoing').locator(`[data-request-id="${requestId}"]`);
  await expect(row.getByTestId('request-status')).toHaveText('Pending');
  await expect(row).toContainText(`To @${payer.handle}`);

  // No money moved: both balances are where they started.
  expect(await usdt(payee)).toBe('1');
  expect(await usdt(payer)).toBe('30');
  run.write({ first: requestId });
});

test(`${J} #2 the payer opens the notice: the request detail page with the amount, the note and Pay and Decline buttons`, async ({
  page,
}) => {
  const { payee, payer } = people();
  const { first } = run.read();
  if (!first) throw new Error(`${J} #1 made no request, so there is no notice to open`);
  await signIn(page, payer);
  const row = await notices(page, `${payee.handle} asked you for ${ASK} USDT.`);
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/pay/request/${first}$`));

  const room = page.getByTestId('request-room');
  await expect(room).toHaveAttribute('data-request-id', first);
  await expect(room.getByTestId('request-who')).toHaveText(`@${payee.handle}`);
  await expect(room.getByTestId('request-amount')).toHaveText(`${ASK} USDT`);
  await expect(room.getByTestId('request-note')).toHaveText(NOTE);
  await expect(room.getByTestId('request-status')).toHaveText('Pending');
  await expect(room.getByRole('button', { name: `Pay ${ASK} USDT` })).toBeEnabled();
  await expect(room.getByRole('button', { name: 'Decline', exact: true })).toBeEnabled();
});

test(`${J} #3 the payer pays: one transfer under the request key, Paid for both, a notice for the payee, and paying twice returns the first receipt`, async ({
  page,
}) => {
  const { payee, payer } = people();
  const { first } = run.read();
  if (!first) throw new Error(`${J} #1 made no request, so there is nothing to pay`);
  const posted = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/bank/trpc/transfers.toUser')) posted.push(req.postDataJSON());
  });

  await signIn(page, payer);
  await page.goto(`/pay/request/${first}`);
  const room = page.getByTestId('request-room');
  await room.getByRole('button', { name: `Pay ${ASK} USDT` }).click();
  await expect(room.getByTestId('request-pay-review')).toContainText(`You pay @${payee.handle} ${ASK} USDT`);
  await room.getByRole('button', { name: 'Confirm and pay' }).click();
  await expect(room.getByTestId('request-paid')).toBeVisible();
  await expect(room.getByTestId('request-status')).toHaveText('Paid');

  // One send, under the request's own key.
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ transferId: `request:${first}`, requestId: first, toUserId: payee.userId, amount: ASK });
  const paid = await request(payer, first);
  expect(paid.status).toBe('paid');
  expect(paid.ledgerTxId).toBeTruthy();
  await expect(room.getByTestId('request-receipt')).toHaveText(paid.ledgerTxId);

  // Paying again under the same key returns the first receipt, and nothing more moves.
  const again = await trpc(await api(payer), 'POST', 'bank/trpc/transfers.toUser', {
    transferId: `request:${first}`,
    fromSpaceId: await payerSpace(),
    toUserId: payee.userId,
    amount: ASK,
    requestId: first,
  });
  expect(again.ledgerTxId).toBe(paid.ledgerTxId);
  expect(await usdt(payer)).toBe('18');
  expect(await usdt(payee)).toBe('13');

  // Paid for the payee too, with the payee's notice.
  expect((await request(payee, first)).status).toBe('paid');
  await signIn(page, payee);
  const notice = await notices(page, `${payer.handle} paid your request for ${ASK} USDT.`);
  await expect(notice).toHaveCount(1, { timeout: 20_000 });
  await page.goto('/pay');
  await page.getByRole('tab', { name: 'Request', exact: true }).click();
  await expect(page.getByTestId('requests-outgoing').locator(`[data-request-id="${first}"]`).getByTestId('request-status')).toHaveText(
    'Paid',
  );
});

test(`${J} #4 the payee sends a reminder on a second, unpaid request: once per window, and one over the cap refuses with the next allowed time`, async ({
  page,
}) => {
  const { payee, payer } = people();
  // The second request, and the fourth and fifth that steps 5 and 6 need, made now while A may still ask B.
  const tag = Date.now().toString(36);
  const second = await askByApi('5', { note: 'Second, TEST', key: `${J}:second:${tag}` });
  const fourth = await askByApi('4', { note: 'Fourth, TEST', seconds: 60, key: `${J}:fourth:${tag}` });
  const fifth = await askByApi('2', { note: 'Fifth, TEST', key: `${J}:fifth:${tag}` });
  run.write({ second: second.requestId, fourth: fourth.requestId, fifth: fifth.requestId });

  await signIn(page, payee);
  await page.goto(`/pay/request/${second.requestId}`);
  const room = page.getByTestId('request-room');
  await expect(room.getByTestId('request-status')).toHaveText('Pending');
  await expect(room.getByTestId('request-remind-count')).toHaveText('0 of 1 reminders used in this window.');
  await room.getByRole('button', { name: 'Send a reminder' }).click();
  await expect(room.getByTestId('request-note-shown')).toHaveText('Reminder sent.');
  await expect(room.getByTestId('request-remind-count')).toHaveText('1 of 1 reminders used in this window.');
  const facts = await trpc(await api(payee), 'GET', 'bank/trpc/personalRequest.reminders', { requestId: second.requestId });
  expect(facts).toMatchObject({ sentInWindow: 1, cap: 1, windowSeconds: 86_400 });
  expect(facts.nextAllowedAt).toBeTruthy();
  await expect(room.getByTestId('request-remind-next')).toHaveAttribute('data-next', facts.nextAllowedAt);
  await expect(room.getByTestId('request-remind-next')).toContainText('Next reminder allowed after');

  // A second reminder in the same window: refused, naming the next allowed time; nothing more goes out.
  await room.getByRole('button', { name: 'Send a reminder' }).click();
  await expect(room.getByTestId('request-problem')).toHaveText('No more reminders in this window. Nothing was sent.');
  const refused = await trpcRaw(await api(payee), 'POST', 'bank/trpc/personalRequest.remind', {
    requestId: second.requestId,
    idempotencyKey: `${J}:remind:${tag}`,
  });
  expect(refused.status).toBe(429);
  expect(JSON.stringify(refused.body)).toContain(facts.nextAllowedAt);
  await expect(room.getByTestId('request-remind-next')).toHaveAttribute('data-next', facts.nextAllowedAt);

  // B was told twice about the second request: when it was made, and the one reminder.
  await signIn(page, payer);
  const told = await notices(page, `${payee.handle} asked you for 5 USDT.`);
  await expect(told).toHaveCount(2, { timeout: 20_000 });
  await page.waitForTimeout(3_000);
  await page.reload();
  await expect(page.getByTestId('nf-row').filter({ hasText: `${payee.handle} asked you for 5 USDT.` })).toHaveCount(2);
});

test(`${J} #5 the payer declines a third request with Report and block: Declined, a case exists, the block is active, and the payee only sees Declined`, async ({
  page,
}) => {
  const { payee, payer } = people();
  const tag = Date.now().toString(36);
  const third = await askByApi('7', { note: 'Third, TEST', key: `${J}:third:${tag}` });
  run.write({ third: third.requestId });

  await signIn(page, payer);
  await page.goto(`/pay/request/${third.requestId}`);
  const room = page.getByTestId('request-room');
  await room.getByRole('button', { name: 'Decline and report' }).click();
  const report = room.getByRole('region', { name: 'Report this request' });
  await report.getByLabel('What’s wrong').selectOption('scam');
  await expect(report.getByLabel(`Also block @${payee.handle} from asking me for money`)).toBeChecked();
  await report.getByRole('button', { name: 'Decline and report' }).click();

  await expect(room.getByTestId('request-status')).toHaveText('Declined');
  const safety = await trpc(await api(payer), 'GET', 'bank/trpc/personalRequest.safety', { requestId: third.requestId });
  expect(safety).toMatchObject({ reason: 'scam', state: 'open', blocked: true });
  await expect(room.getByTestId('request-case')).toHaveText(`Reported. Case ${safety.caseId} is open.`);
  await expect(room.getByTestId('request-block')).toHaveText(`@${payee.handle} is blocked: they can no longer ask you for money.`);

  // The block is active: A can no longer ask B, in the app or through the API.
  const blocked = await trpcRaw(await api(payee), 'POST', 'bank/trpc/personalRequest.create', {
    payerUserId: payer.userId,
    assetId: 'USDT',
    amount: '1',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    idempotencyKey: `${J}:after-block:${tag}`,
  });
  expect(blocked.status).toBe(412);
  expect(JSON.stringify(blocked.body)).toContain('bank.personal_request_unavailable');

  // A sees Declined and nothing of the report or the block.
  const seen = await request(payee, third.requestId);
  expect(seen.status).toBe('declined');
  expect(Object.keys(seen)).not.toContain('safety');
  const hidden = await trpcRaw(await api(payee), 'GET', 'bank/trpc/personalRequest.safety', { requestId: third.requestId });
  expect(hidden.status).toBe(404);
  await signIn(page, payee);
  await page.goto(`/pay/request/${third.requestId}`);
  const theirs = page.getByTestId('request-room');
  await expect(theirs.getByTestId('request-status')).toHaveText('Declined');
  await expect(theirs.getByTestId('request-safety')).toHaveCount(0);
  await expect(theirs).not.toContainText(/report|block|case/i);
  // No money moved for any of it.
  expect(await usdt(payer)).toBe('18');
  expect(await usdt(payee)).toBe('13');
});

test(`${J} #6 the period passes on a fourth request: both lists show Expired, and a pay that races a decline lets exactly one win`, async ({
  page,
}) => {
  const { payee, payer } = people();
  const { fourth, fifth } = run.read();
  if (!fourth || !fifth) throw new Error(`${J} #4 made no fourth or fifth request`);
  // The fourth request was open for 60 seconds from step 4; wait out whatever is left of it.
  const made = await request(payee, fourth);
  const left = Date.parse(made.expiresAt) - Date.now();
  if (left > 0) await page.waitForTimeout(left + 1_000);
  expect((await request(payee, fourth)).status).toBe('expired');
  expect((await request(payer, fourth)).status).toBe('expired');

  for (const [who, list] of [
    [payee, 'requests-outgoing'],
    [payer, 'requests-incoming'],
  ]) {
    await signIn(page, who);
    await page.goto('/pay');
    await page.getByRole('tab', { name: 'Request', exact: true }).click();
    await expect(page.getByTestId(list).locator(`[data-request-id="${fourth}"]`).getByTestId('request-status')).toHaveText('Expired');
  }
  // An expired request cannot be paid.
  const late = await trpcRaw(await api(payer), 'POST', 'bank/trpc/transfers.toUser', {
    transferId: `request:${fourth}`,
    fromSpaceId: await payerSpace(),
    toUserId: payee.userId,
    amount: '4',
    requestId: fourth,
  });
  expect(late.status).not.toBe(200);
  expect(JSON.stringify(late.body)).toContain('bank.personal_request_expired');

  // The race: B pays and declines the fifth request at the same moment. Exactly one wins.
  const before = { payer: await usdt(payer), payee: await usdt(payee) };
  const b1 = await api(payer);
  const b2 = await api(payer);
  const space = await payerSpace();
  const [pay, decline] = await Promise.all([
    trpcRaw(b1, 'POST', 'bank/trpc/transfers.toUser', {
      transferId: `request:${fifth}`,
      fromSpaceId: space,
      toUserId: payee.userId,
      amount: '2',
      requestId: fifth,
    }),
    trpcRaw(b2, 'POST', 'bank/trpc/personalRequest.decline', { requestId: fifth }),
  ]);
  const wins = [pay.status === 200, decline.status === 200].filter(Boolean);
  expect(wins).toHaveLength(1);
  const after = await request(payee, fifth);
  if (pay.status === 200) {
    expect(after.status).toBe('paid');
    expect(toUnits(await usdt(payer))).toBe(toUnits(before.payer) - toUnits('2'));
    expect(toUnits(await usdt(payee))).toBe(toUnits(before.payee) + toUnits('2'));
  } else {
    expect(after.status).toBe('declined');
    expect(await usdt(payer)).toBe(before.payer);
    expect(await usdt(payee)).toBe(before.payee);
  }
});
