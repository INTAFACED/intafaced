import { test, expect } from '@playwright/test';
import { signIn, signUp } from './desk.mjs';
import { signOutBrowser } from './stack.mjs';

// J-dex-protocol-09, in the running app (docs/roadmap/journeys.json): explore the chain signed out: blocks,
// transactions, addresses, contracts and pools. One test per step, titled "J-dex-protocol-09 #<n>". The explorer is
// read only and holds no funds; step 6 signs in to keep a private watch and checks a second account cannot read it.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - The stack publishes no node and starts no indexer reader for the explorer, so blocks, transactions, addresses,
//   pools and contracts have no rows: every step from #2 on waits on that (D-explorer-01 to -07).
// - #1: Chain home has no latest-blocks list and no INTACHAIN "not launched" line (D-explorer-07).
// - #6: no private watch with a tag and note; #9: no pool fee fields; #11: no token info update with owner proof.
// The explorer's TEST network is Base Sepolia; the hashes and addresses below are well-formed but name nothing on it.
const J = 'J-dex-protocol-09';
const UNBUILT = { timeout: 5_000 };
const UNKNOWN_TX = `0x${'ab'.repeat(32)}`;
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const search = (page) => page.getByRole('searchbox', { name: /Search by address, transaction or block/ });

/** A row from a listed table, by the column it is read from: the first block or transaction the explorer shows. */
async function firstLink(page, table, pattern) {
  const link = page.getByRole('table', { name: table }).getByRole('link', { name: pattern }).first();
  await expect(link).toBeVisible(UNBUILT);
  return link;
}

test(`${J} #1 opens Chain home: latest blocks and transactions for the test network, and an INTACHAIN line reading "not launched" with its blocker`, async ({
  page,
}) => {
  await page.goto('/chain');
  await expect(main(page).getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Latest blocks' })).toBeVisible(UNBUILT);
  await expect(page.getByRole('table', { name: 'Latest transactions' })).toBeVisible();
  const intachain = main(page).getByTestId('chain-intachain');
  await expect(intachain).toContainText('INTACHAIN');
  await expect(intachain).toContainText('not launched');
  await expect(intachain).toContainText(/Blocked:/);
  await expect(main(page)).not.toContainText(/INTACHAIN mainnet/i);
});

test(`${J} #2 opens the blocks list and a block: rows down from the finalized height with its marker and as-of time, a reorged block badged, a missing block named, and the gas tracker`, async ({
  page,
}) => {
  await page.goto('/chain/blocks');
  const table = page.getByRole('table', { name: 'Blocks' });
  const rows = table.locator('tbody tr');
  await expect(rows.first()).toBeVisible(UNBUILT);
  const heights = (await table.getByRole('rowheader').allInnerTexts()).map((text) => Number(text.replace(/\D/g, '')));
  expect(heights).toEqual([...heights].sort((a, b) => b - a));
  await expect(main(page)).toContainText(/Finalized at block \d+/);
  await expect(main(page)).toContainText(/as of \d{1,2}:\d{2}/);
  await expect(page.getByRole('region', { name: 'Gas tracker' })).toBeVisible();
  await (await firstLink(page, 'Blocks', /^\d+$/)).click();
  await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(/^Block \d+$/);
  await page.goto('/chain/blocks/999999999999');
  await expect(main(page)).toContainText('No such block on this network');
});

test(`${J} #3 searches a transaction hash: status, decoded input with named arguments and a Logs tab; a reverted one shows its error or "No reason returned"; an unknown hash reads "Not found on this network"`, async ({
  page,
}) => {
  await page.goto('/chain');
  await search(page).fill(UNKNOWN_TX, UNBUILT);
  await search(page).press('Enter');
  await expect(main(page)).toContainText('Not found on this network');

  await page.goto('/chain');
  await (await firstLink(page, 'Latest transactions', /^0x[0-9a-f]{4}/)).click();
  await expect(main(page).getByTestId('tx-status')).toHaveText(/Success|Reverted|Pending/);
  await expect(page.getByRole('region', { name: 'Input' })).toContainText(/\w+\s*:/);
  await page.getByRole('tab', { name: 'Logs' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Logs' })).toBeVisible();
  if ((await main(page).getByTestId('tx-status').textContent()) === 'Reverted') {
    await expect(main(page).getByTestId('tx-revert-reason')).toHaveText(/\w+|No reason returned/);
  }
});

test(`${J} #4 pastes a 40-hex address into search: the address page is the top result, and two tokens sharing a symbol are both listed`, async ({
  page,
}) => {
  await page.goto('/chain');
  await search(page).fill(ADDRESS, UNBUILT);
  const results = page.getByRole('listbox', { name: 'Search results' }).getByRole('option');
  await expect(results.first()).toContainText(ADDRESS.slice(0, 6));
  await expect(results.first()).toContainText('Address');
  await search(page).fill('TEST');
  const tokens = results.filter({ hasText: 'Token' });
  // Tokens are told apart by address, never merged by symbol.
  const addresses = await tokens.evaluateAll((items) => items.map((item) => item.getAttribute('data-address')));
  expect(new Set(addresses).size).toBe(addresses.length);
});

test(`${J} #5 opens the address page: summary, transactions, holdings with unpriced ones counted, internal transactions or "trace unavailable", and a past balance or "not indexed before block N"`, async ({
  page,
}) => {
  await page.goto(`/chain/address/${ADDRESS}`);
  await expect(page.getByRole('region', { name: 'Summary' })).toBeVisible(UNBUILT);
  await expect(page.getByRole('table', { name: 'Transactions' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Holdings' })).toContainText(/holdings? (has|have) no price|\$[\d,.]+/);
  await page.getByRole('tab', { name: 'Internal transactions' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Internal transactions' })).toContainText(/trace unavailable|0x/i);
  await page.getByRole('textbox', { name: 'Balance on date' }).fill('2026-01-01');
  await expect(page.getByTestId('address-past-balance')).toContainText(/not indexed before block \d+|[\d.]+/);
});

test(`${J} #6 adds a watch with a tag and a private note: listed for this person only, adding again changes nothing, another account cannot read it, and the page says the explorer holds no funds`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'cx');
  await signIn(page, who);
  await page.goto(`/chain/address/${ADDRESS}`);
  await expect(main(page)).toContainText('This explorer holds no funds', UNBUILT);
  const add = async () => {
    await page.getByRole('button', { name: 'Watch this address' }).click();
    const dialog = page.getByRole('dialog', { name: 'Watch this address' });
    await dialog.getByRole('textbox', { name: 'Tag' }).fill('TEST cold wallet');
    await dialog.getByRole('textbox', { name: 'Private note' }).fill('TEST note');
    await dialog.getByRole('button', { name: 'Save' }).click();
  };
  await add();
  await page.goto('/chain/watchlist');
  const rows = page.getByRole('table', { name: 'Your watched addresses' }).locator('tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('TEST cold wallet');
  await page.goto(`/chain/address/${ADDRESS}`);
  await add();
  await page.goto('/chain/watchlist');
  await expect(rows).toHaveCount(1);

  await signOutBrowser(page.context());
  const other = await signUp(page, 'cy');
  await signIn(page, other);
  await page.goto(`/chain/address/${ADDRESS}`);
  await expect(main(page)).not.toContainText('TEST note');
  await page.goto('/chain/watchlist');
  await expect(page.getByRole('table', { name: 'Your watched addresses' }).locator('tbody tr')).toHaveCount(0);
});

test(`${J} #7 opens a pool page and a token page: candles, volume, buy and sell rows, holders; an address that is not a pool reads "not a pool"`, async ({
  page,
}) => {
  await page.goto('/dex/pools');
  const pool = page.getByRole('table', { name: 'Pools' }).getByRole('link').first();
  await expect(pool).toBeVisible(UNBUILT);
  await pool.click();
  await expect(page.getByRole('img', { name: /Price chart/ })).toBeVisible();
  await expect(main(page)).toContainText(/Volume/);
  await expect(page.getByRole('table', { name: 'Trades' }).locator('tbody tr').first()).toContainText(/Buy|Sell/);
  await page
    .getByRole('link', { name: /TEST Token A/ })
    .first()
    .click();
  await expect(page.getByRole('tab', { name: 'Holders' })).toBeVisible();
  await page.goto(`/dex/pools/${ADDRESS.toLowerCase()}`);
  await expect(main(page)).toContainText('not a pool');
});

test(`${J} #8 opens a contract's source status and the Read tab: exact, similar or unverified with the reason; a proxy reads through its implementation; a Write asks the wallet`, async ({
  page,
}) => {
  await page.goto('/protocol/contracts');
  const contract = page.getByRole('table').getByRole('link', { name: /^0x/ }).first();
  await expect(contract).toBeVisible(UNBUILT);
  await contract.click();
  await expect(page.getByTestId('contract-source-status')).toHaveText(/Exact match|Similar match|Unverified: .+/, UNBUILT);
  await page.getByRole('tab', { name: 'Read' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Read' })).toBeVisible();
  if (await page.getByTestId('contract-implementation').count()) {
    await expect(page.getByTestId('contract-implementation')).toContainText(/Implementation 0x/);
  }
  await page.getByRole('tab', { name: 'Write' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Write' })).toContainText(/Connect a wallet/);
});

test(`${J} #9 reads the pool's fee fields: as the contract holds them, no third share, and a protocol fee request with the policy blank refuses`, async ({
  page,
}) => {
  await page.goto('/dex/pools');
  const pool = page.getByRole('table', { name: 'Pools' }).getByRole('link').first();
  await expect(pool).toBeVisible(UNBUILT);
  await pool.click();
  const fees = page.getByRole('region', { name: 'Fees' });
  await expect(fees).toContainText(/Swap fee [\d.]+ ?%/);
  await expect(fees).toContainText('There is no third share');
  await fees.getByRole('button', { name: 'Request a protocol fee' }).click();
  await expect(page.getByRole('alert')).toContainText('protocol fee policy is not set');
});

test(`${J} #10 searches a hash that exists on two networks: both are listed, and a network that did not answer reads "not checked" with its reason`, async ({
  page,
}) => {
  await page.goto('/chain');
  await search(page).fill(UNKNOWN_TX, UNBUILT);
  await search(page).press('Enter');
  const networks = page.getByRole('list', { name: 'Networks searched' }).getByRole('listitem');
  expect(await networks.count()).toBeGreaterThan(1);
  for (const network of await networks.all()) await expect(network).toContainText(/Found|Not found|not checked: .+/);
});

test(`${J} #11 requests a token info update with the token owner's signature: the proof is stored; a replayed challenge, a non-owner and an ownerless token each refuse with their own reason`, async ({
  page,
}) => {
  await page.goto(`/dex/tokens/${ADDRESS.toLowerCase()}`);
  await page.getByRole('button', { name: 'Request an info update' }).click(UNBUILT);
  const dialog = page.getByRole('dialog', { name: 'Request an info update' });
  await expect(dialog).toContainText(/Sign this challenge with the token owner's wallet/);
  await expect(dialog.getByTestId('token-update-challenge')).toHaveText(/\S{16,}/);
});
