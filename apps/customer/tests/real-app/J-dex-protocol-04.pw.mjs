import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { TOKEN_A, UNBUILT, connectWallet, dexRun, walletSection } from './dex.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';
import { ROOT, fund, mailedLines, tool } from './stack.mjs';

// J-dex-protocol-04, in the running app (docs/roadmap/journeys.json): send and receive tokens, use a claim link and scan
// a code. One test per step, titled "J-dex-protocol-04 #<n>", run in order with one TEST wallet holding TEST tokens and
// an address book entry. Transfers are signed by the person's own wallet; nothing posts to the ledger. With no node the
// room shows rail.crypto.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - the wallet room has no Send, Receive, address book, scan or claim-link panel (D-portfolio-wallet-03, -05, D-swap-12),
//   and its Activity section is an empty table with no failed or spam toggles or export;
// - the stack has no TEST chain, so a transfer, a speed-up or a cancel (RC-dex-protocol-01) has nothing to go to;
const J = 'J-dex-protocol-04';
const dex = dexRun(J);
const FRIEND = '0x52908400098527886E0F7030069857D2E4169EE7';
// A contract address on the TEST chain: sending to it needs a tick.
const CONTRACT = '0x0000000000000000000000000000000000c0ffee';

test.describe.configure({ mode: 'default' });

const send = (page) => page.getByRole('form', { name: 'Send' });

async function openSend(page) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await walletSection(page, 'Send');
  await expect(send(page)).toBeVisible(UNBUILT);
  return wallet;
}

test(`${J} starts: a TEST wallet with TEST tokens and one address book entry`, async ({ page }) => {
  dex.start();
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await walletSection(page, 'Address book');
  const book = page.getByRole('form', { name: 'Add a contact' });
  await book.getByRole('textbox', { name: /^Label/ }).fill('TEST friend');
  await book.getByRole('textbox', { name: /^Address/ }).fill(FRIEND);
  await book.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByRole('region', { name: 'Contacts' }).getByRole('table')).toContainText('TEST friend');
});

test(`${J} #1 opens Send and types a new address: a summary; confirming needs the last four characters; a contract needs a tick; sending to oneself is refused`, async ({
  page,
}) => {
  const wallet = await openSend(page);
  await send(page).getByRole('combobox', { name: 'Token' }).selectOption({ label: 'TEST Token A' });
  await send(page)
    .getByRole('textbox', { name: /^Amount/ })
    .fill('1');
  await send(page).getByRole('textbox', { name: /^To/ }).fill(FRIEND);
  await send(page).getByRole('button', { name: 'Review' }).click();
  const summary = page.getByRole('dialog', { name: 'Review the send' });
  await expect(summary).toContainText(FRIEND);
  const confirm = summary.getByRole('button', { name: 'Send' });
  await expect(confirm).toBeDisabled();
  await summary.getByRole('textbox', { name: /^Last four characters/ }).fill(FRIEND.slice(-4));
  await expect(confirm).toBeEnabled();
  await summary.getByRole('button', { name: 'Back' }).click();

  await send(page).getByRole('textbox', { name: /^To/ }).fill(CONTRACT);
  await send(page).getByRole('button', { name: 'Review' }).click();
  await expect(summary.getByRole('note')).toContainText('This address is a contract.');
  await expect(summary.getByRole('checkbox', { name: /I know this is a contract/ })).not.toBeChecked();
  await summary.getByRole('button', { name: 'Back' }).click();

  await send(page).getByRole('textbox', { name: /^To/ }).fill(wallet.address);
  await send(page).getByRole('button', { name: 'Review' }).click();
  await expect(send(page).getByRole('alert')).toHaveText('You cannot send to your own wallet.');
});

test(`${J} #2 types a name that does not resolve: "Name not resolved" and nothing is sent`, async ({ page }) => {
  const wallet = await openSend(page);
  await send(page).getByRole('textbox', { name: /^To/ }).fill('nobody-here.test');
  await expect(send(page).getByRole('alert')).toHaveText('Name not resolved');
  await expect(send(page).getByRole('button', { name: 'Review' })).toBeDisabled();
  expect(wallet.requests).toHaveLength(0);
});

test(`${J} #3 saves the address in the address book and groups two wallets: the contact with its label; the group shows combined activity`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await walletSection(page, 'Address book');
  await expect(
    page.getByRole('region', { name: 'Contacts' }).getByRole('table').getByRole('row').filter({ hasText: 'TEST friend' }),
  ).toContainText(FRIEND);
  await page.getByRole('button', { name: 'New wallet group' }).click();
  const group = page.getByRole('dialog', { name: 'New wallet group' });
  await group.getByRole('textbox', { name: /^Name/ }).fill('TEST group');
  await group.getByRole('checkbox', { name: /TEST friend/ }).check();
  await group.getByRole('checkbox', { name: /This wallet/ }).check();
  await group.getByRole('button', { name: 'Save group' }).click();
  await page.getByRole('link', { name: 'TEST group' }).click();
  await expect(page.getByRole('region', { name: 'Group activity' }).getByRole('table')).toBeVisible();
});

test(`${J} #4 opens Receive: the address, a code and a warning naming the network for a wrong-chain deposit`, async ({ page }) => {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await walletSection(page, 'Receive');
  const receive = page.getByRole('region', { name: 'Receive' });
  await expect(receive.getByText(wallet.address)).toBeVisible();
  await expect(receive.getByRole('img', { name: 'Address code' })).toBeVisible();
  await expect(receive.getByRole('note')).toContainText('Only send on Base Sepolia test network. Tokens sent on another network are lost.');
});

test(`${J} #5 scans a code on a phone: an address opens Send pre-filled, a token address opens its page, a connection code opens the confirm, unknown reads "Not recognised"`, async ({
  page,
}) => {
  // A phone: its viewport, and its camera. Headless Chromium has no camera and no code reader, so both are stood in for
  // at the browser's edge: the camera gives a blank stream and the reader returns what the next code holds. The app's own
  // camera path (Use the camera, the video, the read loop) runs unchanged.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    window.__codes = [];
    window.BarcodeDetector = class {
      async detect() {
        return window.__codes.length > 0 ? [{ rawValue: window.__codes.shift() }] : [];
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      canvas.getContext('2d').fillRect(0, 0, 2, 2);
      return canvas.captureStream();
    };
  });
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  const asked = { requests: wallet.requests.length, sends: wallet.sends.length };
  const scan = page.getByRole('region', { name: 'Scan a code' });
  const scanCode = async (text) => {
    await walletSection(page, 'Scan');
    await scan.getByRole('button', { name: 'Use the camera' }).click();
    await expect(scan.getByLabel('Use the camera')).toBeVisible();
    await page.evaluate((code) => window.__codes.push(code), text);
  };
  await scanCode(`ethereum:${FRIEND}`);
  await expect(send(page).getByRole('textbox', { name: /^To/ })).toHaveValue(FRIEND);
  // Unsubmitted: no review is open, and the wallet was asked for nothing.
  await expect(page.getByRole('dialog', { name: 'Review the send' })).toHaveCount(0);
  expect({ requests: wallet.requests.length, sends: wallet.sends.length }).toEqual(asked);
  await scanCode(`ethereum:${TOKEN_A.address}@84532`);
  await expect(page).toHaveURL(new RegExp(`/dex/tokens/${TOKEN_A.address}$`, 'i'));
  await page.goBack();
  await scanCode('wc:00000000-0000-4000-8000-000000000000@2?relay-protocol=irn&symKey=00');
  await expect(page.getByRole('dialog', { name: 'Connect to this app?' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await scanCode('hello');
  await expect(scan.getByRole('alert')).toHaveText('Not recognised');
  expect({ requests: wallet.requests.length, sends: wallet.sends.length }).toEqual(asked);
});

test(`${J} #6 creates a claim link for TEST tokens: amount and expiry; the recipient claims once and a second claim fails; claw back after expiry`, async ({
  page,
  browser,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await walletSection(page, 'Claim links');
  const create = page.getByRole('form', { name: 'New claim link' });
  await create.getByRole('textbox', { name: /^Amount/ }).fill('2');
  await create.getByRole('textbox', { name: /^Expires in/ }).fill('1');
  await create.getByRole('button', { name: 'Create link' }).click();
  const link = await page.getByRole('textbox', { name: 'Claim link' }).inputValue();
  expect(link).toMatch(/\/claim\//);
  const other = await browser.newContext();
  try {
    const recipient = await other.newPage();
    await recipient.goto(link);
    await recipient.getByRole('button', { name: 'Claim 2 TEST Token A' }).click();
    await expect(recipient.getByRole('status')).toContainText('Claimed');
    await recipient.reload();
    await expect(recipient.getByRole('alert')).toContainText('This link was already claimed.');
  } finally {
    await other.close();
  }
  await expect(page.getByRole('region', { name: 'Your claim links' }).getByRole('table')).toContainText('Claimed');
  // An unclaimed link past its expiry can be clawed back by the sender.
  await expect(page.getByRole('button', { name: 'Claw back' }).first()).toBeEnabled({ timeout: 120_000 });
});

test(`${J} #7 opens Activity and toggles failed and spam: the counts change with the toggles and the export equals the visible rows`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await walletSection(page, 'Activity');
  const activity = page.getByRole('region', { name: 'Activity' }).getByRole('table');
  const count = page.getByTestId('activity-count');
  await expect(count).toHaveText(/^\d+ shown$/, UNBUILT);
  const before = await count.innerText();
  await page.getByRole('checkbox', { name: 'Show failed' }).check();
  await page.getByRole('checkbox', { name: 'Show spam' }).check();
  await expect(count).not.toHaveText(before);
  const rows = (await activity.getByRole('row').count()) - 1;
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const file = await (await download).path();
  expect(readFileSync(file, 'utf8').trim().split('\n').length - 1).toBe(rows);
});

test(`${J} #8 speeds up a pending transfer, then cancels another that has mined: a same-nonce replacement with a higher fee; the mined one is final`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await walletSection(page, 'Activity');
  const pending = page.getByRole('region', { name: 'Activity' }).getByRole('table').getByRole('row').filter({ hasText: 'Pending' }).first();
  await pending.getByRole('button', { name: 'Speed up' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'Speed up' });
  await expect(sheet).toContainText('Same nonce, higher fee');
  await sheet.getByRole('button', { name: 'Continue in wallet' }).click();
  const mined = page.getByRole('region', { name: 'Activity' }).getByRole('table').getByRole('row').filter({ hasText: 'Confirmed' }).first();
  await expect(mined).toContainText('Final');
  await expect(mined.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
});

test(`${J} #9 opens Withdraw from the exchange with a wallet connected: destination and network filled and read-only until Edit; step-up still applies; no wallet: "Connect a wallet to use it"`, async ({
  page,
  browser,
}) => {
  test.setTimeout(360_000);
  // A verified TEST account with an authenticator, TEST USDT, and the connected wallet's own address saved on TEST
  // Ethereum, approved by its emailed link and past its cooling-off (as J-wallet-05 starts), so the send can reach step-up.
  tool('local-test-gates.mjs', 'withdraw-terms');
  const who = await signUp(page, 'dex04');
  await verify(page, who);
  await signIn(page, who);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const factor = await addAuthenticator(page, totp);
  let step = factor.step;
  const code = async () => {
    const next = await nextCode(totp, factor.secret, step);
    step = next.step;
    return next.code;
  };
  const confirmItsMe = async (on) => {
    const dialog = on.getByRole('dialog', { name: 'Confirm it’s you' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Authenticator code or recovery code').fill(await code());
    await dialog.getByRole('button', { name: 'Confirm' }).click();
  };
  expect(fund(who.email, 'USDT', '10').tx).toBeTruthy();
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });

  await page.goto('/uc/withdraw/address');
  const add = page.getByRole('form', { name: 'Add an address' });
  await add.getByRole('textbox', { name: /^Label/ }).fill('TEST my wallet');
  await add.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  await add.getByRole('combobox', { name: /^Network/ }).selectOption('ethereum');
  await add.getByRole('textbox', { name: /^Address/ }).fill(wallet.address);
  await add.getByRole('button', { name: 'Save address' }).click();
  await confirmItsMe(page);
  await expect(page.getByText('TEST my wallet was saved to your address book.')).toBeVisible();
  const seen = mailedLines(who.email, 'withdraw-address-approval').length;
  await page.locator('tbody tr', { hasText: 'TEST my wallet' }).getByRole('button', { name: 'Withdraw to this address' }).click();
  await page.getByTestId('address-use').getByRole('button', { name: 'Email me an approval link' }).click();
  const links = () =>
    mailedLines(who.email, 'withdraw-address-approval').map((line) => `/${/link=(approveAddress\?token=\S+)/.exec(line)?.[1]}`);
  await expect.poll(() => links().length, { timeout: 20_000 }).toBeGreaterThan(seen);
  const other = await browser.newContext();
  try {
    const away = await other.newPage();
    await away.goto(links().at(-1));
    await away.getByRole('link', { name: 'Sign in' }).last().click();
    await away.fill('input[name=totp]', await code());
    await away.fill('input[name=identifier]', who.email);
    await away.fill('input[name=password]', who.password);
    await away.getByRole('button', { name: /^sign in$/i }).click();
    await expect(away).toHaveURL(/\/approveAddress$/);
    await away.getByTestId('approve-address').getByRole('button', { name: 'Approve' }).click();
    await confirmItsMe(away);
    await expect(away.getByRole('heading', { name: 'Address approved' })).toBeVisible();
  } finally {
    await other.close();
  }
  expect(tool('local-test-stack.mjs', 'age-addresses', who.email, '25')).toContain('1 saved address(es)');

  // With the wallet connected, the destination is the wallet's address and the network the one it is saved on, both
  // read-only until Edit.
  await page.goto('/uc/withdraw?to=wallet');
  const form = page.getByTestId('withdraw-form');
  await form.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  const destination = form.getByRole('textbox', { name: /^Your wallet/ });
  const network = form.getByRole('combobox', { name: /^Network/ });
  await expect(destination).toHaveValue(wallet.address);
  await expect(destination).not.toBeEditable();
  await expect(network).toHaveValue('ethereum');
  await expect(network).toBeDisabled();
  await form.getByRole('button', { name: 'Edit' }).click();
  const edited = form.getByRole('textbox', { name: /^Or enter a new address/ });
  await expect(edited).toHaveValue(wallet.address);
  await expect(edited).toBeEditable();
  await expect(network).toBeEnabled();
  await expect(network).toHaveValue('ethereum');

  // Sending to the wallet is still a withdrawal: it asks the step-up like any other.
  await page.goto('/uc/withdraw?to=wallet');
  await form.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  await expect(destination).toHaveValue(wallet.address);
  await form.getByRole('textbox', { name: /^Amount/ }).fill('1');
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await page.getByRole('button', { name: 'Confirm and send' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm it’s you' })).toContainText('Sending money out needs a fresh confirmation.');
  await page.keyboard.press('Escape');

  // With the wallet disconnected, nothing is filled and the chip says how to use it.
  await page.goto('/wallet');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.goto('/uc/withdraw?to=wallet');
  await expect(page.getByTestId('withdraw-wallet')).toContainText('Connect a wallet to use it');
  await expect(form.getByRole('textbox', { name: /^Your wallet/ })).toHaveCount(0);
  await expect(form.getByRole('textbox', { name: /^Or enter a new address/ })).toHaveValue('');
});
