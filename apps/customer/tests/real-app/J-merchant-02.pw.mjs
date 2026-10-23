import { test, expect } from '@playwright/test';
import { forgetSession } from './identity-factors.mjs';
import { businessReadyPerson, openBusiness, refusedPayCalls, signInWithCode, verifiedBusiness } from './merchant.mjs';

// J-merchant-02, in the running app (docs/roadmap/journeys.json): get verified and go live. Tests titled
// "J-merchant-02 #<n>" prove a whole step; the others prove part of one and say which.
const J = 'J-merchant-02';

test(`${J} part of #2 sending the verification reference and INTAFACED's decision both show in the verification history`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mkh', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST History Ltd');
  const refused = refusedPayCalls(page);
  // Sends the reference from /pay/onboarding/verification, then the founder pair approves it.
  await verifiedBusiness(page, owner, merchantId);

  await page.goto('/pay/onboarding/verification');
  const history = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Verification history' }) });
  await expect(history).toContainText('In review to Approved');
  await expect(history).toContainText('Decided by INTAFACED');
  await expect(history).toContainText('Not sent to In review');
  await expect(history).toContainText('Sent by you');
  await expect(history.getByText('Nothing sent yet')).toHaveCount(0);
  expect(refused).toEqual([]);
});

test(`${J} part of #1 the owner reads the second-approval rule and turns it on and off again`, async ({ page }) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'msa', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Second Approval Ltd');
  // Changing a setting is a pay:write call, which a business holds once it is verified.
  await verifiedBusiness(page, owner, merchantId);
  await forgetSession(page);
  await signInWithCode(page, owner, '/pay/settings');
  const refused = refusedPayCalls(page);

  const rule = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Second approval', level: 2 }) });
  await expect(rule.getByRole('status')).toHaveText('Second approval is off.');
  await expect(rule).not.toContainText('We can’t read this setting.');
  await rule.getByRole('button', { name: 'Turn on second approval' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn on second approval' }).click();
  await expect(rule.getByRole('status')).toHaveText('Second approval is on.');
  await page.reload();
  await expect(rule.getByRole('status')).toHaveText('Second approval is on.');
  await rule.getByRole('button', { name: 'Turn off second approval' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn off second approval' }).click();
  await expect(rule.getByRole('status')).toHaveText('Second approval is off.');
  expect(refused).toEqual([]);
});

test(`${J} part of #1 a new owner adds the business address before verification, and setup counts the details as done`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mad', '/pay/onboarding');
  await openBusiness(page, owner, 'TEST Address Ltd');
  const refused = refusedPayCalls(page);
  await page.goto('/pay/onboarding');
  await expect(page.getByText('Your business details are missing: address.')).toBeVisible();

  await page.goto('/pay/settings');
  await page.getByLabel('Address line 1').fill('1 Test Street');
  await page.getByLabel('City').fill('Testville');
  await page.getByLabel('Postal code').fill('T3ST 1NG');
  await page.getByLabel('Country code').fill('GB');
  await page.getByLabel('Reason *').fill('Add our address');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText('1 Test Street, Testville, T3ST 1NG, GB');
  await review.getByRole('button', { name: 'Save changes' }).click();
  const history = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Change history', level: 2 }) });
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await expect(history).toContainText('Add our address');

  await page.goto('/pay/onboarding');
  await expect(page.getByText('What is left')).toBeVisible();
  await expect(page.getByText(/Your business details are missing/)).toHaveCount(0);
  await expect(page.getByText('Send your verification reference for review (step 2).')).toBeVisible();
  expect(refused).toEqual([]);
});

test(`${J} part of #6 the owner reads the published merchant terms and accepts them before going live`, async ({ page }) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mtc', '/pay/onboarding');
  await openBusiness(page, owner, 'TEST Terms Ltd');
  const refused = refusedPayCalls(page);

  await page.goto('/pay/onboarding');
  await expect(page.getByText('Accept the terms of service (step 3).')).toBeVisible();
  await page.goto('/pay/onboarding/go-live');
  const terms = page.locator('.stack').filter({ has: page.getByRole('heading', { name: 'Terms of service' }) });
  await expect(terms.getByRole('link', { name: 'Read the terms (version TEST-merchant-terms-1)' })).toHaveAttribute(
    'href',
    'https://terms.example/TEST-merchant-terms-1',
  );
  await expect(page.getByText('No terms of service to accept')).toHaveCount(0);
  await terms.getByRole('button', { name: 'Accept the terms' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Accept the terms' }).click();
  await expect(terms.getByRole('status')).toContainText('Version TEST-merchant-terms-1 accepted.');
  await page.reload();
  await expect(terms.getByRole('status')).toContainText('Version TEST-merchant-terms-1 accepted.');
  await page.goto('/pay/onboarding');
  await expect(page.getByText('Accept the terms of service (step 3).')).toHaveCount(0);
  expect(refused).toEqual([]);
});
