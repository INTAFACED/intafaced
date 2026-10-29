import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { TOKEN_A, UNBUILT, connectWallet, continueSignIn, dexRun, walletSection } from './dex.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-dex-protocol-04, in the running app (docs/roadmap/journeys.json): send and receive tokens, use a claim link and scan
// a code. One test per step, titled "J-dex-protocol-04 #<n>", run in order with one TEST wallet holding TEST tokens and
// an address book entry. Transfers are signed by the person's own wallet; nothing posts to the ledger. With no node the
// room shows rail.crypto.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - the wallet room has no Send, Receive, address book, scan or claim-link panel (D-portfolio-wallet-03, -05, D-swap-12),
//   and its Activity section is an empty table with no failed or spam toggles or export;
// - the stack has no TEST chain, so a transfer, a speed-up or a cancel (RC-dex-protocol-01) has nothing to go to;
// - #9 opens the exchange's Withdraw with a wallet connected: the destination is not filled from the wallet yet
//   (D-bridge-chain-02).
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
  await continueSignIn(page);
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
  await continueSignIn(page);
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
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await walletSection(page, 'Scan');
  const scan = page.getByRole('region', { name: 'Scan a code' });
  // The camera is stood in for by pasting what the code holds.
  const read = async (text) => {
    await scan.getByRole('textbox', { name: /^Or paste what the code holds/ }).fill(text);
    await scan.getByRole('button', { name: 'Read' }).click();
  };
  await read(`ethereum:${FRIEND}`);
  await expect(send(page).getByRole('textbox', { name: /^To/ })).toHaveValue(FRIEND);
  expect(await send(page).getByRole('button', { name: 'Send' }).count()).toBe(0);
  await walletSection(page, 'Scan');
  await read(`ethereum:${TOKEN_A.address}@84532`);
  await expect(page).toHaveURL(new RegExp(`/dex/tokens/${TOKEN_A.address}$`, 'i'));
  await page.goBack();
  await read('wc:00000000-0000-4000-8000-000000000000@2?relay-protocol=irn&symKey=00');
  await expect(page.getByRole('dialog', { name: 'Connect to this app?' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await read('hello');
  await expect(scan.getByRole('alert')).toHaveText('Not recognised');
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
}) => {
  test.setTimeout(240_000);
  const who = await fundedTrader(page, 'dex04', '10');
  await signIn(page, who);
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.goto('/uc/withdraw?to=wallet');
  const form = page.getByTestId('withdraw-form');
  const destination = form.getByRole('textbox', { name: /^Your wallet/ });
  await expect(destination).toHaveValue(wallet.address, UNBUILT);
  await expect(destination).not.toBeEditable();
  await form.getByRole('button', { name: 'Edit' }).click();
  await expect(destination).toBeEditable();
  // Sending to the wallet is still a withdrawal: it asks the step-up like any other.
  await form.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  await form.getByRole('textbox', { name: /^Amount/ }).fill('1');
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await page.getByRole('button', { name: 'Confirm and send' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm it’s you' })).toBeVisible();
  await page.keyboard.press('Escape');

  // With the wallet disconnected, the chip says how to use it.
  await page.goto('/wallet');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.goto('/uc/withdraw?to=wallet');
  await expect(form).toContainText('Connect a wallet to use it');
});
