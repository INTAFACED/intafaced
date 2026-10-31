import { test, expect } from './journey.mjs';
import { TOKEN_A, UNBUILT, connectWallet, dexRun, walletSection } from './dex.mjs';
import { bodyRows, tableIn } from './tables.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-dex-protocol-08, in the running app (docs/roadmap/journeys.json): keep my wallet safe with approvals, session keys,
// risk cards and reporting. One test per step, titled "J-dex-protocol-08 #<n>", run in order with one TEST wallet on Base
// Sepolia holding two session keys and old approvals. Revoke calls are signed by the person's wallet; nothing posts to
// the ledger. vendor.aml shows while no screening source is configured: the page says the list is not loaded.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - the wallet room's Session keys and Approvals sections are empty tables with no revoke or Revoke all
//   (D-portfolio-wallet-02, D-swap-04), and the stack has no TEST chain or indexer to list keys or allowances from;
// - Accounts lists no sub-accounts and has no multi-signature control (D-portfolio-wallet-02);
// - an address page has no risk card or report form (D-developer-compliance-01);
// - Safety has no education or compromise steps (D-developer-compliance-02, D-portfolio-wallet-02), and there is no
//   embedded login to export a key from (RC-dex-protocol-05).
const J = 'J-dex-protocol-08';
const dex = dexRun(J);
const account = dexRun(`${J}-account`);
// A TEST address to look up and report.
const SUSPECT = '0x000000000000000000000000000000000000bad0';

test.describe.configure({ mode: 'default' });

/** Opens one wallet section with the run's wallet connected. */
async function openSection(page, name) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await walletSection(page, name);
  return wallet;
}

/** The run's TEST account, signed in (made by #6 on first use). */
async function person(page) {
  let who = account.run.read().who;
  if (!who) {
    who = await fundedTrader(page, 'dex08', '1');
    account.run.reset({ who });
  }
  await signIn(page, who);
  return who;
}

test(`${J} starts: a TEST wallet with two active session keys and several old approvals`, async ({ page }) => {
  dex.start();
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
  const rows = bodyRows(approvals).filter({ hasText: TOKEN_A.name });
  await expect(rows).not.toHaveCount(0, UNBUILT);
  await rows.first().getByRole('button', { name: 'Revoke' }).click();
  const sheet = page.getByRole('dialog', { name: 'Check before you sign' });
  await expect(sheet.getByRole('term').filter({ hasText: 'Amount' })).toBeVisible();
  await expect(sheet).toContainText('Approve 0');
  await sheet.getByRole('button', { name: 'Continue in wallet' }).click();
  // approve(spender, 0): selector 0x095ea7b3 with a zero amount word.
  await expect.poll(() => wallet.sends.some((s) => /^0x095ea7b3[0-9a-f]{64}0{64}$/i.test(String(s.params[0]?.data)))).toBe(true);
});

test(`${J} #4 opens sub-accounts and a multi-signature account: the sub-account list; the multi-signature control shows its blocker until the contract exists`, async ({
  page,
}) => {
  await openSection(page, 'Accounts');
  await expect(page.getByRole('region', { name: 'Sub-accounts' }).getByRole('table')).toBeVisible(UNBUILT);
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
  await person(page);
  await page.goto(`/chain/address/${SUSPECT}`);
  await page.getByRole('button', { name: 'Report this address' }).click(UNBUILT);
  const report = page.getByRole('dialog', { name: 'Report this address' });
  await report.getByRole('combobox', { name: 'Reason' }).selectOption({ label: 'Scam' });
  await report.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('status')).toContainText('Thank you. Your report was received.');
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
    await expect(card).not.toContainText(account.run.read().who.handle);
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
  for (const link of await lessons.getByRole('link').all()) await expect(link).toHaveAttribute('href', /^\//);
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
  for (const name of ['Revoke session keys', 'Revoke approvals', 'Move your funds'])
    await expect(steps.getByRole('link', { name })).toBeVisible();
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
