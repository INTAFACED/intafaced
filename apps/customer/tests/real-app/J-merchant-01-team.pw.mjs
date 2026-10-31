import { test, expect } from './journey.mjs';
import { forgetSession } from './identity-factors.mjs';
import { businessReadyPerson, everyRoomOpens, openBusiness, refusedPayCalls, signInWithCode, verifiedBusiness } from './merchant.mjs';

// J-merchant-01 step 4 in the running app: every room opens from navigation for the owner of a new business, with its
// own layout, an honest empty state where it lists records and no console error (`everyRoomOpens`). Then a finance team
// member of that business, once verified, sees asking for a payout on, and refunds off with who can. Kept apart from
// J-merchant-01.pw.mjs because it needs an approved business, which the founder pair decides.
const J = 'J-merchant-01';

test(`${J} #4 every room opens from navigation with its own layout and an honest empty state, no console errors, and a finance team member may ask for a payout and is told only the owner can refund`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  const finance = await businessReadyPerson(page, 'mfin', '/pay/merchant');
  await forgetSession(page);

  const owner = await businessReadyPerson(page, 'mown', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Team Ltd');
  const rooms = await everyRoomOpens(page);
  await test
    .info()
    .attach('rooms-and-states.json', { body: JSON.stringify(Object.fromEntries(rooms), null, 2), contentType: 'application/json' });
  await verifiedBusiness(page, owner, merchantId);
  await forgetSession(page);
  await signInWithCode(page, owner, '/pay/team');
  // Email invitations are off on this stack (no published invite lifetime): the owner invites by account ID instead.
  expect(finance.userId).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Invite by account ID instead' }).click();
  await page.getByLabel('Account ID *').fill(finance.userId);
  await page.getByRole('combobox', { name: /^Role \*/ }).selectOption({ label: 'Finance' });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'Finance' })
      .filter({ hasText: /Invited/ }),
  ).toHaveCount(1);
  await forgetSession(page);

  await signInWithCode(page, finance, '/pay/team');
  // Sign-in binds the emailed invitation to the account without waiting for it, so the page may need a reload to show it.
  const accept = page.locator('li').filter({ hasText: 'Finance' }).getByRole('button', { name: 'Accept' }).first();
  await expect(async () => {
    await page.reload();
    await expect(accept).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await accept.click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(accept).toHaveCount(0);
  await page.goto('/pay/merchant');
  await expect(page.getByText('TEST Team Ltd').first()).toBeVisible();
  const refused = refusedPayCalls(page);

  await page.goto('/pay/payouts');
  await expect(page.locator('main h1').first()).toBeVisible();
  // Asking for a payout is the finance role's: the header's "Pay out" is a live link to the request page.
  await expect(page.getByRole('link', { name: 'Pay out', exact: true }).first()).toHaveAttribute('href', '/pay/payouts/new');
  await page.getByRole('link', { name: 'Pay out', exact: true }).first().click();
  await expect(page).toHaveURL(/\/pay\/payouts\/new$/);
  await expect(page.locator('main h1').first()).toBeVisible();
  await expect(page.getByText(/Only the account owner, admins and finance can ask/)).toHaveCount(0);
  await page.goto('/pay/refunds');
  await expect(page.getByText('Only the account owner can refund payments.').first()).toBeVisible();
  expect(refused).toEqual([]);
});
