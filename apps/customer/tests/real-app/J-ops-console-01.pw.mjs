import { expect, test } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-01: a founder signs in to the console and sees how every module is doing.
// Steps covered here: #1 (sign in as a founder) and #5 (the same eight sections on each of the five desks).
const SECTIONS = ['overview', 'items', 'failures', 'limits', 'halt', 'approvals', 'audit', 'exports'];
const DESKS = [
  { path: '/bank-ops', title: 'Bank operations' },
  { path: '/pay-ops', title: 'Personal Pay operations' },
  { path: '/academy-ops', title: 'Academy operations' },
  { path: '/more-ops/mining', title: 'Mining operations' },
  { path: '/more-ops/predict', title: 'Predict operations' },
];

test.describe.configure({ mode: 'serial' });

test('J-ops-console-01 #1 a founder signs in to the console', async ({ page }) => {
  await founderSignIn(page, 'a');
  await expect(page.getByText('Founder', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' }).or(page.getByRole('link', { name: 'Sign out' }))).toBeVisible();
});

test('J-ops-console-01 #5 each of the five desks shows all eight common sections, and a section with no source names its blocker', async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  for (const desk of DESKS) {
    await page.goto(`${ADMIN}${desk.path}`);
    await expect(page.getByRole('heading', { level: 1, name: desk.title })).toBeVisible();
    const set = page.getByTestId('common-sections');
    await expect(set).toBeVisible();
    for (const id of SECTIONS) await expect(set.getByTestId(`common-${id}`), `${desk.path} ${id}`).toBeVisible();
    // Every unwired section says why, with the typed code; none is hidden or drawn as a zero.
    const unwired = set.locator('[data-state="unwired"]');
    for (const card of await unwired.all()) {
      await expect(card).toContainText('no source');
      await expect(card).toContainText('ops.desk_section_unwired');
    }
    if (desk.path === '/more-ops/predict') await expect(unwired).toHaveCount(8);
  }
  // A wired section links to the desk's own section on the page.
  await page.goto(`${ADMIN}/bank-ops`);
  await page.getByTestId('common-limits').getByRole('link', { name: 'Loans book' }).click();
  await expect(page).toHaveURL(/#loans$/);
  await expect(page.getByTestId('section-loans')).toBeInViewport();
});
