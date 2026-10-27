import { test, expect } from '@playwright/test';
import { signIn, signUp, verify } from './desk.mjs';
import { installTestWallet } from './test-wallet.mjs';

// J-dex-protocol-04, in the running app (docs/roadmap/journeys.json): send and receive TEST tokens from the person's own
// wallet, use a claim link and scan a code. One test per step, titled "J-dex-protocol-04 #<n>". Transfers are signed by
// the TEST wallet in test-wallet.mjs; nothing posts to the ledger. Step 9 is the exchange's own Withdraw, signed in.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - The wallet room (/wallet) connects a wallet but has no Send, Receive, address book, claim links or activity list
//   (D-portfolio-wallet-03, -05, D-swap-12), and the stack publishes no node, so no transfer can be built (rail.crypto).
// - #8: no speed-up or cancel of a pending transfer (RC-dex-protocol-01).
// - #9: Withdraw does not fill the destination from a connected wallet (D-bridge-chain-02).
const J = 'J-dex-protocol-04';
const UNBUILT = { timeout: 5_000 };
const BASE_SEPOLIA = 84532;
const FRIEND = '0x52908400098527886E0F7030069857D2E4169EE7';
const CONTRACT = '0x4200000000000000000000000000000000000006';

test.describe.configure({ mode: 'default' });

/** The wallet room with the TEST wallet connected; returns the wallet. */
async function connected(page, path = '/wallet') {
  const wallet = await installTestWallet(page, { chainId: BASE_SEPOLIA });
  await page.goto(path);
  await page.getByRole('button', { name: /^Connect TEST Wallet/ }).click(UNBUILT);
  await expect(page.getByText(wallet.address).first()).toBeVisible();
  return wallet;
}

const sendForm = (page) => page.getByRole('form', { name: 'Send' });

async function openSend(page) {
  await page.getByRole('link', { name: 'Send', exact: true }).click(UNBUILT);
  await expect(sendForm(page)).toBeVisible();
}

test(`${J} #1 opens Send and types a new address: a summary, confirm needs the last four characters, a contract warns and needs a tick, and sending to oneself is refused`, async ({
  page,
}) => {
  const wallet = await connected(page);
  await openSend(page);
  const to = sendForm(page).getByRole('textbox', { name: 'To' });
  await to.fill(FRIEND);
  await sendForm(page).getByRole('textbox', { name: 'Amount' }).fill('1');
  await sendForm(page).getByRole('button', { name: 'Review' }).click();
  const summary = page.getByRole('dialog', { name: 'Review the transfer' });
  await expect(summary).toContainText(FRIEND.slice(0, 6));
  const confirm = summary.getByRole('button', { name: 'Send' });
  await expect(confirm).toBeDisabled();
  await summary.getByRole('textbox', { name: /last four characters/ }).fill(FRIEND.slice(-4));
  await expect(confirm).toBeEnabled();
  await summary.getByRole('button', { name: 'Back' }).click();

  await to.fill(CONTRACT);
  await sendForm(page).getByRole('button', { name: 'Review' }).click();
  await expect(summary).toContainText(/This address is a contract/);
  await expect(summary.getByRole('checkbox', { name: /I understand/ })).toBeVisible();
  await summary.getByRole('button', { name: 'Back' }).click();

  await to.fill(wallet.address);
  await expect(sendForm(page).getByRole('alert')).toContainText('You can’t send to your own address.');
});

test(`${J} #2 types a name that does not resolve: "Name not resolved" and nothing is sent`, async ({ page }) => {
  const wallet = await connected(page);
  await openSend(page);
  await sendForm(page).getByRole('textbox', { name: 'To' }).fill('no-such-name-for-test.eth');
  await expect(sendForm(page)).toContainText('Name not resolved');
  await expect(sendForm(page).getByRole('button', { name: 'Review' })).toBeDisabled();
  expect(wallet.requests.filter((request) => request.method === 'eth_sendTransaction')).toEqual([]);
});

test(`${J} #3 saves the address in the address book and groups two wallets: the contact with its label, and the group's combined activity`, async ({
  page,
}) => {
  await connected(page);
  await page.getByRole('link', { name: 'Address book' }).click(UNBUILT);
  await page.getByRole('button', { name: 'Add a contact' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a contact' });
  await dialog.getByRole('textbox', { name: 'Label' }).fill('TEST friend');
  await dialog.getByRole('textbox', { name: 'Address' }).fill(FRIEND);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('table', { name: 'Contacts' }).getByRole('row', { name: /TEST friend/ })).toBeVisible();

  await page.getByRole('link', { name: 'Wallet groups' }).click();
  await page.getByRole('button', { name: 'Make a group' }).click();
  const group = page.getByRole('dialog', { name: 'Make a group' });
  await group.getByRole('textbox', { name: 'Group name' }).fill('TEST group');
  await group.getByRole('textbox', { name: 'Add a wallet address' }).fill(FRIEND);
  await group.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('link', { name: 'TEST group' }).click();
  await expect(page.getByRole('table', { name: 'Activity' })).toBeVisible();
});

test(`${J} #4 opens Receive: the address, a code and a warning naming the network for a wrong-chain deposit`, async ({ page }) => {
  const wallet = await connected(page);
  await page.getByRole('link', { name: 'Receive', exact: true }).click(UNBUILT);
  await expect(page.getByRole('main')).toContainText(wallet.address);
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
  await expect(page.getByRole('main')).toContainText(/Only send on Base Sepolia test network/);
});

test(`${J} #5 scans a code: an address opens Send filled and unsent; a token opens its page; a connection code opens the confirmation; an unknown code reads "Not recognised"`, async ({
  page,
}) => {
  await connected(page);
  await page.getByRole('button', { name: 'Scan a code' }).click(UNBUILT);
  const scan = page.getByRole('dialog', { name: 'Scan a code' });
  const paste = async (text) => {
    await scan.getByRole('textbox', { name: 'Or paste what the code holds' }).fill(text);
    await scan.getByRole('button', { name: 'Open' }).click();
  };
  await paste(`ethereum:${FRIEND}@${BASE_SEPOLIA}`);
  await expect(sendForm(page).getByRole('textbox', { name: 'To' })).toHaveValue(FRIEND);
  await page.getByRole('button', { name: 'Scan a code' }).click();
  await paste('not-a-known-code');
  await expect(scan).toContainText('Not recognised');
});

test(`${J} #6 creates a claim link for TEST tokens: a link with the amount and expiry; the recipient claims once, a second claim fails; the sender claws back after expiry`, async ({
  page,
  browser,
}) => {
  await connected(page);
  await page.getByRole('link', { name: 'Claim links' }).click(UNBUILT);
  await page.getByRole('button', { name: 'Make a claim link' }).click();
  const dialog = page.getByRole('dialog', { name: 'Make a claim link' });
  await dialog.getByRole('textbox', { name: 'Amount' }).fill('1');
  await dialog.getByRole('button', { name: 'Make the link' }).click();
  const link = (await page.getByTestId('claim-link').textContent())?.trim();
  expect(link).toMatch(/\/claim\//);
  await expect(page.getByTestId('claim-link-summary')).toContainText(/1 TEST.*expires/i);

  const friend = await browser.newContext();
  const other = await friend.newPage();
  await installTestWallet(other, { chainId: BASE_SEPOLIA });
  await other.goto(link);
  await other.getByRole('button', { name: /^Connect TEST Wallet/ }).click(UNBUILT);
  await other.getByRole('button', { name: 'Claim' }).click();
  await expect(other.getByRole('status')).toContainText('Claimed');
  await other.reload();
  await expect(other.getByRole('main')).toContainText('This link has already been claimed');
  await friend.close();
});

test(`${J} #7 opens Activity and toggles failed and spam: the counts change and the export equals the visible rows`, async ({ page }) => {
  await connected(page, '/wallet/activity');
  const rows = page.getByRole('table', { name: 'Activity' }).locator('tbody tr');
  await expect(page.getByRole('checkbox', { name: 'Show failed' })).toBeVisible(UNBUILT);
  const shown = await rows.count();
  await page.getByRole('checkbox', { name: 'Show failed' }).check();
  await page.getByRole('checkbox', { name: 'Show spam' }).check();
  expect(await rows.count()).toBeGreaterThanOrEqual(shown);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export' }).click()]);
  const csv = Buffer.concat(await (await download.createReadStream()).toArray()).toString('utf8');
  expect(csv.trim().split('\n').length - 1).toBe(await rows.count());
});

test(`${J} #8 speeds up a pending transfer, then cancels one that has mined: a same-nonce replacement with a higher fee; a mined one is final and cannot be cancelled`, async ({
  page,
}) => {
  await connected(page, '/wallet/activity');
  const pending = page
    .getByRole('table', { name: 'Activity' })
    .getByRole('row', { name: /Pending/ })
    .first();
  await expect(pending).toBeVisible(UNBUILT);
  await pending.getByRole('button', { name: 'Speed up' }).click();
  await expect(page.getByRole('dialog', { name: 'Speed up' })).toContainText(/same nonce/i);
  const mined = page
    .getByRole('table', { name: 'Activity' })
    .getByRole('row', { name: /Confirmed/ })
    .first();
  await expect(mined).toContainText('Final');
  await expect(mined.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
});

test(`${J} #9 opens Withdraw on the exchange with a wallet connected: destination and network filled and read-only until Edit, the step-up still applies; with no wallet the chip says "Connect a wallet to use it"`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'dw');
  await verify(page, who);
  await signIn(page, who);
  await page.goto('/uc/withdraw');
  await expect(page.getByRole('button', { name: 'Use my wallet' })).toContainText('Connect a wallet to use it', UNBUILT);
  const wallet = await connected(page, '/uc/withdraw');
  await page.getByRole('button', { name: 'Use my wallet' }).click();
  const address = page.getByTestId('withdraw-form').getByRole('textbox', { name: /^Or enter a new address/ });
  await expect(address).toHaveValue(wallet.address);
  await expect(address).not.toBeEditable();
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(address).toBeEditable();
});
