// World: restart, stack
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import { test, expect } from './journey.mjs';
import { forgetSession, nextCode } from './identity-factors.mjs';
import { tool } from './stack.mjs';
import { businessReadyPerson, openBusiness, paidCardPayment, payApiOf, signInWithCode, uuidOf, verifiedBusiness } from './merchant.mjs';

// J-developer-10, in the running app (docs/roadmap/journeys.json): receive webhooks and verify them. Independent tests
// (OWNER 212), one per step, each titled "J-developer-10 #<n>" and written from the step's own words.
//
// The developer's live endpoint: a receiver this test runs on the loopback address. svc-pay sends to http loopback
// receivers only under the stack's explicit dev APP_ENV (webhook-url-guard.ts, allowLocalHttp), so it stands in for the
// developer's https address here; every clause about refusing other addresses is checked against the production rules.
const J = 'J-developer-10';
const EVENT_ID_HEADER = 'x-intafaced-event-id';
const SIGNATURE_HEADER = 'x-intafaced-signature';
const TIMESTAMP_HEADER = 'x-intafaced-timestamp';
// svc-pay drains due deliveries every 15 s and waits 60 s before the first retry (merchant-webhooks.ts): a step that
// needs two attempts waits up to this long for them.
const TWO_ATTEMPTS_MS = 180_000;

/** The service's typed code on a refusal thrown by payApiOf (or answered whole), wherever tRPC carries it. */
function codeOf(err) {
  let body = err?.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      /* text */
    }
  }
  const e = body?.error ?? body?.[0]?.error;
  return e?.data?.cause?.code ?? e?.data?.code ?? /^([a-z0-9_]+\.[a-z0-9_]+)/.exec(e?.message ?? '')?.[1] ?? null;
}
const refusal = (call) =>
  call.then(
    (ok) => ({ refused: false, ok }),
    (err) => ({ refused: true, status: err.status, code: codeOf(err) }),
  );

/** HMAC-SHA256 of `${timestamp}.${rawBody}`, as the guide states the signature is made. */
const sign = (secret, timestamp, rawBody) => createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
/** Every signature in the header (one, or several during a secret overlap), without any `v1=` prefix. */
const signaturesIn = (header) =>
  String(header ?? '')
    .split(/[,\s]+/)
    .map((s) => s.replace(/^v\d+=/, ''))
    .filter(Boolean);

/**
 * The developer's endpoint: records every request with its raw body bytes and answers as `answer(request, n)` says,
 * where n counts earlier requests for the same event id. `answer` returns a status, or 'hang' to never answer.
 */
async function receiver(answer = () => 200) {
  const got = [];
  const hung = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const eventId = req.headers[EVENT_ID_HEADER];
      const n = got.filter((g) => g.eventId === eventId).length;
      const one = { at: Date.now(), headers: req.headers, raw, body: raw.toString('utf8'), eventId };
      got.push(one);
      const status = answer(one, n);
      if (status === 'hang') {
        hung.push(res);
        return;
      }
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(`TEST receiver answered ${status}`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/hooks/${randomUUID()}`,
    got,
    of: (eventId) => got.filter((g) => g.eventId === eventId),
    close: () =>
      new Promise((resolve) => {
        for (const res of hung) res.destroy();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** svc-pay restarted with one of the stack's TEST owner values blank (`LOCAL_STACK_<name>=off`), then put back. */
function payWith(knob, blank) {
  const before = process.env[knob];
  if (blank) process.env[knob] = 'off';
  else delete process.env[knob];
  try {
    tool('local-test-stack.mjs', 'restart', 'pay');
  } finally {
    if (before === undefined) delete process.env[knob];
    else process.env[knob] = before;
  }
}

/**
 * The journey's start: a verified business owner signed in on the developer pages, with the same person's pay API (a
 * session with its authenticator code, so svc-pay reads it as interactive, which adding an endpoint needs).
 */
async function developer(page, prefix, room = '/pay/developer/webhooks') {
  const owner = await businessReadyPerson(page, prefix, '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, `TEST ${prefix} Webhooks Ltd`);
  await verifiedBusiness(page, owner, merchantId);
  await forgetSession(page);
  await signInWithCode(page, owner, room);
  const api = await payApiOf(owner, (step) => {
    owner.step = step;
  });
  const code = async () => {
    const fresh = await nextCode(owner.totp, owner.secret, owner.step);
    owner.step = fresh.step;
    return fresh.code;
  };
  return { owner, merchantId, api, code };
}

const endpoints = async (api) => (await api.query('merchantOps.webhooks.list', { limit: 100 })).items;
const deliveries = async (api, input = {}) => (await api.query('merchantOps.webhooks.deliveries.list', { limit: 100, ...input })).items;

/** Waits until `check` returns something truthy, reading again every 2 s. */
async function until(what, check, timeout) {
  let last;
  await expect
    .poll(
      async () => {
        last = await check();
        return Boolean(last);
      },
      { message: what, timeout, intervals: [2_000] },
    )
    .toBe(true);
  return last;
}

/** A paid TEST card payment, so svc-pay sends its payment events to every endpoint the business has. */
async function takePayment(dev, key, amount = '10.00') {
  const paid = await paidCardPayment(dev.api, dev.merchantId, { key: `${J}:${key}:${dev.merchantId}`, amount });
  expect(paid.status).toBe('captured');
  return paid;
}

test(`${J} #1 an http address is refused with the https-required code, and an https address that resolves to a private address is refused by the URL guard`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const dev = await developer(page, 'dwh1');

  // An http address on a live endpoint: the service's own https-required code, and nothing is added.
  const plain = await refusal(dev.api.mutate('merchantOps.webhooks.create', { url: 'http://receiver.example.com/hooks' }));
  expect(plain.refused).toBe(true);
  expect(plain.code).toMatch(/https.?required/i);
  // The page says so too, before anything is sent.
  await page.goto('/pay/developer/webhooks');
  await page.getByLabel('Endpoint address').fill('http://receiver.example.com/hooks');
  await expect(page.getByText('Use https:// so events cannot be read in transit.')).toBeVisible();

  // An https address whose name resolves to a private address (10.0.0.1): the URL guard refuses it when it is added.
  const privateName = 'https://10.0.0.1.nip.io/hooks';
  const hidden = await refusal(dev.api.mutate('merchantOps.webhooks.create', { url: privateName }));
  expect(hidden.refused).toBe(true);
  expect(hidden.code).toBe('pay.webhook_url_invalid');
  const urls = (await endpoints(dev.api)).map((e) => e.url);
  expect(urls).not.toContain('http://receiver.example.com/hooks');
  expect(urls).not.toContain(privateName);
});

test(`${J} #2 adding an endpoint with the endpoint cap blank refuses with the cap-unset code; with a cap the endpoint is created`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const dev = await developer(page, 'dwh2');
  const live = await receiver();
  try {
    payWith('LOCAL_STACK_PAY_WEBHOOK_ENDPOINT_CAP', true);
    const blank = await refusal(dev.api.mutate('merchantOps.webhooks.create', { url: live.url }));
    expect(blank.refused).toBe(true);
    expect(blank.code).toMatch(/cap.?unset/i);
    expect((await endpoints(dev.api)).map((e) => e.url)).not.toContain(live.url);
  } finally {
    payWith('LOCAL_STACK_PAY_WEBHOOK_ENDPOINT_CAP', false);
  }
  // With the stack's TEST cap set, the same address is created and listed, active.
  const created = await dev.api.mutate('merchantOps.webhooks.create', { url: live.url });
  expect(created.endpoint.url).toBe(live.url);
  const listed = (await endpoints(dev.api)).find((e) => e.id === created.endpoint.id);
  expect(listed?.status).toBe('active');
  await live.close();
});

test(`${J} #3 an endpoint subscribed to two event types gets no delivery written when a third type fires`, async ({ page }) => {
  test.setTimeout(420_000);
  const dev = await developer(page, 'dwh3');
  const live = await receiver();
  try {
    const subscribed = ['payment.authorized', 'payment.captured'];
    const created = await dev.api.mutate('merchantOps.webhooks.create', { url: live.url, eventTypes: subscribed });
    const endpointId = created.endpoint.id;
    expect([...(created.endpoint.eventTypes ?? [])].sort()).toEqual(subscribed);

    // The two subscribed types fire (a paid card payment), then the third: a refund.
    const paid = await takePayment(dev, '#3');
    const refunder = await dev.api.steppedUp(dev.merchantId, ['pay:refund'], await dev.code());
    await refunder.mutate('payment.refund', { paymentId: paid.id, amount: '10.00', refundId: `TEST-${J}-3-${paid.id}` });

    // The subscribed events are written (so the third had its chance to be written too) ...
    await until(
      'deliveries written for both subscribed types',
      async () => {
        const types = new Set((await deliveries(dev.api, { endpointId })).map((d) => d.eventType));
        return subscribed.every((t) => types.has(t));
      },
      60_000,
    );
    // ... and none is written for the refund.
    const types = (await deliveries(dev.api, { endpointId })).map((d) => d.eventType);
    expect(types).not.toContain('payment.refunded');
    expect(types.every((t) => subscribed.includes(t))).toBe(true);
  } finally {
    await live.close();
  }
});

test(`${J} #4 the event catalogue shows each public type with a payload schema and no internal subject name, with ordering and duplicate-handling guidance`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  await developer(page, 'dwh4', '/pay/developer/docs');
  const catalogue = page.locator('section').filter({ has: page.getByRole('heading', { name: /event catalogue/i }) });
  await expect(catalogue).toBeVisible();
  for (const type of ['payment.authorized', 'payment.captured', 'payment.refunded', 'payment.failed']) {
    const entry = catalogue.locator('article, li, tr, section').filter({ hasText: type }).last();
    await expect(entry, `${type} is in the catalogue`).toBeVisible();
    await expect(entry, `${type} has a payload schema`).toContainText(/schema/i);
    // The schema names the payload's fields, as the event body carries them.
    await expect(entry).toContainText('amount');
    await expect(entry).toContainText('status');
  }
  const text = await catalogue.innerText();
  // No internal subject name: no message-bus subject and no internal stream prefix.
  expect(text).not.toMatch(/\bsubject\b|\bnats\b|\bpay\.(events?|internal|payment)\.[a-z]/i);
  // Ordering guidance and duplicate-handling guidance.
  expect(text).toMatch(/order/i);
  expect(text).toMatch(/duplicate|more than once|repeat/i);
});

test(`${J} #5 the signing secret is shown once; a roll with overlap signs with both and either verifies, then only the new one after the end time; a blank maximum refuses overlap above zero`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  const dev = await developer(page, 'dwh5');
  const live = await receiver();
  try {
    // Shown once: the create answers the secret; the list never carries it.
    const created = await dev.api.mutate('merchantOps.webhooks.create', { url: live.url });
    const endpointId = created.endpoint.id;
    const oldSecret = created.secret;
    expect(oldSecret).toMatch(/\S{32,}/);
    expect(JSON.stringify(await endpoints(dev.api))).not.toContain(oldSecret);

    // Rolled with a 90 s overlap: the new secret is shown once, and a repeat of the same request shows nothing.
    const requestId = randomUUID();
    const rolled = await dev.api.mutate('merchantOps.webhooks.rotateSecret', { endpointId, requestId, overlapSeconds: 90 });
    const newSecret = rolled.secret;
    expect(newSecret).toMatch(/\S{32,}/);
    expect(newSecret).not.toBe(oldSecret);
    const again = await dev.api.mutate('merchantOps.webhooks.rotateSecret', { endpointId, requestId, overlapSeconds: 90 });
    expect(again.secret).toBeNull();
    expect(rolled.endpoint.overlapEndsAt ?? rolled.overlapEndsAt).toBeTruthy();
    const overlapEnds = Date.parse(rolled.endpoint.overlapEndsAt ?? rolled.overlapEndsAt);

    // During the overlap: the header carries two signatures, and either secret verifies the delivery.
    await takePayment(dev, '#5:during');
    const during = await until('a delivery during the overlap', () => live.got[0], 60_000);
    const both = signaturesIn(during.headers[SIGNATURE_HEADER]);
    expect(both).toHaveLength(2);
    const ts = during.headers[TIMESTAMP_HEADER];
    expect(both).toContain(sign(oldSecret, ts, during.body));
    expect(both).toContain(sign(newSecret, ts, during.body));

    // After the end time: only the new one.
    await until('the overlap end time has passed', async () => Date.now() > overlapEnds + 1_000, 150_000);
    const seen = live.got.length;
    await takePayment(dev, '#5:after');
    const after = await until('a delivery after the overlap', () => live.got.slice(seen).find((g) => g.at > overlapEnds), 60_000);
    const only = signaturesIn(after.headers[SIGNATURE_HEADER]);
    expect(only).toEqual([sign(newSecret, after.headers[TIMESTAMP_HEADER], after.body)]);
    expect(only).not.toContain(sign(oldSecret, after.headers[TIMESTAMP_HEADER], after.body));
  } finally {
    await live.close();
  }

  // With the maximum overlap blank, a roll with any overlap above zero refuses, and the secret is unchanged.
  try {
    payWith('LOCAL_STACK_PAY_WEBHOOK_SECRET_OVERLAP', true);
    const [endpoint] = await endpoints(dev.api);
    const blank = await refusal(
      dev.api.mutate('merchantOps.webhooks.rotateSecret', { endpointId: endpoint.id, requestId: randomUUID(), overlapSeconds: 1 }),
    );
    expect(blank.refused).toBe(true);
    expect(blank.code).toMatch(/overlap/i);
  } finally {
    payWith('LOCAL_STACK_PAY_WEBHOOK_SECRET_OVERLAP', false);
  }
});

test(`${J} #6 the receiver guide gives timestamp, tolerance, raw body, signature and sender IPs; the published vector passes and a tampered body fails`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  await developer(page, 'dwh6', '/pay/developer/docs');
  const guide = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Checking the events we send' }) });
  await expect(guide).toBeVisible();
  const text = await guide.innerText();
  expect(text).toMatch(/timestamp/i);
  // The tolerance, as a stated amount of time.
  expect(text).toMatch(/tolerance|accepted for/i);
  expect(text).toMatch(/\d+\s*(seconds?|minutes?|s\b)/i);
  expect(text).toMatch(/raw body/i);
  expect(text).toMatch(/signature/i);
  // The addresses events are sent from.
  expect(text).toMatch(/IP address/i);
  expect(text).toMatch(/\b\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?\b|[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}/i);

  // The published test vector: recomputed as the guide says, it passes; with one byte of the body changed, it fails.
  const vector = guide
    .locator('section, figure, div')
    .filter({ has: page.getByRole('heading', { name: /test vector/i }) })
    .last();
  await expect(vector).toBeVisible();
  const field = async (name) =>
    (await vector.locator('dt', { hasText: name }).locator('xpath=following-sibling::dd[1]').innerText()).trim();
  const secret = await field(/secret/i);
  const timestamp = await field(/timestamp/i);
  const body = await field(/body/i);
  const signature = await field(/signature/i);
  expect(sign(secret, timestamp, body)).toBe(signature);
  const tampered = body.replace(/\d/, (d) => String((Number(d) + 1) % 10));
  expect(tampered).not.toBe(body);
  expect(sign(secret, timestamp, tampered)).not.toBe(signature);
});

test(`${J} #7 when my endpoint returns 500 then 200, the same event id and body bytes are sent twice with new timestamps and signatures, and the row ends delivered`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  const dev = await developer(page, 'dwh7');
  const live = await receiver((_, n) => (n === 0 ? 500 : 200));
  try {
    const created = await dev.api.mutate('merchantOps.webhooks.create', { url: live.url });
    const secret = created.secret;
    const paid = await takePayment(dev, '#7');
    const eventId = `payment.captured:${paid.id}`;
    const [first, second] = await until(
      'two attempts of the captured event',
      () => live.of(eventId).length >= 2 && live.of(eventId),
      TWO_ATTEMPTS_MS,
    );

    // The same event id and the same body bytes ...
    expect(first.headers[EVENT_ID_HEADER]).toBe(eventId);
    expect(second.headers[EVENT_ID_HEADER]).toBe(eventId);
    expect(JSON.parse(first.body).id).toBe(eventId);
    expect(Buffer.compare(first.raw, second.raw)).toBe(0);
    // ... with a new timestamp and a new signature, each valid for its own timestamp.
    expect(second.headers[TIMESTAMP_HEADER]).not.toBe(first.headers[TIMESTAMP_HEADER]);
    expect(second.headers[SIGNATURE_HEADER]).not.toBe(first.headers[SIGNATURE_HEADER]);
    for (const attempt of [first, second])
      expect(signaturesIn(attempt.headers[SIGNATURE_HEADER])).toContain(sign(secret, attempt.headers[TIMESTAMP_HEADER], attempt.body));

    // The row ends delivered, and nothing more is sent.
    const row = await until(
      'the captured delivery reads delivered',
      async () =>
        (await deliveries(dev.api, { endpointId: created.endpoint.id })).find(
          (d) => d.eventType === 'payment.captured' && d.status === 'delivered',
        ),
      60_000,
    );
    expect(row.status).toBe('delivered');
    expect(live.of(eventId)).toHaveLength(2);
  } finally {
    await live.close();
  }
});

test(`${J} #8 when my endpoint times out the row is unknown, and no second worker sends it while the lease holds`, async ({ page }) => {
  test.setTimeout(600_000);
  const dev = await developer(page, 'dwh8');
  const live = await receiver(() => 'hang');
  try {
    const created = await dev.api.mutate('merchantOps.webhooks.create', { url: live.url });
    const paid = await takePayment(dev, '#8');
    const eventId = `payment.captured:${paid.id}`;
    const first = await until('the first attempt of the captured event', () => live.of(eventId)[0], 60_000);

    // The attempt times out: its row reads unknown (whether the endpoint got it is not known).
    const row = await until(
      'the timed-out delivery reads unknown',
      async () =>
        (await deliveries(dev.api, { endpointId: created.endpoint.id })).find(
          (d) => d.eventType === 'payment.captured' && d.status === 'unknown',
        ),
      60_000,
    );
    expect(row.status).toBe('unknown');
    // While the lease holds (svc-pay's 60 s claim, WEBHOOK_CLAIM_LEASE_MS), no second send of the event arrives.
    await until('the lease has run', async () => Date.now() > first.at + 55_000, 70_000);
    expect(live.of(eventId)).toHaveLength(1);
  } finally {
    await live.close();
  }
});

test(`${J} #9 when my endpoint returns 410 the endpoint is disabled`, async ({ page }) => {
  test.setTimeout(420_000);
  const dev = await developer(page, 'dwh9');
  const live = await receiver(() => 410);
  try {
    const created = await dev.api.mutate('merchantOps.webhooks.create', { url: live.url });
    await takePayment(dev, '#9');
    await until('an event reached the endpoint', () => live.got[0], 60_000);
    // One 410 (Gone): the endpoint is disabled, in the service and on the page.
    const off = await until(
      'the endpoint reads disabled',
      async () => (await endpoints(dev.api)).find((e) => e.id === created.endpoint.id && e.status === 'disabled'),
      30_000,
    );
    expect(off.status).toBe('disabled');
    await page.goto(`/pay/developer/webhooks/${encodeURIComponent(created.endpoint.id)}`);
    await expect(page.getByText('Off: we do not send events to this address.')).toBeVisible();
  } finally {
    await live.close();
  }
});

test(`${J} #10 on /pay/developer/deliveries each attempt shows its status and response; one new attempt per resend request id; a resend outside the window refuses; missed events are recovered; a blank retry policy sends nothing and the dashboard says so`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const dev = await developer(page, 'dwh10', '/pay/developer/deliveries');
  // The endpoint fails every event until it is fixed, so its events are missed.
  let fixed = false;
  const live = await receiver(() => (fixed ? 200 : 500));
  try {
    const created = await dev.api.mutate('merchantOps.webhooks.create', { url: live.url });
    const endpointId = created.endpoint.id;
    const paid = await takePayment(dev, '#10');
    const eventId = `payment.captured:${paid.id}`;
    await until('two failed attempts of the captured event', () => live.of(eventId).length >= 2, TWO_ATTEMPTS_MS);
    fixed = true;
    const row = (await deliveries(dev.api, { endpointId })).find((d) => d.eventType === 'payment.captured');

    // Each attempt, with its status and the endpoint's response.
    await page.goto(`/pay/developer/deliveries?delivery=${encodeURIComponent(row.id)}`);
    const attempts = page.getByRole('list', { name: /attempts/i }).getByRole('listitem');
    await expect(attempts).toHaveCount(2);
    for (const attempt of await attempts.all()) {
      await expect(attempt).toContainText(/failed/i);
      await expect(attempt).toContainText('500');
    }

    // One resend request id, sent twice: one new attempt.
    const requestId = randomUUID();
    const before = live.of(eventId).length;
    await dev.api.mutate('merchantOps.webhooks.deliveries.retry', { requestId, deliveryId: row.id });
    await dev.api.mutate('merchantOps.webhooks.deliveries.retry', { requestId, deliveryId: row.id });
    await until('the resend arrived', () => live.of(eventId).length > before, 60_000);
    await until('no second resend for the same request id', async () => Date.now() > live.of(eventId).at(-1).at + 30_000, 45_000);
    expect(live.of(eventId)).toHaveLength(before + 1);
    await until(
      'the resent delivery reads delivered',
      async () => (await deliveries(dev.api, { endpointId })).find((d) => d.id === row.id && d.status === 'delivered'),
      60_000,
    );

    // Recovering missed events: the authorised event, also missed, is sent again from the dashboard and delivered.
    const authorizedId = `payment.authorized:${paid.id}`;
    const missedBefore = live.of(authorizedId).length;
    await page.goto('/pay/developer/deliveries');
    await page.getByRole('button', { name: /recover missed events/i }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /recover/i })
      .click();
    await until('the missed event was sent again', () => live.of(authorizedId).length > missedBefore, 60_000);
    await until(
      'the missed delivery reads delivered',
      async () => (await deliveries(dev.api, { endpointId })).find((d) => d.eventType === 'payment.authorized' && d.status === 'delivered'),
      60_000,
    );

    // A resend outside the window refuses, and nothing is sent.
    const window = await dev.api.query('merchantOps.webhooks.retryPolicy', {});
    expect(window.windowMs).toBeGreaterThan(0);
    await until(
      'the event is outside the resend window',
      async () => Date.now() > Date.parse(row.createdAt) + window.windowMs + 1_000,
      window.windowMs + 60_000,
    );
    const sent = live.of(eventId).length;
    const late = await refusal(dev.api.mutate('merchantOps.webhooks.deliveries.retry', { requestId: randomUUID(), deliveryId: row.id }));
    expect(late.refused).toBe(true);
    expect(late.code).toMatch(/window/i);
    expect(live.of(eventId)).toHaveLength(sent);
  } finally {
    fixed = false;
  }

  // With the retry policy blank: a resend sends nothing, and the dashboard says so.
  try {
    payWith('LOCAL_STACK_PAY_WEBHOOK_RETRY', true);
    const failing = await dev.api.mutate('merchantOps.webhooks.create', { url: live.url });
    await takePayment(dev, '#10:blank', '11.00');
    const failed = await until(
      'a failed delivery to resend',
      async () => (await deliveries(dev.api, { endpointId: failing.endpoint.id })).find((d) => d.status === 'failed'),
      90_000,
    );
    const sent = live.got.length;
    // The developer presses Send again on the dashboard: the service refuses with its typed code and the page says why.
    await page.goto(`/pay/developer/deliveries?delivery=${encodeURIComponent(failed.id)}`);
    const resent = page.waitForResponse(
      (r) => r.url().includes('merchantOps.webhooks.deliveries.retry') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Send again' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Send again' }).click();
    expect(codeOf({ body: await (await resent).text() })).toBe('pay.webhook_retry_unconfigured');
    await expect(page.getByText('Sending again is not switched on for your account. INTAFACED has to set a limit first.')).toBeVisible();
    // Nothing is sent: two drains (15 s each) pass with no new request at the endpoint.
    await page.waitForTimeout(35_000);
    expect(live.got.length).toBe(sent);
  } finally {
    payWith('LOCAL_STACK_PAY_WEBHOOK_RETRY', false);
    await live.close();
  }
});
