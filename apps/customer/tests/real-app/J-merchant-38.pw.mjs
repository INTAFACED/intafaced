// World: stack
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT, journeyState } from './stack.mjs';
import { nextCode } from './identity-factors.mjs';
import {
  businessReadyPerson,
  openBusiness,
  paidCardPayment,
  payApiOf,
  refusedPayCalls,
  signInWithCode,
  verifiedBusiness,
} from './merchant.mjs';

// J-merchant-38, in the running app (docs/roadmap/journeys.json): use Business Pay on a phone and trust what it shows.
// Written from the step words in operation-zero/modules/merchant/acceptance/journeys.md by a test-writer, not a builder.
// Starts signed in on a 375 px phone, the full portal. One verified TEST business is made by #1 and used by every step.
// #1 opens the dashboard at 375 px: no sideways scroll, every target at least 44 px, and a bottom navigation that reaches
//    the portal's main rooms (its five areas), each of which fits the phone too.
// #2 creates a payment link, a refund, a payout and a subscription, one test each, losing the reply of the create each
//    time (the request reaches the service, its answer never reaches the page). After a reload the page shows the
//    stored request id, any create it sends again carries that same id, and the service holds exactly one object.
// #3 the suite on the stack: every room of every area opened at 375 px with zero console errors and a screenshot per
//    area, and every ledger-touching path (a payment, a refund, a settlement, a payout) reconciles: balance before,
//    action, balance after, to the exact amount.
const J = 'J-merchant-38';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const PHONE = { width: 375, height: 812 };

/** The portal's main rooms: the first room of each of its five areas (portal/home-layout/groups.ts). */
const MAIN_ROOMS = ['/pay/merchant', '/pay/payments', '/pay/money', '/pay/customers', '/pay/settings'];

test.describe.configure({ mode: 'default' });

const saved = (who) => ({ handle: who.handle, email: who.email, password: who.password, secret: who.secret, step: who.step });

function journey() {
  const state = run.read();
  if (!state.owner?.secret || !state.merchantId) throw new Error(`${J} #1 made no business, so this step has no owner to act as`);
  return state;
}

async function signInOwner(page, destination) {
  const state = journey();
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = { ...state.owner, totp };
  await signInWithCode(page, who, destination);
  run.write({ owner: saved(who) });
  return who;
}

/** The owner's own pay API through Edge; the code's time step is kept for the next sign-in. */
async function ownerApi() {
  const state = journey();
  return payApiOf(state.owner, (step) => run.write({ owner: { ...run.read().owner, step } }));
}

/** The owner's next authenticator code, its time step kept so no later sign-in reuses it. */
async function ownerCode() {
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const owner = run.read().owner;
  const next = await nextCode(totp, owner.secret, owner.step);
  run.write({ owner: { ...owner, step: next.step } });
  return next.code;
}

/** A decimal string as a bigint of 18 decimal places, so balances are compared exactly. */
function units(value) {
  const [whole, frac = ''] = String(value ?? '0').split('.');
  const neg = whole.startsWith('-');
  const n = BigInt(whole.replace('-', '') || '0') * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18) || '0');
  return neg ? -n : n;
}

/** The business's balance of `asset` as svc-pay reads it from the ledger: clearing and available, exact. */
async function balanceOf(api, merchantId, asset = 'USDT') {
  const snap = await api.query('merchantMetrics.snapshot', { merchantId, window: { kind: 'preset', preset: 'rolling_30d' } });
  const row = snap.balances.find((b) => b.assetCode === asset);
  return { clearing: units(row?.clearing), available: units(row?.available) };
}

/** Is the page wider than the phone? Both the document and the body are read. */
async function sidewaysScroll(page) {
  return page.evaluate(() => {
    const w = window.innerWidth;
    return Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - w;
  });
}

/**
 * Every visible control on the page smaller than 44 by 44 CSS px, named. A link inside a run of text (display inline) is
 * the one exception, as in WCAG's target-size rule.
 */
async function smallTargets(page) {
  return page.evaluate(() => {
    const out = [];
    const sel =
      'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch]';
    for (const el of document.querySelectorAll(sel)) {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      if (el.tagName === 'A' && style.display === 'inline') continue;
      if (box.width < 44 || box.height < 44)
        out.push(
          `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`,
        );
    }
    return out;
  });
}

/**
 * The navigation fixed to the bottom of the phone's screen: a navigation landmark whose box ends at the bottom of the
 * viewport and stays there when the page scrolls. Returns its links' addresses, or null when there is none.
 */
async function bottomNavigation(page) {
  return page.evaluate(() => {
    const h = window.innerHeight;
    for (const nav of document.querySelectorAll('nav, [role=navigation]')) {
      const box = nav.getBoundingClientRect();
      const style = getComputedStyle(nav);
      if (box.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      if (!['fixed', 'sticky'].includes(style.position)) continue;
      if (Math.abs(box.bottom - h) > 1) continue;
      return [...nav.querySelectorAll('a[href]')].map((a) => new URL(a.href).pathname);
    }
    return null;
  });
}

test(`${J} #1 opens the dashboard on a phone: no sideways scroll, 44 px targets, bottom navigation for the main rooms`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const owner = await businessReadyPerson(page, 'mp');
  const merchantId = await openBusiness(page, owner);
  await verifiedBusiness(page, owner, merchantId);
  run.reset({ owner: saved(owner), merchantId });
  await page.setViewportSize(PHONE);
  const refused = refusedPayCalls(page);
  await signInOwner(page, '/pay/merchant');
  await expect(page.locator('main h1').first()).toBeVisible();
  await expect(page.locator('[data-slot="state-block"][data-kind="loading"]')).toHaveCount(0);

  // No sideways scroll: the page is no wider than the 375 px phone.
  expect(await sidewaysScroll(page), 'the dashboard is no wider than the phone').toBeLessThanOrEqual(0);
  // 44 px targets: every control on the dashboard is at least 44 by 44.
  expect(await smallTargets(page), 'every target on the dashboard is at least 44 px').toEqual([]);

  // Bottom navigation for the main rooms: fixed at the bottom of the screen, linking each main room.
  const links = await bottomNavigation(page);
  expect(links, 'a navigation fixed to the bottom of the phone screen').not.toBeNull();
  for (const room of MAIN_ROOMS) expect(links, `the bottom navigation reaches ${room}`).toContain(room);
  // It stays at the bottom when the page scrolls.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  expect(await bottomNavigation(page), 'the bottom navigation stays at the bottom after a scroll').not.toBeNull();

  // Each main room, opened from the bottom navigation, fits the phone and keeps the navigation.
  for (const room of MAIN_ROOMS.slice(1)) {
    await page.evaluate((href) => {
      const h = window.innerHeight;
      const nav = [...document.querySelectorAll('nav, [role=navigation]')].find(
        (n) => ['fixed', 'sticky'].includes(getComputedStyle(n).position) && Math.abs(n.getBoundingClientRect().bottom - h) <= 1,
      );
      [...nav.querySelectorAll('a[href]')].find((a) => new URL(a.href).pathname === href).click();
    }, room);
    await expect(page).toHaveURL(new RegExp(`${room.replace(/[/.]/g, '\\$&')}(\\?.*)?$`));
    await expect(page.locator('main h1').first(), room).toBeVisible();
    expect(await sidewaysScroll(page), `${room} is no wider than the phone`).toBeLessThanOrEqual(0);
    expect(await bottomNavigation(page), `${room} keeps the bottom navigation`).not.toBeNull();
  }
  expect(refused).toEqual([]);
});

/** The request id a create carries: the first string field named for a request, idempotency or refund key. */
function requestIdOf(body) {
  const seen = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && /^(requestId|idempotencyKey|refundId|clientRequestId)$/.test(k)) seen.push(x);
      else walk(x);
    }
  };
  walk(body);
  return seen[0];
}

/**
 * Loses the reply of the first create the page sends to `procedures`: the request reaches the service and is answered
 * there, and the page's connection is reset before the answer arrives. Every create sent (the lost one and any later)
 * is kept with its request id and the service's status.
 */
async function loseFirstReply(page, procedures) {
  const sent = [];
  let lost = false;
  await page.route(
    (url) => url.pathname.startsWith('/api/pay/trpc/') && procedures.some((p) => url.pathname.includes(p)),
    async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.continue();
      const body = request.postDataJSON();
      const res = await route.fetch();
      sent.push({ requestId: requestIdOf(body), status: res.status(), body: await res.json().catch(() => null) });
      if (!lost) {
        lost = true;
        return route.abort('connectionreset');
      }
      return route.fulfill({ response: res });
    },
  );
  return sent;
}

/**
 * What the step says after a lost reply: the page is reloaded and shows the stored request id; whatever it sends again
 * carries that id; and the service holds one object for it.
 */
async function recoversAfterReload(page, sent, { count, what }) {
  await expect.poll(() => sent.length, { message: `the ${what} create reached the service` }).toBeGreaterThan(0);
  const first = sent[0];
  expect(first.requestId, `the ${what} create carries a request id`).toBeTruthy();
  expect(first.status, `the service answered the lost ${what} create`).toBeLessThan(300);
  await page.reload();
  // The page shows it: the stored request id, read back after the reload.
  await expect(page.getByText(first.requestId, { exact: false }).first(), `the page shows the stored ${what} request id`).toBeVisible();
  // A reload reuses the stored request id: anything the page sends again names the same id, never a new one.
  for (const again of sent.slice(1)) expect(again.requestId, `a resent ${what} create reuses the stored id`).toBe(first.requestId);
  // One object each.
  await expect.poll(count, { message: `one ${what} on the service` }).toBe(1);
}

test(`${J} #2 creates a payment link, losing the reply: one link; a reload reuses the stored request id; the page shows it`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { merchantId, owner } = journey();
  await page.setViewportSize(PHONE);
  await signInOwner(page, '/pay/links/new');
  const label = `TEST phone link ${owner.handle}`;
  const sent = await loseFirstReply(page, ['merchant.createLink']);
  await page.getByLabel('Link label *').fill(label);
  await page.getByLabel('Fixed amount', { exact: true }).fill('12');
  await page.getByRole('button', { name: 'Create link' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create link' }).click();
  const api = await ownerApi();
  const links = async () => {
    const list = await api.query('merchant.listLinks', { merchantId });
    return (list.items ?? list).filter((l) => (l.label ?? l.name ?? JSON.stringify(l)).includes(label)).length;
  };
  await recoversAfterReload(page, sent, { count: links, what: 'payment link' });
});

test(`${J} #2 creates a refund, losing the reply: one refund; a reload reuses the stored request id; the page shows it`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { merchantId } = journey();
  const api = await ownerApi();
  const paid = await paidCardPayment(api, merchantId, { key: `${J}:refund-payment:${merchantId}`, amount: '25.00' });
  expect(paid.status, 'the TEST payment to refund is captured').toBe('captured');
  await page.setViewportSize(PHONE);
  await signInOwner(page, `/pay/refunds/new?payment=${paid.id}`);
  const sent = await loseFirstReply(page, ['payment.refund']);
  await page.getByLabel(/^Refund amount/).fill('5');
  await page.getByRole('button', { name: 'Review refund' }).click();
  await page.getByRole('button', { name: 'Confirm refund' }).click();
  const confirm = page.getByRole('dialog', { name: "Confirm it's you" });
  if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await confirm.getByLabel(/6-digit code/).fill(await ownerCode());
    await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  }
  const refunds = async () => (await api.query('payment.refunds.list', { merchantId, paymentId: paid.id, limit: 200 })).items.length;
  await recoversAfterReload(page, sent, { count: refunds, what: 'refund' });
});

test(`${J} #2 creates a payout, losing the reply: one payout; a reload reuses the stored request id; the page shows it`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { merchantId } = journey();
  const api = await ownerApi();
  // A posted TEST settlement to pay out: a paid TEST card payment, settled through the service for today's window.
  const paid = await paidCardPayment(api, merchantId, { key: `${J}:payout-payment:${merchantId}`, amount: '30.00' });
  expect(paid.status, 'the TEST payment to settle is captured').toBe('captured');
  const posted = await api.mutate('settlement.run', { merchantId, window: new Date().toISOString().slice(0, 10), assetId: 'USDT' });
  expect(posted.status, 'the TEST settlement is posted').toBe('posted');
  run.write({ settlement: posted.id });

  await page.setViewportSize(PHONE);
  // A destination to pay out to, saved by the owner with a fresh authenticator code.
  await signInOwner(page, '/pay/onboarding/go-live');
  const wallet = page.getByLabel('Wallet address *');
  if (await wallet.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await wallet.fill(`0x${'38'.repeat(20)}`);
    await page.getByRole('button', { name: 'Save destination' }).click();
    const save = page.getByRole('dialog');
    await save.getByLabel('6-digit code from your authenticator app *').fill(await ownerCode());
    await save.getByRole('button', { name: 'Save destination' }).click();
    await expect(page.getByText('Destination saved.', { exact: true })).toBeVisible();
  }

  await page.goto(`/pay/payouts/new?settlement=${posted.id}`);
  const sent = await loseFirstReply(page, ['settlement.payout', 'merchantControl.approvals.request']);
  await page.getByRole('button', { name: 'Pay out', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: "Confirm it's you" });
  await confirm.getByLabel('6-digit code from your authenticator app').fill(await ownerCode());
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review: Pay out' }).getByRole('button', { name: 'Pay out', exact: true }).click();
  const payouts = async () => {
    const list = await api.query('merchantControl.approvals.list', { merchantId });
    const asked = (list.items ?? list).filter((a) => JSON.stringify(a).includes(posted.id)).length;
    const record = await api.query('settlement.get', { settlementId: posted.id });
    return asked + (record.payoutId ? 1 : 0) - (asked && record.payoutId ? 1 : 0);
  };
  await recoversAfterReload(page, sent, { count: payouts, what: 'payout' });
});

test(`${J} #2 creates a subscription, losing the reply: one subscription; a reload reuses the stored request id; the page shows it`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { merchantId, owner } = journey();
  await page.setViewportSize(PHONE);
  const customer = `TEST-phone-customer-${owner.handle}`;
  // A customer mandate to subscribe on, recorded by the owner on the subscription form.
  await signInOwner(page, '/pay/subscriptions/new');
  await page.getByRole('button', { name: /Record a mandate/ }).click();
  await page.getByLabel('Customer reference *').fill(customer);
  await page.getByLabel('Maximum per charge *').fill('5');
  await page.getByRole('button', { name: 'Save mandate' }).click();
  const mandate = page.getByLabel('Active customer mandate *');
  await expect(mandate.locator('option', { hasText: customer })).toHaveCount(1);
  await mandate.selectOption(await mandate.locator('option', { hasText: customer }).getAttribute('value'));
  const sent = await loseFirstReply(page, ['subscription.create']);
  await page.getByRole('button', { name: 'Create subscription' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create subscription' }).click();
  const api = await ownerApi();
  const subs = async () => {
    const list = await api.query('subscription.list', { merchantId });
    return (list.items ?? list).filter((s) => JSON.stringify(s).includes(customer)).length;
  };
  await recoversAfterReload(page, sent, { count: subs, what: 'subscription' });
});

test(`${J} #3 the suite runs on the stack: zero console errors, a screenshot per area, every ledger-touching path reconciles`, async ({
  page,
}, info) => {
  test.setTimeout(300_000);
  const { merchantId } = journey();
  await page.setViewportSize(PHONE);
  const errors = [];
  page.on('console', (msg) => msg.type() === 'error' && errors.push(`${page.url()}: ${msg.text()}`));
  page.on('pageerror', (err) => errors.push(`${page.url()}: ${err.message}`));
  await signInOwner(page, '/pay/merchant');

  // A screenshot per area: each of the five areas, with every room under it opened on the phone.
  const areas = await page
    .getByTestId('plo-tabs')
    .locator('a')
    .evaluateAll((as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href')]));
  expect(areas.length, 'the portal shows its five areas').toBe(5);
  for (const [area, href] of areas) {
    await page.goto(href);
    await expect(page.locator('main h1').first(), area).toBeVisible();
    await expect(page.locator('[data-slot="state-block"][data-kind="loading"]'), `${area} finishes loading`).toHaveCount(0);
    const rooms = await page.locator('.plo-subtabs a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    for (const room of rooms) {
      await page.goto(room);
      await expect(page.locator('main h1').first(), room).toBeVisible();
      await expect(page.locator('[data-slot="state-block"][data-kind="loading"]'), `${room} finishes loading`).toHaveCount(0);
    }
    await page.goto(href);
    await expect(page.locator('main h1').first(), area).toBeVisible();
    const shot = await page.screenshot({ fullPage: true });
    await info.attach(`${J} area ${area}`, { body: shot, contentType: 'image/png' });
  }
  expect(info.attachments.filter((a) => a.name.startsWith(`${J} area `)).length, 'a screenshot per area').toBe(areas.length);
  expect(errors, 'zero console errors').toEqual([]);

  // Every ledger-touching path reconciles: balance before, action, balance after, to the exact amount.
  const api = await ownerApi();
  // A payment: captured, clearing grows by its amount and available is unchanged.
  let before = await balanceOf(api, merchantId);
  const paid = await paidCardPayment(api, merchantId, { key: `${J}:reconcile-payment:${merchantId}:${Date.now()}`, amount: '40.00' });
  expect(paid.status).toBe('captured');
  await expect
    .poll(async () => (await balanceOf(api, merchantId)).clearing - before.clearing, { message: 'a payment adds its amount to clearing' })
    .toBe(units('40'));
  let after = await balanceOf(api, merchantId);
  expect(after.available, 'a payment leaves available unchanged').toBe(before.available);

  // A refund: clearing falls by the refunded amount exactly.
  before = after;
  const refunder = await api.steppedUp(merchantId, ['pay:refund'], await ownerCode());
  await refunder.mutate('payment.refund', { paymentId: paid.id, amount: '15.00', refundId: `${J}:reconcile-refund:${paid.id}` });
  await expect
    .poll(async () => before.clearing - (await balanceOf(api, merchantId)).clearing, { message: 'a refund takes its amount from clearing' })
    .toBe(units('15'));
  after = await balanceOf(api, merchantId);
  expect(after.available, 'a refund of clearing money leaves available unchanged').toBe(before.available);

  // A settlement: clearing falls by its gross and available rises by its net, both as the settlement records them.
  before = after;
  const posted = await api.mutate('settlement.run', { merchantId, window: new Date().toISOString().slice(0, 10), assetId: 'USDT' });
  expect(posted.status).toBe('posted');
  after = await balanceOf(api, merchantId);
  expect(before.clearing - after.clearing, 'a settlement takes its gross from clearing').toBe(units(posted.gross));
  expect(after.available - before.available, 'a settlement adds its net to available').toBe(units(posted.net));

  // A payout: available falls by the settlement's net exactly.
  before = after;
  const payer = await api.steppedUp(merchantId, ['pay:payout'], await ownerCode());
  await payer.mutate('settlement.payout', { settlementId: posted.id, railId: 'crypto-native' });
  await expect
    .poll(async () => before.available - (await balanceOf(api, merchantId)).available, { message: 'a payout takes its net from available' })
    .toBe(units(posted.net));
  expect((await balanceOf(api, merchantId)).clearing, 'a payout leaves clearing unchanged').toBe(before.clearing);
});
