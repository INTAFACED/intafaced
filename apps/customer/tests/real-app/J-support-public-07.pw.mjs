import { test, expect } from '@playwright/test';
import { draftNotice, publishNotice } from './notices.mjs';
import { configureStatusPage, recordReading } from './status-page.mjs';
import { ORIGIN } from './stack.mjs';

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
  await expect(card.locator('.status-timeline li')).toHaveCount(2);
  await expect(card.locator('.status-timeline li').first()).toContainText('TEST fix deployed, watching');
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
  await expect(card.locator('.status-timeline li')).toHaveCount(3);
  await expect(component(main, 'trading')).toHaveAttribute('data-state', 'operational');
  await page.context().close();
});
