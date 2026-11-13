// World: book
import { createRequire } from 'node:module';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { CHAIN_ID, TOKEN_USD, connectWallet, fundOnTestChain, testChain } from './dex.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { api } from './stack.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';

// J-academy-07, in the running app (docs/roadmap/journeys.json): buy a paid course and get access. One test per step,
// titled "J-academy-07 #<n>", run in order by one verified TEST learner with a TEST wallet of this run's own, connected to
// the stack's LOCAL TEST chain (tooling/scripts/local-test-chain.mjs, chain id 84532) and funded there with TEST USD.
//
// The stack sells a priced course's certificate track for the ledger asset USDC, paid in the chain's seeded TEST USD token
// (6 decimals) to INTAFACED's TEST receiving address, counted after two confirmations, with the chain's TEST refund signer
// (tooling/scripts/local-stack-services/academy.mjs). Staff make this run's courses through Academy's admin door, as
// J-academy-01 does. Money: the learner's wallet signs one TEST USD transfer to INTAFACED; once the chain confirmed it,
// the ledger records it once under `academy:purchase:<course>:<learner>:1` (read back by that key, to the exact decimal
// amount the chain moved); the refund is one TEST USD send from INTAFACED's own receiving address, recorded once under
// `academy:refund:<course>:<learner>:1`. The learner's own balances on the ledger never move.
//
// #4 pauses the TEST chain's one-second interval mining while it watches the payment wait for its second confirmation,
// mines that block itself (`evm_mine`, the TEST chain's own control, as J-dex-protocol-05 does) and puts the interval back.
// #5's lost replies are made in the browser: one Buy answer is dropped after Academy stored it, and the report of the
// sent payment never reaches Academy, which then finds the payment on the chain itself.
const J = 'J-academy-07';
const RUN = Date.now().toString(36);
const PRICE = '2.5';
const PRICE_UNITS = 2_500_000n; // 2.5 TEST USD in the token's 6 decimals
const ASSET = 'USDC';
const REFUND_REASON = `TEST ${J}: the learner asked for their money back within the refund window`;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

test.describe.configure({ mode: 'serial' });

/** What one run keeps between steps (serial, one worker). */
const run = { who: null, userId: null, walletKey: null, unpriced: null, priced: null, second: null, key: null, payment: null };

let staffDoor;
async function founders() {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const sessions = await gates.approverSessions(ctx);
    return { ctx, sessions };
  })();
  return staffDoor;
}

/** One call on Academy's admin door with a founder session's token (`tradeOpsToken`: admin:read and admin:write). */
async function staff(kind, procedure, input, { as = 'a', token } = {}) {
  const { ctx, sessions } = await founders();
  const res = await ctx.edge[kind]('academy', procedure, input, token ?? (await sessions[as].tradeOpsToken()));
  return { status: res.status, body: JSON.parse(res.text) };
}
const data = (res) => {
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
  return res.body.result.data;
};
const codeOf = (res) => res.body?.error?.data?.cause?.code ?? res.body?.error?.data?.appCode ?? res.body?.error?.json?.data?.cause?.code;

/** A course staff make: details with its price, a one-lesson outline, published; a price withdrawn after when asked. */
async function staffCourse(tag, { price, withdrawPrice = false }) {
  const slug = `test-j07-${tag}-${RUN}`;
  const title = `TEST J-academy-07 ${tag} course ${RUN}`;
  const course = data(
    await staff('mutate', 'admin.createCourse', {
      slug,
      title,
      summary: `TEST ${title}, made by staff for ${J}.`,
      thumbnailUrl: null,
      pricing: 'paid',
      price,
      priceAsset: ASSET,
    }),
  );
  const outline = data(
    await staff('mutate', 'admin.saveOutline', {
      courseId: course.id,
      revision: course.revision,
      sections: [{ title: 'TEST Week one', items: [{ kind: 'lesson', title: `TEST First lesson of ${title}`, indent: 0, url: null }] }],
    }),
  );
  const published = data(
    await staff('mutate', 'admin.setCourseState', {
      courseId: course.id,
      to: 'published',
      revision: outline.course.revision,
      reason: `TEST ${J}: publish ${slug}`,
    }),
  );
  if (withdrawPrice)
    data(
      await staff('mutate', 'admin.withdrawCoursePrice', {
        courseId: course.id,
        revision: published.revision,
        reason: `TEST ${J}: withdraw the price of ${slug}`,
      }),
    );
  return { slug, title, id: course.id };
}

/** The learner's own Academy door, as the page calls it. */
async function learner() {
  return api(run.who);
}
async function learnerQuery(procedure, input) {
  const me = await learner();
  return me.get(`/api/academy/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`);
}
async function purchaseView(slug) {
  const res = await learnerQuery('coursePurchase', { slug });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** One JSON-RPC call on the stack's TEST chain, through its gate. */
async function chainRpc(method, params = []) {
  const res = await fetch(testChain().gateUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
async function withMiningPaused(fn) {
  const interval = await chainRpc('anvil_getIntervalMining');
  await chainRpc('evm_setIntervalMining', [0]);
  try {
    return await fn();
  } finally {
    await chainRpc('evm_setIntervalMining', [interval]);
  }
}
const word = (address) => `0x${address.toLowerCase().slice(2).padStart(64, '0')}`;
/** The TEST USD transfers one mined transaction made, read from the node's own receipt. */
async function transfersIn(hash) {
  const receipt = await chainRpc('eth_getTransactionReceipt', [hash]);
  expect(receipt?.status, `${hash} mined and succeeded`).toBe('0x1');
  return receipt.logs
    .filter((log) => log.topics[0] === TRANSFER_TOPIC && log.address.toLowerCase() === TOKEN_USD.address)
    .map((log) => ({ from: log.topics[1], to: log.topics[2], value: BigInt(log.data) }));
}
async function usdOf(address) {
  const balanceOf = `0x70a08231${word(address).slice(2)}`;
  return BigInt(await chainRpc('eth_call', [{ to: TOKEN_USD.address, data: balanceOf }, 'latest']));
}

/** One booked ledger transaction, found by its business key, as svc-ledger itself holds it (founder A, admin:treasury). */
async function ledgerTrace(businessKey) {
  const { ctx, sessions } = await founders();
  const res = await fetch(`${ctx.url('ledger')}/operator/trace?businessKey=${encodeURIComponent(businessKey)}`, {
    headers: { authorization: `Bearer ${await sessions.a.treasuryToken()}` },
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text);
}
/** Every posting of a booked transaction is the price, in USDC, to the exact decimal: debits equal credits. */
function expectPrice(tx) {
  expect(tx.postings.length).toBeGreaterThanOrEqual(2);
  for (const p of tx.postings) {
    expect(p.assetId).toBe(ASSET);
    expect(p.amount).toMatch(/^\d+(\.\d+)?$/);
    expect(p.amount.replace(/\.?0+$/, '')).toBe(PRICE);
  }
}

/** svc-academy's own rows for one course and learner, read on its own database role on the stack. */
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
async function purchaseRows(courseId) {
  const { ctx } = await founders();
  const postgres = createRequire(nodePath.join(REPO, 'services', 'svc-academy', 'package.json'))('postgres');
  const port = ctx.marker.ports.postgres ?? 15460;
  const sql = postgres(`postgres://svc_academy:${encodeURIComponent(ctx.secrets.pgService)}@127.0.0.1:${port}/intafaced_local_test`, {
    max: 1,
    onnotice: () => {},
  });
  try {
    return await sql`SELECT purchase_key, state, tx_hash FROM academy.course_purchases WHERE course_id = ${courseId} AND user_id = ${run.userId}`;
  } finally {
    await sql.end();
  }
}

/** The learner signed in, with the run's TEST wallet connected in Wallet, on one course's page. */
async function openCourse(page, slug) {
  await signIn(page, run.who);
  const wallet = await connectWallet(page, { onChain: true, key: () => run.walletKey });
  await page.goto(`/academy/learning/course/${slug}`);
  const root = page.locator(`[data-academy-authored-course="${slug}"]`);
  await expect(root).toBeVisible({ timeout: 30_000 });
  return { wallet, root, panel: page.locator(`[data-academy-purchase="${slug}"]`) };
}
const signSheet = (page) => page.locator('[data-sheet="sign"]');
const transferSends = (wallet) => wallet.sends.filter((s) => s.method === 'eth_sendTransaction');

test(`${J} starts signed in, verified, with a connected TEST wallet holding TEST USD; a published course has a priced certificate track`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  expect(testChain().chain, 'the stack runs its LOCAL TEST chain').toBe('running');
  run.who = await signUp(page, 'ja07');
  await verify(page, run.who);
  run.userId = (await learner()).userId;
  run.walletKey = testWalletKey();
  const address = privateKeyToAccount(run.walletKey).address;
  fundOnTestChain(address, 'venue');
  expect(await usdOf(address)).toBeGreaterThanOrEqual(PRICE_UNITS * 2n);
  // The wallet is the learner's own: linked to their account by its own signature and a passkey confirmation, as
  // J-agents-02 #4 links one (Security, Sign-in methods). Only a linked wallet may pay for a purchase.
  const passkeyContext = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
  try {
    const linking = await passkeyContext.newPage();
    await virtualAuthenticator(linking);
    const linked = await installTestWallet(linking, { chainId: CHAIN_ID, privateKey: run.walletKey });
    await signIn(linking, run.who);
    await addPasskey(linking);
    const card = linking.getByTestId('security__signin-methods');
    const walletsRow = card.getByRole('listitem', { name: 'Wallets', exact: true });
    await walletsRow.getByRole('button', { name: 'Link a wallet' }).click();
    await card.getByRole('form', { name: 'Confirm it is you' }).getByRole('button', { name: 'Confirm with a passkey' }).click();
    await expect(walletsRow.getByTitle(linked.address)).toBeVisible();
  } finally {
    await passkeyContext.close();
  }
  run.unpriced = await staffCourse('unpriced', { price: PRICE, withdrawPrice: true });
  run.priced = await staffCourse('priced', { price: PRICE });
  run.second = await staffCourse('second', { price: PRICE });
  const { root } = await openCourse(page, run.priced.slug);
  await expect(root.getByRole('heading', { name: run.priced.title })).toBeVisible();
});

test(`${J} #1 a paid course with no price set shows without a price, and Enrol refuses with "price not set"`, async ({ page }) => {
  const { root, panel } = await openCourse(page, run.unpriced.slug);
  await expect(root.getByText('Paid, with no price set yet')).toBeVisible();
  await expect(root).not.toContainText(/\d+(\.\d+)? (USDT|USD|USDC)\b/);
  await expect(panel.getByText('Price not set: this paid track cannot be bought until staff set a price.').first()).toBeVisible();
  await expect(panel.getByTestId('academy-purchase-price')).toHaveCount(0);
  // Choosing the paid track: Enrol refuses with the reason beside it, and Buy is refused for the same reason.
  await root.getByLabel('Certificate track').check();
  await expect(root.getByText('Enrol is refused: price not set.')).toBeVisible();
  await expect(root.getByRole('button', { name: 'Enrol now' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Buy', exact: true })).toBeDisabled();
  // The service refuses the same, by name, whoever asks.
  const me = await learner();
  const enrol = await me.post('/api/academy/trpc/enrolCourse', { slug: run.unpriced.slug, track: 'certificate' });
  // Enrol's own refusal names the reason: the certificate track is closed because no price is set.
  expect(enrol.status).toBe(412);
  expect(codeOf(enrol)).toBe('academy.enrolment_closed');
  expect(enrol.body.error.message).toContain('track=certificate reason=no_price');
  const terms = (await learnerQuery('courseEnrolment', { slug: run.unpriced.slug })).body.result.data;
  expect(terms.tracks.find((row) => row.track === 'certificate')).toMatchObject({ free: false, closed: 'no_price' });
  const buy = await me.post('/api/academy/trpc/buyCourse', { slug: run.unpriced.slug, wallet: privateKeyToAccount(run.walletKey).address });
  expect(codeOf(buy)).toBe('academy.price_unset');
  expect(await purchaseRows(run.unpriced.id)).toHaveLength(0);
});

test(`${J} #2 a priced course shows the price, the free and paid track difference, and a Buy control`, async ({ page }) => {
  const { root, panel } = await openCourse(page, run.priced.slug);
  await expect(panel.getByTestId('academy-purchase-price')).toHaveText(`Price: ${PRICE} ${ASSET}`);
  await expect(panel).toContainText(
    'The free track costs nothing and needs no payment. The certificate track is the paid track: it opens once your payment is confirmed and recorded.',
  );
  await expect(root.getByLabel('Free track')).toBeEnabled();
  await root.getByLabel('Certificate track').check();
  await expect(root.getByLabel('Certificate track')).toBeChecked();
  await expect(panel.getByTestId('academy-purchase-wallet')).toHaveText(
    `Paying from ${privateKeyToAccount(run.walletKey).address.toLowerCase()}`,
  );
  await expect(panel.getByRole('button', { name: 'Buy', exact: true })).toBeEnabled();
  const view = await purchaseView(run.priced.slug);
  expect(view).toMatchObject({
    pricing: 'paid',
    price: PRICE,
    asset: ASSET,
    wallet: { state: 'on', chainId: CHAIN_ID, token: TOKEN_USD.address },
    purchase: null,
  });
});

test(`${J} #3 Enrol now on the paid track with no purchase is a typed refusal that payment is required`, async ({ page }) => {
  const { root } = await openCourse(page, run.priced.slug);
  await root.getByLabel('Certificate track').check();
  const answered = page.waitForResponse((res) => res.url().includes('/api/academy/trpc/enrolCourse'));
  await root.getByRole('button', { name: 'Enrol now' }).click();
  expect((await answered).status()).toBe(403);
  await expect(root.getByText('Payment is required: buy the certificate track before you enrol on it.')).toBeVisible();
  const me = await learner();
  const enrol = await me.post('/api/academy/trpc/enrolCourse', { slug: run.priced.slug, track: 'certificate' });
  expect(enrol.status).toBe(403);
  expect(codeOf(enrol)).toBe('academy.payment_required');
  const terms = await learnerQuery('courseEnrolment', { slug: run.priced.slug });
  expect(terms.body.result.data.enrolment).toBeNull();
});

test(`${J} #4 Buy asks the wallet to sign one payment to INTAFACED; the grant appears only after it confirms and posted; a rejected signature leaves no purchase`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const payer = privateKeyToAccount(run.walletKey).address.toLowerCase();
  const { root, panel, wallet } = await openCourse(page, run.priced.slug);
  const buy = panel.getByRole('button', { name: 'Buy', exact: true });

  // A wallet that is not linked to this account cannot be named as the payer: nobody's payment counts for another.
  const notMine = privateKeyToAccount(testWalletKey()).address;
  const refusedWallet = await (await learner()).post('/api/academy/trpc/buyCourse', { slug: run.priced.slug, wallet: notMine });
  expect(refusedWallet.status).toBe(403);
  expect(codeOf(refusedWallet)).toBe('academy.wallet_not_linked');
  expect(await purchaseRows(run.priced.id)).toHaveLength(0);

  // Rejected in the wallet itself (code 4001): nothing was bought, and no purchase is left.
  wallet.rejectNextSend();
  await buy.click();
  await expect(signSheet(page)).toBeVisible();
  await signSheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(panel.getByText('Your wallet rejected the payment, so nothing was bought.')).toBeVisible();
  expect(transferSends(wallet)).toHaveLength(0);
  expect((await purchaseView(run.priced.slug)).purchase).toBeNull();
  await expect(panel.getByTestId('academy-purchase-state')).toHaveCount(0);

  const before = await usdOf(payer);
  await withMiningPaused(async () => {
    await buy.click();
    const sheet = signSheet(page);
    await expect(sheet).toBeVisible();
    // One transfer of the price, in the token's units, to INTAFACED's receiving address, on the TEST USD token.
    const view = await purchaseView(run.priced.slug);
    expect(view.wallet.state).toBe('on');
    await expect(sheet).toContainText(view.wallet.token);
    await sheet.getByRole('button', { name: 'Continue in wallet' }).click();
    await expect.poll(() => transferSends(wallet).length).toBe(1);
    const sent = transferSends(wallet)[0];
    expect(sent.params[0].to.toLowerCase()).toBe(view.wallet.token);
    expect(sent.params[0].data.toLowerCase()).toBe(
      `0xa9059cbb${word(view.wallet.receiver).slice(2)}${PRICE_UNITS.toString(16).padStart(64, '0')}`,
    );
    await expect.poll(() => sent.hash ?? null).not.toBeNull();
    run.payment = sent.hash.toLowerCase();

    // Mined once, not yet confirmed twice: the payment waits, no grant, no enrolment, and nothing on the ledger.
    const waiting = panel.getByTestId('academy-purchase-state');
    await expect(waiting).toHaveAttribute('data-state', 'submitted', { timeout: 20_000 });
    await expect(waiting).toHaveAttribute('data-grant', 'none');
    await expect(waiting).toContainText('Payment sent. The network is confirming it');
    await expect(panel.getByTestId('academy-purchase-tx')).toHaveText(run.payment);
    const pending = await purchaseView(run.priced.slug);
    run.key = pending.purchase.key;
    expect(run.key).toBe(`academy:purchase:${run.priced.slug}:${run.userId}:1`);
    expect(pending.purchase).toMatchObject({ state: 'submitted', grant: null, txHash: run.payment, amount: PRICE, asset: ASSET, payer });
    await page.waitForTimeout(5_000); // more than two reconcile rounds: still not counted
    expect((await purchaseView(run.priced.slug)).purchase).toMatchObject({ state: 'submitted', grant: null });
    expect(await ledgerTrace(run.key)).toEqual({ found: false, businessKey: run.key });
    const enrol = await (await learner()).post('/api/academy/trpc/enrolCourse', { slug: run.priced.slug, track: 'certificate' });
    expect(codeOf(enrol)).toBe('academy.payment_required');
    await chainRpc('evm_mine');
  });

  // Confirmed and posted: the grant appears, and the paid track can be enrolled on.
  const state = panel.getByTestId('academy-purchase-state');
  await expect(state).toHaveAttribute('data-state', 'posted', { timeout: 60_000 });
  await expect(state).toHaveAttribute('data-grant', 'granted');
  await expect(state).toContainText('Bought. Your access to the certificate track is granted.');
  const posted = (await purchaseView(run.priced.slug)).purchase;
  expect(posted).toMatchObject({ key: run.key, state: 'posted', grant: 'granted', txHash: run.payment });
  expect(Date.parse(posted.postedAt)).toBeGreaterThan(Date.parse(posted.createdAt));

  // Money: the chain moved exactly the price from the wallet to INTAFACED, once; the ledger booked that amount once under the key.
  const moved = await transfersIn(run.payment);
  expect(moved).toEqual([{ from: word(payer), to: word(posted.receiver), value: PRICE_UNITS }]);
  expect(before - (await usdOf(payer))).toBe(PRICE_UNITS);
  const tx = await ledgerTrace(run.key);
  expect(tx).toMatchObject({ found: true, businessKey: run.key, module: 'academy' });
  expectPrice(tx);
  const staffRead = data(await staff('query', 'admin.coursePurchase', { key: run.key }));
  expect(staffRead).toMatchObject({ course: run.priced.slug, userId: run.userId, state: 'posted', refundLedgerTxId: null });
  expect(staffRead.ledgerTxId).toBe(tx.txId);

  await page.reload();
  await root.getByLabel('Certificate track').check();
  await root.getByRole('button', { name: 'Enrol now' }).click();
  await expect(root.getByText(/Enrolled on the Certificate track/i)).toBeVisible();
  expect(await purchaseRows(run.priced.id)).toHaveLength(1);
});

test(`${J} #5 a second Buy or a lost reply is still one purchase and no second signature request; the screen re-reads the stored state`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const slug = run.second.slug;
  const payer = privateKeyToAccount(run.walletKey).address;
  const { panel, wallet } = await openCourse(page, slug);

  // The answer to Buy is lost after Academy stored the purchase: the wallet is not asked, and a reload shows the stored one.
  await page.route('**/api/academy/trpc/buyCourse**', async (route) => {
    await route.fetch();
    await route.abort('connectionreset');
  });
  await panel.getByRole('button', { name: 'Buy', exact: true }).click();
  // The screen re-reads the stored purchase by itself: the one intent, waiting on a signature it will not ask for again.
  await expect(panel.getByTestId('academy-purchase-state')).toHaveAttribute('data-state', 'awaiting_signature', { timeout: 20_000 });
  await page.unroute('**/api/academy/trpc/buyCourse**');
  expect(transferSends(wallet)).toHaveLength(0);
  await expect(signSheet(page)).toHaveCount(0);
  await page.reload();
  await expect(panel.getByTestId('academy-purchase-state')).toHaveAttribute('data-state', 'awaiting_signature');
  await expect(panel).toContainText('Your wallet has already been asked to sign this payment, so it is not asked again.');
  await expect(panel.getByRole('button', { name: 'Buy', exact: true })).toHaveCount(0);
  // A second Buy, from anywhere, answers the same purchase and asks for no signature.
  const again = data(await (await learner()).post('/api/academy/trpc/buyCourse', { slug, wallet: payer }));
  expect(again.request).toBeNull();
  expect(again.purchase.key).toBe(`academy:purchase:${slug}:${run.userId}:1`);
  expect(await purchaseRows(run.second.id)).toHaveLength(1);

  // The person says they rejected it; Buy again asks the wallet once, even when pressed twice.
  await panel.getByRole('button', { name: 'I rejected it in my wallet' }).click();
  await expect(panel.getByTestId('academy-purchase-state')).toHaveCount(0);
  // The answer to the payment report is lost after Academy stored it: the screen re-reads, and the payment is settled once.
  let reported = 0;
  await page.route('**/api/academy/trpc/submitCoursePayment**', async (route) => {
    reported += 1;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await panel.getByRole('button', { name: 'Buy', exact: true }).dblclick();
  await expect(signSheet(page)).toHaveCount(1);
  await signSheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect.poll(() => transferSends(wallet).length).toBe(1);
  await expect.poll(() => transferSends(wallet)[0].hash ?? null).not.toBeNull();
  const hash = transferSends(wallet)[0].hash.toLowerCase();
  await expect.poll(() => reported).toBe(1);
  await page.unroute('**/api/academy/trpc/submitCoursePayment**');
  await expect
    .poll(async () => (await purchaseView(slug)).purchase?.state, { timeout: 60_000, message: 'Academy found the payment on the chain' })
    .toBe('posted');
  await page.reload();
  const state = panel.getByTestId('academy-purchase-state');
  await expect(state).toHaveAttribute('data-state', 'posted');
  await expect(state).toHaveAttribute('data-grant', 'granted');
  await expect(panel.getByTestId('academy-purchase-tx')).toHaveText(hash);

  // Still one purchase, one signature, one payment on the chain and one ledger post under the key.
  const key = `academy:purchase:${slug}:${run.userId}:1`;
  const rows = await purchaseRows(run.second.id);
  expect(rows).toEqual([{ purchase_key: key, state: 'posted', tx_hash: hash }]);
  expect(transferSends(wallet)).toHaveLength(1);
  expect(await transfersIn(hash)).toHaveLength(1);
  const tx = await ledgerTrace(key);
  expect(tx).toMatchObject({ found: true, businessKey: key });
  expectPrice(tx);
  const after = data(await (await learner()).post('/api/academy/trpc/buyCourse', { slug, wallet: payer }));
  expect(after).toMatchObject({ request: null, purchase: { key, state: 'posted' } });
});

test(`${J} #6 Pay by card, with no card partner set, shows that card payment needs a card partner and is switched off`, async ({
  page,
}) => {
  const { panel } = await openCourse(page, run.priced.slug);
  const card = panel.getByRole('group', { name: 'Pay by card' });
  await expect(card.getByRole('button', { name: 'Pay by card' })).toBeDisabled();
  await expect(card.getByText('Card payment needs a card partner. It is switched off in this build.').first()).toBeVisible();
  await expect(card).toContainText('rail.card');
  expect((await purchaseView(run.priced.slug)).card).toEqual({ state: 'off', code: 'rail.card' });
});

test(`${J} #7 staff with the refund permission refund: INTAFACED sends the TEST amount once from its own funds with the chain reference; the grant ends and the grant audit shows it with its reason`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const payer = privateKeyToAccount(run.walletKey).address.toLowerCase();
  const { sessions } = await founders();
  const refundKey = `academy:refund:${run.priced.slug}:${run.userId}:1`;

  // A session without the refund permission (the support desk's scopes only) is refused, and nothing moves.
  const refused = await staff(
    'mutate',
    'admin.refundCoursePurchase',
    { key: run.key, reason: REFUND_REASON },
    { token: await sessions.a.supportOpsToken() },
  );
  expect(refused.status).toBe(403);
  const noReason = await staff('mutate', 'admin.refundCoursePurchase', { key: run.key, reason: ' ' }, { as: 'b' });
  expect(noReason.status).toBe(400);
  expect((await purchaseView(run.priced.slug)).purchase.state).toBe('posted');

  const before = await usdOf(payer);
  const refunding = data(await staff('mutate', 'admin.refundCoursePurchase', { key: run.key, reason: REFUND_REASON }, { as: 'b' }));
  expect(refunding).toMatchObject({ key: run.key, state: 'refunding', refund: { reason: REFUND_REASON } });
  // A second press is the same refund, never a second send.
  const twice = await staff('mutate', 'admin.refundCoursePurchase', { key: run.key, reason: REFUND_REASON }, { as: 'b' });
  expect(twice.status).toBe(409);
  expect(codeOf(twice)).toBe('academy.purchase_state');

  const { panel, root } = await openCourse(page, run.priced.slug);
  const state = panel.getByTestId('academy-purchase-state');
  await expect(state).toHaveAttribute('data-state', 'refunded', { timeout: 60_000 });
  await expect(state).toHaveAttribute('data-grant', 'revoked');
  await expect(state).toContainText(`Refunded: ${PRICE} ${ASSET} was sent back to your wallet. Your access has ended.`);
  await expect(state).toContainText(`Reason: ${REFUND_REASON}`);
  const refunded = (await purchaseView(run.priced.slug)).purchase;
  expect(refunded.refund.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  await expect(panel.getByTestId('academy-purchase-tx').nth(1)).toHaveText(refunded.refund.txHash);

  // Money: one send of exactly the price from INTAFACED's receiving address back to the buyer's wallet; one reverse post.
  expect(await transfersIn(refunded.refund.txHash)).toEqual([{ from: word(refunded.receiver), to: word(payer), value: PRICE_UNITS }]);
  expect((await usdOf(payer)) - before).toBe(PRICE_UNITS);
  const tx = await ledgerTrace(refundKey);
  expect(tx).toMatchObject({ found: true, businessKey: refundKey, module: 'academy' });
  expectPrice(tx);
  const staffRead = data(await staff('query', 'admin.coursePurchase', { key: run.key }));
  expect(staffRead).toMatchObject({ state: 'refunded' });
  expect(staffRead.refundLedgerTxId).not.toBeNull();
  await page.waitForTimeout(5_000); // more reconcile rounds: still one send and one post
  expect((await usdOf(payer)) - before).toBe(PRICE_UNITS);

  // The grant ended: the paid track's enrolment closed, and enrolling again needs a new purchase.
  const terms = await learnerQuery('courseEnrolment', { slug: run.priced.slug });
  expect(terms.body.result.data.enrolment).toBeNull();
  const enrol = await (await learner()).post('/api/academy/trpc/enrolCourse', { slug: run.priced.slug, track: 'certificate' });
  expect(codeOf(enrol)).toBe('academy.payment_required');
  await expect(root.getByLabel('Certificate track')).toBeVisible();

  // The grant audit: the purchase grant by the buyer, then the refund's revoke by the staff member, with its reason.
  const audit = data(await staff('query', 'admin.grantAudit', { course: run.priced.slug }));
  const lines = audit.items.filter((row) => row.accountId === run.userId);
  expect(lines.map((row) => row.kind)).toEqual(['access_revoked', 'access_granted']);
  const founderB = sessions.b.op.userId;
  expect(lines[0]).toMatchObject({ target: run.priced.slug, reason: REFUND_REASON, reference: `refund:${refundKey}` });
  expect(lines[0].actorId).toBe(founderB);
  expect(lines[0].actorId).not.toBe(run.userId);
  expect(lines[1]).toMatchObject({ target: run.priced.slug, source: 'purchase', actorId: run.userId, reference: `purchase:${run.key}` });
});
