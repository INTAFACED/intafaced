import { expect, test } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signUpInBrowser } from './stack.mjs';

// J-ops-console-02 step #1: a founder finds customers in the console by the start of a handle or a whole email (identity's
// operator search). 26 fresh TEST customers share a handle start, one more than identity's page of 25: the first page shows
// 25 with the matching field and says more match, the next page shows the 26th and says that is every match, and nothing is
// cut. A whole email finds one, and a record opens. Every search the console sends is audited: identity's own
// operator_read_audit holds one row per search, under the founder, as a hash of the search.

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const PEOPLE = 26;

/** svc-identity's own database role on the stack (loopback, the marker's postgres port, the stack's secret). */
function identityDb(ctx) {
  const postgres = createRequire(path.join(REPO, 'services', 'svc-identity', 'package.json'))('postgres');
  const port = ctx.marker.ports.postgres ?? 15460;
  return postgres(`postgres://svc_identity:${encodeURIComponent(ctx.secrets.pgService)}@127.0.0.1:${port}/intafaced_local_test`, {
    max: 1,
    onnotice: () => {},
  });
}

const searchHash = (kind, value) => createHash('sha256').update(`${kind}\0${value}`).digest('hex');

test('J-ops-console-02 #1 customer search by handle start and by email', async ({ browser }) => {
  test.setTimeout(600_000);
  const prefix = `q${Date.now().toString(36)}`;
  const people = [];
  for (let n = 1; n <= PEOPLE; n++) {
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
  const founder = await founderSignIn(page, 'a');
  const ctx = await makeContext({ log: () => undefined });
  const sql = identityDb(ctx);
  const [{ since }] = await sql`SELECT clock_timestamp() AS since`;
  await page.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
  const search = page.getByTestId('account-search');
  await expect(search.getByRole('button', { name: 'Search' })).toBeEnabled();

  await search.getByLabel('Handle or email').fill(prefix);
  await search.getByRole('button', { name: 'Search' }).click();
  const results = page.getByTestId('account-search-results');
  const rows = results.getByTestId('account-search-row');
  await expect(rows).toHaveCount(25, { timeout: 30_000 });
  await expect(rows.first()).toContainText('Handle start');
  await expect(rows.first()).toContainText(people[0].handle);
  await expect(results.getByTestId('account-search-count')).toHaveText('25 shown, more match.');
  const handles = async () => (await rows.allInnerTexts()).map((text) => new RegExp(`${prefix}n\\d+`).exec(text)?.[0]);
  // More than the page limit pages: Next page adds the rest below the first 25, and every match is then shown once.
  await results.getByRole('button', { name: 'Next page' }).click();
  await expect(results.getByTestId('account-search-count')).toHaveText(`${PEOPLE} shown, that is every match.`, { timeout: 30_000 });
  await expect(rows).toHaveCount(PEOPLE);
  await expect(results.getByRole('button', { name: 'Next page' })).toHaveCount(0);
  const shown = await handles();
  expect(new Set(shown).size, 'no match shown twice').toBe(shown.length);
  expect([...shown].sort(), 'every match shown, none cut').toEqual(people.map((p) => p.handle).sort());
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
  await expect(rows).toHaveCount(25, { timeout: 30_000 });

  // Every search the console sent is in identity's audit under this founder, as a hash and never the words searched:
  // the handle start, its next page, the email, and the handle start again. The two-letter search was never sent.
  const audited = await sql`
    SELECT kind, query_hash FROM identity.operator_read_audit
     WHERE actor_id = ${founder.userId} AND created_at >= ${since} ORDER BY created_at`;
  await sql.end();
  const handleHash = searchHash('handle', prefix);
  expect(audited.map((r) => r.kind)).toEqual(['account_search', 'account_search', 'account_search', 'account_search']);
  expect(audited.map((r) => r.query_hash === handleHash)).toEqual([true, true, false, true]);
  expect(audited[2].query_hash, 'the email search is audited as a hash, not the address').not.toContain('@');

  await results.getByRole('link', { name: 'Open record' }).first().click();
  await page.waitForURL(/\/accounts\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  // The record that opens is the account that was found.
  await expect(page.getByTestId('customer-record-id')).toHaveText(new URL(page.url()).pathname.split('/').pop());
  await expect(page.getByTestId('customer-tab-money')).toBeVisible();
});
