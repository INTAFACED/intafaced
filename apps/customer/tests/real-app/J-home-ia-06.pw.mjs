import { test, expect } from '@playwright/test';
import { signUp } from './desk.mjs';
import { draftNotice, openNotices, publishNotice } from './notices.mjs';
import { expectServiceOff } from './service-off.mjs';
import { ORIGIN } from './stack.mjs';

// J-home-ia-06, in the running app (docs/roadmap/journeys.json): I see announcements and maintenance on Home. Tests titled
// "J-home-ia-06 #<n>" prove a whole step. The stack's two TEST founders draft and publish through the notice board's own
// four-eyes door; every notice closes a few minutes after it opens, so a run leaves the board empty for the next one.
const J = 'J-home-ia-06';
const RUN = Date.now().toString(36);
const WINDOW_MINUTES = 6;

test.describe.configure({ mode: 'serial' });

let page;
let announcement;
let maintenance;

/** Home after both notice reads have answered, so "nothing drawn" is an answer and not a page still loading. */
async function openHome() {
  const status = page.waitForResponse((res) => res.url().includes('/notify.noticeStatus'));
  const current = page.waitForResponse((res) => res.url().includes('/notify.announcement'));
  await page.goto('/home');
  await Promise.all([status, current]);
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeAttached();
}

/** "23 Oct, 05:00", as Home words an end time in the browser's own zone (UTC here). */
const dayTime = (iso) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(Date.parse(iso));

test.beforeAll(async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const context = await browser.newContext({ baseURL: ORIGIN, timezoneId: 'UTC', viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  await signUp(page, 'hmn');
  // An earlier run's notices close on their own; wait for the board to be empty rather than start on its leftovers.
  await expect
    .poll(
      async () => {
        const open = await openNotices();
        return open.incidents.length + open.maintenance.length + (open.announcement ? 1 : 0);
      },
      { timeout: (WINDOW_MINUTES + 1) * 60_000, intervals: [5_000] },
    )
    .toBe(0);
});

test.afterAll(async () => {
  await page?.context().close();
});

test(`${J} #1 with nothing published, Home draws no strip and no banner`, async () => {
  await openHome();
  await expect(page.getByTestId('home-notices')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('home-notice')).toHaveCount(0);
});

test(`${J} #4 a founder's draft never reaches the customer`, async () => {
  test.setTimeout(3 * 60_000);
  announcement = await draftNotice({
    kind: 'announcement',
    title: `TEST announcement ${RUN}`,
    body: 'TEST: a journey announcement on the local stack.',
    minutes: WINDOW_MINUTES,
    key: `${J}:${RUN}:announcement`,
  });
  maintenance = await draftNotice({
    kind: 'maintenance',
    title: `TEST maintenance ${RUN}`,
    body: 'TEST: a journey maintenance window on the local stack.',
    minutes: WINDOW_MINUTES,
    key: `${J}:${RUN}:maintenance`,
  });
  expect([announcement.status, maintenance.status]).toEqual(['draft', 'draft']);
  await openHome();
  await expect(page.getByTestId('home-notices')).toHaveCount(0);
  await expect(page.getByText(`TEST announcement ${RUN}`)).toHaveCount(0);
  await expect(page.getByText(`TEST maintenance ${RUN}`)).toHaveCount(0);
});

test(`${J} #2 a published announcement shows once, with its kind and a link to the notice`, async () => {
  test.setTimeout(3 * 60_000);
  expect((await publishNotice(announcement, `${J}:${RUN}:announcement`)).status).toBe('published');
  await openHome();
  const strip = page.getByRole('status', { name: 'Announcement' });
  await expect(strip).toHaveCount(1);
  await expect(strip).toContainText('Announcement');
  await expect(strip.getByText(`TEST announcement ${RUN}`, { exact: true })).toHaveCount(1);
  await expect(page.getByText(`TEST announcement ${RUN}`, { exact: true })).toHaveCount(1);
  await expect(strip.getByRole('link', { name: 'All notices' })).toHaveAttribute('href', '/notice');
  await strip.getByRole('link', { name: 'Read' }).click();
  await expect(page).toHaveURL(new RegExp(`/notice/${announcement.id}$`));
  await expect(page.getByText(`TEST announcement ${RUN}`).first()).toBeVisible();
});

test(`${J} #3 during an open maintenance window, a banner shows its title and end time`, async () => {
  test.setTimeout(3 * 60_000);
  const published = await publishNotice(maintenance, `${J}:${RUN}:maintenance`);
  expect(published.status).toBe('published');
  await openHome();
  const banner = page.getByRole('status', { name: 'Maintenance' });
  await expect(banner).toHaveCount(1);
  await expect(banner).toContainText(`TEST maintenance ${RUN}`);
  await expect(banner).toContainText(`Until ${dayTime(published.endsAt)}`);
  await expect(banner.getByRole('link', { name: 'Read' })).toHaveAttribute('href', `/notice/${maintenance.id}`);
  // The announcement strip is still there, once, under the banner.
  await expect(page.getByRole('status', { name: 'Announcement' })).toHaveCount(1);
});

test(`${J} #5 an action the shell cannot run because an outside service is off says one shared sentence, the same in every room`, async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: ORIGIN });
  await context.grantPermissions(['notifications']);
  const person = await context.newPage();
  await signUp(person, 'hmo');
  // Notifications: allowing this device needs the push delivery gateway, which the stack leaves unset.
  await person.goto('/notifications?view=settings');
  const push = person.locator('[data-testid="nf-channelcard"][data-channel="push"]');
  await push.getByRole('button', { name: 'Allow notifications on this device' }).click();
  const pushed = await expectServiceOff(push.locator('[data-not-connected]'), 'vendor.push', 'Registering this device');
  // Web3: staking needs the INTACHAIN launch go-ahead. Same component, same sentence, its own code.
  await person.goto('/chain/validators');
  const stake = person.locator('[data-action="stake"]');
  await expect(stake.getByRole('button', { name: 'Stake' })).toBeDisabled();
  const staked = await expectServiceOff(stake.locator('[data-not-connected]'), 'chain.go', 'Stake');
  expect(pushed.replace(/^.+ needs .+?\./, '')).toBe(' It is switched off in this build. vendor.push');
  expect(staked.replace(/^.+ needs .+?\./, '')).toBe(' It is switched off in this build. chain.go');
  await context.close();
});
