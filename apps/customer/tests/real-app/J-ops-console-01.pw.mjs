// World: none
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './journey.mjs';
import { founderTotp, makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { FOUNDER_VAULT_NAME } from '../../../../tooling/scripts/local-test-founders.mjs';
import { ADMIN, assertAdminUp, founderSignIn } from './admin.mjs';
import { mailedCodes, nextMailedCode } from './stack.mjs';
import { staffSignIn } from './staff.mjs';

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

test('J-ops-console-01 #1 a founder follows the runbook on a clean browser and signs in, with no hidden step', async ({ browser }) => {
  // docs/LOCAL-TEST-STACK.md, "Founder console" and "Local test founders": the console is on :3100, the founder's
  // password and authenticator secret are in founders.json, and a browser the console has not seen is approved with
  // the code mailed to the founder (the stack's outbox file). Nothing is put in this browser first: no device cookie.
  await assertAdminUp();
  // The journey config starts each browser as the stack's trusted TEST browser; this one is cleared to a clean browser.
  const clean = await browser.newContext();
  try {
    await clean.clearCookies();
    const page = await clean.newPage();
    expect(await clean.cookies()).toEqual([]);
    const ctx = await makeContext({ log: () => {} });
    const founder = JSON.parse(readFileSync(path.join(ctx.paths.stateDir, FOUNDER_VAULT_NAME), 'utf8')).founders.find((f) => f.key === 'a');
    expect(founder?.totpConfirmed, 'founder a has enrolled their authenticator (pnpm local:stack enrols the pair)').toBe(true);
    expect(founder.totpSecret).toBeTruthy();
    await page.goto(`${ADMIN}/login`);
    await page.getByLabel('Email or handle').fill(founder.handle ?? founder.email);
    await page.getByLabel('Password').fill(founder.password);
    await page.getByLabel('Authenticator or recovery code').fill(await founderTotp(ctx, 'a', founder.totpSecret));
    const seen = mailedCodes(founder.email, 'new-device-code').length;
    await page.locator('button[type=submit]').click();
    // The right password and second factor on a new browser are not yet a session: the console asks for the device code.
    await expect(page.getByRole('heading', { name: 'Authorise this browser' })).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('Device code from the email').fill(await nextMailedCode(founder.email, seen, 20_000, 'new-device-code'));
    await page.getByRole('button', { name: 'Approve this browser' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
    // The session bar names the founder who signed in: its span carries their own id, and once the console's founder
    // directory is read it shows that founder's configured name. ("Founder" is only the placeholder before that read, so
    // a check on it raced the read, #6652.) The name is read back from the same directory the bar reads.
    const owners = await page.request.get(`${ADMIN}/api/crm?view=owners`);
    expect(owners.status()).toBe(200);
    const name = (await owners.json()).owners.find((owner) => owner.userId === founder.userId)?.displayName;
    expect(name).toMatch(/^(Nitro|Phantom)$/);
    await expect(page.locator(`.adm-session > span[title="${founder.userId}"]`)).toHaveText(name);
    await expect(page.locator(`.adm-session > span[title="${founder.userId}"]`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' }).or(page.getByRole('link', { name: 'Sign out' }))).toBeVisible();
    // The browser it approved is now trusted: its session is the founder's own, read back from the console.
    const session = await page.request.get(`${ADMIN}/api/session`);
    expect(session.status()).toBe(200);
    expect((await session.json()).userId).toBe(founder.userId);
  } finally {
    await clean.close();
  }
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

// #6's last clause: pages the person lacks scope for are not listed. The person is the stack's TEST support staff member
// (identity's labelled TEST roster, staff.mjs), whose role may read accounts, payments, trading and documents and not the
// ledger. The palette lists them the pages they may open and none of the ledger's pages or actions; a founder searching the
// same word is shown both (the test above).
test('J-ops-console-01 #6 scope: pages the person lacks scope for are not listed', async ({ page, browser }) => {
  await staffSignIn(page, browser, 'support');
  await page.goto(`${ADMIN}/accounts`);
  await expect(page.getByRole('button', { name: /^Search Ctrl K/ })).toBeEnabled();
  // The nav shows the support desk its own pages, and no ledger page.
  const nav = page.getByRole('navigation', { name: 'Operator console' }).first();
  await expect(nav.getByRole('link', { name: 'Account controls' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Ledger ops' })).toHaveCount(0);
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  // A page this person has scope for is listed, so an empty list cannot pass for a filtered one.
  await page.keyboard.type('account controls');
  await expect(palette.getByRole('option', { name: /^Account controls/ })).toBeVisible();
  await palette.getByRole('combobox').fill('ledger');
  await expect(palette.getByRole('option', { name: /Ledger ops/ })).toHaveCount(0);
  await expect(palette.getByRole('option', { name: /Freeze or unfreeze ledger posting/ })).toHaveCount(0);
  await expect(palette.getByRole('option', { name: /Halt or clear a pay rail/ })).toHaveCount(0);
  await expect(palette.getByRole('option', { name: /Ledger restore proof|Prove a ledger restore/ })).toHaveCount(0);
});
