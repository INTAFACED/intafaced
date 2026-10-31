import { test, expect } from './journey.mjs';
import { draftNotice, publishNotice } from './notices.mjs';
import { campaignTotals, enquiriesFor, inviteCampaign, publicSettings, setPublicSettings } from './outreach.mjs';
import { ORIGIN, tool } from './stack.mjs';

/** The public invitation site on the stack (apps/invitation), where the join and partner enquiry forms live. */
const JOIN = process.env.JOURNEY_JOIN_URL ?? 'http://127.0.0.1:3220';

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
  await expect(main.getByTestId('partner-terms-unset')).toHaveText('Programme terms are not published.');
  await expect(main.getByText('No partner tiers or prices are published, so none are shown.', { exact: false })).toBeVisible();
  await page.context().close();
});

/** A form control by its visible label (the invitation site labels each input, select and textarea). */
const control = (page, label, options) => page.getByLabel(label, options).and(page.locator('input, select, textarea'));

/** Begin, then the contact screens. Leaves the visitor on the first question once the enquiry is stored. */
async function contact(page, email) {
  await page.getByRole('button', { name: 'Begin', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Let’s start with you.', exact: true })).toBeVisible();
  await control(page, 'Your name').fill('LOCAL TEST visitor');
  await control(page, 'Email', { exact: false }).fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A little more, if you like.', exact: true })).toBeVisible();
  await control(page, 'Organisation', { exact: false }).fill('LOCAL TEST organisation');
  await page.getByRole('button', { name: 'Save details & continue' }).click();
}

const next = async (page) => {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('#intake-heading')).toBeFocused();
};

/** The partner questions, review and send, from the first question to the thank-you heading. */
async function partnerEnquiry(page) {
  await expect(page.getByRole('heading', { name: 'What’s your area of expertise?', exact: true })).toBeVisible();
  await control(page, 'Your expertise').fill('LOCAL TEST expertise');
  await next(page);
  await control(page, 'What would you like to contribute?').fill('LOCAL TEST contribution');
  await next(page);
  await page
    .getByRole('radiogroup', { name: 'What kind of relationship do you have in mind?', exact: true })
    .getByRole('radio', { name: 'Collaboration', exact: true })
    .check();
  await next(page);
  await next(page);
  await page
    .getByRole('radiogroup', { name: 'When would you consider taking part?', exact: true })
    .getByRole('radio', { name: 'Later', exact: true })
    .check();
  await next(page);
  await page.getByRole('button', { name: 'Review your answers' }).click();
  await expect(page.getByRole('heading', { name: 'Before you send.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send enquiry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Thank you. We’ve received your enquiry.' })).toBeVisible();
}

test(`${J} #3 /partner with the founders' join address set: the form opens and one enquiry is recorded`, async ({ browser }) => {
  test.setTimeout(240_000);
  const key = `${J}-3-${Date.now()}`;
  const email = `${key.toLowerCase()}@example.org`;
  const before = await publicSettings();
  const terms = `LOCAL TEST programme terms ${key}`;
  await setPublicSettings({ joinUrl: JOIN, partnerTerms: terms }, 'LOCAL TEST journey sets the partner join address');
  try {
    const page = await visitor(browser);
    await page.goto('/partner');
    const main = page.locator('main');
    await expect(main.getByTestId('partner-terms')).toHaveText(terms);
    const form = main.getByRole('link', { name: 'Open the partner enquiry form' });
    await expect(form).toHaveAttribute('href', `${JOIN}/partner`);
    await form.click();
    await expect(page).toHaveURL(`${JOIN}/partner`);
    await contact(page, email);
    await partnerEnquiry(page);
    // Exactly one enquiry for this visitor: one partner opportunity carrying one completed submission.
    await expect.poll(() => enquiriesFor(email)).toEqual({ opportunities: 1, submissions: 1 });
    await page.context().close();
  } finally {
    // Step 2 needs the page with nothing set: put back what was stored.
    await setPublicSettings(
      { joinUrl: before.joinUrl, partnerTerms: before.partnerTerms },
      'LOCAL TEST journey restores the partner settings',
    );
  }
});

test(`${J} #4 joining from an invite link captures one enquiry for that invite, and a failed store refuses`, async ({ browser }) => {
  test.setTimeout(240_000);
  const key = `${J}-4-${Date.now()}`;
  const invite = await inviteCampaign(key);
  const page = await visitor(browser);
  await page.goto(`${JOIN}/partner?source=${invite.sourceKey}`);
  await contact(page, `${key.toLowerCase()}@example.org`);
  await partnerEnquiry(page);
  // One enquiry, attributed to the invite the link carried.
  await expect.poll(async () => (await campaignTotals(invite.campaignId)).submissions).toBe(1);
  await page.context().close();

  // The store is down: the visitor is told it did not go through, and nothing is recorded for the invite.
  const failing = await inviteCampaign(`${key}-down`);
  try {
    tool('local-test-stack.mjs', 'stop', 'ops');
    const down = await visitor(browser);
    await down.goto(`${JOIN}/partner?source=${failing.sourceKey}`);
    await contact(down, `${key.toLowerCase()}-down@example.org`);
    await expect(down.getByRole('alert')).toBeVisible();
    await expect(down.getByRole('heading', { name: 'What’s your area of expertise?', exact: true })).toHaveCount(0);
    await expect(down.getByRole('heading', { name: 'Thank you. We’ve received your enquiry.' })).toHaveCount(0);
    await down.context().close();
  } finally {
    tool('local-test-stack.mjs', 'start', '--only', 'ops');
  }
  expect((await campaignTotals(failing.campaignId)).submissions).toBe(0);
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
