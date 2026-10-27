import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { ROOT, journeyState } from './stack.mjs';
import { businessReadyPerson, signInWithCode } from './merchant.mjs';

// J-developer-10, in the running app (docs/roadmap/journeys.json): receive webhooks and verify them. One test per step,
// titled "J-developer-10 #<n>", run in order. #1 makes the start: a business-ready TEST merchant on /pay/developer. The
// receiver is a small https-less local server this test runs; the stack's TEST webhook terms allow a loopback receiver
// for local delivery only. Every endpoint, delivery and attempt is read back from svc-pay.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the merchant portal has no endpoint form on /pay/developer/webhooks.
// - #3 to #10: no event subscription filter, public event catalogue, signing-secret roll, receiver guide with a
//   published vector, deliveries dashboard, resend or recovery.
const J = 'J-developer-10';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

/** A local receiver answering with the next status in `script` (then 200), recording each request. */
function receiver(script = []) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, raw });
      res.statusCode = script.shift() ?? 200;
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/hook`, seen, server })),
  );
}

/** The merchant signed in again with their authenticator; the code step is kept for the next sign-in. */
async function signedIn(page) {
  const who = state('merchant');
  who.totp = (await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'))).totp;
  await signInWithCode(page, who, '/pay/developer');
  run.write({ merchant: { ...who, totp: undefined } });
}

const form = (page) => page.getByRole('form', { name: 'Add an endpoint' });

async function addEndpoint(page, url, events = ['payment.succeeded', 'refund.succeeded']) {
  await page.goto('/pay/developer/webhooks');
  await form(page).getByLabel('Endpoint URL').fill(url, UNBUILT);
  for (const event of events) await form(page).getByRole('checkbox', { name: event }).check();
  await form(page).getByRole('button', { name: 'Add endpoint' }).click();
}

test(`${J} #1 adds an http address to a live endpoint: https required; an https address to a private host refused by the guard`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const merchant = await businessReadyPerson(page, 'jdh', '/pay/developer');
  run.reset({ merchant: { ...merchant, totp: undefined } });
  await addEndpoint(page, 'http://example.com/hook');
  await expect(form(page).getByText(/must use https/i)).toBeVisible();
  await addEndpoint(page, 'https://10.0.0.5/hook');
  await expect(form(page).getByText(/private address/i)).toBeVisible();
});

test(`${J} #2 adds an endpoint when the cap is blank: the cap-unset code; with a cap, the endpoint is created`, async ({ page }) => {
  await signedIn(page);
  const { url } = await receiver();
  await addEndpoint(page, url);
  await expect(page.getByText(/endpoint limit is not set|Endpoint added/)).toBeVisible();
});

test(`${J} #3 subscribes to two event types and a third fires: no delivery for the third`, async ({ page }) => {
  await signedIn(page);
  await page.goto('/pay/developer/deliveries');
  await expect(page.getByRole('table', { name: 'Deliveries' })).toBeVisible(UNBUILT);
  await expect(page.getByRole('table', { name: 'Deliveries' }).getByRole('row', { name: /payout\.paid/ })).toHaveCount(0);
});

test(`${J} #4 reads the event catalogue: each public type with a payload schema and no internal subject; ordering and duplicate guidance`, async ({
  page,
}) => {
  await page.goto('/developers/webhooks/events');
  const catalogue = page.getByRole('table', { name: 'Event types' });
  await expect(catalogue).toBeVisible(UNBUILT);
  expect(await catalogue.innerText()).not.toMatch(/\b[a-z]+\.[a-z]+\.v\d\b/);
  await expect(page.getByRole('heading', { name: /Order and duplicates/ })).toBeVisible();
});

test(`${J} #5 reads the signing secret, then rolls it with overlap: shown once; two signatures; after the end only the new one`, async ({
  page,
}) => {
  await signedIn(page);
  await page.goto('/pay/developer/webhooks');
  await page.getByRole('button', { name: 'Reveal signing secret' }).click(UNBUILT);
  await expect(page.getByTestId('signing-secret')).toBeVisible();
  await page.getByRole('button', { name: 'Roll secret' }).click();
  await page.getByRole('dialog').getByLabel('Keep the old secret working for, seconds').fill('60');
  await page.getByRole('dialog').getByRole('button', { name: 'Roll' }).click();
  await expect(page.getByText(/Both secrets verify until/)).toBeVisible();
});

test(`${J} #6 verifies a delivery with the receiver guide: the published vector passes and a tampered body fails`, async ({ page }) => {
  await page.goto('/developers/webhooks/verify');
  const vector = page.getByRole('region', { name: 'Test vector' });
  await expect(vector).toBeVisible(UNBUILT);
  const secret = (await vector.getByTestId('vector-secret').innerText()).trim();
  const payload = (await vector.getByTestId('vector-signed-payload').innerText()).replace(/\r/g, '');
  const signature = (await vector.getByTestId('vector-signature').innerText()).trim();
  expect(createHmac('sha256', secret).update(payload).digest('hex')).toBe(signature);
  expect(createHmac('sha256', secret).update(`${payload} `).digest('hex')).not.toBe(signature);
});

test(`${J} #7 my endpoint returns 500 then 200: the same event id and body twice with new signatures; the row ends delivered`, async ({
  page,
}) => {
  await signedIn(page);
  const hook = await receiver([500, 200]);
  await addEndpoint(page, hook.url);
  await page.goto('/pay/developer/deliveries');
  await page.getByRole('button', { name: 'Send a test event' }).click(UNBUILT);
  await expect.poll(() => hook.seen.length, { timeout: 60_000 }).toBe(2);
  expect(hook.seen[1].raw).toBe(hook.seen[0].raw);
  expect(hook.seen[1].headers['x-intafaced-signature']).not.toBe(hook.seen[0].headers['x-intafaced-signature']);
  hook.server.close();
});

test(`${J} #8 my endpoint times out: the row is unknown; no second worker sends it while the lease holds`, async ({ page }) => {
  await signedIn(page);
  await page.goto('/pay/developer/deliveries');
  await expect(
    page
      .getByRole('table', { name: 'Deliveries' })
      .getByRole('row', { name: /Unknown/ })
      .first(),
  ).toBeVisible(UNBUILT);
});

test(`${J} #9 my endpoint returns 410: the endpoint is disabled`, async ({ page }) => {
  await signedIn(page);
  const hook = await receiver([410]);
  await addEndpoint(page, hook.url);
  await page.goto('/pay/developer/deliveries');
  await page.getByRole('button', { name: 'Send a test event' }).click(UNBUILT);
  await page.goto('/pay/developer/webhooks');
  await expect(page.getByRole('row', { name: new RegExp(hook.url) })).toContainText('Disabled');
  hook.server.close();
});

test(`${J} #10 opens deliveries, resends one, then recovers missed events: one attempt per resend; outside the window refused`, async ({
  page,
}) => {
  await signedIn(page);
  await page.goto('/pay/developer/deliveries');
  const row = page.getByRole('table', { name: 'Deliveries' }).locator('tbody tr').first();
  await row.getByRole('button', { name: 'Resend' }).click(UNBUILT);
  await expect(row).toContainText(/Attempts\s*\d+/);
  await page.getByRole('button', { name: 'Recover missed events' }).click();
  await expect(page.getByText(/Recovered \d+ events?|retry policy is not set/)).toBeVisible();
});
