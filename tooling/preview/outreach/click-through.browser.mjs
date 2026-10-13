/**
 * Clicks through a running `pnpm preview:outreach` the way Nitro would: one
 * investor enquiry on the questionnaire, then the same enquiry in the founder CRM.
 *
 *   node tooling/preview/outreach/click-through.browser.mjs [screenshot-dir]
 *
 * It drives only the local preview; nothing leaves the machine.
 */
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { applyPlaywrightBrowsersEnv } from '../../uiproof/playwright-browsers.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const shots = resolve(process.argv[2] ?? join(tmpdir(), 'intafaced-preview-shots'));
const questionnaire = `http://localhost:${process.env.PREVIEW_PUBLIC_PORT ?? 4400}`;
const crm = `http://localhost:${process.env.PREVIEW_ADMIN_PORT ?? 4401}`;
const visitor = `Click-through visitor ${new Date().toISOString().slice(11, 19)}`;
await mkdir(shots, { recursive: true });
const { executablePath } = applyPlaywrightBrowsersEnv({ repoRoot: repo });

const control = (page, label, options) => page.getByLabel(label, options).and(page.locator('input, select, textarea'));
async function next(page) {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('#intake-heading')).toBeFocused();
}

const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}) });
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    const page = await context.newPage();
    const failures = [];
    page.on('pageerror', (error) => failures.push(`${new URL(page.url()).pathname}: ${error.message.slice(0, 120)}`));

    await page.goto(`${questionnaire}/invest`);
    await expect(page.locator('#intafaced-preview-label')).toHaveText(/test data/i);
    await page.screenshot({ path: join(shots, `1-welcome-${width}.png`) });
    await page.getByRole('button', { name: 'Begin', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Let’s start with you.', exact: true })).toBeVisible();
    await control(page, 'Your name').fill(`${visitor} ${width}`);
    await control(page, 'Email', { exact: false }).fill(`click-through-${width}@example.invalid`);
    await page.screenshot({ path: join(shots, `2-contact-${width}.png`) });
    // Contact is two screens: name and email, then the optional extras. Nothing is sent until the second.
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'A little more, if you like.', exact: true })).toBeFocused();
    await page.screenshot({ path: join(shots, `2b-contact-more-${width}.png`) });
    await page.getByRole('button', { name: 'Save details & continue' }).click();
    await expect(page.getByRole('heading', { name: 'How would you like to take part?', exact: true })).toBeVisible();
    await page
      .getByRole('radiogroup', { name: 'Are you considering investing or making an introduction?' })
      .getByRole('radio', { name: 'I’m considering investing', exact: true })
      .check();
    await next(page);
    await page
      .getByRole('radiogroup', { name: 'Which best describes you or the organisation you represent?' })
      .getByRole('radio', { name: 'Individual', exact: true })
      .check();
    await page.screenshot({ path: join(shots, `2c-answer-cards-${width}.png`) });
    await next(page);
    await page
      .getByRole('radiogroup', { name: 'What is your role in the decision?' })
      .getByRole('radio', { name: 'I make investment decisions', exact: true })
      .check();
    await next(page);
    await page
      .getByRole('radiogroup', { name: 'Amount preference', exact: true })
      .getByRole('radio', { name: 'Share an indicative amount', exact: true })
      .check();
    await control(page, 'Amount', { exact: true }).fill('150,000');
    const currency = page.getByRole('combobox', { name: 'Currency', exact: true });
    await currency.click();
    await currency.fill('EUR');
    await page.getByRole('option', { name: 'Euro' }).first().click();
    await control(page, 'Amount', { exact: true }).blur();
    await page.screenshot({ path: join(shots, `3-amount-${width}.png`) });
    await next(page);
    await page
      .getByRole('radiogroup', { name: 'When would you consider taking part?' })
      .getByRole('radio', { name: 'Within three months', exact: true })
      .check();
    await next(page);
    await control(page, 'What would you like us to know?', { exact: false }).fill('Click-through test enquiry.');
    await page.getByRole('button', { name: 'Review your answers' }).click();
    await expect(page.getByRole('heading', { name: 'Before you send.', exact: true })).toBeVisible();
    await page.getByText('Your details & this device', { exact: true }).click();
    await page.screenshot({ path: join(shots, `4-review-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(shots, `5-sent-${width}.png`), fullPage: true });

    await page.goto(`${crm}/crm`);
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    // Wait for the sign-in form to hydrate; a click before that is a plain HTML form post.
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Email or handle').fill('nitro@example.invalid');
    await page.getByLabel('Password').fill('test-password');
    await page.getByLabel('Authenticator or recovery code').fill('123456');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
    await page.goto(`${crm}/crm`);
    const row = page.getByText(`${visitor} ${width}`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: join(shots, `6-crm-list-${width}.png`), fullPage: true });
    await row.click();
    await expect(page.getByRole('region', { name: 'Selected enquiry' })).toContainText(`${visitor} ${width}`, { timeout: 15_000 });
    await page.getByRole('tab', { name: 'Answers' }).click();
    await expect(page.getByText(/150[,\u202f\u00a0 ]?000/).first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: join(shots, `7-crm-detail-${width}.png`), fullPage: true });
    if (failures.length) throw new Error(`Page errors at ${width}px: ${failures.join(' | ')}`);
    console.log(`✓ ${width}px: questionnaire enquiry reached the founder CRM`);
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(`Screenshots: ${shots}`);
