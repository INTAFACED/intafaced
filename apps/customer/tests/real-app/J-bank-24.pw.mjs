// World: stack
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test, expect } from './journey.mjs';
import { api, journeyState } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { absentIn } from './absent.mjs';
import { holderAgain, keyHolder, withKey } from './developer.mjs';

// J-bank-24, in the running app (docs/roadmap/journeys.json): I connect my systems to the bank API. One test per step,
// titled "J-bank-24 #<n>", run in order on one TEST account with a passkey (its second factor), whose bank money the
// stack's TEST partner bank holds (`testPartner.set({ custody: 'off' })`, the launch model, OWNER 226), funded there with
// TEST 100 USDT (`testPartner.fund`, the partner's figure, no ledger post). A second TEST account shares one pot with it.
// The person's program is this test calling Edge with the key made in #1 (`withKey`); the TEST partner's own doors
// (switches, funding, a payment's completion) are called with the person's session, as the stack's stand-in partner.
// The webhook receiver is this test's own TEST server on loopback (the URL guard's dev/test hatch). The ledger posts
// nothing: every figure checked is the partner's, and the person's ledger balance stays as it was.
const J = 'J-bank-24';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
const PARTNER = 'TEST partner bank';
const RECIPIENT = { name: 'TEST Supplier Inc', accountNumber: '000123456789', routingNumber: '021000021' };

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 15_000 });

/** @type {import('@playwright/test').Page} */
let page;
let hook;
let hookUrl = '';
/** Every request the TEST receiver took: its headers and raw body. */
const posts = [];

const code = (body) => body?.error?.data?.intafacedCode ?? body?.error?.data?.cause?.code ?? body?.error?.data?.code;
const trpcPath = (procedure, input) =>
  `/api/bank/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;

/** One bank API call with the key, as the developer's program sends it. */
async function keyCall(kind, procedure, input) {
  const key = run.read().key;
  if (!key) throw new Error(`${J} #1 made no key, so this step has no program to call with`);
  const res =
    kind === 'query'
      ? await withKey(key, { path: trpcPath(procedure, input) })
      : await withKey(key, { method: 'POST', path: `/api/bank/trpc/${procedure}`, body: input });
  return res.status === 200
    ? { ok: true, data: res.body.result.data }
    : { ok: false, status: res.status, code: code(res.body), body: res.body };
}

/** The person's own session, for the TEST partner's doors and the app's own transfers. */
async function session(who) {
  const own = await api(who);
  const answer = (res) =>
    res.status === 200 ? { ok: true, data: res.body.result.data } : { ok: false, status: res.status, code: code(res.body), body: res.body };
  return {
    userId: own.userId,
    query: async (procedure, input) => answer(await own.get(trpcPath(procedure, input))),
    mutate: async (procedure, input) => answer(await own.post(`/api/bank/trpc/${procedure}`, input)),
    balances: () => own.balances(),
  };
}

const okData = (res, what) => {
  expect(res, `${what}: ${JSON.stringify(res.body ?? {}).slice(0, 400)}`).toMatchObject({ ok: true });
  return res.data;
};

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  hook = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      posts.push({ at: Date.now(), headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') });
      res.statusCode = 200;
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    hook.once('error', reject);
    hook.listen(0, '127.0.0.1', resolve);
  });
  hookUrl = `http://127.0.0.1:${hook.address().port}/jb24/${RUN}`;

  const kept = run.read();
  if (kept.who) {
    page = await holderAgain(browser, kept.who);
    return;
  }
  const made = await keyHolder(browser, 'jb24');
  page = made.page;
  run.reset({ who: made.who });
});

test.afterAll(async () => {
  await new Promise((resolve) => (hook ? hook.close(() => resolve()) : resolve()));
});

test(`${J} #1 creates a token and approves it with SCA: the token's scopes; the secret shown once`, async () => {
  const { who } = run.read();
  // Starts on /developers: the quickstart's first step is the key.
  await page.goto('/developers/quickstart');
  await page.getByRole('link', { name: /key/i }).first().click();
  await expect(page).toHaveURL(/\/uc\/safe\/api-keys/);
  await page.goto('/uc/safe/api-keys/new');
  await page.getByLabel('Key name').fill('TEST bank books');
  await page.getByRole('checkbox', { name: /^bank:read\b/ }).check();
  await page.getByRole('checkbox', { name: /^bank:write\b/ }).check();
  // The strong customer authentication: the passkey (the virtual authenticator) approves this create, once.
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your new key' })).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
  const key = (await page.getByTestId('api-keys__key').locator('code').textContent())?.trim();
  expect(key, 'the key is shown once, on this page').toBeTruthy();
  run.write({ key });
  await page.getByLabel('I have stored this key somewhere safe').check();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(/\/uc\/safe\/api-keys$/);
  // The token's scopes are listed with it; the secret is not shown again anywhere.
  const row = page.getByRole('row', { name: /TEST bank books/ });
  await expect(row).toContainText('bank:read, bank:write');
  await expect(page.getByText(key)).toHaveCount(0);
  await page.reload();
  const listed = page.getByRole('row', { name: /TEST bank books/ });
  await absentIn(page.locator('main'), page.locator('main').getByText(key));
  await expect(listed).toContainText('bank:read, bank:write');
  await absentIn(page.locator('main'), page.locator('main').getByTestId('api-keys__key'));

  // The key now reaches the bank API with the scopes it was approved for.
  const own = await session(who);
  okData(await own.mutate('testPartner.set', { custody: 'off' }), 'the TEST partner holds the money');
  const reached = await keyCall('query', 'bankApi.accounts', { limit: 20 });
  expect(reached, JSON.stringify(reached.body ?? {}).slice(0, 300)).toMatchObject({ ok: true });
  // A key without the scope is refused: a made-up key is not a key.
  const forged = await withKey(`${key.slice(0, -4)}XXXX`, { path: trpcPath('bankApi.accounts', { limit: 20 }) });
  expect(forged.status).toBe(401);
});

test(`${J} #2 lists accounts with the filter joint: the partner's accounts and figures, only joint accounts, spend-today as decimal strings; a locked pot refuses a move`, async ({
  browser,
}) => {
  const { who } = run.read();
  const own = await session(who);
  const ledgerBefore = await own.balances();
  run.write({ ledgerBefore });
  okData(await own.mutate('testPartner.set', { custody: 'off' }), 'custody off');
  okData(
    await own.mutate('testPartner.fund', { fundId: `jb24-${who.email}`.slice(0, 64), assetId: 'USDT', amount: '100' }),
    'TEST 100 USDT',
  );
  const savings = okData(await own.mutate('spaces.create', { assetId: 'USDT', name: 'TEST Savings' }), 'savings pot');
  const joint = okData(await own.mutate('spaces.create', { assetId: 'USDT', name: 'TEST Household' }), 'household pot');
  const locked = okData(
    await own.mutate('spaces.create', {
      assetId: 'USDT',
      name: 'TEST Locked',
      lockedUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    }),
    'locked pot',
  );
  // A second TEST person shares the household pot: it is a joint account.
  const ctx = await browser.newContext();
  const other = await signUp(await ctx.newPage(), 'jb24m');
  await verify(await ctx.newPage(), other);
  await ctx.close();
  const theirs = await session(other);
  okData(await theirs.mutate('testPartner.set', { custody: 'off' }), 'the member at the TEST partner');
  const invite = okData(
    await own.mutate('sharedPots.invite', { inviteId: randomUUID(), spaceId: joint.id, handle: other.handle, role: 'contributor' }),
    'invite',
  );
  okData(await theirs.mutate('sharedPots.accept', { inviteId: invite.inviteId }), 'accept');
  const spaces = okData(await own.query('spaces.list', { limit: 50 }), 'spaces');
  const main = spaces.find((s) => s.kind === 'primary' && s.assetId === 'USDT');
  // TEST 20 into the household pot through the app's own transfer: one partner move.
  okData(
    await own.mutate('transfers.create', { transferId: randomUUID(), fromSpaceId: main.id, toSpaceId: joint.id, amount: '20' }),
    'TEST 20 into the joint pot',
  );
  run.write({ mainId: main.id, savingsId: savings.id, jointId: joint.id, lockedId: locked.id, other });

  const listed = okData(await keyCall('query', 'bankApi.accounts', { type: 'joint', limit: 20 }), 'accounts filter joint');
  expect(listed.items).toEqual([
    expect.objectContaining({
      id: joint.id,
      type: 'joint',
      name: 'TEST Household',
      assetId: 'USDT',
      heldAt: PARTNER,
      balance: '20',
      figure: 'known',
      spendToday: '0',
    }),
  ]);
  for (const a of listed.items) {
    expect(typeof a.balance).toBe('string');
    expect(a.spendToday).toMatch(/^\d+(\.\d+)?$/);
    expect(a.asOf).toBeTruthy();
  }
  // The figures are the partner's: the same as the app's own read of that pot at the partner.
  const appPot = okData(await own.query('spaces.list', { limit: 50 }), 'spaces again').find((s) => s.id === joint.id);
  expect(appPot.balance).toBe('20');
  // Without the filter every account is listed; the main balance's spend-today is a decimal string too.
  const all = okData(await keyCall('query', 'bankApi.accounts', { limit: 20 }), 'every account').items;
  expect(all.map((a) => a.type).sort()).toEqual(['joint', 'savings', 'savings', 'standard']);
  expect(all.find((a) => a.type === 'standard')).toMatchObject({ id: main.id, balance: '80', spendToday: '0' });
  expect(all.find((a) => a.id === locked.id)).toMatchObject({ locked: true });

  // A locked pot refuses a move out, by name, before anything is asked of the partner.
  const refusedQuote = await keyCall('mutation', 'bankApi.quoteMove', { fromAccountId: locked.id, toAccountId: main.id, amount: '1' });
  expect(refusedQuote).toMatchObject({ ok: false, code: 'bank.space_locked' });
  expect(okData(await keyCall('query', 'bankApi.accounts', { limit: 20 }), 'unchanged').items.find((a) => a.id === main.id)).toMatchObject({
    balance: '80',
  });
});

test(`${J} #3 moves a balance with a quote: the partner's quote with the exact figures; one partner move, once`, async () => {
  const { mainId, savingsId } = run.read();
  const quote = okData(
    await keyCall('mutation', 'bankApi.quoteMove', { fromAccountId: mainId, toAccountId: savingsId, amount: '25' }),
    'quote',
  );
  expect(quote).toMatchObject({ amount: '25', fee: '0', receives: '25', assetId: 'USDT', heldAt: PARTNER });
  expect(new Date(quote.validUntil).getTime()).toBeGreaterThan(Date.now());
  const dedupeId = `jb24-move-${RUN}-${Date.now().toString(36)}`;
  const first = okData(await keyCall('mutation', 'bankApi.move', { quoteId: quote.quoteId, dedupeId }), 'move');
  const again = okData(await keyCall('mutation', 'bankApi.move', { quoteId: quote.quoteId, dedupeId }), 'the same move again');
  expect(first).toMatchObject({ state: 'completed', dedupeId, quote: { quoteId: quote.quoteId, amount: '25', fee: '0', receives: '25' } });
  expect(first.partnerMoveId).toBeTruthy();
  expect(again).toEqual(first);
  // Once: TEST 25 left the main balance and arrived in savings, one time.
  const after = okData(await keyCall('query', 'bankApi.accounts', { limit: 20 }), 'after').items;
  expect(after.find((a) => a.id === mainId)).toMatchObject({ balance: '55' });
  expect(after.find((a) => a.id === savingsId)).toMatchObject({ balance: '25' });
  // The same dedupe id on another quote is another instruction, refused; nothing moves.
  const other = okData(
    await keyCall('mutation', 'bankApi.quoteMove', { fromAccountId: mainId, toAccountId: savingsId, amount: '5' }),
    'second quote',
  );
  expect(await keyCall('mutation', 'bankApi.move', { quoteId: other.quoteId, dedupeId })).toMatchObject({
    ok: false,
    code: 'bank.idempotency_conflict',
  });
  expect(okData(await keyCall('query', 'bankApi.accounts', { limit: 20 }), 'unchanged').items.find((a) => a.id === mainId)).toMatchObject({
    balance: '55',
  });
});

test(`${J} #4 creates an instant and an ACH payment: the transfer in its lifecycle through the partner; with no rail the notice with rail.bank`, async () => {
  const { who, mainId } = run.read();
  const own = await session(who);
  const ask = { fromAccountId: mainId, recipient: RECIPIENT, amount: '10' };
  // No rail: the notice names rail.bank, and the payment's intent row is kept refused.
  okData(await own.mutate('testPartner.set', { bankRail: 'none' }), 'no rail');
  const noRail = await keyCall('mutation', 'bankApi.createPayment', { ...ask, idempotencyKey: `jb24-none-${RUN}`, method: 'instant' });
  expect(noRail).toMatchObject({ ok: false, code: 'rail.bank' });
  expect(JSON.stringify(noRail.body)).toContain('needs rail.bank. It is switched off in this build.');
  const kept = okData(await keyCall('query', 'bankApi.payments', { limit: 20 }), 'payments').items;
  expect(kept.find((p) => p.idempotencyKey === `jb24-none-${RUN}`)).toMatchObject({
    state: 'refused',
    refusalCode: 'rail.bank',
    method: 'instant',
  });

  // With the TEST partner's rail: each payment is made pending through the partner, once per key.
  okData(await own.mutate('testPartner.set', { bankRail: 'test' }), 'the TEST rail');
  const instant = okData(
    await keyCall('mutation', 'bankApi.createPayment', { ...ask, idempotencyKey: `jb24-instant-${RUN}`, method: 'instant' }),
    'instant',
  );
  const ach = okData(
    await keyCall('mutation', 'bankApi.createPayment', { ...ask, idempotencyKey: `jb24-ach-${RUN}`, method: 'ach' }),
    'ACH',
  );
  expect(instant).toMatchObject({ method: 'instant', state: 'pending', version: 1, heldAt: PARTNER, amount: '10' });
  expect(ach).toMatchObject({ method: 'ach', state: 'pending', version: 1, heldAt: PARTNER, amount: '10' });
  const retried = okData(
    await keyCall('mutation', 'bankApi.createPayment', { ...ask, idempotencyKey: `jb24-ach-${RUN}`, method: 'ach' }),
    'ACH again',
  );
  expect(retried).toMatchObject({ id: ach.id, state: 'pending' });
  expect(okData(await keyCall('query', 'bankApi.payment', { paymentId: ach.id }), 'ACH read')).toMatchObject({ state: 'pending' });
  // Two payments of TEST 10 left the main balance at the partner, once each.
  expect(okData(await keyCall('query', 'bankApi.accounts', { type: 'standard', limit: 5 }), 'main').items[0]).toMatchObject({
    balance: '35',
    spendToday: '20',
  });
  run.write({ achId: ach.id });
});

test(`${J} #5 receives the webhook when a transfer goes from pending to completed: one delivery with previous and current state; a replay is de-duplicated`, async () => {
  const { who, achId, ledgerBefore } = run.read();
  const own = await session(who);
  const endpoint = okData(await keyCall('mutation', 'bankApi.createWebhook', { endpointId: randomUUID(), url: hookUrl }), 'endpoint');
  expect(endpoint.secret).toMatch(/^whsec_[0-9a-f]{64}$/);

  const settled = okData(await own.mutate('testPartner.settlePayment', { paymentId: achId }), 'the partner completes the ACH payment');
  expect(settled).toMatchObject({ state: 'completed', version: 2, recorded: true });
  const eventId = `bank.transfer.state_changed:${achId}:2`;
  await expect.poll(() => posts.filter((p) => p.headers['x-intafaced-event-id'] === eventId).length, { timeout: 20_000 }).toBe(1);

  // The partner replays its report: the same version, recorded once, delivered once.
  const replay = okData(await own.mutate('testPartner.settlePayment', { paymentId: achId }), 'the partner replays its report');
  expect(replay).toMatchObject({ state: 'completed', version: 2, recorded: false });
  // A later change is delivered after the replay was answered: by then any second copy of the first would have arrived.
  const later = okData(
    await keyCall('mutation', 'bankApi.createPayment', {
      idempotencyKey: `jb24-later-${RUN}`,
      fromAccountId: run.read().mainId,
      method: 'instant',
      recipient: RECIPIENT,
      amount: '1',
    }),
    'a later payment',
  );
  const laterEvent = `bank.transfer.state_changed:${later.id}:1`;
  await expect.poll(() => posts.filter((p) => p.headers['x-intafaced-event-id'] === laterEvent).length, { timeout: 20_000 }).toBe(1);
  const delivered = posts.filter((p) => p.headers['x-intafaced-event-id'] === eventId);
  expect(delivered).toHaveLength(1);
  const body = JSON.parse(delivered[0].raw);
  expect(body).toMatchObject({
    id: eventId,
    type: 'transfer.state_changed',
    transferId: achId,
    previousState: 'pending',
    currentState: 'completed',
    version: 2,
  });
  // Signed with the endpoint's secret, over its timestamp and the exact body.
  const signature = createHmac('sha256', endpoint.secret)
    .update(`${delivered[0].headers['x-intafaced-timestamp']}.${delivered[0].raw}`)
    .digest('hex');
  expect(delivered[0].headers['x-intafaced-signature']).toBe(`v1=${signature}`);
  const log = okData(await keyCall('query', 'bankApi.deliveries', { paymentId: achId, limit: 10 }), 'delivery log').items;
  expect(log).toEqual([
    expect.objectContaining({ eventId, previous: 'pending', current: 'completed', state: 'delivered', attempts: 1, lastStatus: 200 }),
  ]);
  expect(okData(await keyCall('query', 'bankApi.payment', { paymentId: achId }), 'ACH now')).toMatchObject({
    state: 'completed',
    version: 2,
  });
  // The ledger posted nothing for any of it.
  expect(await own.balances()).toEqual(ledgerBefore);
});
