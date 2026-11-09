// World: none
import { test, expect } from './journey.mjs';
import { codeOf, keyHolder, makeKey, withKey } from './developer.mjs';

// J-developer-07 #4, in the running app (docs/roadmap/journeys.json): revoke a key. Written by an independent
// test-writer from the step's own words (OWNER 212). It passed on main's code in branch run 42354158805, so it lands on
// its own; the journey's other steps are in J-developer-07.pw.mjs. The person is a TEST account with a passkey and a
// live trade key made in the browser (developer.mjs), as a running bot would hold it. "A key verifies" means Edge
// answers a signed call the key makes (the account balance).
const J = 'J-developer-07';

/** Whether the key verifies: Edge answers its balance read (200), or refuses it (401 with the code Edge names). */
async function verifies(cred) {
  const reply = await withKey(cred.key, { path: '/api/v1/account/balance' });
  return { status: reply.status, code: reply.status === 200 ? null : codeOf(reply.body), body: reply.body };
}

async function expectVerifies(cred, label) {
  const v = await verifies(cred);
  expect(v.status, `${label} verifies: ${JSON.stringify(v.body).slice(0, 300)}`).toBe(200);
}

test(`${J} #4 revokes a key: it stops verifying at once, and the list shows it revoked with its reason`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { page } = await keyHolder(browser, 'jd7v');
  try {
    const cred = { key: await makeKey(page, { name: 'bot-1' }) };
    await expectVerifies(cred, 'the running bot key');

    await page.goto('/uc/safe/api-keys');
    const row = page
      .getByTestId('api-keys__table')
      .locator('tbody tr')
      .filter({ has: page.getByRole('rowheader', { name: 'bot-1', exact: true }) });
    await row.getByRole('button', { name: 'Revoke', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Reason (optional)').fill('TEST bot retired');
    await dialog.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The key is revoked.' })).toBeVisible();

    // At once: the very next call the bot makes is refused, with no wait in between.
    const v = await verifies(cred);
    expect(v.status, JSON.stringify(v.body).slice(0, 300)).toBe(401);
    expect(v.code).toBe('edge.api_key_revoked');

    await page.reload();
    await expect(row).toContainText('Revoked by you: TEST bot retired');
    await expect(row.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});
