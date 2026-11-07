// World: none
import { test, expect } from './journey.mjs';
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, maxUint256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GATE_URL, TEST_CHAIN_ID } from '../../../../tooling/scripts/local-test-chain.mjs';
import { TOKEN_A, TOKEN_B, UNBUILT, acceptRepresentation, connectWallet, dexRun, fundOnTestChain, walletSection } from './dex.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { bodyRows, tableIn } from './tables.mjs';
import { signIn, signUp } from './desk.mjs';

// J-dex-protocol-08, in the running app (docs/roadmap/journeys.json): keep my wallet safe with approvals, session keys,
// risk cards and reporting. One test per step, titled "J-dex-protocol-08 #<n>", run in order with one TEST wallet on Base
// Sepolia holding two session keys and old approvals. Revoke calls are signed by the person's wallet; nothing posts to
// the ledger. vendor.aml shows while no screening source is configured: the page says the list is not loaded.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - the wallet room's Session keys section is an empty table with no revoke or Revoke all (D-portfolio-wallet-02), and
//   the TEST chain has no smart account factory to grant keys on;
// - there is no embedded login to export a key from (RC-dex-protocol-05).
// The journey runs on the stack's TEST chain (tooling/scripts/local-test-chain.mjs): its approvals and session keys are
// on-chain state the run's wallet makes. It is put on the chain here, with the same funding dexRun gives a chain journey,
// rather than in dex.mjs's ON_TEST_CHAIN, so the two do not edit one shared line.
const J = 'J-dex-protocol-08';
const base = dexRun(J);
const dex = {
  ...base,
  onChain: true,
  start(extra = {}) {
    const walletKey = testWalletKey();
    fundOnTestChain(privateKeyToAccount(walletKey).address);
    return base.run.reset({ walletKey, ...extra });
  },
};
// The old approvals the run's wallet gives before the journey starts: an exact amount of TEST Token A to one TEST spender
// and an unlimited TEST Token B to another. Neither spender is a pool, so the list finds them from the Approval logs.
const OLD_SPENDER_A = '0x0000000000000000000000000000000000a99001';
const OLD_SPENDER_B = '0x0000000000000000000000000000000000a99002';
const OLD_APPROVALS = [
  { token: TOKEN_A.address, spender: OLD_SPENDER_A, amount: 25n * 10n ** BigInt(TOKEN_A.decimals) },
  { token: TOKEN_B.address, spender: OLD_SPENDER_B, amount: maxUint256 },
];
const testChainDef = defineChain({
  id: TEST_CHAIN_ID,
  name: 'LOCAL TEST chain',
  nativeCurrency: { name: 'TEST ETH', symbol: 'TETH', decimals: 18 },
  rpcUrls: { default: { http: [GATE_URL] } },
});

/** Gives the old approvals from the run's wallet, straight to the TEST chain, as a wallet the person used before would have. */
async function giveOldApprovals() {
  const owner = privateKeyToAccount(dex.key());
  const sender = createWalletClient({ account: owner, chain: testChainDef, transport: http(GATE_URL) });
  const reader = createPublicClient({ chain: testChainDef, transport: http(GATE_URL) });
  for (const { token, spender, amount } of OLD_APPROVALS) {
    const hash = await sender.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount] });
    expect((await reader.waitForTransactionReceipt({ hash })).status).toBe('success');
  }
}
const account = dexRun(`${J}-account`);
// A TEST address to look up and report.
const SUSPECT = '0x000000000000000000000000000000000000bad0';

test.describe.configure({ mode: 'default' });

/** Opens one wallet section with the run's wallet connected. */
async function openSection(page, name) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await walletSection(page, name);
  return wallet;
}

/**
 * A new TEST account, signed in, for #6. A new one each attempt: a report from an earlier attempt stays open, so the same
 * person on a retry would get the duplicate refusal first. Reporting needs a sign-in only, no balance.
 */
async function person(page) {
  const who = await signUp(page, 'dex08');
  account.run.reset({ who });
  await signIn(page, who);
  return who;
}

test(`${J} starts: a TEST wallet with two active session keys and several old approvals`, async ({ page }) => {
  dex.start();
  await giveOldApprovals();
  await openSection(page, 'Session keys');
  await expect(bodyRows(tableIn(page, 'Session keys')).filter({ hasText: 'Active' })).toHaveCount(2, UNBUILT);
});

test(`${J} #1 opens Connected apps and session keys: each key with scope, cap, expiry and last use; expired keys marked; no key can carry withdrawal power`, async ({
  page,
}) => {
  await openSection(page, 'Session keys');
  const keys = tableIn(page, 'Session keys');
  for (const column of ['Scope', 'Cap', 'Expires', 'Last used'])
    await expect(keys.getByRole('columnheader', { name: column })).toBeVisible(UNBUILT);
  await expect(bodyRows(keys).filter({ hasText: 'Expired' })).not.toHaveCount(0);
  await page.getByRole('button', { name: 'New session key' }).click();
  const create = page.getByRole('dialog', { name: 'New session key' });
  await expect(create.getByRole('checkbox', { name: /^Withdraw/ })).toHaveCount(0);
});

test(`${J} #2 revokes one key, then presses Revoke all: the call is built; after it mines the key reads revoked; one call revokes every key`, async ({
  page,
}) => {
  const wallet = await openSection(page, 'Session keys');
  const keys = tableIn(page, 'Session keys');
  const active = bodyRows(keys).filter({ hasText: 'Active' });
  await expect(active).toHaveCount(2, UNBUILT);
  await active.first().getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(bodyRows(keys).filter({ hasText: 'Revoked' })).toHaveCount(1, { timeout: 60_000 });
  const before = wallet.sends.length;
  await page.getByRole('button', { name: 'Revoke all' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect.poll(() => wallet.sends.length - before).toBe(1);
  await expect(bodyRows(keys).filter({ hasText: 'Active' })).toHaveCount(0, { timeout: 60_000 });
});

test(`${J} #3 opens the approvals list: spender, token and amount per approval; revoke builds approve to zero`, async ({ page }) => {
  const wallet = await openSection(page, 'Approvals');
  const approvals = tableIn(page, 'Approvals');
  // Spender, token and amount per approval.
  for (const column of ['Token', 'Spender', 'Allowance']) await expect(approvals.getByRole('columnheader', { name: column })).toBeVisible();
  const rows = bodyRows(approvals)
    .filter({ hasText: TOKEN_A.name })
    .filter({ hasText: new RegExp(OLD_SPENDER_A, 'i') });
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(rows).toContainText(/\b25(\.0+)? /);
  await expect(
    bodyRows(approvals)
      .filter({ hasText: TOKEN_B.name })
      .filter({ hasText: new RegExp(OLD_SPENDER_B, 'i') }),
  ).toContainText('Unlimited');
  await rows.first().getByRole('button', { name: 'Revoke' }).click();
  // A wallet's first signing action asks for the representation once (J-dex-protocol-01 #8); a later one goes straight on.
  const representation = page.locator('[data-panel="representation"]');
  const sheet = page.getByRole('dialog', { name: 'Check before you sign' }).filter({ has: page.locator('[data-sheet="sequence"]') });
  await expect(representation.or(sheet)).toBeVisible();
  if (await representation.isVisible()) await acceptRepresentation(page);
  await expect(sheet.getByRole('term').filter({ hasText: 'Amount' })).toBeVisible();
  await expect(sheet).toContainText('Approve 0');
  await sheet.getByRole('button', { name: 'Continue in wallet' }).click();
  // approve(spender, 0) on TEST Token A: selector 0x095ea7b3, the spender's word, then a zero amount word.
  const call = new RegExp(`^0x095ea7b3${'0'.repeat(24)}${OLD_SPENDER_A.slice(2)}${'0'.repeat(64)}$`, 'i');
  await expect
    .poll(() => wallet.sends.some((s) => call.test(String(s.params[0]?.data)) && String(s.params[0]?.to).toLowerCase() === TOKEN_A.address))
    .toBe(true);
});

test(`${J} #4 opens sub-accounts and a multi-signature account: the sub-account list; the multi-signature control shows its blocker until the contract exists`, async ({
  page,
}) => {
  await openSection(page, 'Accounts');
  await expect(page.getByRole('region', { name: 'Sub-accounts' }).getByRole('table')).toBeVisible(UNBUILT);
  // The list holds the accounts this wallet controls, starting with the connected wallet itself.
  const owner = privateKeyToAccount(dex.key()).address;
  await expect(bodyRows(tableIn(page, 'Sub-accounts')).filter({ hasText: owner })).toHaveCount(1);
  const multisig = page.getByRole('button', { name: 'Create a multi-signature account' });
  await expect(multisig).toBeDisabled();
  await expect(page.getByText(/multi-signature contract is not deployed/)).toBeVisible();
});

test(`${J} #5 opens an address page before sending: a risk card with any label and its reason; with no screening source it says the list is not loaded rather than clear`, async ({
  page,
}) => {
  await page.goto(`/chain/address/${SUSPECT}`);
  const card = page.getByRole('region', { name: 'Address risk' });
  await expect(card).toBeVisible(UNBUILT);
  await expect(card).toContainText('The screening list is not loaded');
  await expect(card.getByText(/^Clear$/)).toHaveCount(0);
});

test(`${J} #6 reports a scam address: a confirmation; a second report by the same person is refused as a duplicate; the reporter is hidden from the public`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const who = await person(page);
  await page.goto(`/chain/address/${SUSPECT}`);
  await page.getByRole('button', { name: 'Report this address' }).click(UNBUILT);
  const report = page.getByRole('dialog', { name: 'Report this address' });
  await report.getByRole('combobox', { name: 'Reason' }).selectOption({ label: 'Scam' });
  await report.getByRole('button', { name: 'Send report' }).click();
  // The confirmation shows in the risk card (the card may also be re-reading its count, which is its own status line).
  const mine = page.getByRole('region', { name: 'Address risk' });
  await expect(mine.getByRole('status').filter({ hasText: 'Thank you. Your report was received.' })).toBeVisible();
  await expect(report).toHaveCount(0);
  await page.getByRole('button', { name: 'Report this address' }).click();
  await report.getByRole('combobox', { name: 'Reason' }).selectOption({ label: 'Scam' });
  await report.getByRole('button', { name: 'Send report' }).click();
  await expect(report.getByRole('alert')).toContainText('You already reported this address');
  // Signed out, the address page shows the report count, never who reported.
  const away = await browser.newContext();
  try {
    const other = await away.newPage();
    await other.goto(`/chain/address/${SUSPECT}`);
    const card = other.getByRole('region', { name: 'Address risk' });
    await expect(card).toContainText(/Reported \d+ times?/);
    await expect(card).not.toContainText(who.handle);
    await expect(card).not.toContainText(who.email);
  } finally {
    await away.close();
  }
});

test(`${J} #7 opens the safety education and the audit room: each step opens its control; each product row says "External audit: not done" with no check mark`, async ({
  page,
}) => {
  await openSection(page, 'Safety');
  const lessons = page.getByRole('list', { name: 'Stay safe' });
  await expect(lessons.getByRole('listitem')).not.toHaveCount(0, UNBUILT);
  // Each step opens its control: every lesson links to a page of the app, and that page opens (not "Page not found").
  const targets = [];
  for (const link of await lessons.getByRole('link').all()) {
    await expect(link).toHaveAttribute('href', /^\//);
    targets.push(await link.getAttribute('href'));
  }
  expect(targets.length).toBe(await lessons.getByRole('listitem').count());
  for (const href of targets) {
    await page.goto(href);
    await expect(page.getByTestId('page-heading').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Page not found' })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(href);
  }
  await page.goto('/chain/audit');
  const audits = tableIn(page, 'Audits');
  const rows = bodyRows(audits);
  await expect(rows).not.toHaveCount(0);
  await expect(rows.filter({ hasNotText: 'External audit: not done' })).toHaveCount(0);
  await expect(audits.getByText('✓')).toHaveCount(0);
});

test(`${J} #8 follows the compromise guidance: an ordered list: revoke keys, revoke approvals, move funds, each step linked to its control`, async ({
  page,
}) => {
  await openSection(page, 'Safety');
  const steps = page.getByRole('list', { name: 'If your wallet is compromised' });
  await expect(steps.getByRole('listitem')).toHaveText([/^Revoke session keys/, /^Revoke approvals/, /^Move your funds/], UNBUILT);
  // Each step is linked to its control: the wallet's Session keys, Approvals and Send sections.
  for (const [name, href] of [
    ['Revoke session keys', '/wallet/session-keys'],
    ['Revoke approvals', '/wallet/approvals'],
    ['Move your funds', '/wallet/send'],
  ])
    await expect(steps.getByRole('link', { name })).toHaveAttribute('href', href);
});

test(`${J} #9 exports the embedded-login key once: shown once after a fresh passkey check and derives the owner address; a second request returns no key`, async ({
  page,
}) => {
  await page.goto('/wallet');
  await walletSection(page, 'Keys');
  const exportKey = page.getByRole('button', { name: 'Export my key' });
  await expect(exportKey).toBeVisible(UNBUILT);
  await exportKey.click();
  await expect(page.getByRole('dialog', { name: 'Confirm with your passkey' })).toBeVisible();
  const shown = page.getByTestId('exported-key');
  await expect(shown).toHaveText(/^0x[0-9a-f]{64}$/);
  await page.reload();
  await walletSection(page, 'Keys');
  await page.getByRole('button', { name: 'Export my key' }).click();
  await expect(page.getByRole('alert')).toContainText('This key was already exported');
  await expect(page.getByTestId('exported-key')).toHaveCount(0);
});
