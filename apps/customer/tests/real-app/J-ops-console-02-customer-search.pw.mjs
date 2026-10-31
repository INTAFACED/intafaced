import { expect, test } from './journey.mjs';
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
/** Identity's page of search results; one more customer than that must page, never be cut. */
const PAGE = 25;
const PEOPLE = PAGE + 1;

/** One query on svc-identity's own database role on the stack (loopback, the marker's postgres port, the stack's secret). */
async function identityDb(read) {
  const ctx = await makeContext({ log: () => undefined });
  const postgres = createRequire(path.join(REPO, 'services', 'svc-identity', 'package.json'))('postgres');
  const port = ctx.marker.ports.postgres ?? 15460;
  const sql = postgres(`postgres://svc_identity:${encodeURIComponent(ctx.secrets.pgService)}@127.0.0.1:${port}/intafaced_local_test`, {
    max: 1,
    onnotice: () => {},
  });
  try {
    return await read(sql);
  } finally {
    await sql.end();
  }
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
  const since = await identityDb(async (sql) => (await sql`SELECT clock_timestamp() AS since`)[0].since);
  await page.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
  const search = page.getByTestId('account-search');
  await expect(search.getByRole('button', { name: 'Search' })).toBeEnabled();

  await search.getByLabel('Handle or email').fill(prefix);
  await search.getByRole('button', { name: 'Search' }).click();
  const results = page.getByTestId('account-search-results');
  const rows = results.getByTestId('account-search-row');
  await expect(rows).toHaveCount(PAGE, { timeout: 30_000 });
  await expect(rows.first()).toContainText('Handle start');
  await expect(rows.first()).toContainText(people[0].handle);
  await expect(results.getByTestId('account-search-count')).toHaveText(`${PAGE} shown, more match.`);
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
  await expect(rows).toHaveCount(PAGE, { timeout: 30_000 });

  // Every search the console sent is in identity's audit under this founder, as a hash and never the words searched:
  // the handle start, its next page, the email, and the handle start again. The two-letter search was never sent.
  // Only this test's own searches are looked at, so another read by the same founder meanwhile does not count here.
  const handleHash = searchHash('handle', prefix);
  const emailHash = searchHash('email', people[1].email.toLowerCase());
  const audited = await identityDb(
    (sql) => sql`
      SELECT query_hash FROM identity.operator_read_audit
       WHERE actor_id = ${founder.userId} AND kind = 'account_search' AND created_at >= ${since}
         AND query_hash IN (${handleHash}, ${emailHash})
       ORDER BY created_at`,
  );
  expect(audited.map((r) => r.query_hash)).toEqual([handleHash, handleHash, emailHash, handleHash]);

  await results.getByRole('link', { name: 'Open record' }).first().click();
  await page.waitForURL(/\/accounts\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  // The record that opens is the account that was found.
  await expect(page.getByTestId('customer-record-id')).toHaveText(new URL(page.url()).pathname.split('/').pop());
  await expect(page.getByTestId('customer-tab-money')).toBeVisible();
});
