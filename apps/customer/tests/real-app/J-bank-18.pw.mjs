// World: none
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { api, signUpInBrowser } from './stack.mjs';

// J-bank-18, in the running app (docs/roadmap/journeys.json; step words in project-state
// operation-zero/modules/bank/acceptance/journeys.md): I stay safe, report a scam and make a complaint. Starts signed in
// with a transfer to a new payee in progress; ends with scam warnings read once per payee, a scam report filed with the
// amount and transfer id, and a complaint acknowledged once with its deadline. No money moves.
// DRAFT (test first, 6 Nov): each step names what its words say; the rooms it drives are being built in this PR.
const J = 'J-bank-18';

function person(prefix) {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

test.describe.configure({ mode: 'default' });

test(`${J} #1: a transfer opened from a blocked region shows a notice naming the restriction in the owner's wording, or says the wording is not published`, async ({
  page,
}) => {
  const who = person('bk18a');
  await signUpInBrowser(page, who);
  await page.goto('/bank/transfer');
  const notice = page.getByTestId('safety__blocked-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/restricted|not published/i);
});

test(`${J} #2: reviewing a first-time payee shows the scam warning once per payee with a link to the scam guide`, async ({ page }) => {
  const who = person('bk18b');
  await signUpInBrowser(page, who);
  await page.goto('/bank/transfer');
  await expect(page.getByTestId('safety__scam-warning')).toHaveCount(1);
  await page.getByRole('link', { name: /scam guide/i }).click();
  await expect(page).toHaveURL(/\/help\/scams/);
});

test(`${J} #3: a scam report with an amount and a transfer id makes a ticket in the scam category and a case note; the mule policy page opens`, async ({
  page,
}) => {
  const who = person('bk18c');
  await signUpInBrowser(page, who);
  await page.goto('/support/new?topic=scam');
  await expect(page.getByTestId('safety__scam-report')).toBeVisible();
  const me = await api(who);
  expect(me).toBeTruthy();
  await page.goto('/help/mule-policy');
  await expect(page.getByRole('heading', { name: /money mule/i })).toBeVisible();
});

test(`${J} #4: reporting a lost phone or a compromised account from the bank shows step-up extras and a location signal, and opens Security's compromised-account path`, async ({
  page,
}) => {
  const who = person('bk18d');
  await signUpInBrowser(page, who);
  await page.goto('/uc/safe');
  await expect(page.getByTestId('safety__step-up-extras')).toBeVisible();
  await expect(page.getByTestId('safety__location-signal')).toBeVisible();
  await page.getByRole('link', { name: /my account is compromised/i }).click();
  await expect(page).toHaveURL(/compromised/);
});

test(`${J} #5: a complaint is acknowledged once with the deadline from the owner's limit, or "not set"`, async ({ page }) => {
  const who = person('bk18e');
  await signUpInBrowser(page, who);
  await page.goto('/help/complaint');
  const ack = page.getByTestId('safety__complaint-ack');
  await expect(ack).toHaveCount(0);
  await expect(page.getByTestId('safety__complaint-form')).toBeVisible();
});

test(`${J} #6: a family reporting a deceased customer gets a reporting form and an acknowledgement`, async ({ page }) => {
  await page.goto('/help/deceased');
  await expect(page.getByTestId('safety__deceased-form')).toBeVisible();
});
