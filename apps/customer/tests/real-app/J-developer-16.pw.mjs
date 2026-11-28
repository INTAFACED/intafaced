// World: book, restart
import { API_VERSIONS, LATEST_API_VERSION } from '@intafaced/contracts/api-versions';
import { test, expect } from './journey.mjs';
import { codeOf, keyHolder, makeKey, signedOutVisitor, withKey } from './developer.mjs';
import { draftNotice, publishNotice } from './notices.mjs';
import { configureStatusPage, recordReading } from './status-page.mjs';
import { utcDay } from './clock.mjs';
import { EDGE, restartService } from './stack.mjs';

// J-developer-16, in the running app (docs/roadmap/journeys.json): a developer keeps up with API changes and status.
// They read live component status as a page and as data, read the changelog and the advance notice of breaking changes
// before the cutover date, and call /api/v1 with a dated version header (or their account default), and get refused with
// neither or with an unknown version; a deprecated field comes back with an advisory. Tests titled "J-developer-16 #<n>"
// prove a whole step.
const J = 'J-developer-16';
const RUN = Date.now().toString(36);

test.describe.configure({ mode: 'serial' });

// The founders' status page for #1 and #2, on notify's own new database (LOCAL_STACK_NOTIFY_NOTICES=off,
// local-stack-services/notify.mjs): nothing any other journey published is on it, so its incident list starts empty.
const COMPONENTS = [
  { id: 'rest-api', name: 'TEST REST API', group: 'Developer API', source: null },
  { id: 'webhooks', name: 'TEST Webhooks', group: 'Developer API', source: null },
];
/** The labelled TEST owner values this journey runs with. Production has none until the owner sets them. */
const TEST_VALUES = { componentCap: 5, stalenessSeconds: 600, uptimeDays: 7 };
let emptyBoard = false;
/** When #1's TEST reading was observed: #2 finds it on that day's uptime, which is yesterday on a run just after midnight UTC. */
let readingAt = null;

async function useEmptyBoard(on) {
  await restartService('notify', { LOCAL_STACK_NOTIFY_NOTICES: on ? 'off' : null });
  emptyBoard = on;
}

test.afterAll(async () => {
  // Whatever happened, notify goes back on the stack's own database.
  if (emptyBoard) await useEmptyBoard(false);
});

const component = (main, id) => main.getByTestId(`status-component-${id}`);
const whenUtc = (iso) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

test(`${J} #1 /status shows each component's state with an as-of time and an empty incident list; a component with no data reads "No data"`, async ({
  browser,
}) => {
  // One restart of notify (up to two minutes), then the browser steps.
  test.setTimeout(300_000);
  await useEmptyBoard(true);
  await configureStatusPage({ components: COMPONENTS, ...TEST_VALUES }, `TEST journey ${J} #1`);
  const observedAt = new Date(Date.now() - 30_000).toISOString();
  readingAt = observedAt;
  await recordReading({ componentId: 'rest-api', state: 'operational', observedAt, source: 'TEST probe' });

  const page = await signedOutVisitor(browser);
  await page.goto('/status');
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Platform status', exact: true })).toBeVisible();
  // The page's own as-of time, and the time of the reading the state rests on.
  await expect(main.getByTestId('status-asof')).toContainText(/As of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  await expect(component(main, 'rest-api')).toHaveAttribute('data-state', 'operational');
  await expect(component(main, 'rest-api')).toContainText('Operational');
  await expect(component(main, 'rest-api')).toContainText(`Reading from TEST probe at ${whenUtc(observedAt)}`);
  await expect(component(main, 'webhooks')).toHaveAttribute('data-state', 'no_data');
  await expect(component(main, 'webhooks')).toContainText('No data');
  const incidents = main.getByTestId('status-incidents');
  await expect(incidents).toContainText('No incident has been published.');
  await expect(incidents.locator('article')).toHaveCount(0);
  await page.context().close();
});

test(`${J} #2 the machine feed lists components, incidents with impact and updates, and uptime history`, async ({
  browser,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  if (!emptyBoard) throw new Error('#1 left no status page of this journey to read');
  try {
    const title = `TEST slow API answers ${RUN}`;
    const root = await publishNotice(
      await draftNotice({
        kind: 'incident',
        title,
        body: 'TEST investigating slow answers',
        minutes: 10,
        key: `${J}-incident-${RUN}`,
        impact: 'minor',
        components: ['rest-api'],
      }),
      `${J}-incident-${RUN}`,
    );
    await publishNotice(
      await draftNotice({
        kind: 'incident',
        title,
        body: 'TEST fix deployed, watching',
        minutes: 10,
        key: `${J}-update-${RUN}`,
        parentId: root.id,
        impact: 'major',
      }),
      `${J}-update-${RUN}`,
    );

    // As a developer's program reads it: signed out, plain JSON. The feed may answer a read a few seconds old.
    const read = async () => {
      const res = await fetch(`${EDGE}/api/notify/v1/status`);
      expect(res.status).toBe(200);
      return res.json();
    };
    await expect.poll(async () => (await read()).incidents.find((i) => i.id === root.id)?.updates.length ?? 0, { timeout: 30_000 }).toBe(2);
    const feed = await read();
    expect(Date.parse(feed.asOf)).not.toBeNaN();
    expect(feed.components.map((c) => c.id)).toEqual(['rest-api', 'webhooks']);
    const api = feed.components.find((c) => c.id === 'rest-api');
    // The open incident sets the component's state from its latest impact (major: partial outage).
    expect(api.state).toBe('partial_outage');
    expect(api.basis).toBe('incident');
    expect(api.incidentId).toBe(root.id);
    expect(feed.components.find((c) => c.id === 'webhooks').state).toBe('no_data');
    // Uptime history: one day per day of the window, oldest first, ending on the feed's own day; #1's reading counts on
    // the day it was observed, which is yesterday on a run just after midnight UTC.
    for (const c of feed.components) expect(c.uptime).toHaveLength(TEST_VALUES.uptimeDays);
    expect(api.uptime.at(-1).date).toBe(utcDay(new Date(feed.asOf)));
    if (!readingAt) throw new Error('#1 recorded no reading of this journey to find');
    expect(api.uptime.find((day) => day.date === utcDay(new Date(readingAt)))).toMatchObject({ state: 'operational' });
    expect(feed.components.find((c) => c.id === 'webhooks').uptime.every((day) => day.state === null)).toBe(true);
    // The incident with its impact and both updates.
    expect(feed.incidents).toHaveLength(1);
    const [incident] = feed.incidents;
    expect(incident).toMatchObject({ id: root.id, title, impact: 'major', components: ['rest-api'], resolvedAt: null });
    expect(incident.updates.map((u) => [u.body, u.impact])).toEqual([
      ['TEST investigating slow answers', 'minor'],
      ['TEST fix deployed, watching', 'major'],
    ]);

    // The feed as the developer reads it in a browser: the same JSON, with the incident, its updates and the uptime days.
    const page = await signedOutVisitor(browser);
    await page.goto(`${EDGE}/api/notify/v1/status`);
    const shown = JSON.parse(await page.locator('pre').first().innerText());
    expect(shown.components.map((c) => [c.id, c.uptime.length])).toEqual([
      ['rest-api', TEST_VALUES.uptimeDays],
      ['webhooks', TEST_VALUES.uptimeDays],
    ]);
    expect(shown.incidents.map((i) => [i.id, i.impact, i.updates.length])).toEqual([[root.id, 'major', 2]]);
    await stepPicture(page);
    await page.context().close();
  } finally {
    await useEmptyBoard(false);
  }
});

// #3 and #4: TEST changelog entries, published through the founders' four-eyes desk as an operator would.
const releaseOn = utcDay(Date.now() + 30 * 86_400_000);
const retiredEndpoint = `GET /api/v1/test-${RUN}/legacy`;
const dated = { title: `TEST ${RUN}: the legacy list is retired`, body: `TEST ${RUN}: read the new list instead.` };
const undated = { title: `TEST ${RUN}: order replies change shape`, body: `TEST ${RUN}: a date is not set yet.` };

test(`${J} #3 the developer changelog shows dated entries by area with a breaking flag; an entry with no date reads "date not set" and is not upcoming`, async ({
  browser,
  stepPicture,
}) => {
  for (const [key, text, changelog] of [
    [
      `${RUN}-dated`,
      dated,
      {
        area: 'trading',
        breaking: true,
        addedOn: utcDay(new Date()),
        releaseOn,
        migrationNote: 'TEST call the new list.',
        retired: [retiredEndpoint],
      },
    ],
    [`${RUN}-undated`, undated, { area: 'websocket', breaking: true, migrationNote: 'TEST read the new shape.' }],
  ]) {
    const draft = await draftNotice({ kind: 'changelog', ...text, minutes: 15, key: `${J}-${key}`, changelog });
    expect((await publishNotice(draft, `${J}-${key}`)).status).toBe('published');
  }

  const page = await signedOutVisitor(browser);
  await page.goto('/developers/changelog');
  await expect(page.getByRole('heading', { name: 'Changelog', level: 1, exact: true })).toBeVisible();
  const datedEntry = page.locator('article').filter({ has: page.getByRole('heading', { name: dated.title, exact: true }) });
  await expect(datedEntry).toHaveAttribute('data-breaking', 'true');
  await expect(datedEntry).toContainText('Trading · Breaking');
  await expect(datedEntry).toContainText(`In effect ${releaseOn}`);
  await expect(datedEntry).toContainText(retiredEndpoint);
  const undatedEntry = page.locator('article').filter({ has: page.getByRole('heading', { name: undated.title, exact: true }) });
  await expect(undatedEntry).toHaveAttribute('data-breaking', 'true');
  await expect(undatedEntry).toContainText('WebSocket · Breaking');
  await expect(undatedEntry).toContainText('In effect date not set');
  // The changelog with both entries, before the area filter and the upcoming page.
  await stepPicture(page);

  // By area: only the trading entry under Trading.
  await page.getByRole('combobox', { name: 'Area', exact: true }).selectOption('trading');
  await expect(page.getByRole('heading', { name: dated.title, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: undated.title, exact: true })).toHaveCount(0);

  await page.goto('/developers/changelog/upcoming');
  await expect(page.getByRole('heading', { name: 'Upcoming breaking changes', level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: dated.title, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: undated.title, exact: true })).toHaveCount(0);
  await page.context().close();
});

test(`${J} #4 /notice gives advance notice of breaking changes, with cutover dates and the retired list`, async ({
  browser,
  stepPicture,
}) => {
  const page = await signedOutVisitor(browser);
  await page.goto('/notice');
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Notices', exact: true })).toBeVisible();
  const notice = main.getByTestId('breaking-changes');
  await expect(notice.getByRole('heading', { level: 2, name: 'Upcoming breaking changes', exact: true })).toBeVisible();
  const entry = notice.locator('article').filter({ has: page.getByRole('heading', { name: dated.title, exact: true }) });
  await expect(entry).toHaveAttribute('data-breaking', 'true');
  await expect(entry).toContainText(`In effect ${releaseOn}`);
  await expect(entry).toContainText('TEST call the new list.');
  // An entry with no cutover date is no advance notice: it is not here.
  await expect(notice.getByRole('heading', { name: undated.title, exact: true })).toHaveCount(0);
  // The retired list: the endpoint, the entry that retires it and its date.
  await expect(notice.getByRole('heading', { level: 2, name: 'Retired endpoints', exact: true })).toBeVisible();
  const row = notice.locator('tr').filter({ has: page.getByRole('rowheader', { name: retiredEndpoint }) });
  await expect(row).toContainText(`Retired by ${dated.title}`);
  await expect(row).toContainText(releaseOn);
  await stepPicture(page);
  await page.context().close();
});

// #5 and #6: a developer's key, as a program uses it. `withKey` sends the newest version unless told otherwise.
let holder;
let key;
const echo = (reply) => [reply.headers.get('intafaced-version'), reply.headers.get('intafaced-version-source')];

test(`${J} #5 the version header applies and is echoed; without one the account default applies; with neither, version.unset; an unknown one is refused`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  holder = await keyHolder(browser, 'dev16');
  key = await makeKey(holder.page, { name: `dev16-${RUN}` });
  const path = '/api/v1/account/balance';

  // With the header: that version applies and is echoed.
  const pinned = await withKey(key, { path, version: LATEST_API_VERSION });
  expect(pinned.status, JSON.stringify(pinned.body).slice(0, 300)).toBe(200);
  expect(echo(pinned)).toEqual([LATEST_API_VERSION, 'header']);

  // Without one, before the account has a default: refused, never answered as the latest.
  const unset = await withKey(key, { path, version: null });
  expect(unset.status).toBe(400);
  expect(codeOf(unset.body)).toBe('version.unset');
  expect(unset.body.message).toContain('intafaced-version header');
  expect(unset.body.message).toContain('account default API version');
  expect(unset.body).not.toHaveProperty('balances');
  expect(echo(unset)).toEqual([null, null]);

  // The developer sets the account default on the keys page.
  const { page } = holder;
  await page.goto('/uc/safe/api-keys');
  const panel = page.getByTestId('api-version');
  await expect(panel.getByRole('heading', { level: 2, name: 'API version', exact: true })).toBeVisible();
  await expect(panel.getByTestId('api-version__default')).toHaveText('Account default: not set');
  for (const version of API_VERSIONS) await expect(panel.getByTestId('api-version__versions')).toContainText(version);
  await panel.getByRole('combobox', { name: 'Version to use by default', exact: true }).selectOption(LATEST_API_VERSION);
  await panel.getByRole('button', { name: 'Set as default', exact: true }).click();
  await expect(panel.getByTestId('api-version__outcome')).toHaveText(`The account default is now ${LATEST_API_VERSION}.`);
  await expect(panel.getByTestId('api-version__default')).toContainText(`Account default: ${LATEST_API_VERSION}`);
  // Setting the same version again changes nothing, and says so.
  await panel.getByRole('button', { name: 'Set as default', exact: true }).click();
  await expect(panel.getByTestId('api-version__outcome')).toHaveText(
    `The account default was already ${LATEST_API_VERSION}. Nothing changed.`,
  );
  // The deprecations the API publishes, with their replacement; the removal date is the owner's and not set.
  const deprecations = panel.getByTestId('api-version__deprecations');
  await expect(deprecations).toContainText('POST /api/v1/orders stopPx');
  await expect(deprecations).toContainText('stopPrice');
  await expect(deprecations).toContainText('removal date not set');

  // Without a header now: the account default applies and is echoed as its source.
  const byDefault = await withKey(key, { path, version: null });
  expect(byDefault.status, JSON.stringify(byDefault.body).slice(0, 300)).toBe(200);
  expect(echo(byDefault)).toEqual([LATEST_API_VERSION, 'account']);

  // An unknown version is refused, default or not, and forwarded nowhere.
  for (const version of ['1999-01-01', 'latest']) {
    const unknown = await withKey(key, { path, version });
    expect(unknown.status).toBe(400);
    expect(codeOf(unknown.body)).toBe('version.unknown');
    expect(unknown.body.message).toContain(LATEST_API_VERSION);
    expect(unknown.body).not.toHaveProperty('balances');
  }
});

test(`${J} #6 a call with a deprecated field carries the advisory header and entry`, async ({ stepPicture }) => {
  if (!key) throw new Error('#5 left no key to call with');
  const order = { symbol: 'BTC/USDT', type: 'stop_limit', side: 'buy', amount: '0.0001', price: '1' };
  const deprecated = await withKey(key, {
    method: 'POST',
    path: '/api/v1/orders',
    body: { ...order, stopPx: '1', clientOrderId: `dev16-px-${RUN}` },
  });
  // Whatever the order's own answer (this TEST account holds nothing), the version applied and the advisory is there.
  expect(['version.unset', 'version.unknown']).not.toContain(codeOf(deprecated.body));
  expect(echo(deprecated)).toEqual([LATEST_API_VERSION, 'header']);
  expect(deprecated.headers.get('deprecation')).toBe(`@${Date.parse(`${LATEST_API_VERSION}T00:00:00Z`) / 1000}`);
  expect(deprecated.headers.get('link')).toBe('</developers/changelog>; rel="deprecation"');
  // No removal date is set, so no Sunset.
  expect(deprecated.headers.get('sunset')).toBeNull();
  const advisories = JSON.parse(deprecated.headers.get('intafaced-advisories') ?? 'null');
  expect(advisories).toEqual([
    expect.objectContaining({ method: 'POST', path: '/api/v1/orders', field: 'stopPx', replacement: 'stopPrice', sunset: null }),
  ]);

  // The same order with the documented field carries no advisory.
  const current = await withKey(key, {
    method: 'POST',
    path: '/api/v1/orders',
    body: { ...order, stopPrice: '1', clientOrderId: `dev16-price-${RUN}` },
  });
  expect(echo(current)).toEqual([LATEST_API_VERSION, 'header']);
  expect(current.headers.get('deprecation')).toBeNull();
  expect(current.headers.get('intafaced-advisories')).toBeNull();

  // The advisory's entry as the developer finds it on the keys page: the deprecated field and its replacement.
  const { page } = holder;
  await page.goto('/uc/safe/api-keys');
  const deprecations = page.getByTestId('api-version').getByTestId('api-version__deprecations');
  await expect(deprecations).toContainText(`${advisories[0].method} ${advisories[0].path} ${advisories[0].field}`);
  await expect(deprecations).toContainText(advisories[0].replacement);
  await expect(deprecations).toContainText('removal date not set');
  await stepPicture(page);
  await page.context().close();
});
