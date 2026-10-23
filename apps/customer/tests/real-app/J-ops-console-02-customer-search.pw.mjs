import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signUpInBrowser } from './stack.mjs';

// J-ops-console-02 step #1: a founder finds customers in the console by the start of a handle or a whole email (identity's
// operator search). Two fresh TEST customers share a handle start; the search lists both with the matching field, says it is
// every match, and opens a record. Paging past identity's page of 25 is proven in identity-ops-reads.pg.test.ts.

test('J-ops-console-02 #1 customer search by handle start and by email', async ({ browser }) => {
  test.setTimeout(240_000);
  const prefix = `q${Date.now().toString(36)}`;
  const people = [];
  for (const n of [1, 2]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const who = {
      handle: `${prefix}n${n}`,
      email: `${prefix}n${n}@local-test.invalid`,
      password: `TEST-${randomBytes(9).toString('base64url')}-9a`,
    };
    await signUpInBrowser(page, who);
    people.push(who);
    await context.close();
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
  const search = page.getByTestId('account-search');
  await expect(search.getByRole('button', { name: 'Search' })).toBeEnabled();

  await search.getByLabel('Handle or email').fill(prefix);
  await search.getByRole('button', { name: 'Search' }).click();
  const results = page.getByTestId('account-search-results');
  await expect(results.getByTestId('account-search-row')).toHaveCount(2, { timeout: 30_000 });
  await expect(results.getByTestId('account-search-row').first()).toContainText('Handle start');
  await expect(results.getByTestId('account-search-row').first()).toContainText(people[0].handle);
  await expect(results.getByTestId('account-search-count')).toHaveText('2 shown, that is every match.');
  // The email is masked: the whole address is never on the page.
  await expect(results).not.toContainText(people[0].email);

  await search.getByLabel('Handle or email').fill(people[1].email.toUpperCase());
  await search.getByRole('button', { name: 'Search' }).click();
  await expect(results.getByTestId('account-search-row')).toHaveCount(1, { timeout: 30_000 });
  await expect(results.getByTestId('account-search-row')).toContainText('Email');
  await expect(results.getByTestId('account-search-row')).toContainText(people[1].handle);

  await search.getByLabel('Handle or email').fill('zz');
  await search.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByTestId('account-search-problem')).toContainText('three characters');

  await search.getByLabel('Handle or email').fill(prefix);
  await search.getByRole('button', { name: 'Search' }).click();
  await expect(results.getByTestId('account-search-row')).toHaveCount(2, { timeout: 30_000 });
  await results.getByRole('link', { name: 'Open record' }).first().click();
  await page.waitForURL(/\/accounts\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  // The record that opens is the account that was found.
  await expect(page.getByTestId('customer-record-id')).toHaveText(new URL(page.url()).pathname.split('/').pop());
  await expect(page.getByTestId('customer-tab-money')).toBeVisible();
});
