import { test, expect } from '@playwright/test';
import { contactChannels, helpCentre, setHelpCentre } from './help-centre.mjs';
import { ORIGIN } from './stack.mjs';

// J-support-public-01, in the running app (docs/roadmap/journeys.json): a signed-out visitor finds an answer in the help
// centre. Tests titled "J-support-public-01 #<n>" prove a whole step. A step that changes an owner setting puts back what
// it found, so the stack is left as the run met it.
const J = 'J-support-public-01';

test.describe.configure({ mode: 'serial' });

/** A signed-out visitor on a device of its own. */
async function visitor(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

/** The contact card says "not set" for each detail the owner has not published, and no mailto link is drawn for a blank address. */
async function expectContactCard(page) {
  const owner = await contactChannels();
  const card = page.locator('aside.contact-card');
  await expect(card).toBeVisible();
  if (owner.email === null && !process.env.VITE_SUPPORT_EMAIL) {
    await expect(card.getByTestId('support-email-unset')).toContainText('Support email is not set.');
    await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0);
  } else {
    await expect(card.locator('a[href^="mailto:"]')).toHaveCount(1);
  }
  if (owner.phone === null) await expect(card.getByTestId('support-phone-unset')).toHaveText('Support phone is not set.');
  else await expect(card.getByTestId('support-phone')).toContainText(owner.phone);
}

test(`${J} #1 /help is one front door: search, categories, the request button and a contact card that says "not set"`, async ({
  browser,
}) => {
  const page = await visitor(browser);
  await page.goto('/help');
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'How can we help?' })).toBeVisible();
  await expect(main.getByLabel('Search answers')).toBeVisible();
  await expect(main.getByRole('group', { name: /categor|topic/i })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Send a request' })).toBeVisible();
  await expectContactCard(page);
  // Signed out, the request button asks for a sign-in in place; no mail draft stands in for the form.
  await main.getByRole('button', { name: 'Send a request' }).click();
  await expect(main.getByTestId('request-sign-in')).toBeVisible();
  await page.context().close();
});

test(`${J} #2 with the help centre switched off, /help says so, keeps the contact card and still renders`, async ({ browser }) => {
  const found = await helpCentre();
  const switched = await setHelpCentre({ published: false }, `TEST ${J} #2 switch the help centre off`);
  expect(switched.published).toBe(false);
  try {
    const page = await visitor(browser);
    for (const path of ['/help', '/helpdetail?id=kb-account-access']) {
      await page.goto(path);
      const main = page.locator('main');
      await expect(main.getByRole('heading', { level: 1, name: 'How can we help?' })).toBeVisible();
      await expect(main.getByTestId('help-centre-off')).toContainText('The help centre is switched off');
      await expect(main.getByLabel('Search answers')).toHaveCount(0);
      await expect(main.locator('.help__row, .help__body')).toHaveCount(0);
      await expectContactCard(page);
    }
    await page.context().close();
  } finally {
    const back = await setHelpCentre({ published: found.published }, `TEST ${J} #2 put the switch back`);
    expect(back.published).toBe(found.published);
  }
  // Back as it was: the answers show again.
  const page = await visitor(browser);
  await page.goto('/help');
  await expect(page.locator('main .help__row').first()).toBeVisible();
  await page.context().close();
});
