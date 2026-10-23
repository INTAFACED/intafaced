import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-wallet-04, in the running app (docs/roadmap/journeys.json): I save a withdrawal address. One test per step, titled
// "J-wallet-04 #<n>", run in order on one verified TEST account with an authenticator app, because saving and removing
// an address each ask for a fresh confirmation. The assets and networks offered are the ledger's registry rows the
// stack's founders publish (`local-test-gates.mjs assets`: TEST USDT and USDC on TEST Ethereum and TEST Base). Not here
// yet: #3 (the confirmation notice, W-withdraw-03), #5 and #7 (the allowlist, W-withdraw-09), #6 (W-withdraw-17).
const J = 'J-wallet-04';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';

test.describe.configure({ mode: 'default' });

function account() {
  const state = run.read();
  if (!state.account) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return state;
}

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** Signs in with the password and the next authenticator code, and keeps the step so no code is used twice. */
async function signInWithCode(page) {
  const state = account();
  const { totp } = await totpLib();
  const { code, step } = await nextCode(totp, state.secret, state.step);
  run.reset({ ...state, step });
  await page.goto('/login');
  await page.fill('input[name=totp]', code);
  await page.fill('input[name=identifier]', state.account.email);
  await page.fill('input[name=password]', state.account.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Answers the "Confirm it's you" dialog with the next authenticator code. */
async function confirmItsMe(page) {
  const state = account();
  const { totp } = await totpLib();
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  const { code, step } = await nextCode(totp, state.secret, state.step);
  run.reset({ ...state, step });
  await dialog.getByLabel('Authenticator code or recovery code').fill(code);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
}

const addForm = (page) => page.getByRole('form', { name: 'Add an address' });
/** A field of the add form by its own label (each hint sits inside the label, so a plain label match is ambiguous). */
const field = (page, name) =>
  addForm(page)
    .locator('label.field', { has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) })
    .locator('input, select');
const savedRows = (page) => page.locator('tbody tr', { hasText: 'Crypto wallet' });

test(`${J} #1 opens the address book from Withdraw: empty, with only the assets and networks the registry publishes`, async ({ page }) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'wa');
  await verify(page, who);
  await signIn(page, who);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.reset({ account: who, secret, step });

  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  await page.getByRole('link', { name: 'Manage saved addresses' }).click();
  await expect(page).toHaveURL(/\/uc\/withdraw\/address$/);
  await expect(page.getByRole('heading', { name: 'Withdrawal addresses' })).toBeVisible();
  await expect(page.getByText('You have no saved withdrawal addresses.')).toBeVisible();

  const asset = field(page, 'Asset');
  await expect(asset.locator('option')).toHaveText(['Choose an asset', 'USDC', 'USDT']);
  await expect(field(page, 'Network')).toBeDisabled();
  await asset.selectOption('USDT');
  const network = field(page, 'Network');
  await expect(network).toBeEnabled();
  await expect(network).toHaveValue('ethereum');
  await expect(network.locator('option')).toHaveText(['TEST Ethereum', 'TEST Base']);
});

test(`${J} #2 refuses a mistyped address with its reason, then saves a good one after a fresh confirmation`, async ({ page }) => {
  test.setTimeout(180_000);
  await signInWithCode(page);
  await page.goto('/uc/withdraw/address');
  const form = addForm(page);
  await field(page, 'Label').fill('TEST cold wallet');
  await field(page, 'Asset').selectOption('USDT');
  await field(page, 'Network').selectOption('base');
  await field(page, 'Address').fill('0x1234');
  await form.getByRole('button', { name: 'Save address' }).click();
  await expect(form.getByRole('alert')).toHaveText('This is not a valid address. It must be 0x followed by 40 letters a to f or digits.');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await field(page, 'Address').fill(ADDRESS);
  await form.getByRole('button', { name: 'Save address' }).click();
  await confirmItsMe(page);
  await expect(page.getByText('TEST cold wallet was saved to your address book.')).toBeVisible();

  // The bank's row: asset and network as saved, the address masked, cooling off for the stack's TEST period; the
  // full address only behind Details.
  const row = savedRows(page).filter({ hasText: 'TEST cold wallet' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('USDT · base');
  await expect(row).toContainText('Cooling off');
  await expect(row.locator('td[data-withdrawal-private]')).toHaveText('0x5290…9EE7');
  await page.reload();
  await expect(savedRows(page).filter({ hasText: 'TEST cold wallet' })).toHaveCount(1);
});

test(`${J} #4 removes a saved address after a fresh confirmation, and it is gone after a reload`, async ({ page }) => {
  test.setTimeout(180_000);
  await signInWithCode(page);
  await page.goto('/uc/withdraw/address');
  const row = savedRows(page).filter({ hasText: 'TEST cold wallet' });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Remove' }).click();
  await confirmItsMe(page);
  await expect(page.getByText('TEST cold wallet was removed from your address book.')).toBeVisible();
  await page.reload();
  await expect(savedRows(page)).toHaveCount(0);
  await expect(page.getByText('You have no saved withdrawal addresses.')).toBeVisible();
});
