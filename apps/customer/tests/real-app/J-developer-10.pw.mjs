// World: restart, stack
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { test, expect } from './journey.mjs';
import { signUp, verify } from './desk.mjs';
import { addAuthenticator, forgetSession } from './identity-factors.mjs';
import { openBusiness, paidCardPayment, payApiOf, signInWithCode, verifiedBusiness } from './merchant.mjs';
import { ORIGIN, ROOT, restartWith, restartWithSetting } from './stack.mjs';
import path from 'node:path';

// J-developer-10, in the running app (docs/roadmap/journeys.json): receive webhooks and verify them. One test per step,
// titled "J-developer-10 #<n>", run in order on one TEST business in one browser. Money: none moves here; the TEST card
// payments only make events.
//
// The receiver is this test's own TEST server on the stack's machine (127.0.0.1:14591). The stack has no TLS certificate
// the delivery worker would trust, so the person's live endpoint is that server over http on loopback, the dev/test
// hatch the URL guard keeps for loopback only (services/svc-pay/src/webhook-url-guard.ts); every other http address is
// refused, which #1 shows. Each kind of receiver is one path: `/live/` and `/sub/` take everything, `/flaky/` refuses the
// first copy of each event with 500, `/hang/` never answers, `/gone/` answers 410, `/down/` answers 503 until #10 lets it
// up. svc-pay's drain runs every 15 s, holds a claimed row for 60 s and gives a receiver 10 s (merchant-webhooks.ts).
// The owner's blank values are seen by restarting svc-pay with one LOCAL TEST value off (tooling/scripts/
// local-stack-services/pay.mjs), and each restart is undone in a finally.
const J = 'J-developer-10';
const WEBHOOKS = '/pay/developer/webhooks';
const DELIVERIES = '/pay/developer/deliveries';
const DOCS = '/pay/developer/docs';
const HOOK_PORT = 14591;
const HOOK = `http://127.0.0.1:${HOOK_PORT}`;
const DRAIN_MS = 15_000;
const LEASE_MS = 60_000;
const RUN = Date.now().toString(36);

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 15_000 });

/** @type {import('@playwright/test').Page} */
let page;
let who;
let merchantId = '';
let hook;
/** Every request the TEST receiver took: its kind (first path segment), when, the headers and the raw body. */
const posts = [];
let downIsUp = false;
const flakySeen = new Set();
/** The endpoints this file made, by kind: { id, secret }. */
const endpoints = {};

test.beforeAll(async ({ browser }) => {
  test.setTimeout(480_000);
  hook = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const kind = (req.url ?? '').split('/')[1] ?? '';
      const eventId = String(req.headers['x-intafaced-event-id'] ?? '');
      posts.push({ kind, path: req.url, at: Date.now(), headers: req.headers, raw: Buffer.concat(chunks).toString('utf8'), eventId });
      // Never answers: the worker's own timeout ends the attempt.
      if (kind === 'hang') return;
      let status = 200;
      if (kind === 'flaky') {
        status = flakySeen.has(eventId) ? 200 : 500;
        flakySeen.add(eventId);
      }
      if (kind === 'gone') status = 410;
      if (kind === 'down' && !downIsUp) status = 503;
      res.statusCode = status;
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    hook.once('error', reject);
    hook.listen(HOOK_PORT, '127.0.0.1', resolve);
  });
  // An approved TEST business (as J-merchant-02 sets one up): opening it needs a second factor, and the owner signs in
  // again after approval for the pay grant.
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  who = await signUp(page, 'jd10');
  await verify(page, who);
  await signInWithCode(page, who, '/uc/safe');
  const { secret, step } = await addAuthenticator(page, totp);
  Object.assign(who, { totp, secret, step });
  await forgetSession(page);
  await signInWithCode(page, who, '/pay/merchant');
  merchantId = await openBusiness(page, who, 'TEST Webhook Receiver Ltd');
  await verifiedBusiness(page, who, merchantId);
  await forgetSession(page);
  await signInWithCode(page, who, WEBHOOKS);
  // The journey's start: a live endpoint at the person's receiver, taking captured payments.
  endpoints.live = await addEndpoint('live', ['payment.captured']);
});

test.afterAll(async () => {
  await page?.context().close();
  hook?.closeAllConnections?.();
  await new Promise((resolve) => (hook ? hook.close(() => resolve()) : resolve()));
});

let pay = null;
let payAt = 0;
/** The person's own pay API through Edge, signed in again every few minutes so a long step never holds a stale token. */
async function payApi() {
  if (!pay || Date.now() - payAt > 4 * 60_000) {
    pay = await payApiOf(who, (next) => {
      who.step = next;
    });
    payAt = Date.now();
  }
  return pay;
}
const hooks = async (procedure, input) => (await payApi()).mutate(`merchantOps.webhooks.${procedure}`, input);
const hooksRead = async (procedure, input = {}) => (await payApi()).query(`merchantOps.webhooks.${procedure}`, input);
/** The service's refusal of `call`, as { status, body } (the whole body, with its typed code). */
async function refusal(call) {
  try {
    await call();
  } catch (error) {
    if (error.status) return { status: error.status, body: String(error.body) };
    throw error;
  }
  throw new Error('the call was expected to be refused, and it was not');
}
const sign = (secret, timestamp, raw) => createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');

async function addEndpoint(kind, eventTypes) {
  const made = await hooks('create', { url: `${HOOK}/${kind}/${RUN}`, eventTypes });
  expect(made.secret, `the ${kind} endpoint's secret, shown on create`).toMatch(/^[0-9a-f]{64}$/);
  return { id: made.endpoint.id, secret: made.secret };
}
const deliveriesOf = async (endpointId) => (await hooksRead('deliveries.list', { limit: 50, endpointId })).items;
const attemptsOf = async (deliveryId) => (await hooksRead('deliveries.attempts', { deliveryId })).attempts;
const endpointRow = async (endpointId) => (await hooksRead('list', { limit: 50 })).items.find((e) => e.id === endpointId);
const postsTo = (kind, paymentId) => posts.filter((p) => p.kind === kind && (!paymentId || p.eventId.endsWith(`:${paymentId}`)));

/** A TEST card payment, authorised then captured: two events. */
async function payment(tag) {
  const paid = await paidCardPayment(await payApi(), merchantId, { key: `${J}:${tag}:${merchantId}`, amount: '10.00' });
  expect(paid.status, `the TEST payment for ${tag} was captured`).toBe('captured');
  return paid.id;
}

/** svc-pay restarted with one LOCAL TEST webhook value blank, `run`, then put back. */
async function withPayValueOff(envKey, run) {
  restartWith('pay', envKey, false);
  try {
    await run();
  } finally {
    restartWith('pay', envKey, true);
  }
}

test(`${J} #1 adds an http address to a live endpoint: https-required; an https name resolving to a private address is refused by the URL guard`, async () => {
  // The page says it at once and will not send it.
  await page.goto(WEBHOOKS);
  const add = page.locator('#add');
  await add.getByLabel('Endpoint address').fill('http://receiver.example.com/hook');
  await expect(add.getByText('Use https:// so events cannot be read in transit.')).toBeVisible();
  await expect(add.getByRole('button', { name: 'Add endpoint' })).toBeDisabled();
  // The service refuses it by its code: as a new endpoint, and as the live endpoint's new address.
  const created = await refusal(() => hooks('create', { url: 'http://receiver.example.com/hook', eventTypes: ['payment.captured'] }));
  expect(created.status).toBe(400);
  expect(created.body).toContain('pay.webhook_url_https_required');
  const changed = await refusal(() => hooks('update', { endpointId: endpoints.live.id, url: 'http://receiver.example.com/hook' }));
  expect(changed.body).toContain('pay.webhook_url_https_required');
  expect((await endpointRow(endpoints.live.id)).url, 'the live endpoint keeps its address').toBe(`${HOOK}/live/${RUN}`);

  // An https name whose DNS answer is private (the stack's LOCAL TEST DNS: private-receiver.example.com is 10.20.30.40).
  const privateName = 'https://private-receiver.example.com/hook';
  const guarded = await refusal(() => hooks('create', { url: privateName, eventTypes: ['payment.captured'] }));
  expect(guarded.status).toBe(400);
  expect(guarded.body).toContain('pay.webhook_url_private');
  await add.getByLabel('Endpoint address').fill(privateName);
  await add.getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add endpoint' }).click();
  await expect(page.getByText('its name leads to a private address')).toBeVisible();
  const listed = (await hooksRead('list', { limit: 50 })).items.map((e) => e.url);
  expect(
    listed.filter((u) => u.includes('receiver.example.com')),
    'neither refused address was written',
  ).toEqual([]);
});

test(`${J} #2 adds an endpoint when the cap is blank: cap-unset; with a cap the endpoint is created`, async () => {
  test.setTimeout(300_000);
  await withPayValueOff('LOCAL_STACK_PAY_WEBHOOK_CAP', async () => {
    await page.goto(WEBHOOKS);
    await expect(page.getByTestId('webhook-cap-unset')).toHaveText(
      'INTAFACED has not set how many endpoints a business may have, so none can be added yet.',
    );
    const refused = await refusal(() =>
      hooks('create', { url: 'https://receiver-jd10.example.com/hook', eventTypes: ['payment.captured'] }),
    );
    expect(refused.status).toBe(412);
    expect(refused.body).toContain('pay.webhook_endpoint_cap_unset');
  });
  // With the stack's TEST cap (10) the page shows it, and the person adds one with the form.
  await page.goto(WEBHOOKS);
  await expect(page.getByText('Up to 10 active endpoints per business.')).toBeVisible();
  await expect(page.getByTestId('webhook-cap-unset')).toHaveCount(0);
  const add = page.locator('#add');
  const url = `https://receiver-${RUN}.example.com/hook`;
  await add.getByLabel('Endpoint address').fill(url);
  const created = page.waitForResponse((r) => r.url().includes('merchantOps.webhooks.create') && r.request().method() === 'POST');
  await add.getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add endpoint' }).click();
  expect((await created).status()).toBe(200);
  const secret = page.locator('section.pp-secret');
  await expect(secret.getByRole('heading', { name: 'Signing secret for the new endpoint' })).toBeVisible();
  const row = (await hooksRead('list', { limit: 50 })).items.find((e) => e.url === url);
  expect(row, 'the endpoint is written').toMatchObject({ status: 'active' });
  // It is no receiver of this test's: off again, so later events are not sent to a name that does not exist.
  await hooks('disable', { endpointId: row.id });
});

test(`${J} #3 subscribes to two event types and a third fires: no delivery is written for the third`, async () => {
  test.setTimeout(180_000);
  endpoints.sub = await addEndpoint('sub', ['payment.authorized', 'payment.failed']);
  await page.goto(WEBHOOKS);
  await expect(page.getByRole('row').filter({ hasText: `/sub/${RUN}` })).toContainText('payment.authorized, payment.failed');
  // The payment fires payment.authorized (subscribed) and payment.captured (the third type).
  const paymentId = await payment('#3');
  await expect
    .poll(async () => (await deliveriesOf(endpoints.sub.id)).map((d) => `${d.eventType}:${d.status}`), {
      timeout: 4 * DRAIN_MS,
      intervals: [2_000],
    })
    .toEqual(['payment.authorized:delivered']);
  const live = await deliveriesOf(endpoints.live.id);
  expect(
    live.some((d) => d.eventType === 'payment.captured'),
    'the captured event was written for an endpoint that takes it',
  ).toBe(true);
  expect(postsTo('sub', paymentId).map((p) => JSON.parse(p.raw).type)).toEqual(['payment.authorized']);
  await hooks('disable', { endpointId: endpoints.sub.id });
});

test(`${J} #4 reads the event catalogue: each public type with a payload schema, no internal subject name, ordering and duplicate guidance`, async () => {
  const catalogue = await hooksRead('catalogue');
  expect(catalogue.events.map((e) => e.type)).toEqual(['payment.authorized', 'payment.captured', 'payment.refunded', 'payment.failed']);
  for (const event of catalogue.events) {
    expect(event.payloadSchema, event.type).toMatchObject({ type: 'object', required: ['id', 'type', 'createdAt', 'data'] });
    expect(event.payloadSchema.properties.type).toEqual({ const: event.type });
  }
  // No subject the event bus uses appears anywhere in it.
  const { ALL_EVENTS } = await import(new URL('../../../../packages/events/dist/catalog.js', import.meta.url).href);
  const text = JSON.stringify(catalogue);
  const leaked = ALL_EVENTS.map((e) => e.subject).filter((subject) => text.includes(subject));
  expect(leaked).toEqual([]);
  expect(text).not.toMatch(/intafaced\.[a-z-]+\.[a-z_]+\.[a-z_]+/);
  expect(catalogue.ordering).toContain('Order them by createdAt');
  expect(catalogue.duplicates).toContain('same id');

  await page.goto(DOCS);
  const shown = page.getByTestId('webhook-catalogue');
  await expect(shown.getByTestId('webhook-catalogue-event')).toHaveCount(4);
  for (const event of catalogue.events) {
    const entry = shown.getByRole('article', { name: event.type });
    await expect(entry.getByRole('heading', { name: event.type })).toBeVisible();
    await expect(entry.locator('pre')).toContainText('"createdAt"');
  }
  await expect(shown.getByTestId('webhook-catalogue-ordering')).toHaveText(catalogue.ordering);
  await expect(shown.getByTestId('webhook-catalogue-duplicates')).toHaveText(catalogue.duplicates);
  for (const subject of ALL_EVENTS.map((e) => e.subject)) expect(await page.content()).not.toContain(subject);
});

test(`${J} #5 rolls the signing secret with overlap: shown once, two signatures either secret verifies, then only the new one; a blank maximum refuses overlap`, async () => {
  test.setTimeout(360_000);
  const OVERLAP = 45;
  const old = endpoints.live.secret;
  await page.goto(`${WEBHOOKS}/${endpoints.live.id}`);
  await page.getByLabel('Keep the old secret working for (seconds)').fill(String(OVERLAP));
  const rolled = page.waitForResponse((r) => r.url().includes('merchantOps.webhooks.rotateSecret') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Replace signing secret' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Replace signing secret' }).click();
  const answer = await (await rolled).json();
  const fresh = (Array.isArray(answer) ? answer[0] : answer).result.data.secret;
  expect(fresh).toMatch(/^[0-9a-f]{64}$/);
  const reveal = page.locator('section.pp-secret');
  await expect(reveal.getByRole('heading', { name: 'New signing secret for this endpoint' })).toBeVisible();
  await expect(reveal.locator('code')).toHaveText(fresh);
  // Shown once: the page forgets it on reload, and no read of the endpoint carries it.
  await page.reload();
  await expect(page.locator('section.pp-secret')).toHaveCount(0);
  await expect(page.getByText(fresh)).toHaveCount(0);
  const row = await endpointRow(endpoints.live.id);
  expect(JSON.stringify(row)).not.toContain(fresh);
  expect(Date.parse(row.previousSecretUntil)).toBeGreaterThan(Date.now());
  endpoints.live.secret = fresh;

  // During the overlap: two signatures, the new secret's first, and each verifies the raw body.
  const during = await payment('#5-during');
  await expect.poll(() => postsTo('live', during).length, { timeout: 3 * DRAIN_MS, intervals: [1_000] }).toBe(1);
  const both = postsTo('live', during)[0];
  const ts = both.headers['x-intafaced-timestamp'];
  const signatures = String(both.headers['x-intafaced-signature']).split(',');
  expect(signatures).toEqual([sign(fresh, ts, both.raw), sign(old, ts, both.raw)]);

  // After the end time: only the new one.
  await expect.poll(() => Date.now() > Date.parse(row.previousSecretUntil), { timeout: (OVERLAP + 10) * 1000 }).toBe(true);
  const after = await payment('#5-after');
  await expect.poll(() => postsTo('live', after).length, { timeout: 3 * DRAIN_MS, intervals: [1_000] }).toBe(1);
  const one = postsTo('live', after)[0];
  expect(one.headers['x-intafaced-signature']).toBe(sign(fresh, one.headers['x-intafaced-timestamp'], one.raw));
  expect(one.headers['x-intafaced-signature']).not.toContain(sign(old, one.headers['x-intafaced-timestamp'], one.raw));

  // With the longest overlap blank, any overlap above zero refuses and the secret is not rolled.
  await withPayValueOff('LOCAL_STACK_PAY_WEBHOOK_OVERLAP_MAX', async () => {
    const refused = await refusal(() =>
      hooks('rotateSecret', { endpointId: endpoints.live.id, requestId: crypto.randomUUID(), overlapSeconds: 30 }),
    );
    expect(refused.status).toBe(412);
    expect(refused.body).toContain('pay.webhook_overlap_max_unset');
    await page.goto(`${WEBHOOKS}/${endpoints.live.id}`);
    await expect(page.getByText('INTAFACED has not set a longest overlap, so only 0 is allowed')).toBeVisible();
  });
  const later = await payment('#5-blank');
  await expect.poll(() => postsTo('live', later).length, { timeout: 3 * DRAIN_MS, intervals: [1_000] }).toBe(1);
  const still = postsTo('live', later)[0];
  expect(still.headers['x-intafaced-signature'], 'the refused roll changed nothing').toBe(
    sign(fresh, still.headers['x-intafaced-timestamp'], still.raw),
  );
});

test(`${J} #6 verifies a delivery with the receiver guide: timestamp, tolerance, raw body, signature, sender IPs; the vector passes, a tampered body fails`, async () => {
  const guide = await hooksRead('guide');
  expect(guide.headers).toEqual({
    timestamp: 'X-Intafaced-Timestamp',
    signature: 'X-Intafaced-Signature',
    eventId: 'X-Intafaced-Event-Id',
  });
  expect(guide.toleranceSeconds).toBe(300);
  expect(guide.senderIps).toEqual(['127.0.0.1']);
  expect(guide.algorithm).toContain('raw request body');
  // The published vector, checked here by the guide's own words: HMAC-SHA256 of "timestamp.body", lowercase hex.
  const { secret, timestamp, body, signature } = guide.vector;
  expect(sign(secret, timestamp, body)).toBe(signature);
  expect(sign(secret, timestamp, `${body} `)).not.toBe(signature);
  // A real delivery from #5 verifies the same way.
  const real = postsTo('live').at(-1);
  expect(sign(endpoints.live.secret, real.headers['x-intafaced-timestamp'], real.raw)).toBe(real.headers['x-intafaced-signature']);

  await page.goto(DOCS);
  const shown = page.getByTestId('webhook-guide');
  await expect(shown).toContainText('Timestamp');
  await expect(shown).toContainText('X-Intafaced-Timestamp');
  await expect(shown.getByTestId('webhook-guide-tolerance')).toHaveText(
    'Refuse a delivery whose timestamp is more than 300 seconds from your clock.',
  );
  await expect(shown).toContainText('Raw body');
  await expect(shown).toContainText('X-Intafaced-Signature');
  await expect(shown.getByTestId('webhook-guide-sender-ips')).toHaveText('127.0.0.1');
  await expect(shown.getByTestId('webhook-guide-vector')).toContainText(signature);
  // The page's own checker: the published example is valid; one changed character in the body is not.
  const checker = page.getByTestId('webhook-checker');
  await checker.getByRole('button', { name: 'Use the published example' }).click();
  await checker.getByRole('button', { name: 'Check signature' }).click();
  await expect(checker.getByTestId('webhook-checker-verdict')).toHaveText('Valid: the signature matches this body.');
  await checker.getByLabel('Raw body').fill(body.replace('10.00', '99.00'));
  await checker.getByRole('button', { name: 'Check signature' }).click();
  await expect(checker.getByTestId('webhook-checker-verdict')).toHaveText(
    'Does not match: this body was not signed with this secret and timestamp.',
  );
});

test(`${J} #7 my endpoint returns 500 then 200: the same event id and body bytes twice, new timestamps and signatures; the row ends delivered`, async () => {
  test.setTimeout(240_000);
  endpoints.flaky = await addEndpoint('flaky', ['payment.captured']);
  const paymentId = await payment('#7');
  endpoints.flaky.paymentId = paymentId;
  await expect
    .poll(async () => (await deliveriesOf(endpoints.flaky.id)).find((d) => d.eventType === 'payment.captured')?.status, {
      timeout: 6 * DRAIN_MS,
      intervals: [2_000],
    })
    .toBe('delivered');
  const sent = postsTo('flaky', paymentId);
  expect(sent).toHaveLength(2);
  const [first, second] = sent;
  expect(second.eventId).toBe(first.eventId);
  expect(first.eventId).toBe(`payment.captured:${paymentId}`);
  expect(Buffer.from(second.raw).equals(Buffer.from(first.raw)), 'the same body bytes').toBe(true);
  expect(second.headers['x-intafaced-timestamp']).not.toBe(first.headers['x-intafaced-timestamp']);
  expect(second.headers['x-intafaced-signature']).not.toBe(first.headers['x-intafaced-signature']);
  for (const p of sent)
    expect(p.headers['x-intafaced-signature']).toBe(sign(endpoints.flaky.secret, p.headers['x-intafaced-timestamp'], p.raw));
  const [row] = (await deliveriesOf(endpoints.flaky.id)).filter((d) => d.eventType === 'payment.captured');
  expect(row).toMatchObject({ status: 'delivered', attempts: 2, lastStatusCode: 200 });
  endpoints.flaky.deliveryId = row.id;
  expect((await attemptsOf(row.id)).map((a) => `${a.outcome}:${a.statusCode}`)).toEqual(['failed:500', 'delivered:200']);
});

test(`${J} #8 my endpoint times out: the row is unknown, and no second worker sends it while the lease holds`, async () => {
  test.setTimeout(300_000);
  endpoints.hang = await addEndpoint('hang', ['payment.captured']);
  const paymentId = await payment('#8');
  await expect
    .poll(async () => (await deliveriesOf(endpoints.hang.id))[0]?.status, { timeout: 4 * DRAIN_MS, intervals: [2_000] })
    .toBe('unknown');
  const claimedAt = postsTo('hang', paymentId)[0].at;
  const [row] = await deliveriesOf(endpoints.hang.id);
  expect(row.attempts).toBe(1);
  // Not tried again before the claim's lease ends, though the drain passes several times meanwhile.
  expect(Date.parse(row.nextAttemptAt)).toBeGreaterThanOrEqual(claimedAt + LEASE_MS - 2_000);
  const [attempt] = await attemptsOf(row.id);
  expect(attempt).toMatchObject({ outcome: 'unknown', statusCode: null, error: 'webhook_timeout' });
  const leaseEnds = Date.parse(row.nextAttemptAt);
  while (Date.now() < leaseEnds - 1_000) {
    expect(postsTo('hang', paymentId), 'sent once while the lease holds').toHaveLength(1);
    await page.waitForTimeout(Math.min(5_000, Math.max(0, leaseEnds - 1_000 - Date.now())));
  }
  expect(postsTo('hang', paymentId)).toHaveLength(1);
  await hooks('disable', { endpointId: endpoints.hang.id });
});

test(`${J} #9 my endpoint returns 410: the endpoint is disabled`, async () => {
  test.setTimeout(180_000);
  endpoints.gone = await addEndpoint('gone', ['payment.captured']);
  const paymentId = await payment('#9');
  await expect
    .poll(async () => (await endpointRow(endpoints.gone.id)).status, { timeout: 4 * DRAIN_MS, intervals: [2_000] })
    .toBe('disabled');
  expect(await endpointRow(endpoints.gone.id)).toMatchObject({ status: 'disabled', disabledReason: 'receiver_gone' });
  expect(postsTo('gone', paymentId)).toHaveLength(1);
  const [row] = await deliveriesOf(endpoints.gone.id);
  expect(row).toMatchObject({ status: 'dead', lastStatusCode: 410 });
  await page.goto(`${WEBHOOKS}/${endpoints.gone.id}`);
  await expect(page.getByText('Off: we do not send events to this address.')).toBeVisible();
  await expect(page.getByText('Turned off: receiver gone')).toBeVisible();
});

test(`${J} #10 resends one event and recovers missed ones from /pay/developer/deliveries: each attempt shown, one per resend request id; outside the window refuses; a blank retry policy sends nothing`, async () => {
  test.setTimeout(900_000);
  const flaky = endpoints.flaky;
  // Each attempt with its status and response.
  await page.goto(DELIVERIES);
  await expect(page.getByTestId('webhook-policy')).toContainText(
    'If your system does not accept an event we try again after 5, 10, 20 seconds.',
  );
  await page.getByLabel('Endpoint', { exact: true }).first().selectOption({ value: flaky.id });
  // Every later step's payment reached this endpoint too; #7's is the oldest (the list is newest first).
  const row = page.getByRole('row').filter({ hasText: 'payment.captured' }).last();
  await row.getByRole('button', { name: 'Details of payment.captured' }).click();
  const shown = page.getByTestId('delivery-attempts');
  await expect(shown.getByTestId('delivery-attempt')).toHaveCount(2);
  await expect(shown.getByTestId('delivery-attempt').nth(0)).toContainText('Not accepted');
  await expect(shown.getByTestId('delivery-attempt').nth(0)).toContainText('HTTP 500');
  await expect(shown.getByTestId('delivery-attempt').nth(1)).toContainText('Accepted');
  await expect(shown.getByTestId('delivery-attempt').nth(1)).toContainText('HTTP 200');

  // Resend it: one new attempt for the request id; the same request id again queues nothing more.
  const asked = page.waitForRequest((r) => r.url().includes('merchantOps.webhooks.deliveries.retry') && r.method() === 'POST');
  await row.getByRole('button', { name: 'Send again' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send again' }).click();
  const requestId = (await asked).postDataJSON().requestId;
  await expect(page.getByTestId('delivery-notice')).toContainText('will be sent to the same address again');
  const again = await hooks('deliveries.retry', { deliveryId: flaky.deliveryId, requestId });
  expect(again.retried, 'the same request id queues nothing more').toBe(false);
  await expect.poll(async () => (await attemptsOf(flaky.deliveryId)).length, { timeout: 4 * DRAIN_MS, intervals: [2_000] }).toBe(3);
  await page.waitForTimeout(2 * DRAIN_MS);
  const attempts = await attemptsOf(flaky.deliveryId);
  expect(attempts.map((a) => `${a.outcome}:${a.resend}`)).toEqual(['failed:false', 'delivered:false', 'delivered:true']);
  expect(postsTo('flaky', flaky.paymentId)).toHaveLength(3);
  await page.reload();
  await page.getByLabel('Endpoint', { exact: true }).first().selectOption({ value: flaky.id });
  await page
    .getByRole('row')
    .filter({ hasText: 'payment.captured' })
    .last()
    .getByRole('button', { name: 'Details of payment.captured' })
    .click();
  await expect(page.getByTestId('delivery-attempt')).toHaveCount(3);
  await expect(page.getByTestId('delivery-attempt').nth(2)).toContainText('Yes, sent again by you');

  // Recover missed events: an endpoint whose receiver is down misses one; once it is up, recovery sends it again.
  endpoints.down = await addEndpoint('down', ['payment.captured']);
  const missed = await payment('#10-missed');
  await expect
    .poll(async () => (await deliveriesOf(endpoints.down.id))[0]?.status, { timeout: 4 * DRAIN_MS, intervals: [1_000] })
    .toBe('failed');
  await page.goto(DELIVERIES);
  const recover = page
    .locator('section[data-testid="pay-section"]')
    .filter({ has: page.getByRole('heading', { name: 'Recover missed events' }) });
  await recover.getByLabel('Endpoint').selectOption({ value: endpoints.down.id });
  const since = await page.evaluate(() => {
    const d = new Date(Date.now() - 10 * 60_000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  });
  await recover.getByLabel('Since').fill(since);
  const recoverAsked = page.waitForResponse(
    (r) => r.url().includes('merchantOps.webhooks.deliveries.recover') && r.request().method() === 'POST',
  );
  await recover.getByRole('button', { name: 'Recover missed events' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Recover missed events' }).click();
  const recoverInput = (await recoverAsked).request().postDataJSON();
  // The receiver comes back up once the recovery is queued, so the recovered attempt is the one that gets through.
  downIsUp = true;
  await expect(page.getByTestId('delivery-notice')).toHaveText('1 missed events are queued to be sent again.');
  const recoveredAgain = await hooks('deliveries.recover', recoverInput);
  expect(recoveredAgain).toEqual({ recovered: false, queued: 1 });
  await expect
    .poll(async () => (await deliveriesOf(endpoints.down.id))[0]?.status, { timeout: 4 * DRAIN_MS, intervals: [2_000] })
    .toBe('delivered');
  const [downRow] = await deliveriesOf(endpoints.down.id);
  const downAttempts = await attemptsOf(downRow.id);
  expect(
    downAttempts.filter((a) => a.resend),
    'one new attempt for the recovery',
  ).toHaveLength(1);
  expect(downAttempts.at(-1)).toMatchObject({ outcome: 'delivered', statusCode: 200 });
  expect(postsTo('down', missed).at(-1).eventId).toBe(`payment.captured:${missed}`);

  // A resend outside the window refuses: svc-pay with a one-second LOCAL TEST window.
  restartWithSetting('pay', 'LOCAL_STACK_PAY_WEBHOOK_RESEND_WINDOW', '1');
  try {
    const outside = await refusal(() => hooks('deliveries.retry', { deliveryId: flaky.deliveryId, requestId: crypto.randomUUID() }));
    expect(outside.status).toBe(412);
    expect(outside.body).toContain('pay.webhook_resend_outside_window');
    await page.goto(DELIVERIES);
    await page.getByLabel('Endpoint', { exact: true }).first().selectOption({ value: flaky.id });
    const old = page.getByRole('row').filter({ hasText: 'payment.captured' }).last();
    await old.getByRole('button', { name: 'Send again' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Send again' }).click();
    await expect(page.getByText('That is too long ago to send again.')).toBeVisible();
    expect(await attemptsOf(flaky.deliveryId)).toHaveLength(3);
  } finally {
    restartWithSetting('pay', 'LOCAL_STACK_PAY_WEBHOOK_RESEND_WINDOW', null);
  }

  // A blank retry policy sends nothing, and the dashboard says so.
  let waiting = '';
  await withPayValueOff('LOCAL_STACK_PAY_WEBHOOK_RETRY_POLICY', async () => {
    await page.goto(DELIVERIES);
    await expect(page.getByTestId('webhook-policy-unset')).toHaveText(
      'INTAFACED has not set a retry policy, so nothing is sent. Events wait here as Waiting until it is set.',
    );
    waiting = await payment('#10-blank-policy');
    await page.waitForTimeout(3 * DRAIN_MS);
    expect(postsTo('live', waiting), 'nothing is sent while the policy is blank').toHaveLength(0);
    const held = (await deliveriesOf(endpoints.live.id)).find((d) => d.eventId === `payment.captured:${waiting}`);
    expect(held).toMatchObject({ status: 'pending', attempts: 0 });
  });
  // Set again, the waiting event goes out.
  await expect.poll(() => postsTo('live', waiting).length, { timeout: 4 * DRAIN_MS, intervals: [2_000] }).toBe(1);
});
