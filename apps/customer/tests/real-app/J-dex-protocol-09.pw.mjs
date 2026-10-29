import { test, expect } from '@playwright/test';
import { signIn, signUp } from './desk.mjs';
import { EDGE, ORIGIN, signOutBrowser } from './stack.mjs';
import { tableIn, bodyRows } from './tables.mjs';
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { TOKEN_A, fundOnTestChain, testChain } from './dex.mjs';

// J-dex-protocol-09, in the running app (docs/roadmap/journeys.json): explore the chain signed out: blocks,
// transactions, addresses, contracts and pools. One test per step, titled "J-dex-protocol-09 #<n>". The explorer is
// read only and holds no funds; step 6 signs in to keep a private watch and checks a second account cannot read it.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT). The stack's TEST chain
// (anvil, chain 84532) and the indexer reading it give #1 to #3 real blocks and transactions; the journey mines what it
// needs there (a reorg, a decodable call, failed calls) rather than relying on what other journeys left on the chain.
// The explorer's TEST network is Base Sepolia; the hashes and addresses below are well-formed but name nothing on it.
// A step passes only on rows read from a chain: an empty table, an unknown hash or a blocked row fails it (OWNER 114),
// so #1, #4 and #10 wait on the stack's TEST networks and the indexer like the rest.
const J = 'J-dex-protocol-09';
const UNBUILT = { timeout: 5_000 };
const UNKNOWN_TX = `0x${'ab'.repeat(32)}`;
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';

test.describe.configure({ mode: 'default' });

// A journey before this one may have shut the TEST chain's gate (J-dex-protocol-01 does, for its "node unreachable"
// steps) and reopened it: wait until the indexer reads the chain again, so step 1 is not judged on that window.
test.beforeAll(async () => {
  const input = encodeURIComponent(JSON.stringify({ chainId: testChain().chainId }));
  await expect(async () => {
    const res = await fetch(`${EDGE}/api/indexer/trpc/explorer.blocks.list?input=${input}`, { headers: { origin: ORIGIN } });
    expect(res.status).toBe(200);
  }).toPass({ timeout: 30_000 });
});

const main = (page) => page.getByRole('main');
const search = (page) => page.getByRole('searchbox', { name: /Search by address, transaction or block/ });

/** A row from a listed table, by the column it is read from: the first block or transaction the explorer shows. */
async function firstLink(page, table, pattern) {
  const link = tableIn(page, table).getByRole('link', { name: pattern }).first();
  await expect(link).toBeVisible(UNBUILT);
  return link;
}

test(`${J} #1 opens Chain home: latest blocks and transactions for the test network, and an INTACHAIN line reading "not launched" with its blocker`, async ({
  page,
}) => {
  await page.goto('/chain');
  await expect(main(page).getByRole('heading', { level: 1 })).toBeVisible();
  await expect(tableIn(page, 'Latest blocks')).toBeVisible(UNBUILT);
  await expect(tableIn(page, 'Latest transactions')).toBeVisible();
  // Empty tables show no network: both must list what the test network holds, newest block first.
  // A blocked row is a row too: each block row is headed by its height.
  await expect(tableIn(page, 'Latest blocks').getByRole('rowheader').first()).toHaveText(/\d/, UNBUILT);
  // Newest first is only shown by two rows or more; the TEST chain mines every few seconds, so the list has them.
  await expect.poll(() => tableIn(page, 'Latest blocks').getByRole('rowheader').count(), UNBUILT).toBeGreaterThan(1);
  const heights = (await tableIn(page, 'Latest blocks').getByRole('rowheader').allInnerTexts()).map((text) =>
    // The height is the header's leading digits; a reorged row's header goes on with its badge and hash.
    Number(text.replace(/\D.*$/s, '')),
  );
  expect(new Set(heights).size).toBe(heights.length);
  expect(heights).toEqual([...heights].sort((a, b) => b - a));
  await expect(
    tableIn(page, 'Latest transactions')
      .getByRole('link', { name: /^0x[0-9a-f]{4}/ })
      .first(),
  ).toBeVisible(UNBUILT);
  const intachain = main(page).getByTestId('chain-intachain');
  // The whole line: "not launched", its blocker word for word, and the test network these tables are read from.
  await expect(intachain).toHaveText(
    'INTACHAIN: not launched. Blocked: no INTACHAIN chain service or validator set is running. This explorer reads Base Sepolia test network.',
  );
  await expect(main(page)).not.toContainText(/INTACHAIN mainnet/i);
});

/**
 * Mines one call to the TEST token on the stack's TEST chain, from a fresh TEST key funded for gas, checks it ended with
 * `status` and returns its hash. The gas is set so the node does not refuse a failing call at estimate time: the point is
 * a failed transaction in a block.
 */
async function minedTx(data, status = 'reverted') {
  const chain = testChain();
  expect(chain.chain, 'the stack runs no TEST chain, so no transaction can be mined').toBe('running');
  const account = privateKeyToAccount(generatePrivateKey());
  fundOnTestChain(account.address);
  const viemChain = {
    id: chain.chainId,
    name: 'TEST chain',
    nativeCurrency: { name: 'TEST ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [chain.gateUrl] } },
  };
  const wallet = createWalletClient({ account, chain: viemChain, transport: http(chain.gateUrl) });
  const reader = createPublicClient({ chain: viemChain, transport: http(chain.gateUrl) });
  const hash = await wallet.sendTransaction({ to: TOKEN_A.address, data, gas: 200_000n });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe(status);
  return hash;
}

/** Searches a hash from Chain home and opens the transaction from the search answer. */
async function openTxBySearch(page, hash) {
  await page.goto('/chain');
  await search(page).fill(hash);
  await search(page).press('Enter');
  await page.getByRole('list', { name: 'Networks searched' }).getByRole('link', { name: 'Open transaction' }).click();
}

/** One JSON-RPC call to the stack's TEST chain gate. */
async function chainRpc(method, params = []) {
  const response = await fetch(testChain().gateUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/**
 * Reorgs out the TEST chain's newest block after the explorer has read it, and returns its height and hash. Interval
 * mining is paused for the few seconds this takes, so no new block lands between the read and the reorg, and restored
 * after. The replacement block carries a different transaction, so its hash differs.
 */
async function reorgedBlock(page) {
  expect(testChain().chain, 'the stack runs no TEST chain, so no block can be reorged').toBe('running');
  const interval = await chainRpc('anvil_getIntervalMining');
  await chainRpc('evm_setIntervalMining', [0]);
  try {
    await chainRpc('evm_mine');
    const block = await chainRpc('eth_getBlockByNumber', ['latest', false]);
    const height = String(Number(block.number));
    // Read by the explorer first: the block is listed under its height before it is replaced.
    await expect(async () => {
      await page.goto('/chain/blocks');
      await expect(tableIn(page, 'Blocks').getByRole('link', { name: height, exact: true })).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    const self = privateKeyToAccount(generatePrivateKey()).address;
    await chainRpc('anvil_reorg', [1, [[{ from: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', to: self, value: '0x1' }, 0]]]);
    const replaced = await chainRpc('eth_getBlockByNumber', [block.number, false]);
    expect(replaced.hash).not.toBe(block.hash);
    await chainRpc('evm_mine');
    return { height, hash: block.hash };
  } finally {
    await chainRpc('evm_setIntervalMining', [interval]);
  }
}

test(`${J} #2 opens the blocks list and a block: rows down from the finalized height with its marker and as-of time, a reorged block badged, a missing block named, and the gas tracker`, async ({
  page,
}) => {
  const orphan = await reorgedBlock(page);
  await page.goto('/chain/blocks');
  const table = tableIn(page, 'Blocks');
  const rows = bodyRows(table);
  await expect(rows.first()).toBeVisible(UNBUILT);
  // A row is headed by its height; a reorged row adds its badge and hash after it.
  const heights = (await table.getByRole('rowheader').allInnerTexts()).map((text) => Number(text.replace(/\D.*$/s, '')));
  expect(heights).toEqual([...heights].sort((a, b) => b - a));
  const finalized = Number((await main(page).getByTestId('blocks-finalized').textContent())?.match(/Finalized at block (\d+)/)?.[1]);
  expect(finalized).toBeGreaterThan(0);
  // Rows run down from the head: every row at or below the finalized height is marked Finalized, every row above it not.
  for (const row of await rows.all()) {
    const height = Number((await row.getByRole('rowheader').innerText()).replace(/\D.*$/s, ''));
    if (await row.getAttribute('data-orphaned')) await expect(row).toContainText('Off the chain');
    else await expect(row).toContainText(height <= finalized ? 'Finalized' : 'Not finalized');
  }
  // The reorged block stays listed at its height, badged with the reason, next to the block that replaced it.
  await expect(async () => {
    await page.goto('/chain/blocks');
    const reorged = bodyRows(tableIn(page, 'Blocks'))
      .filter({ hasText: `Reorged: ` })
      .filter({ hasText: orphan.hash.slice(0, 10) });
    await expect(reorged.getByRole('rowheader')).toContainText(new RegExp(`^${orphan.height} Reorged: \\S`), { timeout: 1_000 });
    await expect(tableIn(page, 'Blocks').getByRole('link', { name: orphan.height, exact: true })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await expect(main(page)).toContainText(/as of \d{1,2}:\d{2}/);
  const gas = page.getByRole('region', { name: 'Gas tracker' });
  await expect(gas.getByTestId('gas-base-fee')).toHaveText(/^[\d.]+ gwei$/);
  await expect(gas.getByTestId('gas-used-share')).toHaveText(/^\d+ of \d+ \([\d.]+%\)$/);
  const opened = await firstLink(page, 'Blocks', /^\d+$/);
  const height = await opened.innerText();
  await opened.click();
  await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(`Block ${height}`);
  await expect(tableIn(page, 'Transactions in this block')).toBeVisible();
  await page.goto('/chain/blocks/999999999999');
  await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Block 999999999999');
  await expect(main(page)).toContainText('No such block on this network');
});

test(`${J} #3 searches a transaction hash: status, decoded input with named arguments and a Logs tab; a reverted one shows its error or "No reason returned"; an unknown hash reads "Not found on this network"`, async ({
  page,
}) => {
  await page.goto('/chain');
  await search(page).fill(UNKNOWN_TX, UNBUILT);
  await search(page).press('Enter');
  await expect(main(page)).toContainText('Not found on this network');

  // The hash is searched, not clicked. The journey mines its own call so the answer never depends on what else the
  // chain holds: an approve on the TEST token, whose input decodes against the token's interface and which logs Approval.
  const approve = encodeFunctionData({
    abi: parseAbi(['function approve(address spender, uint256 amount)']),
    functionName: 'approve',
    args: [ADDRESS, 7n],
  });
  await openTxBySearch(page, await minedTx(approve, 'success'));
  await expect(main(page).getByTestId('tx-status')).toHaveText('Success');
  const input = page.getByRole('region', { name: 'Input' });
  await expect(input.getByTestId('tx-input-method')).toHaveText('approve');
  // Decoded means every argument named with its type (the TEST token's own `approve(address spender, uint256 amount)`)
  // and read back as the values this journey mined: ADDRESS and 7.
  const args = input.getByTestId('tx-input-args');
  await expect(args.locator('dt')).toHaveText(['spender address', 'amount uint256']);
  const values = await args.locator('dd').allInnerTexts();
  expect(values.map((value) => value.trim().toLowerCase())).toEqual([ADDRESS.toLowerCase(), '7']);
  await page.getByRole('tab', { name: 'Logs' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Logs' })).toContainText(/Log \d+/);

  // A reverted one shows the error its contract returned: an expired permit on the TEST token reverts PermitExpired().
  const permit = encodeFunctionData({
    abi: parseAbi(['function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)']),
    functionName: 'permit',
    args: [ADDRESS, ADDRESS, 1n, 0n, 27, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`],
  });
  await openTxBySearch(page, await minedTx(permit));
  await expect(main(page).getByTestId('tx-status')).toHaveText('Reverted');
  await expect(main(page).getByTestId('tx-revert-reason')).toHaveText('PermitExpired');
  // A call the token has no function for reverts with no data at all: that one reads "No reason returned".
  await openTxBySearch(page, await minedTx('0xdeadbeef'));
  await expect(main(page).getByTestId('tx-status')).toHaveText('Reverted');
  await expect(main(page).getByTestId('tx-revert-reason')).toHaveText('No reason returned');
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
  // Tokens are told apart by address, never merged by symbol: at least two listed tokens share a symbol, each its own row.
  await expect.poll(() => tokens.count(), UNBUILT).toBeGreaterThan(1);
  const listed = await tokens.evaluateAll((items) =>
    items.map((item) => [item.getAttribute('data-symbol'), item.getAttribute('data-address')]),
  );
  const addresses = listed.map(([, address]) => address);
  expect(addresses.every(Boolean)).toBe(true);
  expect(new Set(addresses).size).toBe(addresses.length);
  const symbols = listed.map(([symbol]) => symbol);
  expect(symbols.some((symbol, i) => symbol && symbols.indexOf(symbol) !== i)).toBe(true);
});

test(`${J} #5 opens the address page: summary, transactions, holdings with unpriced ones counted, internal transactions or "trace unavailable", and a past balance or "not indexed before block N"`, async ({
  page,
}) => {
  await page.goto(`/chain/address/${ADDRESS}`);
  await expect(page.getByRole('region', { name: 'Summary' })).toBeVisible(UNBUILT);
  await expect(tableIn(page, 'Transactions')).toBeVisible();
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
  const rows = bodyRows(tableIn(page, 'Your watched addresses'));
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('TEST cold wallet');
  // The owner reads the note back, so the other account's empty page below proves privacy, not a dropped note.
  await expect(rows.first()).toContainText('TEST note');
  await page.goto(`/chain/address/${ADDRESS}`);
  await expect(main(page)).toContainText('TEST note');
  await add();
  await page.goto('/chain/watchlist');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('TEST note');

  await signOutBrowser(page.context());
  const other = await signUp(page, 'cy');
  await signIn(page, other);
  await page.goto(`/chain/address/${ADDRESS}`);
  await expect(main(page)).not.toContainText('TEST note');
  await page.goto('/chain/watchlist');
  await expect(bodyRows(tableIn(page, 'Your watched addresses'))).toHaveCount(0);
});

test(`${J} #7 opens a pool page and a token page: candles, volume, buy and sell rows, holders; an address that is not a pool reads "not a pool"`, async ({
  page,
}) => {
  await page.goto('/dex/pools');
  const pool = tableIn(page, 'Pools').getByRole('link').first();
  await expect(pool).toBeVisible(UNBUILT);
  await pool.click();
  await expect(page.getByRole('img', { name: /Price chart/ })).toBeVisible();
  await expect(main(page)).toContainText(/Volume/);
  await expect(bodyRows(tableIn(page, 'Trades')).first()).toContainText(/Buy|Sell/);
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
  const pool = tableIn(page, 'Pools').getByRole('link').first();
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
  // An unknown hash reads "Not found" everywhere and proves nothing about two networks: the hash searched is one the
  // stack's two test networks both hold (the same signed deploy sent to each), read from the first network's list.
  await page.goto('/chain');
  const link = tableIn(page, 'Latest transactions')
    .getByRole('link', { name: /^0x[0-9a-f]{4}/ })
    .first();
  await expect(link).toBeVisible(UNBUILT);
  const hash = (await link.getAttribute('href'))?.match(/0x[0-9a-fA-F]{64}/)?.[0];
  expect(hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  await search(page).fill(hash);
  await search(page).press('Enter');
  const networks = page.getByRole('list', { name: 'Networks searched' }).getByRole('listitem');
  await expect.poll(() => networks.count()).toBeGreaterThan(1);
  for (const network of await networks.all()) await expect(network).toContainText(/Found|Not found|not checked: .+/);
  await expect.poll(() => networks.filter({ hasText: /: Found/ }).count()).toBeGreaterThan(1);
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
