import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { TEST_DEPOSIT_TRAVEL_RULE } from '../../../../tooling/scripts/local-test-gates.mjs';
import path from 'node:path';
import {
  api,
  bestPrices,
  fromUnits,
  journeyState,
  mailedLines,
  otherTrader,
  ROOT,
  signUpInBrowser,
  times,
  toUnits,
  tool,
  signOutBrowser,
} from './stack.mjs';
import { awayBid, confirm, free, held, openDesk, openOrders, previewed, reviewLimit, reviewSheet, signIn } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// DIAGNOSTIC ONLY (claude/csp-data-diag, never merged): Chromium's own record of every data: request, the CSP report
// POST and CSP issues, with the initiator stack, in the page and in every worker.
test.beforeEach(async ({ page }) => {
  const t = () => new Date().toISOString();
  const watch = async (cdp, where) => {
    cdp.on('Network.requestWillBeSent', (e) => {
      const u = e.request.url;
      if (u.startsWith('data:') || u.includes('__csp-report') || u.startsWith('blob:'))
        console.log(
          `CDPDIAG ${t()} ${where} req ${e.type} ${u.slice(0, 160)} doc=${e.documentURL} init=${JSON.stringify(e.initiator).slice(0, 1500)} post=${(e.request.postData ?? '').slice(0, 600)}`,
        );
    });
    cdp.on('Network.loadingFailed', (e) => {
      if (e.blockedReason || /csp|blocked/i.test(e.errorText ?? ''))
        console.log(`CDPDIAG ${t()} ${where} failed ${e.type} ${e.errorText} ${e.blockedReason} ${e.requestId}`);
    });
    cdp.on('Audits.issueAdded', (e) => console.log(`CDPDIAG ${t()} ${where} issue ${JSON.stringify(e.issue).slice(0, 1500)}`));
    cdp.on('Log.entryAdded', (e) =>
      console.log(
        `CDPDIAG ${t()} ${where} log ${e.entry.source} ${e.entry.level} ${e.entry.text.slice(0, 400)} ${e.entry.url ?? ''}:${e.entry.lineNumber ?? ''}`,
      ),
    );
    cdp.on('Runtime.consoleAPICalled', () => {});
    await cdp.send('Network.enable').catch(() => {});
    await cdp.send('Audits.enable').catch(() => {});
    await cdp.send('Log.enable').catch(() => {});
  };
  const cdp = await page.context().newCDPSession(page);
  await watch(cdp, 'page');
  cdp.on('Target.attachedToTarget', (e) => console.log(`CDPDIAG ${t()} attached ${e.targetInfo.type} ${e.targetInfo.url}`));
  await cdp
    .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    .catch((e) => console.log(`CDPDIAG autoattach ${e.message}`));
  // Every browser target (prerender, popup, worker, other page) with its URL and life.
  const browserCdp = await page.context().browser().newBrowserCDPSession();
  for (const ev of ['Target.targetCreated', 'Target.targetInfoChanged', 'Target.targetDestroyed'])
    browserCdp.on(ev, (e) => console.log(`CDPDIAG ${t()} ${ev} ${JSON.stringify(e.targetInfo ?? e).slice(0, 400)}`));
  await browserCdp.send('Target.setDiscoverTargets', { discover: true });
  // Every request of #3's page, any URL, so the menu's window is complete.
  if (test.info().title.includes('#3'))
    cdp.on('Network.requestWillBeSent', (e) =>
      console.log(
        `CDPDIAG ${t()} any ${e.type} ${e.request.method} ${e.request.url.slice(0, 140)} frame=${e.frameId} init=${e.initiator.type}`,
      ),
    );
  page.on('worker', (w) => console.log(`CDPDIAG ${t()} worker ${w.url()}`));
  page.on('framenavigated', (f) => console.log(`CDPDIAG ${t()} nav ${f === page.mainFrame() ? 'main' : 'sub'} ${f.url()}`));
  page.on('frameattached', (f) => console.log(`CDPDIAG ${t()} frameattached ${f.url()}`));
  page.on('console', (m) => console.log(`CDPDIAG ${t()} console ${m.type()} ${m.text().slice(0, 300)} ${JSON.stringify(m.location())}`));
});

// J-cex-spot-01, in the running app (docs/roadmap/journeys.json). One test per step, titled "J-cex-spot-01 #<n>", run in
// order on one TEST account. Every number here is a TEST number on the local stack; the ledger is read through the
// customer's own API after each move.
const J = 'J-cex-spot-01';
const DESK = '/trade/spot/BTC-USDT';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/**
 * A dollar figure as the app writes one (fmtUsd in apps/customer/src/data/format.ts): two decimals; under $1 up to four,
 * so a figure under $1 can read "$0.8094"; and "<$0.0001" for a non-zero figure below that.
 */
const DOLLARS = String.raw`(?:\$[\d,]+\.\d{2}|\$0\.\d{3,4}|<\$0\.0001)`;

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

async function desk(page) {
  await openDesk(page, account());
}

/** A number as the room draws it ("65,000.10", "60.12 USDT", "$1.20"), as scaled units, so it compares to the service's. */
function shownUnits(text) {
  const found = /[+−-]?[\d,]+(\.\d+)?/.exec(text.replace(/\$/g, ''));
  if (!found) throw new Error(`no number in "${text}"`);
  return toUnits(found[0].replace(/,/g, '').replace('−', '-').replace('+', ''));
}

/** A decimal the service sent, as scaled units; money on the wire is a decimal string, never a JSON number. */
function wireUnits(value) {
  if (typeof value !== 'string') throw new Error(`not a decimal string on the wire: ${JSON.stringify(value)}`);
  return toUnits(value);
}

/** A dollar figure from the service as the app shows it (fmtUsd): half up to the cent, or to 0.0001 under $1. */
function asShownUsd(value) {
  const units = wireUnits(value);
  const abs = units < 0n ? -units : units;
  const one = toUnits('1');
  const unit = one / 10n ** (abs < one ? 4n : 2n);
  let rounded = (abs / unit + ((abs % unit) * 2n >= unit ? 1n : 0n)) * unit;
  // A non-zero figure that rounds to nothing reads "<$0.0001", which shownUnits reads as 0.0001.
  if (rounded === 0n && abs !== 0n) rounded = unit;
  return units < 0n ? -rounded : rounded;
}

/** The value next to a review sheet label (its dt/dd pair). */
function reviewValue(review, label) {
  return review
    .locator('div', { has: review.page().locator('dt', { hasText: label }) })
    .locator('dd')
    .first();
}

/**
 * One TEST chain delivery of `amount` USDT to a deposit address svc-pay issued, final at the published 6 confirmations, as
 * transfer `label`: the same label to the same address is the same transfer, so sending it again is a replay. Returns the
 * transaction hash, as Deposit's records show it.
 */
function chainDeposit(address, amount, label) {
  const out = tool('local-test-stack.mjs', 'chain-deposit', address, 'USDT', amount, '6', '--tx', label);
  expect(out).toContain('"received":true');
  const tx = /^\s*tx\s+(0x[0-9a-f]{64}):\d+/m.exec(out)?.[1];
  expect(tx, out).toBeTruthy();
  return tx;
}

/**
 * A rate the service sends as a ratio ("0.0008"), as the percent the desk shows to two places ("0.08"), in units: rounded
 * half away from zero, so a rebate (a negative rate) rounds as its size does.
 */
function asPercent(ratio) {
  const cent = toUnits('0.01');
  const percent = wireUnits(ratio) * 100n;
  const size = percent < 0n ? -percent : percent;
  const rounded = ((size + cent / 2n) / cent) * cent;
  return percent < 0n ? -rounded : rounded;
}

/** The pointer leaves the top bar, as a person's does, so a door's hover menu closes over the room. */
async function pointerOff(page) {
  await page.mouse.move(0, 600);
}

/** One order's fills as the service reports them. */
async function fillsOf(who, orderId) {
  const { status, body } = await (await api(who)).get(`/api/v1/orders/${orderId}/trades?symbol=BTC%2FUSDT&limit=50`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
}

/** One cent above the best bid: the order rests (it does not cross the ask) and is first in line for a crossing sell. */
async function topBid() {
  const { bid, ask } = await bestPrices();
  const price = toUnits(bid) + toUnits('0.01');
  if (price >= toUnits(ask)) throw new Error(`the book has no room between bid ${bid} and ask ${ask}`);
  return fromUnits(price);
}

/** One percent under the best bid, to the cent: a limit sell there still fills at the bids' own prices when the
 * market maker requotes between the read and the order, which a sell at the old best bid would not. */
async function underBid() {
  const { bid } = await bestPrices();
  const cent = toUnits('0.01');
  return fromUnits(((toUnits(bid) * 99n) / 100n / cent) * cent);
}

/** #6's buy, in the row's own words: TEST 0.1 BTC. */
const BUY = '0.1';

/**
 * The second TEST deposit #6 starts with. #4 funds 1000 USDT, but a 0.1 BTC buy that rests at the top of the book, where
 * #8's crossing sell can reach it inside the stack's 10% price band, sets aside about 6,500 USDT at the stack's TEST BTC
 * price (about 65,000). 7000 more covers the buy up to a TEST price of 80,000.
 */
const TOP_UP = '7000';

/** The desk's Assets row for each asset (Available, In orders, Total) equals the ledger, unit for unit. */
async function deskEqualsLedger(page, client, assets) {
  await page.locator('[role=tab]', { hasText: /^Assets$/ }).click();
  const table = page.getByTestId('dk-table');
  // The desk refreshes its balances on its own; it is read again until it shows the ledger, which nothing moves meanwhile.
  const ledger = await client.balances();
  await expect(async () => {
    for (const asset of assets) {
      const row = table.locator('tr', { has: page.locator('td', { hasText: new RegExp(`^${asset}$`) }) });
      await expect(row).toHaveCount(1, { timeout: 2_000 });
      const heads = (await table.locator('th').allInnerTexts()).map((h) => h.trim());
      const cells = (await row.locator('td').allInnerTexts()).map((c) => c.trim());
      expect(shownUnits(cells[heads.indexOf('Available')]), `${asset}: ${heads.join(' | ')}`).toBe(wireUnits(ledger[asset].free));
      expect(shownUnits(cells[heads.indexOf('In orders')]), asset).toBe(wireUnits(ledger[asset].used));
      expect(shownUnits(cells[heads.indexOf('Total')]), asset).toBe(wireUnits(ledger[asset].total));
    }
  }).toPass({ timeout: 20_000 });
  expect(await client.balances()).toEqual(ledger);
  return ledger;
}

/**
 * One TEST USDT deposit of `amount` (at or over the stack's TEST travel-rule threshold) the way #4's is made: Deposit
 * issues the address, the TEST chain delivers to it as transfer `label`, the deposit is held for the travel rule, the
 * person declares the sender, and a founder releases it once on the console. Returns the transaction hash once the
 * ledger's free USDT has risen by exactly `amount`.
 */
async function depositReleased(page, browser, client, who, amount, label) {
  expect(toUnits(amount) >= toUnits(TEST_DEPOSIT_TRAVEL_RULE.threshold), TEST_DEPOSIT_TRAVEL_RULE.threshold).toBe(true);
  const usdtFree = async () => toUnits((await client.balances()).USDT?.free ?? '0');
  const before = await usdtFree();
  await page.goto('/uc/recharge');
  await pointerOff(page);
  await page.getByRole('combobox', { name: /^Asset Coins you hold/ }).selectOption('USDT');
  await page.getByRole('combobox', { name: 'Network', exact: true }).selectOption({ label: 'TEST Ethereum' });
  await page.getByRole('checkbox', { name: 'I will send only USDT on TEST Ethereum.' }).check();
  await page.getByRole('button', { name: 'Show my deposit address' }).click();
  const address = (await page.getByTestId('deposit-address').locator('strong[data-testid="numeric"]').innerText()).trim();
  expect(address.length).toBeGreaterThan(8);
  const tx = chainDeposit(address, amount, label);
  const records = page.locator('section', { has: page.getByRole('heading', { name: 'Deposit records' }) });
  await expect(async () => {
    await page.reload();
    await pointerOff(page);
    await expect(records.locator('tbody tr', { hasText: tx }).locator('[data-status]')).toHaveAttribute('data-status', 'held_travel_rule', {
      timeout: 3_000,
    });
  }).toPass({ timeout: 30_000 });
  expect(await usdtFree()).toBe(before);
  const panel = records
    .locator('tbody tr', { has: page.getByTestId('deposit-travel-rule') })
    .filter({ has: page.locator(`xpath=preceding-sibling::tr[1][contains(., "${tx}")]`) })
    .getByTestId('deposit-travel-rule');
  const form = panel.getByTestId('deposit-travel-rule-form');
  await form.getByRole('radio', { name: 'An exchange or other crypto platform' }).check();
  await form.getByLabel('Sender’s full name').fill('TEST Sender Person');
  await form.getByLabel('Sender’s address').fill('1 TEST Street, Testville');
  await form.getByRole('button', { name: 'Send declaration' }).click();
  await expect(panel).toHaveAttribute('data-state', 'under_review', { timeout: 30_000 });
  const founderContext = await browser.newContext();
  try {
    const founder = await founderContext.newPage();
    await founderSignIn(founder, 'a');
    await founder.goto(`${ADMIN}/accounts/${client.userId}?tab=money`, { waitUntil: 'load' });
    const holds = founder.getByTestId('read-money.deposit-travel-rule');
    await expect(holds.getByRole('table')).toBeVisible({ timeout: 60_000 });
    // This deposit's own hold, found by its transaction in each USDT hold's detail (#4's 1000 USDT hold is listed too).
    const rows = holds.locator('tbody > tr', { hasText: 'USDT' }).filter({ has: founder.getByRole('button', { name: /^(Open|Close)$/ }) });
    await expect(rows.first()).toBeVisible();
    const detail = holds.getByTestId('row-detail');
    /** Opens row `i` (a click before the console is ready to answer it opens nothing, so it is clicked until open). */
    const openRow = async (i) => {
      const toggle = rows.nth(i).getByRole('button', { name: /^(Open|Close)$/ });
      await expect(async () => {
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      await expect(detail).toHaveCount(1);
      return detail.innerText();
    };
    const seen = [];
    const matches = [];
    const n = await rows.count();
    for (let i = 0; i < n; i += 1) {
      const text = await openRow(i);
      seen.push(text.replace(/\s+/g, ' '));
      if (text.includes(tx)) matches.push(i);
    }
    // Exactly one hold names this transaction, and it holds this deposit's amount.
    expect(matches, `USDT holds naming ${tx}: ${JSON.stringify(seen)}`).toHaveLength(1);
    await openRow(matches[0]);
    const holdAmount = detail.locator('.dk-kv-row', { has: founder.locator('dt', { hasText: /^Amount$/ }) }).locator('dd');
    await expect(holdAmount).toHaveCount(1);
    expect(shownUnits(await holdAmount.innerText())).toBe(toUnits(amount));
    const review = detail.getByTestId('deposit-travel-rule-review');
    await review.getByLabel(/^Why/).fill(`LOCAL TEST declaration checked for ${who.handle}`);
    await review.getByRole('button', { name: 'Release and credit once' }).click();
    await expect(detail.getByTestId('deposit-travel-rule-reply')).toContainText('credited it once', { timeout: 60_000 });
  } finally {
    await founderContext.close();
  }
  await expect.poll(usdtFree, { timeout: 30_000 }).toBe(before + toUnits(amount));
  return tx;
}

test(`${J} #1 signs up with an email and a password`, async ({ page }) => {
  const handle = `jt${Date.now().toString(36)}`;
  // A fresh TEST password per run, kept only in the run file (mode 600).
  const who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  // Sign-up is J-identity-01's own journey: details, then the code the stack mails to its outbox file.
  await signUpInBrowser(page, who);
  await expect(page).not.toHaveURL(/\/register/);
  run.reset({ account: who });
  // An account exists: identity signs the same email and password in on a session of its own, and names its user id.
  const { userId } = await api(who);
  expect(userId).toMatch(/^[0-9a-f-]{36}$/);
  // This browser is signed in as that account: its account menu names the handle, the account id and an unverified level.
  await page.getByRole('button', { name: 'Account menu' }).click();
  const summary = page.getByTestId('account-summary');
  await expect(summary).toContainText(`@${handle}`);
  await expect(summary).toContainText(`Account ID ${userId.slice(0, 8)}…`);
  await expect(summary).toContainText('Verification: Not verified');
  await page.keyboard.press('Escape');
  // Home, where the app opens, asks for verification where the total would be, with its own Verify now.
  await expect(page.getByRole('main').getByText('Verify your identity first').first()).toBeVisible();
  await expect(
    page
      .getByRole('link', { name: 'Verify now' })
      .or(page.getByRole('button', { name: 'Verify now' }))
      .first(),
  ).toBeVisible();
  // The Trade door, from the top bar, reads "Verify to trade" with the way to Verify, and that way opens Verification.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Trade', exact: true }).click();
  await expect(page).toHaveURL(/\/trade$/);
  await pointerOff(page);
  const access = page.getByTestId('trade-access');
  await expect(access).toHaveAttribute('data-state', 'verify');
  await expect(access.getByText('Verify to trade', { exact: true })).toBeVisible();
  const way = access.getByRole('link', { name: 'Verify now' });
  await expect(way).toHaveAttribute('href', '/verification');
  await way.click();
  await expect(page).toHaveURL(/\/verification(\?|$)/);
  await expect(page.getByTestId('verification__level-tag')).toContainText('Not verified');
  await expect(page.getByLabel('Level to request')).toBeVisible();
});

test(`${J} #2 tries a TEST limit buy before verifying and is refused in plain words`, async ({ page }) => {
  await desk(page);
  await page.getByRole('textbox', { name: 'Price' }).first().fill('60000.00');
  await page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001');
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
  const reason = page.locator('#dk-reason-buy');
  await expect(reason).toContainText('Verify your identity first');
  await expect(reason).toContainText('Verify now');
  await expect(reason).not.toContainText(/[a-z]+\.[a-z_]+_[a-z_]+/); // no raw code like trade.kyc_required
  expect(await openOrders(account())).toHaveLength(0);
  const balances = await (await api(account())).balances();
  expect(held(balances, 'USDT')).toBe(0n);
});

test(`${J} #3 submits verification, two operators approve it, signs in again and the desk accepts orders`, async ({ page }) => {
  const who = account();
  await signIn(page, who);
  await page.goto('/verification');
  await page.getByLabel('Level to request').selectOption({ label: 'Full' });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
  // The two TEST operators of the stack approve it through identity's own two-person door.
  tool('local-test-gates.mjs', 'verify');
  const status = tool('local-test-gates.mjs', 'status');
  const accounts = JSON.parse(status.slice(status.indexOf('{'))).accounts;
  expect(accounts.find((a) => a.handle === who.handle)?.tiers).toContain('full');
  // Signs in again, so the session carries the new level.
  await signOutBrowser(page.context());
  await signIn(page, who);
  // The tier reads verified: on the Trade door, in the account menu and on Verification.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Trade', exact: true }).click();
  await expect(page).toHaveURL(/\/trade$/);
  await pointerOff(page);
  const access = page.getByTestId('trade-access');
  await expect(access).toHaveAttribute('data-state', 'verified');
  await expect(access.getByText('Verified to trade', { exact: true })).toBeVisible();
  await expect(access).toContainText('Your level: Full');
  await expect(access.getByText('Verify to trade')).toHaveCount(0);
  console.log(`CDPDIAG ${new Date().toISOString()} MENU open`);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByTestId('account-summary')).toContainText('Verification: Full');
  console.log(`CDPDIAG ${new Date().toISOString()} MENU escape`);
  await page.keyboard.press('Escape');
  // SPLIT B: Escape, then let every open read settle before leaving /trade.
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log(`CDPDIAG ${new Date().toISOString()} SPLIT B idle`);
  console.log(`CDPDIAG ${new Date().toISOString()} MENU goto`);
  await page.goto('/verification');
  await expect(page.getByTestId('verification__level-tag')).toContainText('Full');
  await expect(page.getByTestId('verification__level-tag')).not.toContainText('Not verified');

  // The desk accepts orders: the service's own order check passes a resting limit buy for this account with no refusal,
  // and the order form's only remaining stop is money (#4 funds the account), never verification.
  await desk(page);
  const away = await awayBid(90);
  // The check of this exact order: the price and amount typed below (a check sent before both were typed is not it).
  const check = page.waitForResponse((r) => {
    if (!r.url().includes('/api/v1/orders/preview') || r.request().method() !== 'POST') return false;
    const sent = r.request().postDataJSON();
    const same = (value, want) => typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) && toUnits(value) === toUnits(want);
    return sent?.side === 'buy' && same(sent?.amount, '0.001') && same(sent?.price, away);
  });
  await page.getByRole('textbox', { name: 'Price' }).first().fill(away);
  await page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001');
  const answer = await check;
  expect(answer.status()).toBe(200);
  const preview = await answer.json();
  expect(preview, JSON.stringify(preview).slice(0, 400)).toMatchObject({ orderable: true, refusals: [], holdAsset: 'USDT' });
  expect(wireUnits(preview.holdAmount)).toBe(times(away, '0.001'));
  const reason = page.locator('#dk-reason-buy');
  await expect(reason).toContainText('Not enough USDT');
  await expect(reason).not.toContainText('Verify your identity first');
  await expect(reason).not.toContainText('Verify now');
  // The place door itself takes the same order past verification to the money check: it answers on funds (no USDT
  // yet), not on permission, and nothing is held and no order rests.
  const placed = await (
    await api(who)
  ).post('/api/v1/orders', {
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    amount: '0.001',
    price: away,
    clientOrderId: `${J}-3-${who.handle}`,
  });
  expect(placed.status, JSON.stringify(placed.body).slice(0, 300)).toBe(400);
  expect(placed.body.code, JSON.stringify(placed.body).slice(0, 300)).toBe('InsufficientFunds');
  expect(await openOrders(who)).toHaveLength(0);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(0n);
});

test(`${J} #4 funds TEST 1000 USDT; a replay of the same deposit adds nothing`, async ({ page, browser }) => {
  test.setTimeout(300_000);
  const who = account();
  const client = await api(who);
  const usdt = async () => (await client.balances()).USDT ?? { free: '0', used: '0', total: '0' };
  expect(toUnits((await usdt()).total)).toBe(0n);
  // Funds it as a person does: Deposit issues a USDT address on TEST Ethereum, and the stack's TEST chain sends 1000 USDT
  // to it, final at the published 6 confirmations (svc-pay's chain webhook, signed as the watcher would deliver it). The
  // test uses no direct ledger post.
  await signIn(page, who);
  await page.goto('/uc/recharge');
  await pointerOff(page);
  await page.getByRole('combobox', { name: /^Asset Coins you hold/ }).selectOption('USDT');
  await page.getByRole('combobox', { name: 'Network', exact: true }).selectOption({ label: 'TEST Ethereum' });
  await page.getByRole('checkbox', { name: 'I will send only USDT on TEST Ethereum.' }).check();
  await page.getByRole('button', { name: 'Show my deposit address' }).click();
  const address = (await page.getByTestId('deposit-address').locator('strong[data-testid="numeric"]').innerText()).trim();
  expect(address.length).toBeGreaterThan(8);
  const label = `jcs01-${who.handle}-1000`;
  const tx = chainDeposit(address, '1000', label);
  // A deposit of 1000 or more waits for the depositor's travel-rule declaration (the stack's TEST rule, W-deposit-07):
  // the person declares where it came from, and compliance releases it once on the founder console.
  // 1000 is at or over the stack's TEST threshold, so this deposit is the held kind (read from the stack's own rule).
  expect(toUnits('1000') >= toUnits(TEST_DEPOSIT_TRAVEL_RULE.threshold), TEST_DEPOSIT_TRAVEL_RULE.threshold).toBe(true);
  const records = page.locator('section', { has: page.getByRole('heading', { name: 'Deposit records' }) });
  // svc-pay may record the hold just after the delivery answers, so the room is read again until it shows it.
  await expect(async () => {
    await page.reload();
    await pointerOff(page);
    await expect(records.locator('tbody tr', { hasText: tx }).locator('[data-status]')).toHaveAttribute('data-status', 'held_travel_rule', {
      timeout: 3_000,
    });
  }).toPass({ timeout: 30_000 });
  expect(toUnits((await usdt()).total)).toBe(0n);
  const panel = records
    .locator('tbody tr', { has: page.getByTestId('deposit-travel-rule') })
    .filter({ has: page.locator(`xpath=preceding-sibling::tr[1][contains(., "${tx}")]`) })
    .getByTestId('deposit-travel-rule');
  const form = panel.getByTestId('deposit-travel-rule-form');
  await form.getByRole('radio', { name: 'An exchange or other crypto platform' }).check();
  await form.getByLabel('Sender’s full name').fill('TEST Sender Person');
  await form.getByLabel('Sender’s address').fill('1 TEST Street, Testville');
  await form.getByRole('button', { name: 'Send declaration' }).click();
  await expect(panel).toHaveAttribute('data-state', 'under_review', { timeout: 30_000 });
  const founderContext = await browser.newContext();
  try {
    const founder = await founderContext.newPage();
    await founderSignIn(founder, 'a');
    await founder.goto(`${ADMIN}/accounts/${client.userId}?tab=money`, { waitUntil: 'load' });
    const holds = founder.getByTestId('read-money.deposit-travel-rule');
    await expect(holds.getByRole('table')).toBeVisible({ timeout: 60_000 });
    // This new account has exactly one USDT hold, the deposit above, so the one row released is this deposit's.
    const rows = holds.locator('tbody > tr', { hasText: 'USDT' });
    await expect(rows).toHaveCount(1);
    await rows.getByRole('button', { name: 'Open' }).click();
    const detail = holds.getByTestId('row-detail');
    const review = detail.getByTestId('deposit-travel-rule-review');
    await review.getByLabel(/^Why/).fill(`LOCAL TEST declaration checked for ${who.handle}`);
    await review.getByRole('button', { name: 'Release and credit once' }).click();
    await expect(detail.getByTestId('deposit-travel-rule-reply')).toContainText('credited it once', { timeout: 60_000 });
  } finally {
    await founderContext.close();
  }
  await expect.poll(async () => (await usdt()).free, { timeout: 30_000 }).toMatch(/^1000(\.0+)?$/);
  const credited = await usdt();
  expect(credited).toMatchObject({ free: expect.stringMatching(/^1000(\.0+)?$/), used: expect.stringMatching(/^0(\.0+)?$/) });
  // The same deposit is replayed (the chain delivers the same transfer again): the same transaction, and nothing added.
  expect(chainDeposit(address, '1000', label)).toBe(tx);
  // Read for longer than the first credit took to land, so a second credit that posts late is seen.
  for (let i = 0; i < 10; i += 1) {
    expect(await usdt()).toEqual(credited);
    await page.waitForTimeout(1_000);
  }
  // Deposit's records hold the transfer once, credited, and the ledger's own history shows one 1000 USDT deposit.
  await page.reload();
  await pointerOff(page);
  await expect(records.locator('tbody tr', { hasText: tx })).toHaveCount(1);
  await expect(records.locator('tbody tr', { hasText: tx }).locator('[data-status]')).toHaveAttribute('data-status', 'credited');
  await page.getByRole('combobox', { name: /^Asset Coins you hold/ }).selectOption('USDT');
  const history = page.locator('section', { has: page.getByRole('heading', { name: 'Your deposits' }) });
  await expect(history.locator('tbody tr')).toHaveCount(1);
  await expect(history.locator('tbody tr')).toContainText(/1,?000 USDT/);
  // The desk's balance equals the ledger exactly: its Assets row and the order form's Available, unit for unit.
  await desk(page);
  await page.locator('[role=tab]', { hasText: /^Assets$/ }).click();
  const table = page.getByTestId('dk-table');
  const heads = (await table.locator('th').allInnerTexts()).map((h) => h.trim());
  const cells = (
    await table
      .locator('tr', { has: page.locator('td', { hasText: /^USDT$/ }) })
      .locator('td')
      .allInnerTexts()
  ).map((c) => c.trim());
  const ledger = await usdt();
  expect(shownUnits(cells[heads.indexOf('Available')]), heads.join(' | ')).toBe(wireUnits(ledger.free));
  expect(shownUnits(cells[heads.indexOf('In orders')])).toBe(wireUnits(ledger.used));
  expect(shownUnits(cells[heads.indexOf('Total')])).toBe(wireUnits(ledger.total));
  expect(wireUnits(ledger.free)).toBe(toUnits('1000'));
  expect(wireUnits(ledger.used)).toBe(0n);
  expect(shownUnits(await page.getByTestId('dk-avail').locator('dd').first().innerText())).toBe(wireUnits(ledger.free));
});

test(`${J} #5 opens the spot desk: ticker, book, chart, tape, fees, trading mode and positions`, async ({ page }) => {
  // One signed-in client of the account's own for every service read below (the retries reuse it).
  const client = await api(account());
  await desk(page);
  await expect(page).toHaveURL(new RegExp(`${DESK}$`));
  await expect(page.getByTestId('dk-pair')).toHaveText('BTC/USDT');
  // The ticker's last price is the service's.
  await expect(async () => {
    const { body } = await client.get('/api/v1/ticker/BTC%2FUSDT');
    expect(shownUnits(await page.getByTestId('dk-last').innerText())).toBe(wireUnits(body.last));
  }).toPass({ timeout: 30_000 });
  await expect(page.locator('[role=tab]', { hasText: 'Order book' })).toBeVisible();
  // The book draws real levels on both sides, each at a price the service's book holds.
  await expect(async () => {
    const { body } = await bestPrices();
    for (const [side, levels] of [
      ['bid', body.bids],
      ['ask', body.asks],
    ]) {
      const book = new Set(levels.map(([p]) => toUnits(p)));
      const price = page.locator(`[data-testid=dk-bk-row][data-side=${side}] [data-testid=dk-bk-price]`).first();
      expect(book.has(shownUnits(await price.innerText())), side).toBe(true);
    }
  }).toPass({ timeout: 30_000 });
  // The chart draws the service's candles: on 15m, its legend's close is the close of the service's newest 15m candle.
  // A fresh stack draws its first candle after the TEST market maker's first crossing trade (about a minute).
  await page.getByRole('group', { name: 'Chart intervals' }).getByRole('button', { name: '15m', exact: true }).click();
  await page.mouse.move(0, 0);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 90_000 });
  await expect(async () => {
    const { body } = await client.get('/api/v1/ohlcv/BTC%2FUSDT?timeframe=15m&limit=3');
    expect(Array.isArray(body) && body.length > 0, JSON.stringify(body).slice(0, 200)).toBe(true);
    const close = page.getByTestId('pc-legend').locator('.pc-ohlc').nth(3).locator('b');
    expect(shownUnits(await close.innerText())).toBe(wireUnits(body.at(-1)[4]));
  }).toPass({ timeout: 60_000 });
  // The tape draws the service's prints: its newest row's price is among the service's recent trades.
  await page.locator('[role=tab]', { hasText: 'Last trades' }).click();
  await expect(async () => {
    const { body } = await client.get('/api/v1/trades/BTC%2FUSDT?limit=50');
    const prices = new Set(body.map((t) => toUnits(String(t.price))));
    const first = page.locator('[data-testid=dk-bk-row--tape] [data-testid=dk-bk-price]').first();
    expect(prices.has(shownUnits(await first.innerText()))).toBe(true);
  }).toPass({ timeout: 60_000 });
  // The fee line: this account's own maker and taker rates, as the service lists them for BTC/USDT, to the shown 0.01%.
  const { body: fees } = await client.get('/api/v1/account/fees');
  const rates = fees['BTC/USDT'];
  expect(rates, JSON.stringify(fees).slice(0, 300)).toBeTruthy();
  const line = page.getByRole('form', { name: 'Buy BTC' }).getByTestId('dk-fees-mine');
  await expect(line).toHaveText(/^Your rates: maker [−-]?[\d.]+% · taker [−-]?[\d.]+%$/);
  const [, maker, taker] = /maker ([−-]?[\d.]+)% · taker ([−-]?[\d.]+)%/.exec(await line.innerText());
  expect(toUnits(maker.replace('−', '-'))).toBe(asPercent(rates.maker));
  expect(toUnits(taker.replace('−', '-'))).toBe(asPercent(rates.taker));
  // The trading-mode line: cash spot, open, as the service lists the market (orderable, active, session open, OPEN).
  const { body: markets } = await client.get('/api/v1/markets?limit=500');
  const listing = markets.find((m) => m.symbol === 'BTC/USDT');
  expect(listing, 'BTC/USDT is listed').toBeTruthy();
  expect(listing).toMatchObject({ spot: true, active: true, orderable: true, sessionOpen: true });
  // A listing that names no lifecycle state is open by the desk's own rule (market.ts); one that names a state names OPEN.
  expect(listing.lifecycle?.state ?? 'OPEN').toBe('OPEN');
  const mode = page.getByTestId('dk-stats').locator('.dk-stat', { has: page.locator('.dk-stat-label', { hasText: /^Trading mode$/ }) });
  await expect(mode.locator('.dk-stat-value')).toHaveText('Cash spot · Open');
  // The positions tab reads that cash spot holds balances, not positions.
  await page.locator('[role=tab]', { hasText: /^Positions$/ }).click();
  await expect(page.getByText('Not applicable: cash spot holds balances, not positions')).toBeVisible();
});

test(`${J} #6 reviews a TEST 0.1 BTC limit buy: hold in USDT, maker role and rate, time in force, client id held for retry`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const who = account();
  const client = await api(who);
  // It starts with a second TEST deposit through #4's own path (TOP_UP says why), and the desk's balance equals the
  // ledger after it, before Review.
  expect((await client.balances()).USDT).toMatchObject({
    free: expect.stringMatching(/^1000(\.0+)?$/),
    used: expect.stringMatching(/^0(\.0+)?$/),
  });
  await signIn(page, who);
  await depositReleased(page, browser, client, who, TOP_UP, `jcs01-${who.handle}-${TOP_UP}`);
  await desk(page);
  const funded = await deskEqualsLedger(page, client, ['USDT']);
  expect(wireUnits(funded.USDT.free)).toBe(toUnits('1000') + toUnits(TOP_UP));
  expect(wireUnits(funded.USDT.used)).toBe(0n);
  expect(shownUnits(await page.getByTestId('dk-avail').locator('dd').first().innerText())).toBe(wireUnits(funded.USDT.free));
  run.write({ fundedUsdt: funded.USDT.total });

  // Types a limit buy of TEST 0.1 BTC at a TEST price, one cent above the best bid, and presses Review.
  const price = await topBid();
  expect(times(price, BUY)).toBeLessThanOrEqual(wireUnits(funded.USDT.free));
  const previews = [];
  const sent = (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/orders/preview') previews.push(request.postDataJSON());
  };
  page.on('request', sent);
  const review = await reviewLimit(page, 'buy', price, BUY);
  // The order reviewed is the one typed: 0.1 BTC at that price.
  await expect(reviewValue(review, 'Amount')).toContainText('BTC');
  expect(shownUnits(await reviewValue(review, 'Amount').innerText())).toBe(toUnits(BUY));
  // The amount set aside is price x amount, in USDT.
  const hold = reviewValue(review, 'set aside');
  await expect(hold).toContainText('USDT');
  expect(shownUnits(await hold.innerText())).toBe(times(price, BUY));
  // The fee role is maker, at this account's own maker rate for BTC/USDT as the service lists it (to the shown 0.01%).
  await expect(reviewValue(review, 'Fee role')).toHaveText('Maker: the order rests on the book');
  const { body: fees } = await client.get('/api/v1/account/fees');
  const maker = fees['BTC/USDT']?.maker;
  expect(maker, JSON.stringify(fees).slice(0, 300)).toBeTruthy();
  const rate = /up to ([−-]?[\d.]+)%/.exec(await reviewValue(review, 'Estimated fee').innerText())?.[1];
  expect(rate, 'the estimated fee names its rate').toBeTruthy();
  expect(toUnits(rate.replace('−', '-'))).toBe(asPercent(maker));
  await expect(reviewValue(review, 'Time in force')).toHaveText('Good till cancelled');
  // The client id is shown with the promise that a retry sends it again, and it is the id this review's own check sent.
  const id = (await review.getByTestId('client-order-id').innerText()).trim();
  expect(id).toMatch(/^\S+$/);
  await expect(reviewValue(review, 'Client order ID')).toContainText('A retry sends this same ID, so it can’t become a second order.');
  expect(
    previews.some((body) => typeof body?.clientOrderId === 'string' && body.clientOrderId.endsWith(`:${id}`)),
    JSON.stringify(previews.map((b) => b?.clientOrderId)),
  ).toBe(true);
  // Held for retry: the review is closed with nothing sent, the same order is reviewed again, and it keeps the same id.
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(reviewSheet(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Buy BTC' }).click();
  await expect(reviewSheet(page)).toBeVisible();
  await expect(reviewSheet(page).getByTestId('client-order-id')).toHaveText(id);
  await reviewSheet(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(reviewSheet(page)).toHaveCount(0);
  page.off('request', sent);
  // A review sends nothing: no order exists and nothing is held.
  expect(await openOrders(who)).toHaveLength(0);
  expect(held(await client.balances(), 'USDT')).toBe(0n);
});

test(`${J} #7 confirms: the order is Open and the USDT hold equals the review`, async ({ page }) => {
  const who = account();
  await desk(page);
  // The book has moved since the review in step 6, so the price is taken again now.
  const price = await topBid();
  const amount = BUY;
  const review = await reviewLimit(page, 'buy', price, amount);
  const reviewHold = shownUnits(await reviewValue(review, 'set aside').innerText());
  await confirm(page, 'buy');
  await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
  const row = page.locator('tr', { hasText: Number(price).toLocaleString('en-US', { minimumFractionDigits: 2 }) });
  await expect(row).toBeVisible();
  const orders = await openOrders(who);
  expect(orders).toHaveLength(1);
  expect(orders[0].status).toBe('open');
  run.write({ limitBuy: { price, amount, id: orders[0].id } });
  // The hold equals the review's, on the ledger and in the row's Held cell.
  const balances = await (await api(who)).balances();
  expect(held(balances, 'USDT')).toBe(reviewHold);
  expect(reviewHold).toBe(times(price, amount));
  const heldCol = await row.locator('xpath=ancestor::table//th').allInnerTexts();
  const cells = await row.locator('td').allInnerTexts();
  const heldAt = heldCol.findIndex((h) => h.trim() === 'Held');
  expect(heldAt, heldCol.join(' | ')).toBeGreaterThanOrEqual(0);
  expect(shownUnits(cells[heldAt])).toBe(reviewHold);
});

test(`${J} #8 another TEST trader's crossing sell fills it: fill row with price, amount, fee and maker role`, async ({ page }) => {
  const who = account();
  const { price, amount, id } = run.read().limitBuy ?? {};
  expect(id).toBeTruthy();
  const other = await api(otherTrader());
  // The other TEST trader is the stack's test_taker, which also crosses the best bid now and then on its own; the market
  // maker's quotes are post-only and never cross. Either way the order fills as maker against the other trader's sell.
  // An IOC sell takes the best bids first: if the market maker has bid above this order since, sell through those
  // too, so the sell reaches this order at its price. The maker requotes every few seconds, so bids it adds between the
  // book read and the sell can use the sell up first (run 1132, #7108): while the order is still open a few seconds
  // after a sell, read the book again and send another.
  let sells = 0;
  let lastSell = 0;
  const sellWhileOpen = async () => {
    const open = await openOrders(who);
    if (!open.some((o) => o.id === id) || Date.now() - lastSell < 3_000) return open.length;
    const { body } = await bestPrices();
    const ahead = body.bids.filter(([p]) => toUnits(p) > toUnits(price)).reduce((sum, [, size]) => sum + toUnits(size), 0n);
    sells += 1;
    const sell = await other.post('/api/v1/orders', {
      symbol: 'BTC/USDT',
      type: 'limit',
      side: 'sell',
      amount: fromUnits(ahead + toUnits(amount)),
      price,
      timeInForce: 'IOC',
      clientOrderId: `${J}-8-${id}-${sells}`,
    });
    expect(sell.status, JSON.stringify(sell.body).slice(0, 300)).toBeLessThan(300);
    lastSell = Date.now();
    return open.length;
  };
  await expect.poll(sellWhileOpen, { timeout: 30_000 }).toBe(0);
  const client = await api(who);
  // The service holds the order as filled: closed, its whole amount filled, nothing left.
  const { status: read, body: order } = await client.get(`/api/v1/orders/${id}`);
  expect(read, JSON.stringify(order).slice(0, 300)).toBe(200);
  expect(order).toMatchObject({ id, status: 'closed' });
  expect(wireUnits(order.filled)).toBe(toUnits(amount));
  expect(wireUnits(order.remaining)).toBe(0n);
  // The order's own fills, from the service: maker, at its price, for its whole amount, each with a fee and no rebate.
  const fills = await fillsOf(who, id);
  expect(fills.length).toBeGreaterThan(0);
  expect(
    fills.every((f) => f.takerOrMaker === 'maker' && wireUnits(f.price) === toUnits(price) && !f.rebate),
    JSON.stringify(fills),
  ).toBe(true);
  expect(fills.reduce((sum, f) => sum + wireUnits(f.amount), 0n)).toBe(toUnits(amount));
  // Every fill is another TEST trader's crossing sell: the other trader's own fills hold, for each, a taker sell at the
  // same price, amount and moment (each of its fills used once).
  const { status: theirsRead, body: theirs } = await other.get(
    `/api/v1/account/trades?symbol=BTC%2FUSDT&limit=500&since=${Math.min(...fills.map((f) => Number(f.timestamp))) - 1_000}`,
  );
  expect(theirsRead, JSON.stringify(theirs).slice(0, 300)).toBe(200);
  const crossings = theirs.filter((t) => t.side === 'sell' && t.takerOrMaker === 'taker');
  for (const f of fills) {
    const at = crossings.findIndex(
      (t) =>
        wireUnits(t.price) === wireUnits(f.price) &&
        wireUnits(t.amount) === wireUnits(f.amount) &&
        Math.abs(t.timestamp - f.timestamp) <= 1_000,
    );
    expect(at, `${JSON.stringify(f)} among the other trader's sells ${JSON.stringify(crossings).slice(0, 600)}`).toBeGreaterThanOrEqual(0);
    crossings.splice(at, 1);
  }
  // BTC is credited and USDT debited to the ledger amount: the fills' amount less any fee taken in BTC, and their cost
  // plus any fee taken in USDT. Before the fill the account held no BTC and the USDT #6 left it with, nothing held.
  const feeIn = (asset) => fills.filter((f) => f.fee.currency === asset).reduce((sum, f) => sum + wireUnits(f.fee.cost), 0n);
  expect(
    fills.every((f) => f.fee.currency === 'BTC' || f.fee.currency === 'USDT'),
    JSON.stringify(fills),
  ).toBe(true);
  const cost = fills.reduce((sum, f) => sum + wireUnits(f.cost), 0n);
  expect(cost).toBe(times(price, amount));
  const after = await client.balances();
  expect(toUnits(after.BTC?.total ?? '0')).toBe(toUnits(amount) - feeIn('BTC'));
  expect(toUnits(run.read().fundedUsdt) - toUnits(after.USDT.total)).toBe(cost + feeIn('USDT'));
  expect(held(after, 'USDT')).toBe(0n);
  expect(held(after, 'BTC')).toBe(0n);
  await desk(page);
  // The desk's balances equal the ledger's, BTC and USDT.
  await deskEqualsLedger(page, client, ['BTC', 'USDT']);
  // Order history shows the order filled: its row reads Filled, with its whole amount in the Filled column.
  await page.locator('[role=tab]', { hasText: /^Order history$/ }).click();
  const orderRow = page.locator('tr', { has: page.locator(`a[href="/trade/orders/${encodeURIComponent(id)}"]`) });
  await expect(orderRow).toHaveCount(1);
  const orderHeads = (await orderRow.locator('xpath=ancestor::table//th').allInnerTexts()).map((h) => h.trim());
  const statusAt = orderHeads.indexOf('Status');
  expect(statusAt, orderHeads.join(' | ')).toBeGreaterThanOrEqual(0);
  // The Status cell holds one status tag (a link to the order's changes sits beside it): filled, reading Filled.
  const tag = orderRow.locator('td').nth(statusAt).locator('[data-slot=status-tag]');
  await expect(tag).toHaveCount(1);
  await expect(tag).toHaveAttribute('data-status', 'filled');
  await expect(tag).toHaveText('Filled');
  const orderCells = (await orderRow.locator('td').allInnerTexts()).map((c) => c.trim());
  expect(shownUnits(orderCells[orderHeads.indexOf('Filled')])).toBe(toUnits(amount));
  await page.locator('[role=tab]', { hasText: 'Trade history' }).click();
  // Each fill's row shows its price, amount, fee amount and asset, the fee rate and the maker role.
  const makerRows = page
    .locator('tr', { hasText: 'Maker' })
    .filter({ hasText: Number(price).toLocaleString('en-US', { minimumFractionDigits: 2 }) });
  await expect(makerRows).toHaveCount(fills.length);
  const rows = [];
  for (const row of await makerRows.all()) rows.push((await row.locator('td').allInnerTexts()).map((c) => c.trim()));
  // Each fill is matched to its own row, by amount and fee, and no row is used twice.
  for (const f of fills) {
    const shown = (cells) => cells.some((c) => /^[\d,.]+$/.test(c) && shownUnits(c) === wireUnits(f.amount));
    const feeOf = (cells) => cells.find((c) => c.includes(String(f.fee.currency)) && c.includes('%'));
    const at = rows.findIndex((cells) => shown(cells) && feeOf(cells) && shownUnits(feeOf(cells)) === wireUnits(f.fee.cost));
    expect(at, `${JSON.stringify(f)} in ${JSON.stringify(rows)}`).toBeGreaterThanOrEqual(0);
    const [cells] = rows.splice(at, 1);
    const fee = feeOf(cells);
    expect(fee, cells.join(' | ')).toBeTruthy();
    expect(shownUnits(fee)).toBe(wireUnits(f.fee.cost));
    const shownRate = /([−-]?[\d.]+)%/.exec(fee)?.[1];
    expect(shownRate, `the fee cell names its rate: ${fee}`).toBeTruthy();
    expect(toUnits(shownRate.replace('−', '-'))).toBe(asPercent(f.fee.rate));
  }
});

test(`${J} #9 places a market buy: it fills inside its protection price and leaves no hold`, async ({ page }) => {
  const who = account();
  const before = await (await api(who)).balances();
  await desk(page);
  await page.locator('[role=tab]', { hasText: /^Market$/ }).click();
  await previewed(page, () => page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001'));
  await page.getByRole('button', { name: 'Buy BTC' }).click();
  const review = reviewSheet(page);
  await expect(review).toBeVisible();
  // A requote asks again with a new protection price: the bound is the one on the sheet that was last confirmed.
  let protection;
  for (let i = 0; i < 3 && (await review.count()); i++) {
    protection = shownUnits(await reviewValue(review, 'Price protection').innerText());
    await page.getByRole('button', { name: 'Confirm buy' }).click();
    await page.waitForTimeout(1500);
  }
  await expect(review).toHaveCount(0);
  await expect
    .poll(async () => toUnits((await (await api(who)).balances()).BTC?.total ?? '0') - toUnits(before.BTC?.total ?? '0'), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0n);
  const after = await (await api(who)).balances();
  expect(held(after, 'USDT')).toBe(0n);
  // Every fill of the market buy is inside its protection price.
  const { body: recent } = await (await api(who)).get('/api/v1/orders/closed?symbol=BTC%2FUSDT&limit=5');
  const market = recent.find((o) => o.type === 'market' && o.side === 'buy');
  expect(market, JSON.stringify(recent).slice(0, 300)).toBeTruthy();
  const fills = await fillsOf(who, market.id);
  expect(fills.length).toBeGreaterThan(0);
  for (const f of fills) expect(wireUnits(f.price)).toBeLessThanOrEqual(protection);
});

test(`${J} #10 rests a limit buy away from the market, cancels it, cancels it again`, async ({ page }) => {
  const who = account();
  await desk(page);
  const away = await awayBid(90); // 90% of the bid, whole USDT
  await reviewLimit(page, 'buy', away, '0.001');
  await confirm(page, 'buy');
  const [order] = await openOrders(who);
  expect(order).toBeTruthy();
  await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
  const row = page.locator('tr', { hasText: Number(away).toLocaleString('en-US', { minimumFractionDigits: 2 }) });
  await row.getByRole('button', { name: 'Cancel' }).click();
  // Only a confirm dialog's button: the desk's "Cancel orders…" control also reads "cancel order".
  const sure = page.getByRole('dialog').getByRole('button', { name: /cancel order|yes|confirm/i });
  if (await sure.count()) await sure.first().click();
  await expect(row).toHaveCount(0);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(0n);
  // The repeat is refused with the order's terminal state, and moves nothing.
  const again = await (await api(who)).delete(`/api/v1/orders/${order.id}?symbol=BTC%2FUSDT`);
  expect(again.status).toBe(409);
  expect(JSON.stringify(again.body)).toMatch(/is cancelled/);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(0n);
});

test(`${J} #11 reads the bought lot on Profit and loss, sells it, and reads the realised result`, async ({ page }) => {
  const who = account();
  const client = await api(who);
  /** Profit and loss as svc-tax works it out for this account (the room's own read), its BTC lots and its realised sum. */
  const lotBook = async () => {
    const { status, body } = await client.get('/api/tax/trpc/lotBook');
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
    const book = body.result.data;
    return { book, lots: book.lots.filter((lot) => String(lot.assetId).toUpperCase() === 'BTC') };
  };
  // What the buys cost: every BTC/USDT buy fill of this account (#8's limit buy and #9's market buy), in USDT.
  const { status: read, body: mine } = await client.get('/api/v1/account/trades?symbol=BTC%2FUSDT&limit=500');
  expect(read, JSON.stringify(mine).slice(0, 300)).toBe(200);
  const buys = mine.filter((t) => t.side === 'buy');
  expect(buys.length).toBeGreaterThan(0);
  expect(mine.filter((t) => t.side === 'sell')).toHaveLength(0);
  // Each buy's fee came out of the coins it received (BTC), so what left the account for the coins is its cost alone,
  // which is what svc-tax books as a lot's cost (the quote leg paid out of the order's hold).
  expect(
    buys.every((t) => t.fee?.currency === 'BTC'),
    JSON.stringify(buys.map((t) => t.fee)),
  ).toBe(true);
  const paid = buys.reduce((sum, t) => sum + wireUnits(t.cost), 0n);
  const btc = toUnits((await client.balances()).BTC?.total ?? '0');

  // After the buy: the bought lots are open at their cost. svc-tax holds them as bought (trade), nothing of them sold,
  // still held, together costing what the buys paid and holding the BTC the ledger holds.
  const before = await lotBook();
  expect(before.lots.length).toBeGreaterThan(0);
  for (const lot of before.lots) {
    expect(lot, JSON.stringify(lot)).toMatchObject({ source: 'trade' });
    expect(wireUnits(lot.remaining), JSON.stringify(lot)).toBe(wireUnits(lot.qty));
    expect(lot.daysHeld, JSON.stringify(lot)).not.toBeNull();
    expect(lot.costUsd, JSON.stringify(lot)).not.toBeNull();
  }
  expect(before.lots.reduce((sum, lot) => sum + wireUnits(lot.costUsd), 0n)).toBe(paid);
  expect(before.lots.reduce((sum, lot) => sum + wireUnits(lot.remaining), 0n)).toBe(btc);
  // The room shows each of those lots: what is left, its cost to the shown cent, and a number of days held, not Sold.
  await signIn(page, who);
  await page.goto('/money/pnl?asset=BTC');
  const main = page.locator('main').first();
  const lots = main.locator('tr[data-lot]');
  await expect(lots.first()).toBeVisible({ timeout: 30_000 });
  await expect(lots).toHaveCount(before.lots.length);
  for (const lot of before.lots) {
    const row = main.locator(`tr[data-lot="${lot.id}"]`);
    await expect(row).toHaveCount(1);
    expect(shownUnits(await row.locator('td[data-col=left]').innerText())).toBe(wireUnits(lot.remaining));
    await expect(row.locator('td[data-col=cost]')).toHaveText(new RegExp(`^${DOLLARS}$`));
    expect(shownUnits(await row.locator('td[data-col=cost]').innerText())).toBe(asShownUsd(lot.costUsd));
    await expect(row.locator('td[data-col=days]')).toHaveText(/^\d+$/);
  }

  // Sells the coins on the desk.
  await page.goto(DESK);
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  await page
    .getByRole('textbox', { name: 'Price' })
    .nth(1)
    .fill(await underBid());
  // The sell side's Max: every whole step of the BTC held.
  await previewed(page, () => page.getByRole('button', { name: 'Max' }).last().click());
  await page.getByRole('button', { name: 'Sell BTC' }).click();
  await expect(reviewSheet(page)).toBeVisible();
  await confirm(page, 'sell');
  // What is left is below the market's amount step (0.00001 BTC).
  await expect.poll(async () => toUnits((await client.balances()).BTC?.total ?? '0'), { timeout: 20_000 }).toBeLessThan(toUnits('0.00001'));

  // After the sale: the realised result shows, as svc-tax works it out, labelled as an indicator.
  // svc-tax books the sale's fills one by one, so its figure is read once every fill is in: a realised sum, and BTC lots
  // whose remaining amount is what the ledger still holds.
  const left = toUnits((await client.balances()).BTC?.total ?? '0');
  let after;
  await expect
    .poll(
      async () => {
        after = await lotBook();
        return after.book.realizedUsd !== null && after.lots.reduce((sum, lot) => sum + wireUnits(lot.remaining), 0n) === left;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.goto('/money/pnl');
  await expect(main.getByTestId('money-label').filter({ hasText: 'Realised' }).first()).toBeVisible();
  const realised = main.locator('[data-testid=money-total][data-figure=realised]');
  // A signed dollar result: the sale and its fees leave a non-zero result, which can be under $1 ("−$0.8094" in run 1123).
  await expect(realised).toHaveText(new RegExp(`^[+−]${DOLLARS}$`));
  expect(shownUnits(await realised.innerText())).toBe(asShownUsd(after.book.realizedUsd));
  expect(after.book.indicator).toBe('indicator_not_tax_advice');
  await expect(main.locator('[data-testid=money-note][data-indicator=true]')).toHaveText(
    'This is an indicator worked out from your own trades. It is not a tax form.',
  );
});

/** #12's TEST wallet on TEST Base, where the stack connects no custody signer (no payout rail), saved in the address book. */
const WALLET = '0xdd2fd4581271e230360230f9337d5c0430bf44c0';
const WALLET_LABEL = 'TEST Base wallet';

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** The next authenticator code after the last one this run used, so no code is used twice. */
async function freshCode() {
  const state = run.read();
  const { totp } = await totpLib();
  const { code, step } = await nextCode(totp, state.secret, state.step);
  run.write({ step });
  return code;
}

/** Answers the "Confirm it's you" dialog with the next authenticator code. */
async function confirmItsMe(page) {
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Authenticator code or recovery code').fill(await freshCode());
  await dialog.getByRole('button', { name: 'Confirm' }).click();
}

/** Saves the TEST Base wallet for USDT, approves it by its emailed link in another browser, and ages it past its cooling-off. */
async function saveWallet(page, browser, who) {
  await page.goto('/uc/withdraw/address');
  const add = page.getByRole('form', { name: 'Add an address' });
  await add.getByRole('textbox', { name: /^Label/ }).fill(WALLET_LABEL);
  await add.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  await add.getByRole('combobox', { name: /^Network/ }).selectOption('base');
  await add.getByRole('textbox', { name: /^Address/ }).fill(WALLET);
  await add.getByRole('button', { name: 'Save address' }).click();
  await confirmItsMe(page);
  await expect(page.getByText(`${WALLET_LABEL} was saved to your address book.`)).toBeVisible();
  const links = () =>
    mailedLines(who.email, 'withdraw-address-approval').map((line) => `/${/link=(approveAddress\?token=\S+)/.exec(line)?.[1]}`);
  const seen = links().length;
  await page.locator('tbody tr', { hasText: WALLET_LABEL }).getByRole('button', { name: 'Withdraw to this address' }).click();
  await page.getByTestId('address-use').getByRole('button', { name: 'Email me an approval link' }).click();
  await expect.poll(() => links().length, { timeout: 20_000 }).toBeGreaterThan(seen);
  const other = await browser.newContext();
  try {
    const away = await other.newPage();
    await away.goto(links().at(-1));
    await away.getByRole('link', { name: 'Sign in' }).last().click();
    await away.fill('input[name=totp]', await freshCode());
    await away.fill('input[name=identifier]', who.email);
    await away.fill('input[name=password]', who.password);
    await away.getByRole('button', { name: /^sign in$/i }).click();
    await expect(away).toHaveURL(/\/approveAddress$/);
    await away.getByTestId('approve-address').getByRole('button', { name: 'Approve' }).click();
    await confirmItsMe(away);
    await expect(away.getByRole('heading', { name: 'Address approved' })).toBeVisible();
  } finally {
    await other.close();
  }
  // The cooling-off runs from the approval; the LOCAL TEST clock moves it past its end.
  expect(tool('local-test-stack.mjs', 'age-addresses', who.email, '25')).toContain('1 saved address(es)');
  await page.reload();
  await expect(page.locator('tbody tr', { hasText: WALLET_LABEL })).toContainText('Ready to use');
}

test(`${J} #12 steps up and asks to withdraw TEST 10 USDT: refused with the named blocker, nothing held, no withdrawal; a session not stepped up is refused before that`, async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const who = account();
  // The stack's TEST withdrawal terms (limits, fees, networks), as J-wallet-05 starts from.
  tool('local-test-gates.mjs', 'withdraw-terms');
  // A second factor to step up with, from Security, and a saved wallet on TEST Base to send to.
  await signIn(page, who);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.write({ secret, step });
  await saveWallet(page, browser, who);

  const client = await api(who, { totpCode: await freshCode() });
  const before = await client.balances();
  expect(wireUnits(before.USDT.free)).toBeGreaterThanOrEqual(toUnits('10'));
  const withdrawals = async () => {
    const { status, body } = await client.get(
      `/api/pay/trpc/withdrawal.history?input=${encodeURIComponent(JSON.stringify({ limit: 10 }))}`,
    );
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
    return body.result.data.items;
  };
  const unmoved = async () => {
    const now = await client.balances();
    expect(free(now, 'USDT')).toBe(free(before, 'USDT'));
    expect(held(now, 'USDT')).toBe(held(before, 'USDT'));
    expect(await withdrawals()).toEqual([]);
  };
  expect(await withdrawals()).toEqual([]);

  // A session that has not stepped up is refused before the rail: the same send of TEST 10 USDT to the saved wallet, with
  // a real fee quote, on the signed-in session's own token, is refused for the missing step-up, not for the rail.
  const quoteRef = `${J}-12-${who.handle}`;
  const quoted = await client.post('/api/pay/trpc/withdrawal.quote', { quoteRef, assetId: 'USDT', networkId: 'base', amount: '10' });
  expect(quoted.status, JSON.stringify(quoted.body).slice(0, 400)).toBe(200);
  const unstepped = await client.post('/api/pay/trpc/withdrawal.create', {
    assetId: 'USDT',
    amount: '10',
    railId: 'crypto-native',
    networkId: 'base',
    quoteRef,
    destination: { kind: 'crypto', ref: WALLET },
    clientRef: `${J}-12-unstepped-${who.handle}`,
  });
  expect(unstepped.status, JSON.stringify(unstepped.body).slice(0, 400)).toBe(403);
  expect(unstepped.body?.error?.data?.code).toBe('FORBIDDEN');
  expect(unstepped.body?.error?.message).toContain('trade:withdraw');
  expect(JSON.stringify(unstepped.body)).not.toContain('pay.wallet_withdraw_unavailable');
  await unmoved();

  // In the browser: Withdraw, TEST 10 USDT on TEST Base to the saved wallet, the fee, then Confirm and send.
  await signOutBrowser(page.context());
  await page.goto('/login');
  await page.fill('input[name=totp]', await freshCode());
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto('/uc/withdraw');
  await pointerOff(page);
  const form = page.getByTestId('withdraw-form');
  const pick = (name) => form.getByRole('combobox', { name: new RegExp(`^${name}`) });
  await pick('Asset').selectOption('USDT');
  await pick('Network').selectOption('base');
  const ready = `${WALLET_LABEL} · ${WALLET.slice(0, 6)}…${WALLET.slice(-4)} · Ready to use`;
  await expect(pick('Saved address').locator('option', { hasText: WALLET_LABEL })).toHaveText(ready);
  await pick('Saved address').selectOption({ label: ready });
  await form.getByRole('textbox', { name: /^Amount/ }).fill('10');
  await page.getByRole('button', { name: 'Get the fee' }).click();
  const creates = [];
  const sent = (request) => {
    if (request.url().includes('/api/pay/trpc/withdrawal.create')) creates.push(request.url());
  };
  page.on('request', sent);
  await expect(page.getByRole('button', { name: 'Confirm and send' })).toBeEnabled();
  await page.getByRole('button', { name: 'Confirm and send' }).click();
  // The send asks for a fresh step-up first: with no code, Confirm stays shut and nothing is sent.
  const stepUp = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(stepUp).toContainText('Sending money out needs a fresh confirmation.');
  await expect(stepUp.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  expect(creates).toHaveLength(0);
  // Steps up: the stepped-up send gets past the step-up check and is refused by the rail, by name.
  const answered = page.waitForResponse((res) => res.url().includes('/api/pay/trpc/withdrawal.create'));
  await confirmItsMe(page);
  const refused = await (await answered).json();
  expect(refused?.error?.data?.cause?.code, JSON.stringify(refused).slice(0, 400)).toBe('pay.wallet_withdraw_unavailable');
  page.off('request', sent);
  expect(creates).toHaveLength(1);
  const outcome = page.getByTestId('withdraw-outcome');
  await expect(outcome).toContainText('Not sent');
  await expect(outcome).toContainText(
    'Sending to a wallet outside INTAFACED isn’t connected: no custody signer is set up, so this withdrawal was refused before anything was held.',
  );
  await expect(outcome).toContainText('Nothing was sent and nothing is held.');
  // Nothing held and no withdrawal: the ledger and svc-pay agree, and the room's list is empty.
  await unmoved();
  await page.reload();
  await expect(page.getByText('No withdrawals yet')).toBeVisible();
});
