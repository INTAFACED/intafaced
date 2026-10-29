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
  const { userId } = await founderSignIn(page, 'a');
  // The session bar names the founder who signed in: its span carries their own id, and once the console's founder
  // directory is read it shows that founder's configured name. ("Founder" is only the placeholder before that read, so
  // a check on it raced the read, #6652.) The name is read back from the same directory the bar reads.
  const owners = await page.request.get(`${ADMIN}/api/crm?view=owners`);
  expect(owners.status()).toBe(200);
  const name = (await owners.json()).owners.find((owner) => owner.userId === userId)?.displayName;
  expect(name).toMatch(/^(Nitro|Phantom)$/);
  await expect(page.locator(`.adm-session > span[title="${userId}"]`)).toHaveText(name);
  await expect(page.locator(`.adm-session > span[title="${userId}"]`)).toBeVisible();
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

test('J-ops-console-01 #6 Ctrl K and "ledger" lists matching pages and actions, and Enter opens one', async ({ page }) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/crm`);
  // The shortcut works once the page is live; the Search button says so by turning on.
  await expect(page.getByRole('button', { name: /^Search/ })).toBeEnabled();
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type('ledger');
  const options = palette.getByRole('option');
  await expect(options.first()).toContainText('Ledger ops');
  await expect(palette.getByRole('option', { name: /Freeze or unfreeze ledger posting/ })).toBeVisible();
  // Nothing unrelated is listed.
  await expect(palette.getByRole('option', { name: /^CRM/ })).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/ledger$/);
  await expect(palette).toHaveCount(0);
  // Escape closes it without going anywhere.
  await page.keyboard.press('Control+k');
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(/\/ledger$/);
});
