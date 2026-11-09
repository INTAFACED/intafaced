// World: gates, stack
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainRecordPath, GATE_URL } from '../../../../tooling/scripts/local-test-chain.mjs';
import { test, expect } from './journey.mjs';
import {
  CHAIN_ID,
  TOKEN_A,
  UNBUILT,
  acceptRepresentation,
  connectWallet,
  continueSignIn,
  dexRun,
  fundOnTestChain,
  testChain,
  walletSection,
} from './dex.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';
import { ROOT, fund, mailedLines, tool } from './stack.mjs';
import { installTestWallet, testWalletKey, TEST_WALLET } from './test-wallet.mjs';

// J-dex-protocol-04, in the running app (docs/roadmap/journeys.json): send and receive tokens, use a claim link and scan
// a code. One test per step, titled "J-dex-protocol-04 #<n>", run in order with one TEST wallet holding TEST tokens and
// an address book entry. Transfers are signed by the person's own wallet; nothing posts to the ledger. With no node the
// room shows rail.crypto.
// The journey runs on the stack's LOCAL TEST chain (dex.mjs ON_TEST_CHAIN), which carries the claim-link escrow and the
// TEST Airdrop token (services/svc-protocol/scripts/seed-test-chain.ts). Steps #6 to #8 check the page and the chain:
// what the escrow holds, who received what, and which transaction the chain kept at a nonce. #8 pauses the chain's
// mining while it runs and always starts it again.
const J = 'J-dex-protocol-04';
const dex = dexRun(J);
const FRIEND = '0x52908400098527886E0F7030069857D2E4169EE7';
// A contract address on the TEST chain: sending to it needs a tick.
const CONTRACT = '0x0000000000000000000000000000000000c0ffee';

// The stack's TEST chain, read the way any wallet or explorer reads a chain: balances, the escrow's links, transactions.
const chain = createPublicClient({ transport: http(GATE_URL) });
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const chainRecord = () => JSON.parse(readFileSync(chainRecordPath(), 'utf8'));
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);
const ESCROW = parseAbi([
  'function minExpirySeconds() view returns (uint64)',
  'function links(address id) view returns (address sender, address token, uint256 amount, uint64 expiresAt, uint8 state)',
  'function claim(address id, address to, bytes signature)',
  'function clawback(address id)',
  'event Created(address indexed id, address indexed sender, address indexed token, uint256 amount, uint64 expiresAt)',
  'error NotOpen()',
  'error NotExpired()',
  'error Expired()',
  'error BadSignature()',
]);
const tokenBalance = (token, who) => chain.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] });
/** One link as the escrow holds it; state 1 open, 2 claimed, 3 clawed back. */
async function linkOnChain(escrow, id) {
  const [sender, token, amount, expiresAt, state] = await chain.readContract({
    address: escrow,
    abi: ESCROW,
    functionName: 'links',
    args: [id],
  });
  return { sender, token, amount, expiresAt, state };
}
/** What a link key signs to pay `to` (ClaimLinkEscrow.claimDigest, before its personal-message prefix). */
const claimHashOf = (escrow, id, to) =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }],
      [escrow, BigInt(CHAIN_ID), id, to],
    ),
  );
/** The person's own key sending straight to the TEST chain, as another app or the wallet itself would. */
const signer = (key) =>
  createWalletClient({
    account: privateKeyToAccount(key),
    chain: defineChain({
      id: CHAIN_ID,
      name: 'LOCAL TEST chain',
      nativeCurrency: { name: 'TEST ETH', symbol: 'TESTETH', decimals: 18 },
      rpcUrls: { default: { http: [GATE_URL] } },
    }),
    transport: http(GATE_URL),
  });
/** The published fee bump of a speed-up or cancel on this stack (the labelled TEST owner value). */
const BUMP_BPS = BigInt(
  JSON.parse(readFileSync(path.join(ROOT, 'tooling/profiles/test-owner-values/protocol.json'), 'utf8')).values.PROTOCOL_TX_FEE_BUMP_BPS
    .value,
);
const ceilBump = (fee) => (fee * (10_000n + BUMP_BPS) + 9_999n) / 10_000n;
const FINAL = 'Final. A completed transfer cannot be canceled or revoked; send a new transaction instead.';

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
  // The summary names who sends, how much of which token, and on which network.
  await expect(summary).toContainText(new RegExp(`From\\s*${wallet.address}`, 'i'));
  await expect(summary).toContainText(/Amount\s*1 TEST Token A/);
  await expect(summary).toContainText(/Network\s*Base Sepolia/);
  const confirm = summary.getByRole('button', { name: 'Send' });
  await expect(confirm).toBeDisabled();
  await summary.getByRole('textbox', { name: /^Last four characters/ }).fill(FRIEND.slice(-4));
  await expect(confirm).toBeEnabled();
  await summary.getByRole('button', { name: 'Back' }).click();

  await send(page).getByRole('textbox', { name: /^To/ }).fill(CONTRACT);
  await send(page).getByRole('button', { name: 'Review' }).click();
  await expect(summary.getByRole('note')).toContainText('This address is a contract.');
  const tick = summary.getByRole('checkbox', { name: /I know this is a contract/ });
  await expect(tick).not.toBeChecked();
  // The last four alone do not open Send for a contract; the tick does.
  await summary.getByRole('textbox', { name: /^Last four characters/ }).fill(CONTRACT.slice(-4));
  await expect(confirm).toBeDisabled();
  await tick.check();
  await expect(confirm).toBeEnabled();
  await tick.uncheck();
  await expect(confirm).toBeDisabled();
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
  test.setTimeout(180_000);
  // A second wallet of the person's own, funded on the TEST chain: its address is the new one saved in the address book.
  const otherKey = testWalletKey();
  const other = privateKeyToAccount(otherKey).address;
  fundOnTestChain(other);
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  // One transfer from each wallet of the group, sent on the TEST chain to someone outside it.
  const fromThis = await signer(dex.key()).sendTransaction({
    to: TOKEN_A.address,
    data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [FRIEND, parseUnits('1', TOKEN_A.decimals)] }),
  });
  const fromOther = await signer(otherKey).sendTransaction({
    to: TOKEN_A.address,
    data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [FRIEND, parseUnits('2', TOKEN_A.decimals)] }),
  });
  expect((await chain.waitForTransactionReceipt({ hash: fromThis })).status).toBe('success');
  expect((await chain.waitForTransactionReceipt({ hash: fromOther })).status).toBe('success');

  await walletSection(page, 'Address book');
  await continueSignIn(page);
  const contacts = page.getByRole('region', { name: 'Contacts' }).getByRole('table');
  await expect(contacts.getByRole('row').filter({ hasText: 'TEST friend' })).toContainText(FRIEND);
  // Saves the new address with its label: the contact appears with that label and that address.
  const book = page.getByRole('form', { name: 'Add a contact' });
  await book.getByRole('textbox', { name: /^Label/ }).fill('TEST second wallet');
  await book.getByRole('textbox', { name: /^Address/ }).fill(other);
  await book.getByRole('button', { name: 'Save contact' }).click();
  await expect(contacts.getByRole('row').filter({ hasText: 'TEST second wallet' })).toContainText(new RegExp(other, 'i'));

  // Groups the two wallets: this wallet and the saved one.
  await page.getByRole('button', { name: 'New wallet group' }).click();
  const group = page.getByRole('dialog', { name: 'New wallet group' });
  await group.getByRole('textbox', { name: /^Name/ }).fill('TEST group');
  await group.getByRole('checkbox', { name: /TEST second wallet/ }).check();
  await group.getByRole('checkbox', { name: /This wallet/ }).check();
  await group.getByRole('button', { name: 'Save group' }).click();
  await page.getByRole('link', { name: 'TEST group' }).click();
  const members = page.getByRole('region', { name: 'Wallets in the group' }).getByRole('table');
  await expect(members.getByRole('row').filter({ hasText: 'This wallet' })).toContainText(new RegExp(wallet.address, 'i'));
  await expect(members.getByRole('row').filter({ hasText: 'TEST second wallet' })).toContainText(new RegExp(other, 'i'));

  // Combined activity: the group's activity lists the transfer each wallet sent, one row each, once the chain is read.
  const activity = page.getByRole('region', { name: 'Group activity' }).getByRole('table');
  const rowOf = (hash) => activity.getByRole('row').filter({ has: page.locator(`a[href="/chain/tx/${hash.toLowerCase()}"]`) });
  await expect(rowOf(fromThis)).toHaveCount(1, { timeout: 60_000 });
  await expect(rowOf(fromOther)).toHaveCount(1, { timeout: 60_000 });
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
      static async getSupportedFormats() {
        return ['qr_code'];
      }
      async detect() {
        return window.__codes.length > 0 ? [{ rawValue: window.__codes.shift() }] : [];
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const paint = canvas.getContext('2d');
      // A canvas stream carries a frame only when the canvas is painted: keep painting so the video always has one.
      setInterval(() => paint.fillRect(0, 0, 2, 2), 50);
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
  expect(await send(page).getByRole('button', { name: 'Send' }).count()).toBe(0);
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

test(`${J} #6 creates a claim link for TEST tokens and shares it: a link with the amount and an expiry; the recipient claims once and a second claim fails; the sender can claw back after expiry`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const { claimEscrow: escrow } = chainRecord();
  expect(escrow, 'the TEST chain was seeded with the claim-link escrow').toMatch(/^0x[0-9a-fA-F]{40}$/);
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  const me = wallet.address;
  const [minExpiry] = await Promise.all([chain.readContract({ address: escrow, abi: ESCROW, functionName: 'minExpirySeconds' })]);
  expect(minExpiry, 'a one-minute link is within the published bounds').toBeLessThanOrEqual(60n);
  await walletSection(page, 'Claim links');
  const create = page.getByRole('form', { name: 'New claim link' });
  const linkBox = page.getByRole('textbox', { name: 'Claim link' });
  const links = page.getByRole('region', { name: 'Your claim links' }).getByRole('table');
  const makeLink = async (amount, { first }) => {
    const before = first ? '' : await linkBox.inputValue();
    await create.getByRole('combobox', { name: 'Token' }).selectOption({ label: 'TEST Token A' });
    await create.getByRole('textbox', { name: /^Amount/ }).fill(amount);
    await create.getByRole('textbox', { name: /^Expires in/ }).fill('1');
    await create.getByRole('button', { name: 'Create link' }).click();
    // A fresh wallet accepts the representation once, before its first signing action.
    if (first) await acceptRepresentation(page);
    await page.locator('[data-sheet="sequence"]').getByRole('button', { name: 'Continue in wallet' }).click();
    await expect(linkBox).toHaveValue(/\/wallet\/claim\/0x[0-9a-fA-F]{40}#0x[0-9a-fA-F]{64}$/, { timeout: 60_000 });
    if (!first) await expect(linkBox).not.toHaveValue(before);
    const url = await linkBox.inputValue();
    const [, id, key] = /\/wallet\/claim\/(0x[0-9a-fA-F]{40})#(0x[0-9a-fA-F]{64})$/.exec(url);
    // The link's key is the link: its address is the id the escrow holds the tokens under.
    expect(privateKeyToAccount(key).address.toLowerCase()).toBe(id.toLowerCase());
    // A link with the amount and an expiry: the page says both, and the escrow holds exactly that, for one minute.
    await expect(page.getByText(`Your link for ${amount} TEST Token A. It expires 1 min`)).toBeVisible();
    await expect.poll(async () => (await linkOnChain(escrow, id)).state, { timeout: 30_000 }).toBe(1);
    const held = await linkOnChain(escrow, id);
    expect(same(held.sender, me) && same(held.token, TOKEN_A.address)).toBe(true);
    expect(held.amount).toBe(parseUnits(amount, TOKEN_A.decimals));
    const created = (await chain.getContractEvents({ address: escrow, abi: ESCROW, eventName: 'Created', args: { id }, fromBlock: 0n })).at(
      -1,
    );
    const block = await chain.getBlock({ blockNumber: created.blockNumber });
    expect(held.expiresAt - block.timestamp, 'expires one minute after the block that locked it').toBe(60n);
    const row = links.locator(`tr[data-claim-link="${getAddress(id)}"]`);
    await expect(row).toContainText(`${amount} TEST Token A`, { timeout: 15_000 });
    await expect(row).toContainText(new Date(Number(held.expiresAt) * 1000).getFullYear().toString());
    await expect(row).toContainText('Waiting to be claimed');
    return { url, id, key, row };
  };

  const escrowBefore = await tokenBalance(TOKEN_A.address, escrow);
  const meBefore = await tokenBalance(TOKEN_A.address, me);
  const claimed = await makeLink('2', { first: true });
  const kept = await makeLink('1', { first: false });
  expect(await tokenBalance(TOKEN_A.address, escrow)).toBe(escrowBefore + parseUnits('3', 6));
  expect(await tokenBalance(TOKEN_A.address, me)).toBe(meBefore - parseUnits('3', 6));

  // Before its expiry the sender cannot claw back: the button is off and the escrow refuses.
  await expect(kept.row.getByRole('button', { name: 'Claw back' })).toBeDisabled();
  await expect(
    chain.simulateContract({ account: me, address: escrow, abi: ESCROW, functionName: 'clawback', args: [kept.id] }),
  ).rejects.toThrow(/NotExpired/);

  // The recipient: another person with their own TEST wallet, in another browser, opens the link and claims once.
  const friendRun = dexRun(`${J}-recipient`);
  friendRun.start();
  const other = await browser.newContext();
  try {
    const recipient = await other.newPage();
    const asked = [];
    recipient.on('request', (request) => asked.push(`${request.url()} ${request.postData() ?? ''}`));
    const friend = await installTestWallet(recipient, {
      chainId: CHAIN_ID,
      tokens: [TOKEN_A],
      privateKey: friendRun.key(),
      rpcUrl: testChain().gateUrl,
    });
    const friendBefore = await tokenBalance(TOKEN_A.address, friend.address);
    await recipient.goto(claimed.url);
    await expect(recipient.getByText('2 TEST Token A', { exact: true })).toBeVisible();
    await recipient.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
    await recipient.getByRole('button', { name: 'Claim 2 TEST Token A' }).click();
    await acceptRepresentation(recipient);
    await recipient.locator('[data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet' }).click();
    await expect(recipient.getByText(`Claimed: 2 TEST Token A are in your wallet`)).toBeVisible({ timeout: 60_000 });
    expect(await tokenBalance(TOKEN_A.address, friend.address)).toBe(friendBefore + parseUnits('2', 6));
    expect((await linkOnChain(escrow, claimed.id)).state).toBe(2);
    // A second claim fails: the page offers none, and the escrow refuses the same signed claim again.
    await recipient.reload();
    await expect(recipient.getByText('This link was already claimed.')).toBeVisible();
    await expect(recipient.getByRole('button', { name: /^Claim / })).toHaveCount(0);
    const signature = await privateKeyToAccount(claimed.key).signMessage({
      message: { raw: claimHashOf(escrow, claimed.id, friend.address) },
    });
    await expect(
      chain.simulateContract({
        account: friend.address,
        address: escrow,
        abi: ESCROW,
        functionName: 'claim',
        args: [claimed.id, friend.address, signature],
      }),
    ).rejects.toThrow(/NotOpen/);
    // The link's key never left the browser: no request the recipient's page made carries it.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter((line) => line.toLowerCase().includes(claimed.key.slice(2).toLowerCase()))).toEqual([]);
  } finally {
    await other.close();
  }
  await expect(claimed.row).toContainText('Claimed by', { timeout: 15_000 });
  await expect(claimed.row.getByRole('button', { name: 'Claw back' })).toHaveCount(0);

  // After its expiry the unclaimed link can be clawed back by its sender, and the tokens come home.
  await expect(kept.row.getByRole('button', { name: 'Claw back' })).toBeEnabled({ timeout: 120_000 });
  await expect(kept.row).toContainText('Expired, not claimed');
  const home = await tokenBalance(TOKEN_A.address, me);
  await kept.row.getByRole('button', { name: 'Claw back' }).click();
  await page.locator('[data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(page.getByText('The tokens are back in your wallet.')).toBeVisible({ timeout: 60_000 });
  expect(await tokenBalance(TOKEN_A.address, me)).toBe(home + parseUnits('1', 6));
  expect((await linkOnChain(escrow, kept.id)).state).toBe(3);
  await expect(kept.row).toContainText('Taken back', { timeout: 15_000 });
  await expect(kept.row.getByRole('button', { name: 'Claw back' })).toHaveCount(0);
});

test(`${J} #7 opens Activity and toggles failed and spam: the counts change with the toggles and the export equals the visible rows`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  // A transfer this wallet sent that failed on the chain (more TEST Token A than it holds), and TEST Airdrop, a token no
  // pool lists, sent to it unasked by someone else.
  const failed = await signer(dex.key()).sendTransaction({
    to: TOKEN_A.address,
    data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [FRIEND, parseUnits('1000000000', TOKEN_A.decimals)] }),
    gas: 100_000n,
  });
  expect((await chain.waitForTransactionReceipt({ hash: failed })).status).toBe('reverted');
  const spam = /in (0x[0-9a-fA-F]{64})/.exec(fundOnTestChain(wallet.address, 'spam'))?.[1];
  expect(spam, 'the TEST Airdrop transfer hash').toBeTruthy();

  await walletSection(page, 'Activity');
  const table = page.getByRole('region', { name: 'Activity' }).getByRole('table');
  const count = page.getByTestId('activity-count');
  const showFailed = page.getByRole('checkbox', { name: 'Show failed' });
  const showSpam = page.getByRole('checkbox', { name: 'Show spam' });
  const rowOf = (hash) => table.locator(`tr[data-activity-row="${hash.toLowerCase()}"]`);
  const shownHashes = async () =>
    (await table.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')))).map((href) =>
      href.replace('/chain/tx/', '').toLowerCase(),
    );
  const counted = async () => Number(/^(\d+) shown$/.exec(await count.innerText())?.[1]);

  // Both rows reach the list once the indexer reads their blocks; then both toggles go off again.
  await showFailed.check();
  await showSpam.check();
  await expect(rowOf(failed)).toContainText('Failed', { timeout: 60_000 });
  await expect(rowOf(spam)).toContainText('Spam', { timeout: 60_000 });
  await showFailed.uncheck();
  await showSpam.uncheck();
  await expect(rowOf(failed)).toHaveCount(0);
  await expect(rowOf(spam)).toHaveCount(0);
  const base = await counted();
  expect(base, 'the count is the rows shown').toBe((await shownHashes()).length);

  await showFailed.check();
  await expect(count).toHaveText(`${base + 1} shown`);
  await expect(rowOf(failed)).toHaveCount(1);
  await expect(rowOf(spam)).toHaveCount(0);
  await showFailed.uncheck();
  await showSpam.check();
  await expect(count).toHaveText(`${base + 1} shown`);
  await expect(rowOf(spam)).toHaveCount(1);
  await expect(rowOf(failed)).toHaveCount(0);
  await showFailed.check();
  await expect(count).toHaveText(`${base + 2} shown`);

  const exported = async () => {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export' }).click();
    const lines = readFileSync(await (await download).path(), 'utf8')
      .trim()
      .split('\n');
    expect(lines[0]).toBe('"Transaction","Time (UTC)","What","Status"');
    return lines.slice(1).map((line) => JSON.parse(line.split(',')[0]).toLowerCase());
  };
  // The export equals the visible rows, row for row, with both toggles on and with both off.
  const all = await shownHashes();
  expect(all).toHaveLength(base + 2);
  expect(await exported()).toEqual(all);
  await showFailed.uncheck();
  await showSpam.uncheck();
  await expect(count).toHaveText(`${base} shown`);
  const plain = await shownHashes();
  expect(plain).toHaveLength(base);
  const file = await exported();
  expect(file).toEqual(plain);
  expect(file).not.toContain(failed.toLowerCase());
  expect(file).not.toContain(spam.toLowerCase());
});

test(`${J} #8 speeds up a pending transfer, then cancels another that has mined: a same-nonce replacement with a higher fee; for the mined one the row says it is final and a completed transfer cannot be canceled`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  const activity = page.getByRole('region', { name: 'Activity' }).getByRole('table');
  const rowOf = (hash) => activity.locator(`tr[data-activity-row="${hash}"]`);
  /** Sends 1 TEST Token A to the friend through Send; returns the hash the page shows. */
  const sendOne = async () => {
    await walletSection(page, 'Send');
    await send(page).getByRole('combobox', { name: 'Token' }).selectOption({ label: 'TEST Token A' });
    await send(page)
      .getByRole('textbox', { name: /^Amount/ })
      .fill('1');
    await send(page).getByRole('textbox', { name: /^To/ }).fill(FRIEND);
    await send(page).getByRole('button', { name: 'Review' }).click();
    const summary = page.getByRole('dialog', { name: 'Review the send' });
    await summary.getByRole('textbox', { name: /^Last four characters/ }).fill(FRIEND.slice(-4));
    await summary.getByRole('button', { name: 'Send' }).click();
    await page.locator('[data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet' }).click();
    const sent = page.getByText(/^Sent to the network\. Transaction 0x[0-9a-fA-F]{64}\.$/);
    await expect(sent).toBeVisible({ timeout: 30_000 });
    return /0x[0-9a-fA-F]{64}/.exec(await sent.innerText())[0].toLowerCase();
  };
  // The TEST chain stops mining for this step, so a send stays pending until the step mines a block itself.
  await chain.request({ method: 'evm_setIntervalMining', params: [0] });
  try {
    const first = await sendOne();
    const original = await chain.getTransaction({ hash: first });
    expect(original.blockNumber, 'the transfer is pending').toBeNull();
    await walletSection(page, 'Activity');
    await expect(rowOf(first)).toContainText('Pending', { timeout: 30_000 });

    await rowOf(first).getByRole('button', { name: 'Speed up' }).click();
    const sheet = page.getByRole('dialog', { name: 'Speed up' });
    await expect(sheet).toContainText('Same nonce, higher fee');
    await expect(sheet).toContainText(`at nonce ${original.nonce} with a higher fee`);
    await expect(sheet.locator('[data-fee="old-max"]')).toHaveText(`${formatUnits(original.maxFeePerGas, 9)} gwei`);
    await expect(sheet.locator('[data-fee="new-max"]')).toHaveText(`${formatUnits(ceilBump(original.maxFeePerGas), 9)} gwei`);
    const sends = wallet.sends.length;
    await sheet.getByRole('button', { name: 'Continue in wallet' }).click();
    await page.locator('[data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet' }).click();
    const replacedText = page.getByText(/^Replacement sent: 0x[0-9a-fA-F]{64}\.$/);
    await expect(replacedText).toBeVisible({ timeout: 30_000 });
    const replacement = /0x[0-9a-fA-F]{64}/.exec(await replacedText.innerText())[0].toLowerCase();
    expect(wallet.sends).toHaveLength(sends + 1);
    // A same-nonce replacement with a higher fee: same call, same nonce, both fees raised by at least the published bump.
    const asked = wallet.sends.at(-1).params[0];
    expect(BigInt(asked.nonce)).toBe(BigInt(original.nonce));
    const pendingReplacement = await chain.getTransaction({ hash: replacement });
    expect(pendingReplacement.nonce).toBe(original.nonce);
    expect(same(pendingReplacement.to, original.to) && pendingReplacement.input === original.input).toBe(true);
    expect(pendingReplacement.maxFeePerGas).toBeGreaterThanOrEqual(ceilBump(original.maxFeePerGas));
    expect(pendingReplacement.maxPriorityFeePerGas).toBeGreaterThanOrEqual(ceilBump(original.maxPriorityFeePerGas));

    // The network keeps the replacement and drops the original.
    await chain.request({ method: 'evm_mine', params: [] });
    expect((await chain.getTransactionReceipt({ hash: replacement })).status).toBe('success');
    await expect(chain.getTransaction({ hash: first })).rejects.toThrow();
    await expect(rowOf(replacement)).toContainText('Confirmed', { timeout: 30_000 });
    await expect(rowOf(first)).toContainText(`Replaced by ${replacement.slice(0, 6)}`);

    // Another transfer: Cancel is opened while it is pending, and it mines before the person continues.
    const second = await sendOne();
    expect((await chain.getTransaction({ hash: second })).blockNumber).toBeNull();
    await walletSection(page, 'Activity');
    await expect(rowOf(second)).toContainText('Pending', { timeout: 30_000 });
    await rowOf(second).getByRole('button', { name: 'Cancel' }).click();
    const cancel = page.getByRole('dialog', { name: 'Cancel this transaction' });
    await expect(cancel).toContainText('Sends nothing to yourself at nonce');
    await chain.request({ method: 'evm_mine', params: [] });
    expect((await chain.getTransactionReceipt({ hash: second })).status).toBe('success');
    const before = wallet.sends.length;
    await cancel.getByRole('button', { name: 'Continue in wallet' }).click();
    await expect(cancel.getByRole('alert')).toHaveText(FINAL);
    expect(wallet.sends, 'nothing was sent to cancel a mined transfer').toHaveLength(before);
    await cancel.getByRole('button', { name: 'Back' }).click();
    for (const hash of [second, replacement]) {
      const mined = rowOf(hash);
      await expect(mined).toContainText('Confirmed', { timeout: 30_000 });
      await expect(mined).toContainText(FINAL);
      await expect(mined.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
      await expect(mined.getByRole('button', { name: 'Speed up' })).toHaveCount(0);
    }
  } finally {
    await chain.request({ method: 'evm_setIntervalMining', params: [1] });
  }
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
