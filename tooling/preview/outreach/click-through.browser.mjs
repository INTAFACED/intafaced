/**
 * Clicks through a running `pnpm preview:outreach` the way Nitro would, at 390 and 1280 px:
 *
 *   1. sends one investor enquiry on the questionnaire;
 *   2. finds it in the founder Inbox ("Waiting on us") under "No reply yet", and opens it;
 *   3. presses Mark replied and sees it leave the queue;
 *   4. records a soft-circled commitment and sees it added to the Raise figures;
 *   5. opens the Reply, Decline and Commitment sheets, People and the Tools menu for screenshots.
 *
 *   node tooling/preview/outreach/click-through.browser.mjs [screenshot-dir]
 *
 * It drives only the local preview; nothing leaves the machine. Set PREVIEW_PUBLIC_PORT and PREVIEW_ADMIN_PORT when the
 * preview runs on other ports than 4400 and 4401.
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

/** The page must never scroll sideways, least of all on a phone. */
async function noSideways(page, width, where) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (wide > 0) throw new Error(`${where}: the page scrolls sideways by ${wide}px at ${width}px`);
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
      .getByRole('radiogroup', { name: 'How would you like to take part?' })
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

    const name = `${visitor} ${width}`;
    const nav = page.getByRole('navigation', { name: 'CRM sections' });
    const toolbar = page.getByRole('toolbar', { name: 'Actions for this person' });
    const person = page.locator('article');
    const rowOf = (text) => page.locator('[data-enquiry-id]').filter({ hasText: text });
    const shot = async (file, options = {}) => {
      await page.waitForTimeout(400);
      await noSideways(page, width, file);
      await page.screenshot({ path: join(shots, `${file}-${width}.png`), fullPage: true, ...options });
    };

    // 2. Inbox: "Waiting on us", investors first, the new enquiry under "No reply yet".
    await expect(page.getByRole('heading', { name: 'Waiting on us', level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tab', { name: /^Investors/ })).toHaveAttribute('aria-selected', 'true');
    const noReply = page.locator('section[aria-labelledby="inbox-no_reply"]');
    await expect(noReply.getByText(name).first()).toBeVisible({ timeout: 15_000 });
    await expect(noReply.locator('h2, ul')).not.toHaveCount(0);
    await shot('10-inbox');
    await page.getByRole('tab', { name: /^Everyone else|^Others/ }).click();
    await shot('11-inbox-everyone-else');
    await page.getByRole('tab', { name: /^Investors/ }).click();

    // Open it: their answers, the amount marked self-reported, the action bar.
    await rowOf(name).first().click();
    await expect(person).toContainText(name, { timeout: 15_000 });
    await expect(person).toContainText(/150[,\u202f\u00a0 ]?000/);
    await expect(person).toContainText('self-reported');
    await expect(person).toContainText('Click-through test enquiry.');
    await expect(toolbar).toBeVisible();
    await shot('20-person');

    // The sheets, for the screenshots: Reply (with the draft header), Decline, Commitment.
    await toolbar.getByRole('button', { name: 'Reply', exact: true }).click();
    const reply = page.getByRole('dialog', { name: 'Reply' });
    await expect(reply).toContainText("DRAFT: awaiting Nitro's approval of wording");
    await expect(reply.getByRole('link', { name: 'Open in my email app' })).toHaveAttribute('href', /^mailto:/);
    await shot('21-reply-sheet');
    await page.keyboard.press('Escape');
    await expect(reply).toBeHidden();
    await toolbar.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Decline' }).click();
    const decline = page.getByRole('dialog', { name: 'Decline' });
    await expect(decline).toContainText('Decline reply sent by email on');
    await shot('22-decline-sheet');
    await page.keyboard.press('Escape');
    await expect(decline).toBeHidden();

    // 3. Mark replied: one press, and the person leaves the waiting queue.
    await toolbar.getByRole('button', { name: 'Mark replied', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Marked replied' }).first()).toBeVisible({ timeout: 15_000 });
    await shot('23-marked-replied');
    await page.getByRole('button', { name: /^← / }).click();
    await expect(page.getByRole('heading', { name: 'Waiting on us', level: 1 })).toBeVisible();
    await expect(rowOf(name)).toHaveCount(0, { timeout: 15_000 });

    // 4. Raise: note the soft-circled euros, record 150,000 for this person, and see them added.
    await nav.getByRole('button', { name: /^Raise/ }).click();
    await expect(page.getByRole('heading', { name: 'Raise', level: 1 })).toBeVisible();
    const softCircled = async () => {
      const text = await page.getByText('Soft-circled', { exact: true }).first().locator('xpath=ancestor::div[1]').innerText();
      const digits = /€([\d,]+)/.exec(text)?.[1]?.replaceAll(',', '');
      if (!digits) throw new Error(`No soft-circled euros found in: ${text}`);
      return BigInt(digits);
    };
    await expect(page.getByText('Not converted')).toBeVisible({ timeout: 15_000 });
    const before = await softCircled();
    await shot('30-raise');
    await rowOf(name).first().click();
    await expect(person).toContainText(name, { timeout: 15_000 });
    await toolbar.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Commitment' }).click();
    const commitment = page.getByRole('dialog', { name: 'Commitment' });
    await commitment.getByRole('button', { name: 'Soft-circled', exact: true }).click();
    await commitment.getByRole('button', { name: /^Use their indicated/ }).click();
    await commitment.getByRole('button', { name: 'After the call', exact: true }).click();
    await shot('24-commitment-sheet');
    await commitment.getByRole('button', { name: 'Save commitment' }).click();
    await expect(commitment).toBeHidden({ timeout: 15_000 });
    await expect(person).toContainText('Soft-circled €150,000', { timeout: 15_000 });
    await shot('25-person-soft-circled');
    await page.getByRole('button', { name: /^← / }).click();
    await expect(page.getByRole('heading', { name: 'Raise', level: 1 })).toBeVisible();
    await expect.poll(softCircled, { timeout: 15_000 }).toBe(before + 150000n);
    await expect(rowOf(name).first()).toContainText('Soft-circled');
    await shot('31-raise-after');

    // 5. People, with the search, and the quiet Tools menu.
    await nav.getByRole('button', { name: /^People/ }).click();
    await expect(page.getByRole('heading', { name: 'People', level: 1 })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search' }).fill(visitor);
    await expect(rowOf(name).first()).toBeVisible({ timeout: 15_000 });
    await shot('40-people');
    await page.getByRole('button', { name: /^Tools/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Duplicates' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Sources and campaigns' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Exports' })).toBeVisible();
    await shot('41-tools-menu');
    await page.getByRole('menuitem', { name: 'Duplicates' }).click();
    await expect(page.getByRole('heading', { name: 'Duplicates', level: 1 })).toBeVisible();
    await shot('42-tools-duplicates');
    if (failures.length) throw new Error(`Page errors at ${width}px: ${failures.join(' | ')}`);
    console.log(`✓ ${width}px: enquiry reached the Inbox, was marked replied, and its soft-circled commitment reached Raise`);
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(`Screenshots: ${shots}`);
