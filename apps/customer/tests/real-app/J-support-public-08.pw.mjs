import { test, expect } from '@playwright/test';
import { draftNotice, publishNotice } from './notices.mjs';
import { ORIGIN } from './stack.mjs';

// J-support-public-08, in the running app (docs/roadmap/journeys.json): a signed-out visitor opens the lab, partner, app and
// announcement pages, and each tells the truth about what exists. Tests titled "J-support-public-08 #<n>" prove a whole step.
const J = 'J-support-public-08';

test.describe.configure({ mode: 'serial' });

/** A signed-out visitor on a device of its own. */
async function visitor(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

test(`${J} #1 /lab is its own screen: the owner-decision reason and no sample entry`, async ({ browser }) => {
  const page = await visitor(browser);
  await page.goto('/lab');
  const main = page.locator('main');
  await expect(main.locator('[data-room="lab"]')).toBeVisible();
  await expect(main.getByRole('heading', { level: 1, name: 'Lab' })).toBeVisible();
  await expect(main.getByText('No Lab entry is published')).toBeVisible();
  await expect(main.locator('[data-not-connected="owner.decision"]')).toBeVisible();
  // Not a copy of the Campaigns room: none of its words, and no listed entry.
  await expect(main.getByText(/campaign/i)).toHaveCount(0);
  await expect(main.locator('li')).toHaveCount(0);
  for (const link of await main.getByRole('link').all()) {
    const href = await link.getAttribute('href');
    expect(['/', '/help'], `link ${href}`).toContain(href);
  }
  await page.goto('/lab/detail/not-a-real-entry');
  await expect(main.getByText('This Lab entry is not published')).toBeVisible();
  await expect(main.locator('li')).toHaveCount(0);
  await main.getByRole('link', { name: /Back to the Lab/ }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.context().close();
});

test(`${J} #2 /partner with no join address and no support email: no mailto, no contact set, terms not published`, async ({ browser }) => {
  const page = await visitor(browser);
  await page.goto('/partner');
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Work with Intafaced' })).toBeVisible();
  await expect(main.getByTestId('support-email-unset')).toHaveText('Support email is not set, so there is no email link on this page.');
  await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0);
  await expect(main.getByRole('link', { name: /partner enquiry form/ })).toHaveCount(0);
  await expect(main.getByText('No partner tiers, terms or prices are published, so none are shown.', { exact: false })).toBeVisible();
  await page.context().close();
});

test(`${J} #5 /app with nothing set: the honest state, no store link and no version`, async ({ browser }) => {
  const page = await visitor(browser);
  await page.goto('/app');
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Get the app' })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'There is no store app' })).toBeVisible();
  await expect(main.locator('a[href*="apps.apple.com"], a[href*="play.google.com"]')).toHaveCount(0);
  await expect(main.getByText(/\bv?\d+\.\d+\.\d+\b/)).toHaveCount(0);
  await expect(main.getByRole('link', { name: 'Open the web app' })).toHaveAttribute('href', '/money');
  await page.context().close();
});

test(`${J} #6 /announcement shows a published announcement from the founders' board`, async ({ browser }) => {
  test.setTimeout(120_000);
  const key = `${J}-${Date.now()}`;
  const title = `LOCAL TEST announcement ${key}`;
  const draft = await draftNotice({ kind: 'announcement', title, body: 'LOCAL TEST body for the announcement centre.', minutes: 5, key });
  await publishNotice(draft, key);
  const page = await visitor(browser);
  await page.goto('/announcement');
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Notices' })).toBeVisible();
  await expect(main.getByText(title)).toBeVisible();
  await expect(main.getByText('No public notices are published')).toHaveCount(0);
  await page.context().close();
});
