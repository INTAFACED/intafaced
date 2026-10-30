import { test, expect } from '@playwright/test';
import { draftNotice, publishNotice } from './notices.mjs';
import { configureStatusPage, findSubscriber, recordReading } from './status-page.mjs';
import { ORIGIN, statusMail } from './stack.mjs';

// J-support-public-07, in the running app (docs/roadmap/journeys.json): a signed-out visitor checks /status and sees
// only states the platform recorded or published. Tests titled "J-support-public-07 #<n>" prove a whole step.
const J = 'J-support-public-07';
const RUN = Date.now().toString(36);

test.describe.configure({ mode: 'serial' });

/** A signed-out visitor on a device of its own. */
async function visitor(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

const COMPONENTS = [
  { id: 'trading', name: 'Trading', group: 'Exchange', source: null },
  { id: 'wallets', name: 'Wallets', group: 'Exchange', source: null },
  { id: 'card-network', name: 'Card network', group: 'Outside dependencies', source: 'TEST card scheme status page' },
];

/** The labelled TEST owner values this journey runs with. Production has none until the owner sets them. */
const TEST_VALUES = { componentCap: 5, stalenessSeconds: 600, uptimeDays: 7 };
/** TEST subscription safeguards: proof-of-work strength (leading zero bits) and subscribe requests per address per hour. */
const TEST_SAFEGUARDS = { challengeBits: 12, subscribeRatePerHour: 5 };
const SUBSCRIBER = `status-${RUN}@example.com`;

/** The app path of the first link to `path` in a status message. */
const linkIn = (mail, path) => {
  const match = new RegExp(`(${path}\\?token=\\S+)`).exec(mail.text);
  if (!match) throw new Error(`no ${path} link in "${mail.subject}"`);
  return match[1];
};

/** Status mail to `email` once there are `count` messages; fan-out runs just after the publish answers. */
async function statusMailAtLeast(email, count, waitMs = 15_000) {
  const until = Date.now() + waitMs;
  for (;;) {
    const mail = statusMail(email);
    if (mail.length >= count || Date.now() >= until) return mail;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** A public tRPC mutation through Edge, as the browser sends it, signed out. */
async function publicMutate(procedure, input) {
  const res = await fetch(`${ORIGIN}/api/notify/trpc/${procedure}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input ?? {}),
  });
  return { status: res.status, json: await res.json() };
}

const component = (page, id) => page.locator(`[data-testid="status-component-${id}"]`);

test(`${J} #1 /status with no components defined: "No components are set", no banner, signed out`, async ({ browser }) => {
  await configureStatusPage({ components: [] });
  const page = await visitor(browser);
  await page.goto('/status');
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Platform status' })).toBeVisible();
  await expect(main.getByTestId('status-components-none')).toContainText('No components are set');
  await expect(main.getByTestId('status-overall')).toHaveCount(0);
  await expect(main.getByText(/operational/i)).toHaveCount(0);
  await expect(page).toHaveURL(/\/status$/);
  await page.context().close();
});

test(`${J} #2 /status with components: each shows its state, no reading and a stale reading show No data, top level not operational`, async ({
  browser,
}) => {
  await configureStatusPage({ components: COMPONENTS, ...TEST_VALUES });
  const now = Date.now();
  await recordReading({
    componentId: 'trading',
    state: 'operational',
    observedAt: new Date(now - 30_000).toISOString(),
    source: 'TEST probe',
  });
  // Older than the 600-second staleness window.
  await recordReading({
    componentId: 'card-network',
    state: 'operational',
    observedAt: new Date(now - 2 * 3_600_000).toISOString(),
    source: 'TEST card scheme status page',
  });
  const page = await visitor(browser);
  await page.goto('/status');
  const main = page.locator('main');
  await expect(component(main, 'trading')).toHaveAttribute('data-state', 'operational');
  await expect(component(main, 'trading')).toContainText('Operational');
  await expect(component(main, 'trading')).toContainText('Reading from TEST probe');
  await expect(component(main, 'wallets')).toHaveAttribute('data-state', 'no_data');
  await expect(component(main, 'wallets')).toContainText('No data');
  await expect(component(main, 'wallets')).toContainText('No reading has been recorded.');
  await expect(component(main, 'card-network')).toHaveAttribute('data-state', 'no_data');
  await expect(component(main, 'card-network')).toContainText('The last reading is older than the staleness window.');
  await expect(component(main, 'card-network')).toContainText('Outside dependency: TEST card scheme status page');
  await expect(main.getByTestId('status-overall')).toHaveAttribute('data-state', 'no_data');
  await expect(main.getByTestId('status-overall')).toContainText('Not every component has a current reading');
  await expect(main.getByText('All components report operational')).toHaveCount(0);
  await page.context().close();
});

test(`${J} #3 the uptime strip of a component with no samples is empty and shows no percentage`, async ({ browser }) => {
  const page = await visitor(browser);
  await page.goto('/status');
  const main = page.locator('main');
  const strip = main.getByTestId('status-uptime-wallets');
  await expect(strip.locator('li')).toHaveCount(TEST_VALUES.uptimeDays);
  await expect(strip.locator('li[data-state="empty"]')).toHaveCount(TEST_VALUES.uptimeDays);
  // The strip of the component with a reading today is not empty, so the empty one above is the absence of samples.
  await expect(main.getByTestId('status-uptime-trading').locator('li').last()).toHaveAttribute('data-state', 'operational');
  await expect(main.getByTestId('status-components')).not.toContainText('%');
  await page.context().close();
});

test(`${J} #4 an active incident shows its update timeline and sets the affected component until it is resolved`, async ({ browser }) => {
  await recordReading({ componentId: 'trading', state: 'operational', observedAt: new Date().toISOString(), source: 'TEST probe' });
  const title = `TEST slow order fills ${RUN}`;
  const root = await publishNotice(
    await draftNotice({
      kind: 'incident',
      title,
      body: 'TEST investigating slow fills',
      minutes: 15,
      key: `${J}-root-${RUN}`,
      impact: 'major',
      components: ['trading'],
    }),
    `${J}-root-${RUN}`,
  );
  const page = await visitor(browser);
  await page.goto('/status');
  const main = page.locator('main');
  const card = main.getByTestId(`status-incident-${root.id}`);
  await expect(card.getByRole('heading', { name: title })).toBeVisible();
  await expect(card).toContainText('Open');
  await expect(card).toContainText('Affects: Trading');
  await expect(component(main, 'trading')).toHaveAttribute('data-state', 'partial_outage');
  await expect(component(main, 'trading')).toContainText('From a published incident');

  await publishNotice(
    await draftNotice({
      kind: 'incident',
      title,
      body: 'TEST fix deployed, watching',
      minutes: 15,
      key: `${J}-update-${RUN}`,
      parentId: root.id,
    }),
    `${J}-update-${RUN}`,
  );
  await page.reload();
  await expect(card.getByTestId('status-timeline').locator('li')).toHaveCount(2);
  await expect(card.getByTestId('status-timeline').locator('li').first()).toContainText('TEST fix deployed, watching');
  await expect(component(main, 'trading')).toHaveAttribute('data-state', 'partial_outage');

  await publishNotice(
    await draftNotice({
      kind: 'incident',
      title,
      body: 'TEST resolved',
      minutes: 15,
      key: `${J}-resolve-${RUN}`,
      parentId: root.id,
      resolves: true,
    }),
    `${J}-resolve-${RUN}`,
  );
  await page.reload();
  await expect(card).toContainText('Resolved');
  await expect(card.getByTestId('status-timeline').locator('li')).toHaveCount(3);
  await expect(component(main, 'trading')).toHaveAttribute('data-state', 'operational');
  await page.context().close();
});

test(`${J} #5 /notice lists published notices with their kind, and maintenance as scheduled, in progress or completed`, async ({
  browser,
}) => {
  // Each window's times are taken just before it is drafted. The scheduled one is ten years ahead, so no stack that
  // stays up ever sees it open; the in-progress one is published last and ends within J-home-ia-06's seven-minute wait
  // for an empty board, in case both run on one stack.
  const at = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
  const windows = [
    ['scheduled', 'Scheduled', () => [at(3650 * 24 * 60), at(3650 * 24 * 60 + 60)]],
    ['completed', 'Completed', () => [at(-120), at(-60)]],
    ['in_progress', 'In progress', () => [at(-5), at(6)]],
  ];
  const published = [];
  for (const [phase, , times] of windows) {
    const key = `${J}-maint-${phase}-${RUN}`;
    const [startsAt, endsAt] = times();
    published.push(
      await publishNotice(
        await draftNotice({
          kind: 'maintenance',
          title: `TEST ${phase} maintenance ${RUN}`,
          body: `TEST ${phase} window`,
          key,
          startsAt,
          endsAt,
        }),
        key,
      ),
    );
  }
  const page = await visitor(browser);
  await page.goto('/notice');
  const main = page.locator('main');
  for (const [i, [phase, label]] of windows.entries()) {
    const card = main.getByTestId(`notice-${published[i].id}`);
    await expect(card.getByRole('heading', { name: `TEST ${phase} maintenance ${RUN}` })).toBeVisible();
    await expect(card).toHaveAttribute('data-kind', 'maintenance');
    await expect(card).toHaveAttribute('data-phase', phase);
    await expect(card).toContainText(`Maintenance · ${label}`);
  }
  // Only maintenance carries a phase.
  await expect(main.locator('article[data-phase]:not([data-kind="maintenance"])')).toHaveCount(0);
  await expect(main.getByText('No public notices are published')).toHaveCount(0);
  await page.context().close();
});

test(`${J} #6 subscribe to status updates by email: proof of work in the browser, a failed check stores nothing, SMS and push named not offered`, async ({
  browser,
}) => {
  await configureStatusPage({ components: COMPONENTS, ...TEST_VALUES, ...TEST_SAFEGUARDS });
  // A request whose proof of work does not hold is refused, and no subscriber or confirmation is stored for it.
  const challenge = await publicMutate('statusPage.subscriptions.challenge');
  const token = challenge.json.result.data.token;
  const refused = await publicMutate('statusPage.subscriptions.subscribe', {
    email: SUBSCRIBER,
    componentIds: null,
    challenge: { token, nonce: 'zzzzzzzz' },
  });
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.json)).toContain('status.challenge_failed');
  expect(await findSubscriber(SUBSCRIBER)).toBeNull();
  expect(statusMail(SUBSCRIBER)).toHaveLength(0);

  const page = await visitor(browser);
  await page.goto('/status');
  const form = page.getByTestId('status-subscribe');
  await expect(form.getByRole('heading', { name: 'Get status updates' })).toBeVisible();
  await expect(form.getByTestId('status-subscribe-channels')).toContainText('Text messages: not offered in this build.');
  await expect(form.getByTestId('status-subscribe-email-off')).toHaveCount(0);
  await expect(form.getByTestId('status-subscribe-channels')).toContainText('vendor.sms');
  await expect(form.getByTestId('status-subscribe-channels')).toContainText('vendor.push');
  await form.getByLabel('Email address').fill(SUBSCRIBER);
  await form.getByLabel('Only these components').check();
  await form.getByLabel('Trading').check();
  await form.getByRole('button', { name: 'Subscribe' }).click();
  await expect(form.getByTestId('status-subscribe-sent')).toContainText('Check your inbox');

  const stored = await findSubscriber(SUBSCRIBER);
  expect(stored).toMatchObject({ state: 'unconfirmed', componentIds: ['trading'], webhookUrl: null });
  const mail = statusMail(SUBSCRIBER);
  expect(mail).toHaveLength(1);
  expect(mail[0].subject).toBe('Confirm your status updates');
  await page.context().close();
});

test(`${J} #7 confirm by the emailed link, twice is one subscriber; choose components; a private webhook is refused`, async ({
  browser,
}) => {
  const [confirmMail] = statusMail(SUBSCRIBER);
  const link = linkIn(confirmMail, '/status/confirm');
  const page = await visitor(browser);
  await page.goto(link);
  // Opening the link changes nothing until Confirm is pressed.
  await expect(page.getByRole('heading', { level: 1, name: 'Confirm status updates' })).toBeVisible();
  expect((await findSubscriber(SUBSCRIBER)).state).toBe('unconfirmed');
  await expect(page).toHaveURL(/\/status\/confirm$/);
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'You’re subscribed' })).toBeVisible();
  const manage = page.getByTestId('status-subscription-manage');
  await expect(manage.getByTestId('status-subscription-state')).toHaveText('Active');

  for (const url of ['https://127.0.0.1/status-hook', 'https://10.1.2.3/status-hook', 'https://localhost/status-hook']) {
    await manage.getByLabel('Webhook (optional, https only)').fill(url);
    await manage.getByRole('button', { name: 'Save choices' }).click();
    await expect(manage.getByTestId('status-subscription-refused')).toContainText('status.webhook_target_refused');
  }
  expect((await findSubscriber(SUBSCRIBER)).webhookUrl).toBeNull();
  await manage.getByLabel('Webhook (optional, https only)').fill('');
  await manage.getByLabel('Only these components').check();
  await manage.getByLabel('Wallets').check();
  await manage.getByRole('button', { name: 'Save choices' }).click();
  await expect(manage.getByTestId('status-subscription-saved')).toBeVisible();
  expect((await findSubscriber(SUBSCRIBER)).componentIds.sort()).toEqual(['trading', 'wallets']);

  // The same link a second time: the same one active subscriber, nothing new sent.
  const again = await visitor(browser);
  await again.goto(link);
  await again.getByRole('button', { name: 'Confirm' }).click();
  await expect(again.getByTestId('status-subscription-state')).toHaveText('Active');
  const stored = await findSubscriber(SUBSCRIBER);
  expect(stored).toMatchObject({ state: 'active', email: SUBSCRIBER });
  expect(statusMail(SUBSCRIBER)).toHaveLength(1);
  await page.context().close();
  await again.context().close();
});

test(`${J} #8 a published incident on a chosen component is emailed once with an unsubscribe link that works`, async ({ browser }) => {
  const publish = async (suffix, components) => {
    const key = `${J}-notify-${suffix}-${RUN}`;
    return publishNotice(
      await draftNotice({
        kind: 'incident',
        title: `TEST ${suffix} incident ${RUN}`,
        body: `TEST ${suffix}`,
        minutes: 15,
        key,
        impact: 'minor',
        components,
      }),
      key,
    );
  };
  const before = statusMail(SUBSCRIBER).length;
  const opened = [];
  const card = await publish('card', ['card-network']);
  opened.push(card);
  expect(await statusMailAtLeast(SUBSCRIBER, before + 1, 2_000)).toHaveLength(before);
  const notice = await publish('trading', ['trading']);
  opened.push(notice);
  const updates = (await statusMailAtLeast(SUBSCRIBER, before + 1)).filter((mail) => mail.subject.startsWith('Status update'));
  expect(updates).toHaveLength(1);
  expect(updates[0].subject).toBe(`Status update: TEST trading incident ${RUN}`);
  expect(updates[0].key).toBe(`${notice.id}:${(await findSubscriber(SUBSCRIBER)).deliveries[0].subscriberId}:email`);
  const delivered = (await findSubscriber(SUBSCRIBER)).deliveries.filter((row) => row.event === notice.id);
  expect(delivered).toEqual([expect.objectContaining({ channel: 'email', status: 'accepted', attempts: 1 })]);

  const page = await visitor(browser);
  await page.goto(linkIn(updates[0], '/status/unsubscribe'));
  await expect(page.getByRole('heading', { level: 1, name: 'Stop status updates' })).toBeVisible();
  expect((await findSubscriber(SUBSCRIBER)).state).toBe('active');
  await page.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(page.getByTestId('status-subscription-left')).toContainText('No more status updates');
  expect((await findSubscriber(SUBSCRIBER)).state).toBe('unsubscribed');

  const sent = statusMail(SUBSCRIBER).length;
  opened.push(await publish('after', ['trading']));
  expect(await statusMailAtLeast(SUBSCRIBER, sent + 1, 2_000)).toHaveLength(sent);
  // Resolve what this step opened, so a later run on the same stack starts with no open incident.
  for (const row of opened) {
    const key = `${J}-notify-resolve-${row.id}`;
    await publishNotice(
      await draftNotice({ kind: 'incident', title: row.title, body: 'TEST resolved', minutes: 15, key, parentId: row.id, resolves: true }),
      key,
    );
  }
  await page.context().close();
});

test(`${J} #9 copy the badge snippet for a component: operational with a cache time within the staleness window, or no data; an unknown id is not found`, async ({
  browser,
}) => {
  await configureStatusPage({ components: COMPONENTS, ...TEST_VALUES });
  await recordReading({
    componentId: 'trading',
    state: 'operational',
    observedAt: new Date(Date.now() - 30_000).toISOString(),
    source: 'TEST probe',
  });
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const page = await context.newPage();
  await page.goto('/status');
  const share = page.getByTestId('status-share');
  await expect(share.getByRole('heading', { name: 'Share this status' })).toBeVisible();
  await share.getByLabel('Show').selectOption('trading');
  await share.getByRole('button', { name: 'Copy HTML' }).click();
  await expect(share.getByRole('button', { name: 'Copied' })).toBeVisible();
  const snippet = await page.evaluate(() => navigator.clipboard.readText());
  const image = `${ORIGIN}/api/notify/status/badge.svg?component=trading`;
  expect(snippet).toBe(`<a href="${ORIGIN}/status"><img src="${image}" alt="Trading status"></a>`);
  // The preview on the page is the badge itself, drawn by the service.
  await expect(share.getByTestId('status-share-image')).toHaveJSProperty('complete', true);
  expect(await share.getByTestId('status-share-image').evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);

  const fresh = await fetch(image);
  expect(fresh.status).toBe(200);
  expect(fresh.headers.get('content-type')).toContain('image/svg+xml');
  const svg = await fresh.text();
  expect(svg).toContain('<title>Trading: operational</title>');
  expect(svg).not.toMatch(/<script|<foreignObject/i);
  const json = await (
    await fetch(`${ORIGIN}/api/notify/trpc/statusPage.badge?input=${encodeURIComponent(JSON.stringify({ componentId: 'trading' }))}`)
  ).json();
  expect(json.result.data).toMatchObject({ state: 'operational', label: 'operational' });
  // The service's own cache time: what is left of the reading's window, capped at its 300-second ceiling
  // (STATUS_BADGE_MAX_AGE_SECONDS, svc-notify badge.ts), and more than none while the reading is fresh. The reading is the
  // one the page holds for Trading, read back, not assumed to be the one recorded above.
  const statusRead = await (await fetch(`${ORIGIN}/api/notify/trpc/statusPage.read`)).json();
  const { reading } = statusRead.result.data.components.find((c) => c.id === 'trading');
  const readingAge = (Date.parse(json.result.data.asOf) - Date.parse(reading.observedAt)) / 1000;
  expect(readingAge).toBeGreaterThanOrEqual(0);
  expect(readingAge).toBeLessThan(TEST_VALUES.stalenessSeconds);
  expect(json.result.data.maxAgeSeconds).toBe(Math.min(300, Math.floor(TEST_VALUES.stalenessSeconds - readingAge)));
  expect(json.result.data.maxAgeSeconds).toBeGreaterThan(0);
  expect(json.result.data.maxAgeSeconds).toBeLessThanOrEqual(TEST_VALUES.stalenessSeconds - readingAge);
  // The badge is cacheable, by embedders and caches, for exactly that time: svc-notify sends it (badge.ts
  // statusBadgeCacheControl) and Edge passes it on (PR 6817), but at the public address it never arrives: the origin
  // adds no-store to every /api/ reply (the local stack's proxy; apps/customer/nginx.conf in production), so this clause
  // stays red by name. Soft, so the rest of the step is still proven; the step still fails. The image was fetched a moment
  // before the JSON, so its max-age may be one second more than the JSON's, never less.
  const cacheControl = fresh.headers.get('cache-control');
  const sent = /^public, max-age=(\d+)$/.exec(cacheControl ?? '');
  expect
    .soft(
      [0, 1],
      `BLOCKED (badge_cache_dropped): the customer origin overwrites every /api/ answer with no-store (Edge passes the badge's own Cache-Control since PR 6817), so the badge cannot be cached (sent: ${cacheControl})`,
    )
    .toContain(sent ? Number(sent[1]) - json.result.data.maxAgeSeconds : null);

  // A component with no reading says no data.
  expect(await (await fetch(`${ORIGIN}/api/notify/status/badge.svg?component=wallets`)).text()).toContain(
    '<title>Wallets: no data</title>',
  );
  // An unknown id is not found, and no image comes back.
  const unknown = await fetch(`${ORIGIN}/api/notify/status/badge.svg?component=no-such-component`);
  expect(unknown.status).toBe(404);
  expect(unknown.headers.get('content-type')).not.toContain('image/');
  // The refusal names Edge's request id, the same one as its header (DV-errors-01, svc-edge `reply-envelope.ts`).
  expect(unknown.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  expect(await unknown.json()).toEqual({ code: 'status.component_unknown', requestId: unknown.headers.get('x-request-id') });
  // The JSON read the snippet uses refuses it by the same code, with no badge in it.
  const unknownJson = await (await fetch(badgeJson('no-such-component'))).json();
  expect(unknownJson.result).toBeUndefined();
  expect(JSON.stringify(unknownJson.error)).toContain('status.component_unknown');
  // A refusal changes nothing: the badge still reads the same.
  expect(await (await fetch(image)).text()).toContain('<title>Trading: operational</title>');

  // The page offers the image link and the plain link only: no frame of any kind.
  await expect(share.getByTestId('status-share-url')).toHaveValue(image);
  await expect(page.locator('iframe, frame, object, embed')).toHaveCount(0);
  // The badge carries no personal data: no address, no person, only the component and its state.
  expect(svg).not.toContain('@');

  // No reading, or one older than the staleness window, is no data, cached no longer than the window.
  const noData = await (await fetch(badgeJson('wallets'))).json();
  expect(noData.result.data).toMatchObject({ state: 'no_data', label: 'no data' });
  expect(noData.result.data.maxAgeSeconds).toBeLessThanOrEqual(Math.min(300, TEST_VALUES.stalenessSeconds));
  await recordReading({
    componentId: 'card-network',
    state: 'operational',
    observedAt: new Date(Date.now() - (TEST_VALUES.stalenessSeconds + 60) * 1000).toISOString(),
    source: 'TEST card scheme status page',
  });
  expect(await (await fetch(`${ORIGIN}/api/notify/status/badge.svg?component=card-network`)).text()).toContain(
    '<title>Card network: no data</title>',
  );
  const stale = await (await fetch(badgeJson('card-network'))).json();
  expect(stale.result.data).toMatchObject({ state: 'no_data', label: 'no data' });
  expect(stale.result.data.maxAgeSeconds).toBeLessThanOrEqual(Math.min(300, TEST_VALUES.stalenessSeconds));

  // The top-level badge says the page's overall state, cached no longer than its freshest-expiring component.
  const top = await fetch(`${ORIGIN}/api/notify/status/badge.svg`);
  expect(top.status).toBe(200);
  expect(top.headers.get('content-type')).toContain('image/svg+xml');
  const topJson = (await (await fetch(badgeJson(null))).json()).result.data;
  expect(await top.text()).toContain(`<title>Platform status: ${topJson.label}</title>`);
  const tradingNow = (await (await fetch(badgeJson('trading'))).json()).result.data;
  expect(topJson.maxAgeSeconds).toBeLessThanOrEqual(tradingNow.maxAgeSeconds + 1);

  // A blank staleness window shows every reading as stale: the badge says no data and is not cached at all.
  await configureStatusPage({ stalenessSeconds: null }, 'TEST journey J-support-public-07: blank staleness window');
  try {
    // The image route serves a read a few seconds old (svc-notify index.ts badgeRead); the next read re-derives.
    await expect
      .poll(async () => (await (await fetch(image)).text()).match(/<title>[^<]*<\/title>/)?.[0], { timeout: 20_000 })
      .toBe('<title>Trading: no data</title>');
    const blank = await fetch(image);
    expect(blank.headers.get('cache-control') ?? '').not.toMatch(/public|max-age=[1-9]/);
    expect((await (await fetch(badgeJson('trading'))).json()).result.data).toMatchObject({ state: 'no_data', maxAgeSeconds: 0 });
  } finally {
    await configureStatusPage({ stalenessSeconds: TEST_VALUES.stalenessSeconds });
  }
  await context.close();
});

const badgeJson = (componentId) =>
  `${ORIGIN}/api/notify/trpc/statusPage.badge?input=${encodeURIComponent(JSON.stringify({ componentId }))}`;
