import { randomBytes } from 'node:crypto';
import { expect } from '@playwright/test';
import { api, bestPrices, fromUnits, fund, signUpInBrowser, toUnits, signOutBrowser } from './stack.mjs';

// What a person does on the spot desk in the running app, shared by the cex-spot journeys. Each journey keeps its own
// run file; these helpers take the account they act as.

export async function signIn(page, who) {
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * This browser has chosen Pro, as a person who switched once would have. The app opens in Simple for everyone (owner
 * decision 2026-10-26); a step whose text is about what Pro shows says so with this. A choice the page saves later stays.
 */
export async function chosePro(page) {
  await page.addInitScript((key) => {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (!('layoutMode' in saved)) localStorage.setItem(key, JSON.stringify({ ...saved, layoutMode: 'pro' }));
  }, 'intafaced.customer.view.v1');
}

/** A fresh TEST account, signed up in the browser (details, then the code the stack mails to its outbox file), with a
 * TEST password kept only in the run file (mode 600). */
export async function signUp(page, prefix) {
  const handle = `${prefix}${Date.now().toString(36)}`;
  const who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  await signUpInBrowser(page, who);
  await expect(page).not.toHaveURL(/\/register/);
  return who;
}

/**
 * The founder pair's sign-ins, kept in this worker's memory only and shared by every verification it runs. A fresh
 * sign-in per call spent a new 30-second TOTP step per founder, so back-to-back verifications waited for the clock
 * (20 of the 27.6 s J-merchant-01 #5 took). Never written to disk.
 */
let founderSessions = {};

/**
 * The gates tool's `verify`, in this process: a new context each time (its local-stack guards run on every call) over
 * the kept sign-ins. A refused approval (a kept session that identity no longer honours) drops them and runs once
 * more, signing in again with a fresh TOTP step from the tool's own step file, so a code is never reused. What was still
 * refused after that is returned for the failure message.
 */
async function verifyPending() {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  for (let attempt = 1; ; attempt++) {
    const ctx = await gates.makeContext({ log: () => {}, shareSessions: true });
    ctx.sessionCache = founderSessions;
    const run = await gates.verifyAll(ctx);
    if (attempt === 1 && run.approved.some((row) => !row.ok)) {
      founderSessions = {};
      continue;
    }
    return { ...(await gates.status(ctx)), refused: run.approved.filter((row) => !row.ok) };
  }
}

/** The signed-in person asks for full verification; the stack's two TEST operators approve it through identity's own
 * door. The cookies are cleared after, so the next sign-in carries the new tier. */
export async function verify(page, who) {
  await page.goto('/verification');
  await page.getByLabel('Level to request').selectOption({ label: 'Full' });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
  const { accounts, refused } = await verifyPending();
  expect(accounts.find((a) => a.handle === who.handle)?.tiers, JSON.stringify(refused)).toContain('full');
  await signOutBrowser(page.context());
}

/** A journey's starting point: signed up, verified, and funded with TEST USDT through the real ledger. Signed out after. */
export async function fundedTrader(page, prefix, usdt) {
  const who = await signUp(page, prefix);
  await verify(page, who);
  expect(fund(who.email, 'USDT', usdt).tx).toBeTruthy();
  return who;
}

export const deskPath = (symbol = 'BTC/USDT') => `/trade/spot/${symbol.replace('/', '-')}`;

export async function openDesk(page, who, symbol = 'BTC/USDT') {
  await signIn(page, who);
  // What the market list answered, named in the failure: a desk that never opens shows only "Couldn't load".
  const reads = [];
  const isList = (url) => new URL(url).pathname === '/api/v1/markets';
  // Each read names the page it was made on: a read the sign-in's own page started and goto() cut off is not the desk's.
  const on = () => new URL(page.url()).pathname;
  const answered = (res) => isList(res.url()) && reads.push(`${on()} ${res.status()}`);
  const failed = (req) => isList(req.url()) && reads.push(`${on()} failed (${req.failure()?.errorText ?? 'no answer'})`);
  page.on('response', answered);
  page.on('requestfailed', failed);
  try {
    await page.goto(deskPath(symbol));
    await expect(page.getByRole('button', { name: `Buy ${symbol.split('/')[0]}` })).toBeVisible();
  } catch (err) {
    err.message += `\nmarket list reads: ${reads.join(', ') || 'none'}`;
    throw err;
  } finally {
    page.off('response', answered);
    page.off('requestfailed', failed);
  }
}

/** The review sheet the desk shows before an order is sent ("Review your buy" / "Review your sell"). */
export const reviewSheet = (page) => page.locator('[role=dialog], [role=alertdialog]').filter({ hasText: /Review your (buy|sell)/ });

export const held = (balances, asset) => toUnits(balances[asset]?.used ?? '0');
export const free = (balances, asset) => toUnits(balances[asset]?.free ?? '0');

export async function openOrders(who, symbol = 'BTC/USDT') {
  const { status, body } = await (await api(who)).get(`/api/v1/orders/open?symbol=${encodeURIComponent(symbol)}&limit=100`);
  expect(status).toBe(200);
  return Array.isArray(body) ? body : (body.orders ?? body.items ?? []);
}

/** A whole-USDT price at `percent` of the best bid: a buy there rests, far from anything that would fill it. */
export async function awayBid(percent = 90, symbol = 'BTC/USDT') {
  const { bid } = await bestPrices(symbol);
  const one = toUnits('1');
  return fromUnits(((toUnits(bid) * BigInt(percent)) / 100n / one) * one);
}

/** Run `act` and wait for the desk's own order preview to answer, so Review is pressed on a checked order. */
export async function previewed(page, act) {
  const answer = page.waitForResponse((r) => r.url().includes('/api/v1/orders/preview') && r.request().method() === 'POST');
  await act();
  expect((await answer).status()).toBe(200);
}

/** Fill the limit form on the buy (0) or sell (1) side, press Buy/Sell, return the review dialog. */
export async function reviewLimit(page, side, price, amount, base = 'BTC') {
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  const at = side === 'buy' ? 0 : 1;
  await page.getByRole('textbox', { name: 'Price' }).nth(at).fill(price);
  await previewed(page, () => page.getByRole('textbox', { name: 'Amount' }).nth(at).fill(amount));
  await page.getByRole('button', { name: side === 'buy' ? `Buy ${base}` : `Sell ${base}` }).click();
  const review = reviewSheet(page);
  await expect(review).toBeVisible();
  return review;
}

/** Confirm a review; a requote asks again, so confirm until the dialog closes (at most three times). */
export async function confirm(page, side) {
  for (let i = 0; i < 3; i++) {
    const button = page.getByRole('button', { name: side === 'buy' ? 'Confirm buy' : 'Confirm sell' });
    if (!(await button.count())) break;
    await button.click();
    await page.waitForTimeout(1500);
  }
  await expect(reviewSheet(page)).toHaveCount(0);
}

/** The order sends the browser makes (POST /api/v1/orders), with their bodies, from now on. */
export function placements(page) {
  const sent = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/orders') sent.push(request.postDataJSON());
  });
  return sent;
}
