import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { api, signUpInBrowser } from './stack.mjs';

// J-identity-15, in the running app (docs/roadmap/journeys.json): I run sub-accounts from my main account. Tests titled
// "J-identity-15 #<n>" prove a whole step; the others prove part of one and say which.
const J = 'J-identity-15';

function person(prefix) {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

async function createInPage(page, label) {
  const form = page.getByTestId('subaccounts__create');
  await form.getByLabel('Label').fill(label);
  await form.getByRole('button', { name: 'Review subaccount' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create subaccount' }).click();
}

test(`${J}, part of #1: create a sub-account; at the account's limit the refusal says so plainly and nothing stays blocked`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const who = person('sa');
  await signUpInBrowser(page, who);
  await page.goto('/uc/account');
  await createInPage(page, 'Grid one');
  await expect(page.getByTestId('subaccounts__request').last()).toContainText('The service created the original strategy subaccount.');

  // Fill the account up to the stack's cap through the same front door, until identity refuses with its limit.
  const me = await api(who);
  let refusal = null;
  for (let i = 0; i < 50 && !refusal; i += 1) {
    const r = await me.post('/api/identity/trpc/subAccounts.create', { label: `Filler ${i}` });
    if (r.status !== 200) refusal = r;
  }
  expect(refusal?.status).toBe(403);
  expect(refusal?.body?.error?.data?.cause?.code).toBe('auth.sub_account_limit');

  await page.reload();
  await createInPage(page, 'One too many');
  const receipt = page.getByTestId('subaccounts__request').last();
  await expect(receipt.getByRole('heading')).toHaveText('Creation was refused before insertion');
  await expect(receipt).toContainText('This account already holds the most sub-accounts allowed. Revoke one you no longer use');
  await expect(page.getByText('Creation is not confirmed')).toHaveCount(0);
  // A refusal leaves nothing pending, so the next creation can be reviewed straight away.
  await expect(page.getByTestId('subaccounts__create').getByRole('button', { name: 'Review subaccount' })).toBeEnabled();
});
