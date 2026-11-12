// World: restart
import { test, expect } from './journey.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  maxUint256,
  pad,
  parseAbi,
  parseEther,
  toFunctionSelector,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainRecordPath, GATE_URL, TEST_CHAIN_ID } from '../../../../tooling/scripts/local-test-chain.mjs';
import { makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import {
  CHAIN_ID,
  TOKEN_A,
  TOKEN_B,
  UNBUILT,
  acceptRepresentation,
  connectWallet,
  dexRun,
  fundOnTestChain,
  walletSection,
} from './dex.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { bodyRows, tableIn } from './tables.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, virtualAuthenticator } from './identity-factors.mjs';
import { api, ORIGIN } from './stack.mjs';
import { testVenue, venueAccount, venueForThisFile, venueInfo, venueRecord } from './venue.mjs';

// J-dex-protocol-08, in the running app (docs/roadmap/journeys.json): keep my wallet safe with approvals, session keys,
// risk cards and reporting. One test per step, titled "J-dex-protocol-08 #<n>", run in order with one TEST wallet on Base
// Sepolia holding two session keys and old approvals. Revoke calls are signed by the person's wallet; nothing posts to
// the ledger. vendor.aml shows while no screening source is configured: the page says the list is not loaded.
// #4's sub-account list includes the wallet's own sub-accounts on the trading venue: the file turns svc-trade's user-venue
// door on in front of the stack's TEST venue (venue.mjs venueForThisFile), and #4 compares the list with the TEST venue's
// own record of the wallet's sub-accounts (venueRecord). The venue is read for a signed-in person, so #4 signs one in.
// #5's published label is a TEST label written into svc-protocol's label store on the stack: nothing publishes labels in
// the app yet (the compliance queue is the next part of D-developer-compliance-01), and the card must show it with its reason.
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

// The start state's session keys: the run's wallet makes its smart account with the TEST chain's seeded factory, then
// grants two keys for a day and a third that expires within seconds, each allowed one router function and a small cap,
// signed by the wallet itself, as an app the person used before would have asked it to.
const accountAbi = parseAbi([
  'function createAccount(address owner, bytes32 userSalt) returns (address)',
  'function getAddress(address owner, bytes32 userSalt) view returns (address)',
  'function grantSession((address key, uint48 validAfter, uint48 validUntil, uint128 spendLimitWei, address[] targets, bytes4[] selectors) spec)',
]);
const DEFAULT_SALT = `0x${'00'.repeat(32)}`;
// A router function that moves nothing out of the account by itself (never transfer or approve).
const ROUTER_SELECTOR = '0x38ed1739';
const SESSION_KEYS = {
  first: '0x000000000000000000000000000000000005e001',
  second: '0x000000000000000000000000000000000005e002',
  brief: '0x000000000000000000000000000000000005e003',
};

async function giveOldSessionKeys() {
  const record = JSON.parse(readFileSync(chainRecordPath(), 'utf8'));
  expect(record.accountFactory, 'the TEST chain was seeded with a smart account factory').toMatch(/^0x[0-9a-fA-F]{40}$/);
  const owner = privateKeyToAccount(dex.key());
  const sender = createWalletClient({ account: owner, chain: testChainDef, transport: http(GATE_URL) });
  const reader = createPublicClient({ chain: testChainDef, transport: http(GATE_URL) });
  const mined = async (hash) => expect((await reader.waitForTransactionReceipt({ hash })).status).toBe('success');
  await mined(
    await sender.writeContract({
      address: record.accountFactory,
      abi: accountAbi,
      functionName: 'createAccount',
      args: [owner.address, DEFAULT_SALT],
    }),
  );
  const smart = await reader.readContract({
    address: record.accountFactory,
    abi: accountAbi,
    functionName: 'getAddress',
    args: [owner.address, DEFAULT_SALT],
  });
  const clock = async () => Number((await reader.getBlock()).timestamp);
  const spec = (key, validUntil) => ({
    key,
    validAfter: 0,
    validUntil,
    spendLimitWei: parseEther('0.05'),
    targets: [record.router],
    selectors: [ROUTER_SELECTOR],
  });
  const grant = async (key, validUntil) =>
    mined(await sender.writeContract({ address: smart, abi: accountAbi, functionName: 'grantSession', args: [spec(key, validUntil)] }));
  await grant(SESSION_KEYS.first, (await clock()) + 86_400);
  await grant(SESSION_KEYS.second, (await clock()) + 86_400);
  // The brief key ends 20 seconds after the chain's clock now, and is expired once the clock passes that.
  const briefEnd = (await clock()) + 20;
  await grant(SESSION_KEYS.brief, briefEnd);
  await expect.poll(async () => (await clock()) > briefEnd, { timeout: 90_000 }).toBe(true);
}

/**
 * Continues a signing action as the person does: a wallet's first one asks for the representation once (J-dex-protocol-01
 * #8), a later one goes straight to the plain-words sheet; then Continue in wallet on that sheet.
 */
async function continueSigning(page) {
  const representation = page.locator('[data-panel="representation"]');
  const sheet = page.getByRole('dialog', { name: 'Check before you sign' }).filter({ has: page.locator('[data-sheet="sequence"]') });
  await expect(representation.or(sheet)).toBeVisible();
  if (await representation.isVisible()) await acceptRepresentation(page);
  await sheet.getByRole('button', { name: 'Continue in wallet' }).click();
}

const account = dexRun(`${J}-account`);
// A TEST address to look up and report.
const SUSPECT = '0x000000000000000000000000000000000000bad0';
// A TEST address with a published TEST label (#5).
const LABELLED = '0x000000000000000000000000000000000000bad1';
const LABEL = { value: 'TEST phishing drainer', reason: 'TEST: asked people to sign an approval for all their tokens' };

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

/** One query on svc-protocol's own database role on the stack (loopback, the marker's postgres port, the stack's secret). */
async function protocolDb(run) {
  const ctx = await makeContext({ log: () => undefined });
  const postgres = createRequire(nodePath.join(REPO, 'services', 'svc-protocol', 'package.json'))('postgres');
  const port = ctx.marker.ports.postgres ?? 15460;
  const sql = postgres(`postgres://svc_protocol:${encodeURIComponent(ctx.secrets.pgService)}@127.0.0.1:${port}/intafaced_local_test`, {
    max: 1,
    onnotice: () => {},
  });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

/** The person's wallet signs one action on its own main venue account, on the TEST venue directly (as J-agents-08 does). */
async function ownVenueAction(intent) {
  const wallet = privateKeyToAccount(dex.key());
  const owner = wallet.address.toLowerCase();
  const prepared = await testVenue('/prepare', { account: await venueAccount(owner), signer: { role: 'owner', address: owner }, intent });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const t = prepared.body.typedData;
  const signature = await wallet.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await testVenue('/submit', {
    prepared: prepared.body,
    signature: { digest: prepared.body.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(sent.body.accepted, JSON.stringify(sent.body)).toBe(true);
}

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
  await giveOldSessionKeys();
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
  // Each key with its scope, cap, expiry and last use, as granted on chain.
  const first = bodyRows(keys).filter({ hasText: new RegExp(SESSION_KEYS.first, 'i') });
  await expect(first).toHaveCount(1, { timeout: 30_000 });
  const cell = (row, n) => row.getByRole('cell').nth(n);
  await expect(cell(first, 1)).toContainText(ROUTER_SELECTOR);
  await expect(cell(first, 2)).toContainText(/^0\.05 ETH/);
  await expect(cell(first, 3)).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  await expect(cell(first, 4)).toHaveText('Never');
  // Expired keys are marked.
  await expect(
    bodyRows(keys)
      .filter({ hasText: new RegExp(SESSION_KEYS.brief, 'i') })
      .getByRole('cell')
      .nth(5),
  ).toHaveText('Expired');
  // A key cannot be built with withdrawal power: there is no such option, and a transfer function is refused before anything is signed.
  await expect(page.getByRole('note').filter({ hasText: 'A session key can never move tokens out of your account' })).toBeVisible();
  await page.getByRole('button', { name: 'New session key' }).click();
  const create = page.getByRole('dialog', { name: 'New session key' });
  await expect(create.getByRole('checkbox', { name: /^Withdraw/ })).toHaveCount(0);
  await create.getByLabel('Session key address').fill('0x000000000000000000000000000000000005e0ff');
  await create.getByLabel('Contract it may call').fill(TOKEN_A.address);
  await create.getByLabel('Functions it may call').fill('0xa9059cbb');
  await create.getByRole('button', { name: 'Review and grant' }).click();
  await expect(create.getByRole('alert')).toContainText('a session key can never call a function that moves tokens out of your account');
  await expect(page.locator('[data-sheet]')).toHaveCount(0);
});

test(`${J} #2 revokes one key, then presses Revoke all: the call is built; after it mines the key reads revoked; one call revokes every key`, async ({
  page,
}) => {
  const wallet = await openSection(page, 'Session keys');
  const keys = tableIn(page, 'Session keys');
  const active = bodyRows(keys).filter({ hasText: 'Active' });
  await expect(active).toHaveCount(2, UNBUILT);
  const before1 = wallet.sends.length;
  const revoked = await active.first().getAttribute('data-session-key');
  await active.first().getByRole('button', { name: 'Revoke' }).click();
  await continueSigning(page);
  // The call is built: one transaction to the smart account, revokeSession(that key).
  await expect.poll(() => wallet.sends.length - before1).toBe(1);
  expect(String(wallet.sends.at(-1).params[0]?.data).toLowerCase()).toBe(
    `${toFunctionSelector('function revokeSession(address)')}${pad(revoked).slice(2)}`.toLowerCase(),
  );
  // After it mines, the key reads revoked.
  await expect(bodyRows(keys).filter({ hasText: 'Revoked' })).toHaveCount(1, { timeout: 60_000 });
  await expect(bodyRows(keys).filter({ hasText: 'Active' })).toHaveCount(1);
  const before = wallet.sends.length;
  await page.getByRole('button', { name: 'Revoke all' }).click();
  await continueSigning(page);
  // One call ends every key: bumpSessionEpoch() on the smart account.
  await expect.poll(() => wallet.sends.length - before).toBe(1);
  expect(String(wallet.sends.at(-1).params[0]?.data)).toBe(toFunctionSelector('function bumpSessionEpoch()'));
  await expect(bodyRows(keys).filter({ hasText: 'Active' })).toHaveCount(0, { timeout: 60_000 });
  await expect(bodyRows(keys).filter({ hasText: 'Revoked' })).toHaveCount(3);
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
  // The Allowance column (the third) shows the exact amount given.
  await expect(rows.getByRole('cell').nth(2)).toHaveText(/^25(\.0+)? \S+$/);
  await expect(
    bodyRows(approvals)
      .filter({ hasText: TOKEN_B.name })
      .filter({ hasText: new RegExp(OLD_SPENDER_B, 'i') })
      .getByRole('cell')
      .nth(2),
  ).toHaveText('Unlimited');
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
  test.setTimeout(240_000);
  const owner = privateKeyToAccount(dex.key()).address;
  // The wallet's own sub-account on the trading venue, opened before by the wallet signing the venue's action on the TEST
  // venue itself (the app has no control that opens one): once per wallet, so a retry finds it there.
  const SUB_NAME = 'TEST savings';
  if (!(await venueRecord(owner, '/sub-accounts')).value.some((sub) => sub.name === SUB_NAME))
    await ownVenueAction({ kind: 'create_sub_account', name: SUB_NAME, subAccountKey: `${J}:${owner.toLowerCase()}:sub` });
  const listed = (await venueRecord(owner, '/sub-accounts')).value;
  expect(listed.map((sub) => sub.name)).toEqual([SUB_NAME]);
  // The venue is read for a signed-in person who passed the checks.
  const who = await signUp(page, 'dex08a');
  await verify(page, who);
  await signIn(page, who);
  await openSection(page, 'Accounts');
  const accounts = bodyRows(tableIn(page, 'Sub-accounts'));
  await expect(accounts).toHaveCount(2, UNBUILT);
  // The connected wallet itself, then its smart account: the one the start made with the TEST chain's factory, deployed.
  const record = JSON.parse(readFileSync(chainRecordPath(), 'utf8'));
  const reader = createPublicClient({ chain: testChainDef, transport: http(GATE_URL) });
  const smart = await reader.readContract({
    address: record.accountFactory,
    abi: accountAbi,
    functionName: 'getAddress',
    args: [owner, DEFAULT_SALT],
  });
  await expect(accounts.nth(0)).toContainText('This wallet');
  await expect(accounts.nth(0)).toContainText(owner);
  await expect(accounts.nth(1)).toContainText('Smart account');
  await expect(accounts.nth(1)).toContainText(smart);
  await expect(accounts.nth(1).getByRole('cell').nth(2)).toHaveText('Deployed');
  // The wallet's sub-accounts on the venue: exactly the venue's own list, each by its name and address, the venue named
  // with its TEST label, and the venue's as-of time.
  const { displayName } = await venueInfo();
  const venueRows = bodyRows(tableIn(page, 'Venue sub-accounts'));
  await expect(venueRows).toHaveCount(listed.length);
  for (const [i, sub] of listed.entries()) {
    await expect(venueRows.nth(i).getByRole('cell').nth(0)).toHaveText(sub.name);
    await expect(venueRows.nth(i).getByRole('cell').nth(1)).toHaveText(sub.subAccount);
  }
  const named = page.getByTestId('venue-subs-venue');
  await expect(named).toContainText(displayName);
  await expect(named.getByTestId('venue-test')).toHaveText('TEST');
  await expect(page.getByTestId('venue-as-of')).toContainText('As of');
  const multisig = page.getByRole('button', { name: 'Create a multi-signature account' });
  await expect(multisig).toBeDisabled();
  await expect(page.getByText(/multi-signature contract is not deployed/)).toBeVisible();
});

test(`${J} #5 opens an address page before sending: a risk card with any label and its reason; with no screening source it says the list is not loaded rather than clear`, async ({
  page,
}) => {
  // A TEST label published about another address, as the label store holds it: the card shows it with its reason.
  await protocolDb(
    (sql) => sql`
      INSERT INTO protocol.address_labels (chain_id, address, kind, value, source, reputation, reason, set_by)
      VALUES (${CHAIN_ID}, ${LABELLED}, 'phishing', ${LABEL.value}, 'curator', 'UNSAFE', ${LABEL.reason}, 'LOCAL TEST journey')
      ON CONFLICT (chain_id, lower(address), kind) DO NOTHING`,
  );
  await page.goto(`/chain/address/${LABELLED}`);
  const labelled = page.getByRole('region', { name: 'Address risk' });
  await expect(labelled).toBeVisible(UNBUILT);
  await expect(labelled).toContainText('Risk: unsafe');
  await expect(labelled.getByRole('listitem').filter({ hasText: LABEL.value })).toHaveText(
    `${LABEL.value} (phishing). Why: ${LABEL.reason}`,
  );
  await expect(labelled).toContainText('The screening list is not loaded');
  await expect(labelled.getByText(/^Clear$/)).toHaveCount(0);
  // An address with no label: nothing is invented, and with no screening source it is still not read as clear.
  await page.goto(`/chain/address/${SUSPECT}`);
  const card = page.getByRole('region', { name: 'Address risk' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('No label is published for this address.');
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
  // Each step opens its own control: every lesson links to the control it is about, and that control is there.
  const tab = (name) => page.getByRole('group', { name: 'Wallet sections' }).getByRole('button', { name, exact: true });
  const CONTROLS = [
    ['Look up an address', '/chain', () => page.getByRole('searchbox', { name: /Search by address, transaction or block/ })],
    ['Send', '/wallet/send', () => tab('Send')],
    ['Address book', '/wallet/address-book', () => tab('Address book')],
    ['Approvals', '/wallet/approvals', () => tab('Approvals')],
    ['Session keys', '/wallet/session-keys', () => tab('Session keys')],
    ['Tokens', '/dex/tokens', () => page.getByRole('searchbox', { name: 'Search tokens' })],
    ['Audit room', '/chain/audit', () => page.getByRole('region', { name: 'Audits', exact: true })],
  ];
  await expect(lessons.getByRole('link')).toHaveText(CONTROLS.map(([name]) => name));
  for (const [name, href] of CONTROLS) await expect(lessons.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
  for (const [name, href, control] of CONTROLS) {
    await page.goto(href);
    expect(new URL(page.url()).pathname, name).toBe(href);
    await expect(control(), name).toBeVisible();
    if (href.startsWith('/wallet/')) await expect(control(), name).toHaveAttribute('aria-pressed', 'true');
  }
  await page.goto('/chain/audit');
  const audits = tableIn(page, 'Audits');
  const rows = bodyRows(audits);
  // One row per product the service lists, each named.
  const products = await (await fetch(`${ORIGIN}/api/protocol/trpc/auditProducts`)).json();
  const names = { swap: 'Swap', pools: 'Pools', lending: 'Lending', orders: 'Orders', launch: 'Launch', bridge: 'Bridge' };
  const listed = products.result.data.products.map((p) => names[p.product] ?? p.product);
  expect(listed.length).toBeGreaterThan(0);
  await expect(rows.getByRole('rowheader')).toHaveText(listed);
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

// #9 runs on the person's embedded wallet (J-wallet-22's, /wallet/embedded): its key is kept by the stack's labelled
// TEST wallet provider (tooling/scripts/local-test-wallet-provider.mjs), which gives it out once, after a passkey check.
// Passkeys belong to the stack's relying party `localhost`, so this step uses the customer app at PASSKEY_ORIGIN and
// Chromium's virtual authenticator for the person's device.
test.describe('the embedded login', () => {
  test.use({ baseURL: PASSKEY_ORIGIN });

  test(`${J} #9 exports the embedded-login key once: shown once after a fresh passkey check and derives the owner address; a second request returns no key`, async ({
    page,
  }) => {
    const auth = await virtualAuthenticator(page);
    const held = async () => (await auth.cdp.send('WebAuthn.getCredentials', { authenticatorId: auth.authenticatorId })).credentials;
    const who = await signUp(page, 'jdex08k');
    await page.goto('/wallet/embedded');
    const panel = page.locator('[data-panel="embedded-wallet"]');
    await page.getByRole('button', { name: 'Create my wallet' }).click(UNBUILT);
    const owner = panel.locator('[data-embedded-address]');
    await expect(owner).toHaveText(/^0x[0-9a-fA-F]{40}$/, { timeout: 20_000 });
    const ownerAddress = await owner.textContent();
    const client = await api(who);
    const status = await client.get('/api/protocol/trpc/embeddedWallet.status');
    expect(status.status).toBe(200);
    // The owner address is the one INTAFACED records for this person's wallet.
    expect(status.body.result.data.wallet.address).toBe(ownerAddress);

    // Everything the page sends to and hears from the provider, and everything it sends to INTAFACED.
    const toProvider = [];
    const fromProvider = [];
    const toUs = [];
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith('/__test-wallet-provider/client/')) toProvider.push({ path, body: r.postDataJSON() });
      if (path.startsWith('/api/')) toUs.push(`${r.url()} ${r.postData() ?? ''}`);
    });
    page.on('response', async (r) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith('/__test-wallet-provider/client/'))
        fromProvider.push({ path, status: r.status(), text: await r.text().catch(() => '') });
    });

    // A fresh passkey check: the export is answered by a new assertion from the person's passkey for a new challenge.
    await expect(page.locator('[data-exported-key]')).toHaveCount(0);
    await expect(page.getByText('TEST wallet provider shows your key once.', { exact: false })).toBeVisible();
    const before = (await held())[0].signCount;
    await page.getByRole('button', { name: 'Export my key' }).click();
    const shown = page.locator('[data-exported-key]');
    await expect(shown).toHaveText(/^0x[0-9a-f]{64}$/, { timeout: 20_000 });
    const key = await shown.textContent();
    expect((await held())[0].signCount).toBeGreaterThan(before);
    const exportCall = toProvider.find((c) => c.path.endsWith('/export'));
    expect(exportCall?.body?.assertion?.signature).toBeTruthy();
    const issued = toProvider.filter((c) => c.path.endsWith('/challenge') && c.body?.action === 'export');
    expect(issued).toHaveLength(1);
    expect(exportCall.body.challenge).toBe(JSON.parse(fromProvider.find((r) => r.path.endsWith('/challenge')).text).challenge);
    // It derives the owner address.
    expect(privateKeyToAccount(key).address).toBe(ownerAddress);

    // Shown once: hidden, or after a reload, the key is gone from the page.
    await page.getByRole('button', { name: 'Hide my key' }).click();
    await expect(shown).toHaveCount(0);
    await page.reload();
    await expect(owner).toHaveText(ownerAddress, { timeout: 20_000 });
    await expect(shown).toHaveCount(0);

    // A second request returns no key: refused in words, nothing shown, and no answer from the provider carries it.
    const heard = fromProvider.length;
    const promptsBefore = (await held())[0].signCount;
    await page.getByRole('button', { name: 'Export my key' }).click();
    await expect(page.getByText('This key was already exported', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText('TEST wallet provider shows your key only once, and it was already shown. No key was shown or sent this time.'),
    ).toBeVisible();
    await expect(page.getByText('wallet.export_spent')).toBeVisible();
    await expect(shown).toHaveCount(0);
    const second = fromProvider.slice(heard);
    expect(second.length).toBeGreaterThan(0);
    for (const answer of second) {
      expect(answer.status).toBe(410);
      expect(JSON.parse(answer.text)).toMatchObject({ error: 'export_spent' });
      expect(answer.text.toLowerCase()).not.toContain(key.slice(2).toLowerCase());
    }
    // Refused before any passkey prompt.
    expect((await held())[0].signCount).toBe(promptsBefore);

    // The key never reached INTAFACED, in a request or in its record.
    expect(toUs.length).toBeGreaterThan(0);
    for (const sent of toUs) expect(sent.toLowerCase()).not.toContain(key.slice(2).toLowerCase());
    const after = await client.get('/api/protocol/trpc/embeddedWallet.status');
    expect(JSON.stringify(after.body)).not.toContain(key.slice(2));
  });
});
