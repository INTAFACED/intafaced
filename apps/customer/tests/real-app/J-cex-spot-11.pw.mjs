import { test, expect } from './journey.mjs';
import { api, bestPrices, journeyState, restartWith, toUnits, fromUnits, tool } from './stack.mjs';
import { fundedTrader, signIn, signUp, verify } from './desk.mjs';
import { keyHolder, makeKey, withKey } from './developer.mjs';

// J-cex-spot-11, in the running app (docs/roadmap/journeys.json): convert one coin to another in one tap and see it in
// my history. One test per step, titled "J-cex-spot-11 #<n>", run in order on one TEST account: signed in, verified and
// funded with TEST 100 USDT through the real ledger, the Convert room open. The pair is the stack's TEST BTC/USDT book,
// which the TEST market maker walks; the convert spread and quote hold are the stack's LOCAL TEST values
// (tooling/scripts/local-stack-services/trade.mjs). Every money claim is checked against the ledger balance the account
// reads, and every "nothing sent" against the requests the page made.
const J = 'J-cex-spot-11';
const ROOM = '/trade/convert';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

async function until(read, ok, what, ms = 30_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what}: still ${JSON.stringify(last)}`);
}

const card = (page) => page.getByRole('region', { name: 'Convert', exact: true });
const review = (page) => page.getByRole('alertdialog', { name: 'Review conversion' });
const amountBox = (page) => card(page).getByRole('textbox', { name: 'Amount to convert' });

/** Every convert request the page sends from now on, by procedure (quote, accept, status), so "nothing sent" is checked. */
function convertCalls(page) {
  const seen = [];
  page.on('request', (r) => {
    const m = /\/api\/trade\/trpc\/(convert\.[A-Za-z]+)/.exec(r.url());
    if (m) seen.push(m[1]);
  });
  return seen;
}

/** Opens the room with From and To picked through the pickers, as a person picks them. */
async function pick(page, from, to) {
  await page.goto(ROOM);
  const picker = page.getByRole('dialog', { name: 'Choose an asset' });
  const row = (ticker) =>
    picker.getByTestId('picker__row').filter({ has: page.getByTestId('picker__ticker').getByText(ticker, { exact: true }) });
  await card(page).getByRole('button', { name: 'Change the From asset' }).click();
  await row(from).click();
  await card(page).getByRole('button', { name: 'Change the To asset' }).click();
  await row(to).click();
}

/** A decimal as the receipt writes it: thousands grouped, trailing zeros of the fraction dropped ("10.50" -> "10.5"). */
function shown(decimal) {
  const [whole, frac = ''] = decimal.split('.');
  const cut = frac.replace(/0+$/, '');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${cut ? `.${cut}` : ''}`;
}

/** The account's ledger balances, as decimal strings, read through the API. */
async function ledger(who) {
  return (await api(who)).balances();
}

test(`${J} #1 opens /trade/convert and picks the coins: only convertible coins, each with its per-conversion limit or "Limit not set"; a restricted coin is not listed`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = await fundedTrader(page, 'jcs11', '100');
  run.reset({ account: who });
  await signIn(page, who);
  await page.goto(ROOM);
  await expect(card(page)).toBeVisible();

  // What the service says can be converted: the coins of every orderable spot market, and which are restricted.
  const me = await api(who);
  const pairs = await me.get('/api/trade/trpc/convert.pairs');
  expect(pairs.status, JSON.stringify(pairs.body).slice(0, 300)).toBe(200);
  const { assets, restricted } = pairs.body.result.data;
  expect(assets.length).toBeGreaterThan(1);

  await card(page).getByRole('button', { name: 'Change the From asset' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose an asset' });
  const rows = picker.getByTestId('picker__row');
  const grouped = (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // The From list: every coin the service converts that the account can pay with, each with its limit or none set.
  const tickers = await rows.getByTestId('picker__ticker').allInnerTexts();
  expect(tickers.length).toBeGreaterThan(0);
  for (const ticker of tickers) {
    const a = assets.find((x) => x.asset === ticker);
    expect(a, `${ticker} is listed but the service does not convert it`).toBeTruthy();
    const row = rows.filter({ has: page.getByTestId('picker__ticker').getByText(ticker, { exact: true }) });
    if (a.maxPerConvert === null) await expect(row).toContainText('Limit not set');
    else await expect(row).toContainText(`Up to ${grouped(a.maxPerConvert.amount)} ${a.maxPerConvert.asset} per conversion`);
  }
  // A restricted coin is never offered.
  for (const r of restricted) expect(tickers).not.toContain(r);
  await rows.filter({ has: page.getByTestId('picker__ticker').getByText('USDT', { exact: true }) }).click();
  await card(page).getByRole('button', { name: 'Change the To asset' }).click();
  const toTickers = await rows.getByTestId('picker__ticker').allInnerTexts();
  for (const r of restricted) expect(toTickers).not.toContain(r);
  for (const ticker of toTickers) expect(assets.map((x) => x.asset)).toContain(ticker);
  await rows.filter({ has: page.getByTestId('picker__ticker').getByText('BTC', { exact: true }) }).click();
  await expect(page.getByTestId('headline-pair')).toHaveText('USDT to BTC');
});

test(`${J} #2 types an amount below the minimum or above the balance: "Too small" or "not enough" in words before any price is asked for; the not-enough card links to deposit`, async ({
  page,
}) => {
  await signIn(page, account());
  await pick(page, 'USDT', 'BTC');
  const calls = convertCalls(page);
  await amountBox(page).fill('0.0001');
  // Paying in USDT, the minimum is the smallest whole lot at the live price, an estimate: it reads "about".
  await expect(card(page)).toContainText(/Too small: the minimum is about [\d.,]+ USDT\./);
  await amountBox(page).fill('250');
  const short = card(page).getByRole('alert').filter({ hasText: 'Not enough USDT' });
  await expect(short).toContainText('You have 100 USDT available.');
  await expect(short.getByRole('link', { name: 'Deposit USDT' })).toHaveAttribute('href', '/uc/recharge?asset=USDT');
  await expect(card(page).getByRole('button', { name: 'Preview conversion' })).toBeDisabled();
  await page.waitForTimeout(1_500);
  expect(
    calls.filter((c) => c === 'convert.quote'),
    'no price is asked for',
  ).toEqual([]);
});

test(`${J} #3 gets a quote: the price held for a stated time with a countdown and the spread in basis points; the quote never costs more than the typed spend`, async ({
  page,
}) => {
  await signIn(page, account());
  await pick(page, 'USDT', 'BTC');
  const quoted = page.waitForResponse((r) => /convert\.quote/.test(r.url()) && r.status() === 200);
  await amountBox(page).fill('10');
  const quote = (await (await quoted).json()).result.data;
  expect(toUnits(quote.inAmount)).toBeLessThanOrEqual(toUnits('10'));
  expect(quote.inAsset).toBe('USDT');
  const hold = card(page).getByTestId('hold');
  await expect(hold).toHaveText(/Price held for \d+s/);
  const first = Number(/(\d+)s/.exec(await hold.innerText())[1]);
  await expect.poll(async () => Number(/(\d+)s/.exec(await hold.innerText())?.[1] ?? first)).toBeLessThan(first);
  await expect(card(page).getByRole('group', { name: 'Price details' })).toContainText(`${quote.convertSpreadBps} bps`);
});

test(`${J} #4 lets the quote expire with the review open: a new price must be accepted before anything is sent`, async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, account());
  await pick(page, 'USDT', 'BTC');
  await amountBox(page).fill('10');
  await card(page).getByRole('button', { name: 'Preview conversion' }).click();
  const dialog = review(page);
  await expect(dialog).toBeVisible();
  const calls = convertCalls(page);
  // The hold runs out with the review open; the page asks for a new price by itself.
  await expect(dialog.getByRole('button', { name: 'Accept new price' })).toBeVisible({ timeout: 60_000 });
  expect(
    calls.filter((c) => c === 'convert.accept'),
    'nothing sent while the price is new',
  ).toEqual([]);
  await dialog.getByRole('button', { name: 'Accept new price' }).click();
  // Accepting the new price only shows it: the conversion is still not sent until Convert now.
  await expect(dialog.getByRole('button', { name: 'Convert now' })).toBeVisible();
  expect(calls.filter((c) => c === 'convert.accept')).toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test(`${J} #5 presses Convert now twice: one request is sent; a receipt and the new balances show`, async ({ page }) => {
  const who = account();
  await signIn(page, who);
  await pick(page, 'USDT', 'BTC');
  const before = await ledger(who);
  await amountBox(page).fill('10');
  await card(page).getByRole('button', { name: 'Preview conversion' }).click();
  const dialog = review(page);
  const go = dialog.getByRole('button', { name: /^(Convert now|Accept new price)$/ });
  if ((await go.innerText()) === 'Accept new price') await go.click();
  const calls = convertCalls(page);
  const answer = page.waitForResponse((r) => /convert\.accept/.test(r.url()));
  await dialog.getByRole('button', { name: 'Convert now' }).dblclick();
  const settled = (await (await answer).json()).result.data;
  const receipt = page.getByTestId('cvt-receipt');
  // The receipt names the exact amounts the service settled.
  await expect(receipt).toContainText(`Converted ${shown(settled.inAmount)} USDT to ${shown(settled.outAmount)} BTC`);
  await page.waitForTimeout(1_000);
  expect(
    calls.filter((c) => c === 'convert.accept'),
    'one request',
  ).toHaveLength(1);
  const after = await until(
    () => ledger(who),
    (b) => b.BTC?.total !== before.BTC?.total,
    'the BTC the conversion bought',
  );
  // The ledger moved by exactly the receipt's paid and received amounts, once.
  expect(toUnits(before.USDT.total) - toUnits(after.USDT.total)).toBe(toUnits(settled.inAmount));
  expect(toUnits(after.BTC.total) - toUnits(before.BTC?.total ?? '0')).toBe(toUnits(settled.outAmount));
  await expect(page.getByTestId('cvt-paid')).toHaveText(`${shown(settled.inAmount)} USDT`);
  await expect(page.getByTestId('cvt-received')).toHaveText(`${shown(settled.outAmount)} BTC`);
  run.write({ converted: settled.quoteId, paid: settled.inAmount, received: settled.outAmount });
});

test(`${J} #6 loses the connection on accept: the note stays; Check again asks about the same quote and cannot convert twice`, async ({
  page,
}) => {
  const who = account();
  await signIn(page, who);
  await pick(page, 'USDT', 'BTC');
  await amountBox(page).fill('10');
  await card(page).getByRole('button', { name: 'Preview conversion' }).click();
  const dialog = review(page);
  const go = dialog.getByRole('button', { name: /^(Convert now|Accept new price)$/ });
  if ((await go.innerText()) === 'Accept new price') await go.click();
  const before = await ledger(who);
  // The accept reaches the service; its answer never reaches the page.
  const sent = [];
  page.on('request', (r) => {
    if (/convert\.accept/.test(r.url())) sent.push(r.postDataJSON());
  });
  await page.route(
    /convert\.accept/,
    async (route) => {
      await route.fetch();
      // The page may already have given up on the request; either way its answer never reaches the page.
      await route.abort('connectionreset').catch((err) => {
        if (!/already handled/.test(String(err?.message))) throw err;
      });
    },
    { times: 1 },
  );
  await dialog.getByRole('button', { name: 'Convert now' }).click();
  await expect(page.getByTestId('pending')).toContainText('We couldn’t confirm this conversion');
  await page.unroute(/convert\.accept/);
  await page.reload();
  // The note stays across a reload.
  await expect(page.getByTestId('pending')).toBeVisible();
  // Check again asks about the same quote, under the same request id: the service answers with the one conversion.
  const checked = page.waitForResponse((r) => /convert\.accept/.test(r.url()));
  await page.getByTestId('pending').getByRole('button', { name: 'Check again' }).click();
  const fill = (await (await checked).json()).result.data;
  expect(sent).toHaveLength(2);
  expect(sent[1].quoteId).toBe(sent[0].quoteId);
  expect(sent[1].clientConvertId).toBe(sent[0].clientConvertId);
  expect(fill.quoteId).toBe(sent[0].quoteId);
  await expect(page.getByTestId('cvt-receipt')).toContainText(`Converted ${shown(fill.inAmount)} USDT to ${shown(fill.outAmount)} BTC`);
  const after = await until(
    () => ledger(who),
    (b) => b.USDT.total !== before.USDT.total,
    'the one conversion on the ledger',
  );
  expect(toUnits(before.USDT.total) - toUnits(after.USDT.total)).toBe(toUnits(fill.inAmount));
  // Asked once more with the same quote, the service answers the same conversion and moves nothing.
  const again = await (await api(who)).post('/api/trade/trpc/convert.accept', sent[0]);
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body.result.data.fillId).toBe(fill.fillId);
  expect((await ledger(who)).USDT.total, 'the same quote converts once').toBe(after.USDT.total);
});

test(`${J} #7 converts while instant buys are paused: "Use Spot" with the reason; nothing sent`, async ({ page }) => {
  test.setTimeout(240_000);
  const who = account();
  restartWith('trade', 'LOCAL_STACK_TRADE_CONVERT', false);
  try {
    await signIn(page, who);
    await pick(page, 'USDT', 'BTC');
    const calls = convertCalls(page);
    const before = await ledger(who);
    await amountBox(page).fill('10');
    const paused = card(page).getByRole('alert').filter({ hasText: 'Instant buy is paused' });
    await expect(paused).toContainText('Conversions are paused on this platform');
    await expect(paused.getByRole('link', { name: 'Use Spot' })).toHaveAttribute('href', '/trade/spot/BTC-USDT');
    await expect(card(page).getByRole('button', { name: 'Preview conversion' })).toBeDisabled();
    expect(calls).not.toContain('convert.accept');
    expect((await ledger(who)).USDT.total).toBe(before.USDT.total);
  } finally {
    restartWith('trade', 'LOCAL_STACK_TRADE_CONVERT', true);
  }
});

test(`${J} #8 sets a limit convert at a target rate: the source is held until the rate is reached, then filled once, the rest released`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = account();
  await signIn(page, who);
  await pick(page, 'USDT', 'BTC');
  const me = await api(who);
  await card(page).getByRole('tab', { name: 'Limit' }).click({ timeout: UNBUILT.timeout });
  const { ask } = await bestPrices('BTC/USDT');
  // A target 0.5% under the ask: the walk alone does not reach it, a TEST move does.
  const target = fromUnits(((toUnits(ask) * 9_950n) / 10_000n / 10n ** 16n) * 10n ** 16n);
  const before = await ledger(who);
  await amountBox(page).fill('20');
  await card(page).getByRole('textbox', { name: 'Target rate' }).fill(target);
  await card(page).getByRole('button', { name: 'Place limit convert' }).click();
  const placed = await until(
    async () => (await me.get('/api/trade/trpc/convert.limits')).body?.result?.data ?? [],
    (list) => list.some((l) => l.status === 'waiting'),
    'the limit convert waiting',
  );
  const order = placed.find((l) => l.status === 'waiting');
  // The source is held: the 20 USDT leave the free balance, not the total.
  const held = await ledger(who);
  expect(toUnits(before.USDT.free) - toUnits(held.USDT.free)).toBe(toUnits('20'));
  expect(held.USDT.total).toBe(before.USDT.total);
  await expect(card(page).getByRole('region', { name: 'Waiting limit converts' })).toContainText(`1 BTC ≤ ${target}`);
  try {
    tool('local-test-market.mjs', 'move', 'BTC/USDT', '-1.50%');
    const done = await until(
      async () => (await me.get('/api/trade/trpc/convert.limits')).body.result.data.find((l) => l.id === order.id),
      (l) => l?.status === 'filled',
      'the limit convert filled',
      180_000,
    );
    const after = await ledger(who);
    // Filled once at or under the target; what the fill did not use is free again; nothing stays held.
    expect(toUnits(done.paid) <= toUnits('20')).toBe(true);
    expect(toUnits(before.USDT.total) - toUnits(after.USDT.total)).toBe(toUnits(done.paid));
    expect(toUnits(after.BTC.total) - toUnits(before.BTC.total)).toBe(toUnits(done.received));
    expect(after.USDT.free).toBe(after.USDT.total);
    expect((toUnits(done.paid) * 10n ** 18n) / toUnits(done.received) <= toUnits(target)).toBe(true);
  } finally {
    tool('local-test-market.mjs', 'move', 'BTC/USDT', '0%');
  }
});

test(`${J} #9 converts a very large amount: routed to the quote desk, which says it is closed until its rules are published`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  restartWith('trade', 'LOCAL_STACK_TRADE_OTC_CONVERT_BOUNDS', false);
  try {
    await signIn(page, account());
    await pick(page, 'USDT', 'BTC');
    await amountBox(page).fill('5000000');
    const routed = card(page).getByRole('note').filter({ hasText: 'Too large for an instant conversion' });
    await routed.getByRole('link', { name: 'Use the quote desk' }).click();
    const desk = page.getByRole('region', { name: 'Large conversions at the desk price' });
    await expect(desk).toBeFocused();
    await expect(desk).toContainText('The quote desk is closed for conversions until its rules are published.');
  } finally {
    restartWith('trade', 'LOCAL_STACK_TRADE_OTC_CONVERT_BOUNDS', true);
  }
});

test(`${J} #10 opens Recent conversions: the conversion with paid and received amounts and time; never quotes not taken; an empty list reads as empty`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { converted, paid, received } = run.read();
  if (!converted) throw new Error(`${J} #5 made no conversion, so there is nothing to list`);
  await signIn(page, account());
  await page.goto(ROOM);
  const recent = page.getByRole('region', { name: 'Recent conversions' });
  const me = await api(account());
  // The service's own record over the panel's 30 days, asked the way the panel asks it (a window and a limit).
  const now = Date.now();
  const window = { from: new Date(now - 30 * 86_400_000).toISOString(), to: new Date(now).toISOString(), limit: 100 };
  const listed = await me.get(`/api/trade/trpc/convert.list?input=${encodeURIComponent(JSON.stringify(window))}`);
  expect(listed.status, JSON.stringify(listed.body).slice(0, 300)).toBe(200);
  const rows = listed.body.result.data.rows;
  // The record holds the quotes never taken (#3's, #4's expired one); the panel lists only conversions. Each row's
  // state is its `lifecycle` (svc-trade convert-history-router.ts), the field the panel filters on.
  expect(rows.some((r) => r.lifecycle === 'quoted' || r.lifecycle === 'expired')).toBe(true);
  const taken = rows.filter((r) => r.lifecycle !== 'quoted' && r.lifecycle !== 'expired');
  const row = recent.getByRole('row').filter({ hasText: fromUnits(toUnits(paid)).replace(/\.?0+$/, '') });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('USDT');
  await expect(row).toContainText('BTC');
  await expect(row).toContainText(
    fromUnits(toUnits(received))
      .replace(/\.?0+$/, '')
      .slice(0, 8),
  );
  await expect(row.getByRole('cell').first()).toHaveText(/\d{1,2}:\d{2}/);
  // A header row and one row per conversion taken (the panel shows the latest ten): never a quote not taken.
  await expect(recent.getByRole('row')).toHaveCount(1 + Math.min(10, taken.length));

  // An account that never converted reads as empty.
  const fresh = await signUp(page, 'jcs11e');
  await verify(page, fresh);
  await signIn(page, fresh);
  await page.goto(ROOM);
  await expect(page.getByRole('region', { name: 'Recent conversions' })).toContainText('No conversions in the last 30 days');
});

test(`${J} #11 converts a cash currency through a crypto leg: two linked legs as one record, or a typed refusal where the two-leg plan is not built`, async ({
  page,
}) => {
  await signIn(page, account());
  await page.goto(`${ROOM}?from=EUR&to=BTC`);
  const calls = convertCalls(page);
  await amountBox(page).fill('10');
  const refused = card(page).getByRole('alert').filter({ hasText: 'Cash to a coin in two steps isn’t offered' });
  await expect(refused).toBeVisible();
  await expect(refused).toHaveAttribute('data-code', 'trade.convert_two_leg_unbuilt');
  expect(calls).not.toContain('convert.accept');
});

test(`${J} #12 a developer asks for a quote and trades through the convert API: a quote with no hold; the same quote id twice settles one convert`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { page, who } = await keyHolder(browser, 'jcs11k');
  expect((await import('./stack.mjs')).fund(who.email, 'USDT', '50').tx).toBeTruthy();
  const key = await makeKey(page, { name: 'convert-bot', preset: 'Trade' });
  const me = await api(who);
  const before = await me.balances();
  const quote = await withKey(key, { method: 'POST', path: '/api/v1/convert/quote', body: { from: 'USDT', to: 'BTC', amount: '10' } });
  expect(quote.status, JSON.stringify(quote.body).slice(0, 300)).toBe(200);
  expect(quote.body).toMatchObject({ fromAsset: 'USDT', toAsset: 'BTC' });
  // A quote holds nothing.
  const quoted = await me.balances();
  expect(quoted.USDT.free).toBe(before.USDT.free);
  const accept = { method: 'POST', path: '/api/v1/convert/accept', body: { quoteId: quote.body.quoteId } };
  const [a, b] = await Promise.all([withKey(key, accept), withKey(key, accept)]);
  expect(a.status, JSON.stringify(a.body).slice(0, 300)).toBe(200);
  expect(b.status, JSON.stringify(b.body).slice(0, 300)).toBe(200);
  expect(a.body.fillId).toBe(b.body.fillId);
  const after = await until(
    () => me.balances(),
    (x) => x.USDT.total !== before.USDT.total,
    'the one convert on the ledger',
  );
  expect(toUnits(before.USDT.total) - toUnits(after.USDT.total)).toBe(toUnits(a.body.fromAmount));
  const again = await withKey(key, accept);
  expect(again.body.fillId).toBe(a.body.fillId);
  expect((await me.balances()).USDT.total).toBe(after.USDT.total);
});
