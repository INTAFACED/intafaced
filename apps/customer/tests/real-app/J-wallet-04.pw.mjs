import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-wallet-04, in the running app (docs/roadmap/journeys.json): I save a withdrawal address. One test per step, titled
// "J-wallet-04 #<n>", run in order on one verified TEST account with an authenticator app, because saving and removing
// an address each ask for a fresh confirmation. The assets and networks offered are the ledger's registry rows the
// stack's founders publish (`local-test-gates.mjs assets`: TEST USDT and USDC on TEST Ethereum and TEST Base). #5 and #7
// are W-withdraw-09: here the bank's part (a new address refused with the end of its cooling-off; the security lock
// stopping address changes and withdrawals); the lock itself and the password refusal are in J-wallet-04-security-lock.
// Not here yet: #5's approval by email link or by another signed-in device, and an expired link, so #5 is titled
// "part of #5" and does not count as passed; #7 counts only when both its halves pass (each is titled "#7").
const J = 'J-wallet-04';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
// ADDRESS with the case of one letter flipped (886E0F → 886e0F): its EIP-55 checksum no longer matches.
const TAMPERED = '0x52908400098527886e0F7030069857D2E4169EE7';
// Starts and ends like ADDRESS as the book shows it (0x5290…9EE7), a different middle: the address-poisoning shape.
const LOOKALIKE = `0x5290${'1'.repeat(32)}9EE7`;

test.describe.configure({ mode: 'default' });

function account() {
  const state = run.read();
  if (!state.account) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return state;
}

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

// Two TEST wallet keys, made here from fixed labels so no key text sits in the repo. They hold nothing.
const testKey = (label) => createHash('sha256').update(`INTAFACED TEST wallet proof: ${label}`).digest('hex');
const WALLET_KEY = testKey('saved wallet');
const OTHER_KEY = testKey('another wallet');

async function noble() {
  const { secp256k1 } = await import(path.join(ROOT, 'services/svc-bank/node_modules/@noble/curves/secp256k1.js'));
  const { keccak_256 } = await import(path.join(ROOT, 'services/svc-bank/node_modules/@noble/hashes/sha3.js'));
  return { secp256k1, keccak_256 };
}

/** The EVM address of `keyHex`: the last 20 bytes of the keccak hash of its uncompressed public key. */
async function addressOf(keyHex) {
  const { secp256k1, keccak_256 } = await noble();
  const pub = secp256k1.getPublicKey(Buffer.from(keyHex, 'hex'), false);
  return `0x${Buffer.from(keccak_256(pub.subarray(1)).subarray(12)).toString('hex')}`;
}

/** What a wallet's `personal_sign` returns for `message` (EIP-191, `r || s || v`), made with the bank's own libraries. */
async function personalSign(message, keyHex) {
  const { secp256k1, keccak_256 } = await noble();
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  const recovered = secp256k1.sign(keccak_256(joined), Buffer.from(keyHex, 'hex'), { prehash: false, format: 'recovered' });
  const out = new Uint8Array(65);
  out.set(recovered.subarray(1), 0);
  out[64] = recovered[0] + 27;
  return `0x${Buffer.from(out).toString('hex')}`;
}

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

test(`${J} #3 refuses a changed character, and warns about a look-alike of a saved address until it is checked`, async ({ page }) => {
  test.setTimeout(180_000);
  await signInWithCode(page);
  await page.goto('/uc/withdraw/address');
  const form = addForm(page);
  await field(page, 'Label').fill('TEST look-alike');
  await field(page, 'Asset').selectOption('USDT');
  await field(page, 'Network').selectOption('base');

  // A changed character: the bank's checksum check refuses it at the field, before any code is asked for.
  await field(page, 'Address').fill(TAMPERED);
  await form.getByRole('button', { name: 'Save address' }).click();
  await expect(form.locator('#address-hint')).toHaveText(
    'Some letters in this address are in the wrong case, so a character may have been changed. Copy it again from where it came from.',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // A look-alike of the saved TEST cold wallet: a warning naming it, and nothing goes ahead until it is ticked.
  await field(page, 'Address').fill(LOOKALIKE);
  await form.getByRole('button', { name: 'Save address' }).click();
  const warning = form.getByTestId('address-lookalike');
  await expect(warning).toContainText('This address looks like one you saved');
  await expect(warning).toContainText(
    'It starts and ends like your saved address TEST cold wallet (0x5290…9EE7) but is a different address.',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await form.getByRole('button', { name: 'Save address' }).click();
  await expect(warning).toContainText('Tick the box once you have checked the address, or change it.');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await warning.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Save address' }).click();
  await confirmItsMe(page);
  await expect(page.getByText('TEST look-alike was saved to your address book.')).toBeVisible();
  await page.reload();
  await expect(savedRows(page)).toHaveCount(2);
  // The confirmation is recorded on the new entry, and the book says so; the entry it looks like is unchanged.
  const lookalikeRow = savedRows(page).filter({ hasText: 'TEST look-alike' });
  await expect(lookalikeRow.locator('td[data-withdrawal-private]')).toHaveText('0x5290…9EE7');
  await expect(lookalikeRow).toContainText('You confirmed the look-alike warning');
  await expect(savedRows(page).filter({ hasText: 'TEST cold wallet' })).not.toContainText('You confirmed the look-alike warning');
});

test(`${J} #4 removes a saved address after a fresh confirmation, and it is gone after a reload`, async ({ page }) => {
  test.setTimeout(240_000);
  await signInWithCode(page);
  await page.goto('/uc/withdraw/address');
  // Both entries #2 and #3 saved, one at a time, each with its own confirmation.
  for (const label of ['TEST cold wallet', 'TEST look-alike']) {
    const row = savedRows(page).filter({ hasText: label });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: 'Remove' }).click();
    await confirmItsMe(page);
    await expect(page.getByText(`${label} was removed from your address book.`)).toBeVisible();
    await page.reload();
    await expect(savedRows(page).filter({ hasText: label })).toHaveCount(0);
  }
  await expect(savedRows(page)).toHaveCount(0);
  await expect(page.getByText('You have no saved withdrawal addresses.')).toBeVisible();
});

test(`${J}, part of #5: using a new address at once is refused with the time its cooling-off ends`, async ({ page }) => {
  test.setTimeout(180_000);
  await signInWithCode(page);
  await page.goto('/uc/withdraw/address');
  const form = addForm(page);
  await field(page, 'Label').fill('TEST new wallet');
  await field(page, 'Asset').selectOption('USDT');
  await field(page, 'Network').selectOption('ethereum');
  await field(page, 'Address').fill(ADDRESS);
  await form.getByRole('button', { name: 'Save address' }).click();
  await confirmItsMe(page);
  await expect(page.getByText('TEST new wallet was saved to your address book.')).toBeVisible();

  // The book's cooling-off column and the bank's answer to "withdraw to it now" name the same end time.
  const row = savedRows(page).filter({ hasText: 'TEST new wallet' });
  const ends = ((await row.locator('td').nth(5).textContent()) ?? '').replace(/^Ends\s*/, '').trim();
  expect(ends).not.toBe('');
  await row.getByRole('button', { name: 'Withdraw to this address' }).click();
  const use = page.getByTestId('address-use');
  await expect(use.getByRole('alert')).toHaveText(
    `TEST new wallet is a new address. Money can be sent to it from ${ends}, when its cooling-off ends.`,
  );
  await expect(use.getByRole('link', { name: 'Go to Withdraw' })).toHaveCount(0);
  await use.getByRole('button', { name: 'Close' }).click();

  // Leave the book as #6 expects it: this entry removed again.
  await row.getByRole('button', { name: 'Remove' }).click();
  await confirmItsMe(page);
  await expect(page.getByText('TEST new wallet was removed from your address book.')).toBeVisible();
});

test(`${J} #6 proves a private wallet by signing a message: another wallet's signature is refused, its own is proved`, async ({ page }) => {
  test.setTimeout(180_000);
  await signInWithCode(page);
  await page.goto('/uc/withdraw/address');
  const form = addForm(page);
  await field(page, 'Label').fill('TEST private wallet');
  await field(page, 'Asset').selectOption('USDT');
  await field(page, 'Network').selectOption('ethereum');
  const wallet = await addressOf(WALLET_KEY);
  await field(page, 'Address').fill(wallet);
  await form.getByRole('button', { name: 'Save address' }).click();
  await confirmItsMe(page);
  await expect(page.getByText('TEST private wallet was saved to your address book.')).toBeVisible();

  const row = savedRows(page).filter({ hasText: 'TEST private wallet' });
  await row.getByRole('button', { name: 'Prove ownership' }).click();
  const panel = page.getByTestId('wallet-proof');
  await expect(panel).toContainText('Signing moves no funds and approves nothing else.');
  const messageBox = panel.getByTestId('wallet-proof-message');
  await expect(messageBox).toHaveValue(new RegExp(`^INTAFACED wallet ownership proof\nAddress: ${wallet}\n`));
  const message = await messageBox.inputValue();
  // No confirmation code: proving a wallet cannot change where money goes.
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Signed by another wallet: refused by name, and the same message stays to sign.
  const signature = panel.getByRole('textbox', { name: 'Signature' });
  await signature.fill(await personalSign(message, OTHER_KEY));
  await panel.getByRole('button', { name: 'Check signature' }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    `This was signed by a different wallet. Sign the message with the wallet that holds ${wallet.slice(0, 6)}…${wallet.slice(-4)}.`,
  );
  await expect(messageBox).toHaveValue(message);

  await signature.fill(await personalSign(message, WALLET_KEY));
  await panel.getByRole('button', { name: 'Check signature' }).click();
  await expect(panel.getByRole('status')).toContainText('Ownership proved. It holds until');
  await page.reload();
  const proved = savedRows(page).filter({ hasText: 'TEST private wallet' });
  await expect(proved.getByTestId('address-ownership')).toContainText('Ownership proved · until');
  await expect(proved.getByRole('button', { name: 'Prove ownership' })).toHaveCount(0);
});

test(`${J} #7 (the bank's half): with the security lock on, the bank refuses adding or removing an address and withdrawing`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInWithCode(page);
  await page.goto('/uc/safe');
  const card = page.locator('.security__lock');
  await card.getByRole('button', { name: 'Turn on the lock' }).click();
  await card.getByRole('button', { name: 'Turn it on now' }).click();
  await expect(card.locator('.notice')).toHaveText('The lock is on.');

  const LOCKED =
    'Your security lock is on, so withdrawal addresses cannot be added or removed and nothing can be withdrawn until it ends. Nothing was changed.';
  await page.goto('/uc/withdraw/address');
  // Adding: the bank refuses before a confirmation code is asked for.
  const form = addForm(page);
  await field(page, 'Label').fill('TEST while locked');
  await field(page, 'Asset').selectOption('USDT');
  await field(page, 'Network').selectOption('base');
  await field(page, 'Address').fill(ADDRESS);
  await form.getByRole('button', { name: 'Save address' }).click();
  await expect(form.getByRole('alert')).toHaveText(LOCKED);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Withdrawing to the proved wallet from #6: refused with the lock, and Security is one step away.
  const row = savedRows(page).filter({ hasText: 'TEST private wallet' });
  await row.getByRole('button', { name: 'Withdraw to this address' }).click();
  const use = page.getByTestId('address-use');
  await expect(use.getByRole('alert')).toHaveText(
    'Your security lock is on, so nothing can be withdrawn until it ends. Ask to unlock it on Security.',
  );
  await expect(use.getByRole('link', { name: 'Open Security' })).toHaveAttribute('href', '/uc/safe');

  // Removing: even after a fresh confirmation the bank refuses, and the entry stays.
  await row.getByRole('button', { name: 'Remove' }).click();
  await confirmItsMe(page);
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(LOCKED);
  await page.reload();
  await expect(savedRows(page).filter({ hasText: 'TEST private wallet' })).toHaveCount(1);

  // Asking to unlock fixes an end time; the bank's refusal then names it, and still nothing can be withdrawn.
  await page.goto('/uc/safe');
  await card.getByRole('button', { name: 'Ask to unlock' }).click();
  const state = account();
  const { totp } = await totpLib();
  const { code, step } = await nextCode(totp, state.secret, state.step);
  run.reset({ ...state, step });
  await card.getByLabel('6-digit code from your authenticator app').fill(code);
  await card.getByRole('button', { name: 'Ask with code' }).click();
  await expect(card.locator('.notice')).toContainText('Unlock asked for. The lock ends');
  await page.goto('/uc/withdraw/address');
  await savedRows(page).filter({ hasText: 'TEST private wallet' }).getByRole('button', { name: 'Withdraw to this address' }).click();
  await expect(page.getByTestId('address-use').getByRole('alert')).toContainText(
    'Your security lock is on, so nothing can be withdrawn until it ends. It ends',
  );
});
