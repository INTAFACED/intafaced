import { test, expect } from '@playwright/test';
import { installTestWallet, TEST_WALLET } from './test-wallet.mjs';

// J-dex-protocol-01, in the running app (docs/roadmap/journeys.json): open the Web3 side, read the honest labels and
// connect a wallet. One test per step, titled "J-dex-protocol-01 #<n>". Every step is signed out: the Protocol rooms are
// public and read only. The stack runs svc-protocol on the app's network, Base Sepolia (84532), with no node published
// to it (tooling/scripts/local-stack-services/protocol.mjs), so every chain read refuses as unreachable. The person's own
// browser wallet is the TEST wallet in test-wallet.mjs. No money moves in this journey.
// Steps 8 (the region gate and the first-signing representation) and 9 (a typed-data signature) wait on their slices,
// D-developer-compliance-03 and the first signing action; they are added here when those land.
const J = 'J-dex-protocol-01';
const SHORT = /^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/;

const networkChip = (page) => page.locator('[data-chip="network"]');
const walletChip = (page) => page.locator('[data-chip="wallet"]');

test(`${J} #1 /dex signed out shows the Web3 shell, the testnet chip, the Not INTACHAIN pill and the nav, never "Parked"`, async ({
  page,
}) => {
  await page.goto('/dex');
  await expect(page.locator('[data-shell="web3"]')).toBeVisible();
  await expect(networkChip(page)).toHaveText('Base Sepolia test network · Testnet only');
  await expect(page.locator('[data-chip="label"]')).toHaveText('Not INTACHAIN · not audited');
  await expect(walletChip(page)).toHaveText('No wallet connected');
  await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
  const nav = page.locator('header nav.tb-nav a');
  await expect(nav).toHaveText(['Swap', 'Pools', 'Positions', 'Wallet', 'Explorer', 'Protocol']);
  await expect(page.locator('main h1')).toHaveText('DEX');
  const body = page.locator('body');
  await expect(body).not.toContainText(/parked/i);
  await expect(body).not.toContainText(/INTACHAIN mainnet/i);
});

test(`${J} #2 a block with no data keeps its layout and names the indexer; a malformed id and an unclaimed path answer not found`, async ({
  page,
}) => {
  await page.goto('/chain/blocks/123');
  await expect(page.locator('main h1')).toHaveText('Block 123');
  await expect(page.locator('main [data-blocker="indexer"]')).toBeVisible();
  await expect(page.locator('main')).toContainText('The indexer reader for this page is not built in this build.');
  await expect(page.locator('main table th').first()).toBeVisible();

  await page.goto('/chain/blocks/abc');
  await expect(page.locator('main [data-code="protocol.not_found"]')).toBeVisible();
  await expect(page.locator('main [data-blocker]')).toHaveCount(0);

  await page.goto('/dex/nothing-here');
  await expect(page.locator('main [data-code="protocol.not_found"]')).toBeVisible();
  await expect(page.locator('main h1')).toBeVisible();
});

test(`${J} #3 Swap while the node is unreachable lists its blockers in order, chain unreachable first as a crypto network notice`, async ({
  page,
}) => {
  await page.goto('/dex');
  const swap = page.locator('main [data-action="swap"]');
  await expect(swap.getByRole('button', { name: 'Swap' })).toBeDisabled();
  await expect(swap.locator('[data-not-connected="rail.crypto"]')).toBeVisible();
  await swap.locator('summary', { hasText: 'All blockers' }).click();
  const listed = swap.locator('ol > li');
  await expect(listed.first()).toContainText('The chain is unreachable');
  // The indexer is not started on this stack: the venue and finality checks both wait on it, and the list says so once
  // (no reply, or still checking while the room asks again).
  const order = await listed.evaluateAll((items) => items.map((item) => item.getAttribute('data-blocker')));
  expect(order).toHaveLength(5);
  expect(order[0]).toBe('chain_unreachable');
  expect(['source_no_reply', 'source_checking']).toContain(order[1]);
  expect(order.slice(2)).toEqual(['no_execution_path', 'not_audited', 'network_label']);
  await expect(listed.last()).toHaveText('Base Sepolia test network. Testnet only.');
  await expect(swap).not.toContainText(/INTACHAIN mainnet/i);
});

test(`${J} #4 Connect wallet lists the browser wallet by its own name; connecting shows the address and the wallet chip`, async ({
  page,
}) => {
  const wallet = await installTestWallet(page, { chainId: 84532 });
  await page.goto('/wallet');
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  await expect(page.locator('[data-wallet-address]')).toHaveText(wallet.address);
  await expect(page.locator('[data-wallet-network="ok"]')).toHaveText('Base Sepolia test network. Testnet only.');
  await expect(walletChip(page)).toHaveText(`${TEST_WALLET.name} · ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`);
  expect((await walletChip(page).textContent()).split(' · ')[1]).toMatch(SHORT);
});

test(`${J} #5 a wallet switched to Ethereum mainnet reads "Wrong network" with a switch request; switching back restores the label`, async ({
  page,
}) => {
  const wallet = await installTestWallet(page, { chainId: 84532 });
  const short = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
  await page.goto('/wallet');
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  await expect(walletChip(page)).toHaveText(`${TEST_WALLET.name} · ${short}`);

  await wallet.setChain(1);
  await expect(walletChip(page)).toHaveText(`Wrong network · ${short}`);
  await expect(page.locator('[data-wallet-network="chain_mismatch"]')).toHaveText(
    'This wallet is on another network. Switch it to Base Sepolia test network to continue.',
  );
  await page.getByRole('button', { name: 'Switch network' }).click();
  await expect(walletChip(page)).toHaveText(`${TEST_WALLET.name} · ${short}`);
  await expect(page.locator('[data-wallet-network="ok"]')).toHaveText('Base Sepolia test network. Testnet only.');
  await expect(page.getByRole('button', { name: 'Switch network' })).toHaveCount(0);
  await expect(networkChip(page)).toHaveText('Base Sepolia test network · Testnet only');
});

test(`${J} #6 the network card shows the name and chain id, "RPC: Not published" and Add to wallet disabled with its blocker`, async ({
  page,
}) => {
  await installTestWallet(page, { chainId: 84532 });
  await page.goto('/chain');
  const card = page.locator('main section, main .panel').filter({ has: page.getByRole('heading', { name: 'Network', exact: true }) });
  const fact = (label) =>
    card
      .locator('dl div')
      .filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })
      .locator('dd');
  await expect(fact('Name')).toHaveText('Base Sepolia test network');
  await expect(fact('Chain id')).toHaveText('84532');
  await expect(fact('RPC address')).toHaveText('Not published');
  // A wallet is installed, so the only thing keeping the button off is the unpublished network entry.
  await expect(card.getByRole('button', { name: 'Add to wallet' })).toBeDisabled();
  await expect(card).toContainText(
    'Blocked: the owner has not published this network name, RPC address and currency (protocol.network_params_unset)',
  );
});

test(`${J} #7 faucets and supported routers are listed honestly, and fast confirmations read "Not confirmed"`, async ({ page }) => {
  await page.goto('/chain');
  const faucets = page.getByRole('heading', { name: 'Faucets' });
  await expect(faucets).toBeVisible();
  await expect(page.locator('main')).toContainText('Third-party faucets only. This platform holds no key to send test funds.');
  // The owner has published no faucet for this network yet, so the list says so instead of inventing one.
  await expect(page.locator('main [data-list="faucets"]')).toHaveText('None listed.');

  await page.goto('/dex/venue');
  const table = page.getByRole('region', { name: 'Supported networks' }).getByRole('table');
  const row = (chain) => table.locator('tr').filter({ hasText: chain });
  await expect(row('Base Sepolia test network (84532)')).toContainText('v1');
  // The configured chain is probed; with no node the probe cannot tell, so it is not confirmed. 31337 is not probed at all.
  const base = row('Base Sepolia test network (84532)').locator('[data-fast]');
  await expect(base).toHaveText('Not confirmed');
  await expect(base).toHaveAttribute('data-probed', 'true');
  const local = row('Local test chain (31337)').locator('[data-fast]');
  await expect(local).toHaveText('Not confirmed');
  await expect(local).toHaveAttribute('data-probed', 'false');
  await expect(table).not.toContainText(/INTACHAIN/);
});
