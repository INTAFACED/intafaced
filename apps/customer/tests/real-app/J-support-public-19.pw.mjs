import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { configureStatusPage, statusDefinition } from './status-page.mjs';
import { ORIGIN } from './stack.mjs';

// J-support-public-19, in the running app (docs/roadmap/journeys.json): two operators publish an incident, a maintenance
// window and an announcement from the founder console's notify desk, and the public pages, the notice board and the
// subscribers show the same truth. Tests titled "J-support-public-19 #<n>" prove a whole step.
const J = 'J-support-public-19';

test.describe.configure({ mode: 'serial' });

/** The labelled TEST owner values this journey defines. A short staleness window, so a hand reading goes stale in the run. */
const TEST_STALENESS_SECONDS = 20;
const OUTSIDE_SOURCE = 'TEST SMS provider status page';
// Ids of this journey's own: readings are kept per component, and J-support-public-07 reads trading, wallets and card-network.
const COMPONENTS = [
  { id: 'api', name: 'API', group: 'Platform', source: '' },
  { id: 'payments', name: 'Payments', group: 'Platform', source: '' },
  { id: 'sms-gateway', name: 'SMS gateway', group: 'Outside dependencies', source: OUTSIDE_SOURCE },
];

/** Founder A on the console's status page desk, in a context of its own. */
async function statusDesk(browser) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, 'a');
  await page.goto('/notify/status');
  await expect(page.getByRole('heading', { level: 1, name: 'Status page' })).toBeVisible();
  return page;
}

/** The definition this journey found, put back after it so the stack keeps what other journeys set. */
let found;
test.beforeAll(async () => {
  found = await statusDefinition();
});
test.afterAll(async () => {
  if (!found) return;
  await configureStatusPage(
    {
      components: found.components,
      componentCap: found.componentCap,
      stalenessSeconds: found.stalenessSeconds,
      uptimeDays: found.uptimeDays,
    },
    `TEST journey ${J}: put back the definition it found`,
  );
});

test(`${J} #1 define components and groups and a manual outside entry: it shows its source and age, then goes stale to No data`, async ({
  browser,
}) => {
  // From an empty page, so every row below is the operator's own.
  await configureStatusPage(
    { components: [], componentCap: 5, stalenessSeconds: TEST_STALENESS_SECONDS },
    `TEST journey ${J}: start empty`,
  );
  const page = await statusDesk(browser);
  await expect(page.getByTestId('status-visible-none')).toContainText('No components are defined');
  await expect(page.getByTestId('status-reading-none')).toBeVisible();

  const define = page.getByTestId('status-define');
  for (const [i, c] of COMPONENTS.entries()) {
    await define.getByRole('button', { name: 'Add component' }).click();
    await define.getByLabel(`Row ${i + 1} id`).fill(c.id);
    await define.getByLabel(`Row ${i + 1} name`).fill(c.name);
    await define.getByLabel(`Row ${i + 1} group`).fill(c.group);
    await define.getByLabel(`Row ${i + 1} outside source`).fill(c.source);
  }
  await define.getByLabel(/^Reason/).fill(`TEST journey ${J} #1: components, groups and one outside dependency`);
  await define.getByRole('button', { name: 'Save the page' }).click();
  await expect(page.getByTestId('status-desk-outcome')).toContainText('Saved');

  // No fresh reading yet (a stack that ran this before keeps its old, stale one): No data, and it says why.
  const outside = page.getByTestId('status-visible-sms-gateway');
  await expect(outside).toContainText(`Outside: ${OUTSIDE_SOURCE}`);
  await expect(outside).toContainText('Outside dependencies');
  await expect(outside).toContainText('No data');
  await expect(outside.getByTestId('status-visible-why')).toHaveText(
    /^(nothing has been read for it yet|its latest reading is older than the staleness window)$/,
  );
  await expect(page.getByTestId('status-visible-api').getByTestId('status-visible-source')).toHaveText('Our own');

  // The operator enters the outside dependency's state by hand: it carries the source and its age.
  const reading = page.getByTestId('status-reading');
  await reading.getByLabel('Component').selectOption('sms-gateway');
  await reading.getByLabel('State').selectOption('operational');
  await reading.getByRole('button', { name: 'Store reading' }).click();
  await expect(page.getByTestId('status-desk-outcome')).toContainText('Reading stored');
  await expect(outside).toContainText('Operational');
  await expect(outside.getByTestId('status-visible-why')).toHaveText('from its latest reading');
  await expect(outside.getByTestId('status-visible-reading')).toContainText(`Operational from ${OUTSIDE_SOURCE}, `);
  await expect(outside.getByTestId('status-visible-reading')).toContainText(/\d+ s ago/);

  // The visitor sees the same component, and the same state, on /status.
  const visitor = await browser.newPage({ baseURL: ORIGIN });
  await visitor.goto('/status');
  await expect(visitor.locator('[data-testid="status-component-sms-gateway"]')).toContainText('SMS gateway');
  await expect(visitor.locator('[data-testid="status-component-sms-gateway"]')).toContainText(/operational/i);

  // Past the staleness window the reading no longer counts: No data, with the stale reading and its age still shown.
  await page.waitForTimeout((TEST_STALENESS_SECONDS + 2) * 1000);
  await page.getByRole('button', { name: 'Read again' }).click();
  await expect(outside.getByTestId('status-visible-why')).toHaveText('its latest reading is older than the staleness window');
  await expect(outside).toContainText('No data');
  await expect(outside.getByTestId('status-visible-reading')).toContainText(`Operational from ${OUTSIDE_SOURCE}, `);
  await visitor.reload();
  await expect(visitor.locator('[data-testid="status-component-sms-gateway"]')).toContainText(/no data/i);
  await visitor.context().close();
  await page.context().close();
});

test(`${J} #10 the badge page: an image link, HTML and Markdown snippet per component, on the public site`, async ({ browser }) => {
  const page = await statusDesk(browser);
  const badges = page.getByTestId('status-badges');
  await expect(badges.getByRole('heading', { name: 'Badges' })).toBeVisible();
  await expect(badges.getByTestId('status-badges-no-origin')).toHaveCount(0);
  const defined = (await statusDefinition()).components;
  expect(defined.map((c) => c.id)).toEqual(COMPONENTS.map((c) => c.id));
  for (const c of [{ id: null, name: 'Whole page' }, ...defined]) {
    const block = badges.getByTestId(`status-badge-${c.id ?? 'page'}`);
    const image = `${ORIGIN}/api/notify/status/badge.svg${c.id ? `?component=${c.id}` : ''}`;
    await expect(block.getByTestId('status-badge-image')).toHaveValue(image);
    await expect(block.getByTestId('status-badge-html')).toHaveValue(
      `<a href="${ORIGIN}/status"><img src="${image}" alt="${c.id ? c.name : 'Platform'} status"></a>`,
    );
    await expect(block.getByTestId('status-badge-markdown')).toHaveValue(
      `[![${c.id ? c.name : 'Platform'} status](${image})](${ORIGIN}/status)`,
    );
    // The link serves the badge the service draws, for exactly this component.
    const res = await fetch(image);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    if (c.id) expect(await res.text()).toContain(`<title>${c.name}: `);
  }
  // The desk opens the image on the public site (the console loads no image from another site).
  await expect(badges.getByTestId('status-badge-sms-gateway').getByRole('link', { name: 'Open the badge image' })).toHaveAttribute(
    'href',
    `${ORIGIN}/api/notify/status/badge.svg?component=sms-gateway`,
  );
  await page.context().close();
});
