// World: none
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainRecordPath, GATE_URL, TEST_CHAIN_ID } from '../../../../tooling/scripts/local-test-chain.mjs';
import { test, expect } from './journey.mjs';
import { UNBUILT, agentCard, agentsRun, openAgents, openNavigatorSession } from './agents.mjs';
import { acceptRepresentation, connectWallet, dexRun, fundOnTestChain } from './dex.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { signIn } from './desk.mjs';

// J-agents-19, in the running app (docs/roadmap/journeys.json): let the Navigator act on-chain through a session key I
// can revoke. One test per step, titled "J-agents-19 #<n>", run in order on one verified TEST account with the TEST
// wallet connected on the stack's TEST chain (tooling/scripts/local-test-chain.mjs, chain id 84532, labelled TESTNET).
// No value moves through INTAFACED: the person signs the grant and the revoke in their own wallet, and the key is a
// ceiling, never consent, so every agent trade still asks. A mainnet grant shows the external-audit notice
// (audit.external); with no signer configured the rail notice (rail.crypto). Every signed-in person holds agents:execute
// (packages/auth/src/scopes.ts), so the standard TEST account opens a Navigator session itself.
// The session key is the Navigator's TEST signer, a public address only, from the stack's TEST owner values.
const J = 'J-agents-19';
const agents = agentsRun(J);
// The wallet key lives in its own run file, so the agents run's account and the wallet's key never overwrite each other.
// The wallet runs on the TEST chain and is funded there, as J-dex-protocol-08's does, rather than in dex.mjs's
// ON_TEST_CHAIN, so the two do not edit one shared line.
const base = dexRun(`${J}-wallet`);
const wallet = {
  ...base,
  onChain: true,
  start(extra = {}) {
    const walletKey = testWalletKey();
    fundOnTestChain(privateKeyToAccount(walletKey).address);
    return base.run.reset({ walletKey, ...extra });
  },
};

test.describe.configure({ mode: 'default' });

const SIGNER = JSON.parse(readFileSync(new URL('../../../../tooling/profiles/test-owner-values/agents.json', import.meta.url), 'utf8'))
  .values.AGENTS_NAVIGATOR_ONCHAIN_SIGNER.value;
// The router's swapExactIn(address,address,uint256,uint256,address): the Navigator's one default call.
const SWAP_EXACT_IN = '0x7b32b50e';
const APPROVE = '0x095ea7b3';
const TRADE_ASK = 'TEST: swap 0.1 TEST Token A for TEST Token B on-chain';
const DAY = 86_400;
const DEFAULT_SALT = `0x${'00'.repeat(32)}`;

const main = (page) => page.getByRole('main');
const onChain = (page) => main(page).getByRole('region', { name: 'On-chain access' });
const grant = (page) => onChain(page).getByRole('form', { name: 'Session key grant' });
const status = (page) => onChain(page).getByTestId('binding-status');
const workspace = (page) => main(page).getByRole('region', { name: 'Session workspace' });

const testChainDef = defineChain({
  id: TEST_CHAIN_ID,
  name: 'LOCAL TEST chain',
  nativeCurrency: { name: 'TEST ETH', symbol: 'TETH', decimals: 18 },
  rpcUrls: { default: { http: [GATE_URL] } },
});
const reader = () => createPublicClient({ chain: testChainDef, transport: http(GATE_URL) });
const accountAbi = parseAbi([
  'function createAccount(address owner, bytes32 userSalt) returns (address)',
  'function getAddress(address owner, bytes32 userSalt) view returns (address)',
  'function getSession(address sessionKey) view returns ((bytes32 specHash, uint48 validAfter, uint48 validUntil, uint128 spentWei, uint64 epoch, bool revoked))',
  'event SessionGranted(address indexed sessionKey, bytes32 specHash, uint48 validAfter, uint48 validUntil, uint128 spendLimitWei, address[] targets, bytes4[] selectors)',
]);

/** The run wallet's smart account on the TEST chain, from the seeded factory with the zero salt. */
async function smartAccount() {
  const record = JSON.parse(readFileSync(chainRecordPath(), 'utf8'));
  expect(record.accountFactory, 'the TEST chain was seeded with a smart account factory').toMatch(/^0x[0-9a-fA-F]{40}$/);
  const owner = privateKeyToAccount(wallet.key()).address;
  return {
    record,
    owner,
    address: await reader().readContract({
      address: record.accountFactory,
      abi: accountAbi,
      functionName: 'getAddress',
      args: [owner, DEFAULT_SALT],
    }),
  };
}

/**
 * The person's smart account, made before the journey as a wallet the person used before would have: the run's wallet
 * calls the seeded factory itself (J-dex-protocol-08's start does the same).
 */
async function createSmartAccount() {
  const { record, owner } = await smartAccount();
  const sender = createWalletClient({ account: privateKeyToAccount(wallet.key()), chain: testChainDef, transport: http(GATE_URL) });
  const hash = await sender.writeContract({
    address: record.accountFactory,
    abi: accountAbi,
    functionName: 'createAccount',
    args: [owner, DEFAULT_SALT],
  });
  expect((await reader().waitForTransactionReceipt({ hash })).status).toBe('success');
}

/** The Navigator key's record on the smart account, read straight from the chain, and the newest grant's log. */
async function chainSession() {
  const { address } = await smartAccount();
  const client = reader();
  const record = await client.readContract({ address, abi: accountAbi, functionName: 'getSession', args: [SIGNER] });
  const granted = await client.getContractEvents({
    address,
    abi: accountAbi,
    eventName: 'SessionGranted',
    args: { sessionKey: SIGNER },
    fromBlock: 0n,
  });
  const clock = Number((await client.getBlock()).timestamp);
  return { record, grant: granted.at(-1)?.args ?? null, clock };
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

/** Signs in, connects the run's TEST wallet and opens the Navigator's on-chain panel from its details. */
async function openOnChain(page) {
  await signIn(page, agents.account());
  await connectWallet(page, wallet);
  await openAgents(page, agents);
  await agentCard(page, 'Navigator').getByRole('button', { name: 'Details' }).click();
  await expect(onChain(page)).toBeVisible(UNBUILT);
  await expect(grant(page)).toBeVisible({ timeout: 30_000 });
}

test(`${J} starts: a verified TEST account with the TEST wallet connected on the test network`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag19', '10');
  wallet.start();
  await createSmartAccount();
  await signIn(page, agents.account());
  await connectWallet(page, wallet);
});

test(`${J} #1 prepares a grant with the spend cap blank: a refusal naming the cap`, async ({ page }) => {
  await openOnChain(page);
  await expect(grant(page).getByRole('textbox', { name: /^Spend cap/ })).toHaveValue('');
  await grant(page).getByRole('button', { name: 'Prepare grant' }).click();
  await expect(grant(page).getByRole('alert')).toContainText('Spend cap');
  await expect(onChain(page).getByTestId('unsigned-call')).toHaveCount(0);
  await expect(status(page)).toHaveCount(0);
});

test(`${J} #2 adds a target list that includes an approve selector: the grant is refused and nothing is built`, async ({ page }) => {
  await openOnChain(page);
  await grant(page)
    .getByRole('textbox', { name: /^Spend cap/ })
    .fill('1');
  await grant(page)
    .getByRole('textbox', { name: /^Allowed calls/ })
    .fill(APPROVE);
  await grant(page).getByRole('combobox', { name: 'Expires' }).selectOption({ label: 'In 1 day' });
  await grant(page).getByRole('button', { name: 'Prepare grant' }).click();
  await expect(grant(page).getByRole('alert')).toContainText('A session key may not approve or permit tokens.');
  await expect(onChain(page).getByTestId('unsigned-call')).toHaveCount(0);
  // Nothing was recorded either: no binding, and the chain holds no key for the Navigator.
  await expect(status(page)).toHaveCount(0);
  expect((await chainSession()).grant).toBeNull();
});

test(`${J} #3 prepares a valid test-network grant: scope, expiry and status read from the chain, labelled TESTNET, and the unsigned call`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openOnChain(page);
  await grant(page)
    .getByRole('textbox', { name: /^Spend cap/ })
    .fill('1');
  await grant(page)
    .getByRole('textbox', { name: /^Allowed calls/ })
    .fill('');
  await grant(page).getByRole('combobox', { name: 'Expires' }).selectOption({ label: 'In 1 day' });
  await grant(page).getByRole('button', { name: 'Prepare grant' }).click();
  await expect(onChain(page).getByText('TESTNET', { exact: true })).toBeVisible();
  await expect(onChain(page).getByTestId('unsigned-call')).toHaveText(/^0x[0-9a-f]+$/);
  for (const term of ['Scope', 'Expiry', 'Status']) await expect(onChain(page).getByRole('term').filter({ hasText: term })).toBeVisible();
  // Prepared, not yet on the chain.
  await expect(status(page)).toHaveText('Not granted');
  await onChain(page).getByRole('button', { name: 'Sign in wallet' }).click();
  await continueSigning(page);
  await expect(status(page)).toHaveText('Active', { timeout: 60_000 });
  // What the panel shows is the chain's record: the scope, an expiry a day out, and a cap of 1 TEST ETH.
  const scope = onChain(page).getByRole('term').filter({ hasText: 'Scope' }).locator('xpath=following-sibling::dd[1]');
  await expect(scope).toContainText(SWAP_EXACT_IN);
  const expiry = await onChain(page).getByRole('term').filter({ hasText: 'Expiry' }).locator('xpath=following-sibling::dd[1]').innerText();
  const shownUntil = Date.parse(expiry.replace(' UTC', 'Z').replace(' ', 'T')) / 1000;
  const { record, grant: granted, clock } = await chainSession();
  expect(record.specHash).not.toBe(`0x${'00'.repeat(32)}`);
  expect(record.revoked).toBe(false);
  expect(record.spentWei).toBe(0n);
  expect(Math.abs(record.validUntil - (clock + DAY))).toBeLessThan(600);
  // The panel shows the expiry to the minute.
  expect(Math.abs(record.validUntil - shownUntil)).toBeLessThan(60);
  expect(granted).not.toBeNull();
  expect(granted.specHash).toBe(record.specHash);
  expect(granted.spendLimitWei).toBe(parseEther('1'));
  expect(granted.selectors.map((s) => s.toLowerCase())).toEqual([SWAP_EXACT_IN]);
  await expect(scope).toContainText(new RegExp(granted.targets[0], 'i'));
  await expect(onChain(page).getByRole('term').filter({ hasText: 'Spent' }).locator('xpath=following-sibling::dd[1]')).toContainText(
    '0 of 1 TEST ETH',
  );
});

test(`${J} #4 asks the agent to trade with a live key: an approval request is still created; the key is a ceiling, not consent`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sessionId = await openNavigatorSession(page, agents);
  await workspace(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill(TRADE_ASK);
  await workspace(page).getByRole('button', { name: 'Run' }).click();
  const held = workspace(page).getByRole('region', { name: 'Approval request' });
  await expect(held).toBeVisible();
  await expect(held).toContainText(TRADE_ASK);
  await expect(held).toContainText('Waiting for your approval');
  await expect(workspace(page)).toContainText('A session key is a ceiling, not your consent.');
  await expect(held).toContainText('Your Navigator holds a live session key on the test network; it still asks.');
  // Nothing ran: no review of an engine run, no reply, and on the chain the key has moved nothing.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(workspace(page).getByRole('region', { name: 'Reply' })).toHaveCount(0);
  const { record } = await chainSession();
  expect(record.spentWei).toBe(0n);
  expect(record.revoked).toBe(false);
  // The request is kept by the service: after a reload the session still lists it.
  await page.reload();
  await openAgents(page, agents, 'Sessions');
  const selected = main(page).getByRole('region', { name: 'Selected session' });
  await expect(selected).toContainText(sessionId, { timeout: 30_000 });
  await expect(selected.getByTestId('navigator-approvals')).toContainText(TRADE_ASK);
  await expect(selected.getByTestId('navigator-approvals')).toContainText('Waiting for your approval');
});

test(`${J} #5 revokes: the unsigned revoke call, and the binding reads revoking until the chain reads revoked`, async ({ page }) => {
  test.setTimeout(180_000);
  await openOnChain(page);
  await expect(status(page)).toHaveText('Active', { timeout: 30_000 });
  await onChain(page).getByRole('button', { name: 'Revoke' }).click();
  await expect(onChain(page).getByTestId('unsigned-call')).toHaveText(/^0x[0-9a-f]+$/);
  await expect(status(page)).toHaveText('Revoking');
  // Not signed yet: a reload still reads Revoking, and the chain still holds the key live.
  await page.reload();
  await agentCard(page, 'Navigator').getByRole('button', { name: 'Details' }).click();
  await expect(status(page)).toHaveText('Revoking', { timeout: 30_000 });
  expect((await chainSession()).record.revoked).toBe(false);
  await expect(onChain(page).getByTestId('unsigned-call')).toHaveText(/^0x[0-9a-f]+$/);
  await onChain(page).getByRole('button', { name: 'Sign in wallet' }).click();
  await continueSigning(page);
  await expect(status(page)).toHaveText('Revoked', { timeout: 60_000 });
  expect((await chainSession()).record.revoked).toBe(true);
});
