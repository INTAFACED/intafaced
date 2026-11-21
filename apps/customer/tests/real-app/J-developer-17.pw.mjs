// World: book
import { createHash } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ADMIN } from './admin.mjs';
import { userIdOf } from './copy.mjs';
import { codeOf, holderAgain, keyHolder, makeKey, withKey } from './developer.mjs';
import { staffSignIn } from './staff.mjs';
import { tool } from './stack.mjs';

// J-developer-17, in the running app (docs/roadmap/journeys.json): a support agent helps a developer who says the API is
// failing. Starts signed in to the founder console as the stack's TEST support staff member; a customer gives a request id.
// The agent finds the call by its request id on the customer's record (Developer API tab): its metadata and the typed error
// code, never a secret or a body; another account's request id is not found. They read the customer's keys (no secret, no
// hash), the key's call log (status and request id rows, the calls from outside its IP list flagged), find the
// account-restricted reason the API returned, and point the customer to the error catalogue and the developer support page,
// which lists the contacts and what to send, says "contact not set" for a blank one, and whose request form still works.
// Moves no money. Tests titled "J-developer-17 #<n>" prove a whole step.
const J = 'J-developer-17';
const RUN = Date.now().toString(36);
/** The stack's TEST trading restriction reason (tooling/profiles/test-owner-values/identity.json). */
const RESTRICTION_REASON = 'market_conduct_review';
/** An address the journey's calls never come from, so a key limited to it is called from outside its IP list. */
const ELSEWHERE = '192.0.2.17';

test.describe.configure({ mode: 'serial' });

/** The customer, their keys and their calls, made once and read by every step. */
let world = null;
const restricted = new Set();

test.afterAll(async () => {
  test.setTimeout(300_000);
  // Leave no journey account restricted, whatever happened.
  for (const handle of restricted) {
    try {
      tool('local-test-gates.mjs', 'trading-restrict', handle, 'restore');
    } catch {
      // Already lifted.
    }
  }
  await world?.holder.page.context().close();
});

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const requestIdOf = (reply) => {
  const id = reply.headers.get('x-request-id');
  expect(id, 'every reply names its request id').toBeTruthy();
  return id;
};

/**
 * A verified TEST customer with two keys made in the app: `open` (no IP list) and `fenced` (limited to an address the calls
 * never come from). `open` reads the balance (a 200); `fenced` is refused at the front door from outside its list. A second
 * customer's own call gives a request id that is not the first customer's.
 */
async function customerWorld(browser) {
  if (world) return world;
  const holder = await keyHolder(browser, `dev17${RUN}`);
  const open = await makeKey(holder.page, { name: `dev17-open-${RUN}`, preset: 'Trade' });
  const fenced = await makeKey(holder.page, { name: `dev17-fenced-${RUN}`, preset: 'Trade', ips: ELSEWHERE });
  const ok = await withKey(open, { path: '/api/v1/account/balance' });
  expect(ok.status, JSON.stringify(ok.body).slice(0, 300)).toBe(200);
  const outside = await withKey(fenced, { path: '/api/v1/account/balance' });
  // The front door refuses the key from outside its list as a denied key; the same read with the open key just passed.
  expect([401, 403], JSON.stringify(outside.body).slice(0, 300)).toContain(outside.status);
  const outsideCode = codeOf(outside.body);
  expect(outsideCode, 'the front door names its refusal').toMatch(/^[a-z]+\.[a-z_.]+$/);

  const stranger = await keyHolder(browser, `dev17x${RUN}`);
  const strangerKey = await makeKey(stranger.page, { name: `dev17-x-${RUN}`, preset: 'Trade' });
  const strangerCall = await withKey(strangerKey, { path: '/api/v1/account/balance' });
  await stranger.page.context().close();

  world = {
    holder,
    userId: await userIdOf(holder.who),
    keys: { open, fenced },
    calls: {
      ok: { requestId: requestIdOf(ok), body: ok.body },
      outside: { requestId: requestIdOf(outside), code: outsideCode, status: outside.status },
      stranger: requestIdOf(strangerCall),
    },
  };
  return world;
}

/** The support agent on the customer's Developer API tab, narrowed to `requestId` when given. */
async function supportOn(browser, userId, requestId) {
  const page = await (await browser.newContext()).newPage();
  await staffSignIn(page, browser, 'support');
  await openDeveloperTab(page, userId, requestId);
  return page;
}

async function openDeveloperTab(page, userId, requestId) {
  await page.goto(`${ADMIN}/accounts/${userId}?tab=developer`, { waitUntil: 'load' });
  await expect(page.getByTestId('customer-panel-developer')).toBeVisible({ timeout: 60_000 });
  if (requestId === undefined) return;
  // The search box, as the agent types the id the customer read out.
  const search = page.getByTestId('request-id-search');
  await search.getByLabel('Request id', { exact: true }).fill(requestId);
  await search.getByRole('button', { name: 'Find the call', exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get('requestId') === requestId);
  await expect(
    page
      .getByTestId('read-identity.developer-calls')
      .getByText(/As of /)
      .first(),
  ).toBeVisible({ timeout: 60_000 });
}

/** Nothing secret is anywhere on the page the console served: no key, no key hash, no signing secret field. */
async function expectNoSecret(page, keys) {
  const html = await page.content();
  for (const key of keys) {
    expect(html).not.toContain(key);
    expect(html).not.toContain(sha256(key));
  }
  expect(html).not.toMatch(/signingSecret|keyHash|key_hash/);
}

const callRow = (page, requestId) => page.getByTestId('read-identity.developer-calls').getByRole('row').filter({ hasText: requestId });

test(`${J} #1 searches the request id: metadata and the typed error only, no secret or body; another account's id is not found`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const w = await customerWorld(browser);
  const page = await supportOn(browser, w.userId, w.calls.outside.requestId);
  try {
    const calls = page.getByTestId('read-identity.developer-calls');
    await expect(calls.getByTestId('read-failed')).toHaveCount(0);
    // Exactly the one call, with its metadata and the code the reply carried.
    const row = callRow(page, w.calls.outside.requestId);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('GET');
    await expect(row).toContainText('/api/v1/account/balance');
    await expect(row).toContainText(String(w.calls.outside.status));
    await expect(row).toContainText(w.calls.outside.code);
    await expect(calls.getByRole('row').filter({ hasText: w.calls.ok.requestId })).toHaveCount(0);
    // No secret and no body: not the key, its hash or a signing secret, and not one value of the reply's body.
    await expectNoSecret(page, Object.values(w.keys));
    const html = await page.content();
    expect(html).not.toContain(JSON.stringify(w.calls.ok.body).slice(0, 40));

    // Another account's request id: not found on this customer, said in words.
    await openDeveloperTab(page, w.userId, w.calls.stranger);
    const refused = calls.getByTestId('read-failed');
    await expect(refused).toContainText('Not found: no call by this account’s keys has this request id');
    await expect(refused).toContainText('identity.developer_request_not_found');
    await expect(calls.getByRole('row').filter({ hasText: w.calls.stranger })).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

test(`${J} #2 opens the customer's key list: no secret and no hash anywhere in the reply`, async ({ browser }) => {
  test.setTimeout(300_000);
  const w = await customerWorld(browser);
  const agent = await (await browser.newContext()).newPage();
  try {
    await staffSignIn(agent, browser, 'support');
    // The console's own reply for the tab, as it reached the browser.
    const reply = await agent.goto(`${ADMIN}/accounts/${w.userId}?tab=developer`, { waitUntil: 'load' });
    expect(reply?.status()).toBe(200);
    const keys = agent.getByTestId('read-identity.developer-keys');
    await expect(keys.getByText(/As of /).first()).toBeVisible({ timeout: 60_000 });
    await expect(keys.getByTestId('read-failed')).toHaveCount(0);
    for (const name of [`dev17-open-${RUN}`, `dev17-fenced-${RUN}`])
      await expect(keys.getByRole('row').filter({ hasText: name })).toHaveCount(1);
    // Each key shows its prefix: the first characters only, never the whole key.
    for (const key of Object.values(w.keys)) await expect(keys).not.toContainText(key);
    const body = await reply.text();
    for (const key of Object.values(w.keys)) {
      expect(body).not.toContain(key);
      expect(body).not.toContain(sha256(key));
    }
    expect(body).not.toMatch(/signingSecret|keyHash|key_hash/);
    await expectNoSecret(agent, Object.values(w.keys));
  } finally {
    await agent.context().close();
  }
});

test(`${J} #3 reads the key's call log: status and request id rows, the out-of-IP call flagged`, async ({ browser }) => {
  test.setTimeout(300_000);
  const w = await customerWorld(browser);
  const page = await supportOn(browser, w.userId);
  try {
    const calls = page.getByTestId('read-identity.developer-calls');
    await expect(calls.getByText(/As of /).first()).toBeVisible({ timeout: 60_000 });
    await expect(calls.getByTestId('read-failed')).toHaveCount(0);
    const ok = callRow(page, w.calls.ok.requestId);
    const outside = callRow(page, w.calls.outside.requestId);
    await expect(ok).toContainText('200');
    await expect(ok).toContainText(`dev17-open-${RUN}`);
    await expect(outside).toContainText(String(w.calls.outside.status));
    await expect(outside).toContainText(`dev17-fenced-${RUN}`);
    // The flag column: the call from outside the key's IP list says so; the open key's call does not.
    const flagColumn = await calls.getByRole('columnheader').allInnerTexts();
    const at = flagColumn.findIndex((text) => text.trim() === 'Outside IP list');
    expect(at, 'the log has an outside-IP column').toBeGreaterThanOrEqual(0);
    await expect(outside.getByRole('cell').nth(at)).toHaveText('yes');
    await expect(ok.getByRole('cell').nth(at)).toHaveText('no');
    await expectNoSecret(page, Object.values(w.keys));
  } finally {
    await page.context().close();
  }
});

test(`${J} #4 finds an account-restricted reason: the reason code the API returned`, async ({ browser }) => {
  test.setTimeout(300_000);
  const w = await customerWorld(browser);
  // Staff restrict the customer's trading with the TEST reason, through identity's own two-person door.
  expect(tool('local-test-gates.mjs', 'trading-restrict', w.holder.who.handle, 'restrict', RESTRICTION_REASON)).toMatch(
    /OK .* trading restrict: changed/,
  );
  restricted.add(w.holder.who.handle);
  // The customer's program then places an order, and the API refuses it with the restriction's code.
  const order = await withKey(w.keys.open, {
    method: 'POST',
    path: '/api/v1/orders',
    body: { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '0.0001', price: '1', clientOrderId: `dev17-${RUN}` },
  });
  expect(order.status, JSON.stringify(order.body).slice(0, 300)).toBe(403);
  const returned = order.body?.intafacedCode ?? codeOf(order.body);
  expect(returned).toBe('trade.account_restricted');
  const requestId = requestIdOf(order);

  const page = await supportOn(browser, w.userId, requestId);
  try {
    const row = callRow(page, requestId);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('POST');
    await expect(row).toContainText('/api/v1/orders');
    await expect(row).toContainText('403');
    // The reason code exactly as the API returned it to the customer.
    await expect(row).toContainText(returned);
    await expectNoSecret(page, Object.values(w.keys));
  } finally {
    await page.context().close();
  }
  tool('local-test-gates.mjs', 'trading-restrict', w.holder.who.handle, 'restore');
  restricted.delete(w.holder.who.handle);
});

test(`${J} #5 points the customer to the catalogue and the support route: contacts and what to send; blank contacts say contact not set and the ticket form still works`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const w = await customerWorld(browser);
  // The customer opens the page the agent pointed them to, signed in.
  const page = await holderAgain(browser, w.holder.who);
  try {
    await page.goto('/developers/support');
    const main = page.locator('main');
    await expect(main.getByRole('heading', { level: 1, name: 'Developer support', exact: true })).toBeVisible();
    // The catalogue first: the error pages the agent points to.
    const catalogue = main.getByTestId('developers-support-catalogue');
    await expect(catalogue.getByRole('link', { name: 'Error codes and what to do about each', exact: true })).toHaveAttribute(
      'href',
      '/developers/errors',
    );
    await expect(catalogue.getByRole('link', { name: 'Authentication and permission errors', exact: true })).toHaveAttribute(
      'href',
      '/developers/errors/auth',
    );
    // What to send: the request id, the call, the address, the headers without secrets; never a whole key.
    const send = main.getByTestId('developers-support-send');
    await expect(send).toContainText('The request id');
    await expect(send).toContainText('x-request-id');
    await expect(send).toContainText('The IP address you called from');
    await expect(send).toContainText('without their values for authorization');
    await expect(send.getByTestId('developers-support-never')).toContainText('Never send a whole API key or its signing secret');

    // The contacts: each one is the owner's value, or "contact not set". The stack sets none, so all three are blank.
    const contacts = main.getByTestId('developers-support-contacts');
    for (const id of ['email', 'phone', 'chat-hours']) {
      const row = contacts.getByTestId(`developers-support-contact-${id}`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      const state = await row.getAttribute('data-state');
      if (state === 'unset') await expect(row).toContainText('contact not set');
      else expect(state).toBe('set');
    }
    const blank = contacts.locator('[data-state="unset"]');
    await expect(blank.first(), 'the TEST stack leaves at least one contact blank').toBeVisible();

    // The request form still works with contacts blank: it opens from the page and a request is sent with the request id.
    await main.getByTestId('developers-support-ticket').getByRole('link', { name: 'Open a request form', exact: true }).click();
    await expect(page).toHaveURL(/\/support\/new\?subject=/);
    const subject = page.getByLabel('Subject', { exact: true });
    await expect(subject).toHaveValue(/^API problem: request id/);
    await subject.fill(`API problem: request id ${w.calls.outside.requestId}`);
    await page
      .getByLabel('What happened', { exact: true })
      .fill(`TEST ${J} ${RUN}: my key is refused. Request id ${w.calls.outside.requestId}.`);
    await page.getByRole('button', { name: 'Send request', exact: true }).click();
    // Sent: the request's own page, carrying the request id the customer gave.
    await expect(page).toHaveURL(/\/support\/tickets\/[0-9a-f-]+$/, { timeout: 30_000 });
    await expect(page.getByText(w.calls.outside.requestId).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await page.context().close();
  }
});
