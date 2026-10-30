import { test, expect } from '@playwright/test';
import { signIn, signUp } from './desk.mjs';
import { EDGE, ORIGIN, api, signOutBrowser, tool } from './stack.mjs';
import { tableIn, bodyRows } from './tables.mjs';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, encodeFunctionData, formatUnits, getAddress, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { TOKEN_A, acceptRepresentation, fundOnTestChain, testChain } from './dex.mjs';
import { installTestWallet, testWalletKey, TEST_WALLET } from './test-wallet.mjs';

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

/** The TEST token contract the stack seeds, from its committed build: anyone may mint, so a mint is a real Transfer. */
const TEST_TOKEN = JSON.parse(
  readFileSync(new URL('../../../../services/svc-protocol/contracts/out/TestToken.json', import.meta.url), 'utf8'),
);

/** Deploys a TEST token with this symbol from a fresh funded TEST key and mints to that key, so the indexer sees it emit. */
async function deployedToken(symbol, name) {
  const chain = testChain();
  expect(chain.chain, 'the stack runs no TEST chain, so no token can be deployed').toBe('running');
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
  const deploy = await wallet.deployContract({ abi: TEST_TOKEN.abi, bytecode: TEST_TOKEN.bytecode, args: [name, symbol, 18] });
  const { contractAddress, status } = await reader.waitForTransactionReceipt({ hash: deploy });
  expect(status).toBe('success');
  const mint = await wallet.writeContract({
    address: contractAddress,
    abi: TEST_TOKEN.abi,
    functionName: 'mint',
    args: [account.address, 10n ** 18n],
  });
  expect((await reader.waitForTransactionReceipt({ hash: mint })).status).toBe('success');
  return { address: getAddress(contractAddress), mint };
}

test(`${J} #4 pastes a 40-hex address into search: the address page is the top result, and two tokens sharing a symbol are both listed`, async ({
  page,
}) => {
  // Two TEST tokens that share one symbol, unique to this run so no other token on the chain carries it.
  const symbol = `T${Date.now().toString(36).toUpperCase().slice(-7)}`;
  const one = await deployedToken(symbol, 'TEST Token One');
  const two = await deployedToken(symbol, 'TEST Token Two');

  // "a 40-hex address in search: the address page is the top result"
  await page.goto('/chain');
  await search(page).fill(one.address);
  const results = page.getByRole('listbox', { name: 'Search results' }).getByRole('option');
  const top = results.first();
  await expect(top).toHaveAttribute('data-kind', 'address');
  await expect(top).toHaveAttribute('data-address', one.address.toLowerCase());
  await expect(top).toContainText(new RegExp(one.address, 'i'));
  await top.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/chain/address/${one.address}$`, 'i'));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(new RegExp(`^Address ${one.address}$`, 'i'));
  // The page is that address's: the indexer lists the mint this run sent to it.
  await expect(tableIn(page, 'Transactions').locator(`tr[data-tx="${one.mint.toLowerCase()}"]`)).toBeVisible({ timeout: 30_000 });

  // "two tokens sharing a symbol are both listed, never merged": one option per contract, each with its own address.
  await page.goto('/chain');
  await search(page).fill(symbol.toLowerCase());
  const tokens = page.getByRole('listbox', { name: 'Search results' }).locator('[role="option"][data-kind="token"]');
  await expect
    .poll(async () => (await tokens.evaluateAll((items) => items.map((item) => item.getAttribute('data-address')))).sort(), {
      timeout: 30_000,
      message: 'both tokens listed, once each',
    })
    .toEqual([one.address.toLowerCase(), two.address.toLowerCase()].sort());
  expect(await tokens.evaluateAll((items) => items.map((item) => item.getAttribute('data-symbol')))).toEqual([symbol, symbol]);
});

/**
 * A contract that forwards the value it is sent to the address in its calldata, by an internal call: so the address
 * receives value only inside a transaction, which is what "internal transactions" lists (#5); #10 deploys it as the twin
 * transaction. Runtime code:
 * CALL(gas, calldataload(0), callvalue, 0, 0, 0, 0), then STOP.
 */
const FORWARDER_DEPLOY = '0x600f600c600039600f6000f3' + '600060006000600034600035' + '5af100';

/** Polls the indexer until it has stored the canonical block at `height`, so the page reads a block that holds the run's txs. */
async function indexedTo(height) {
  const input = (h) => encodeURIComponent(JSON.stringify({ chainId: testChain().chainId, height: h }));
  await expect(async () => {
    const res = await fetch(`${EDGE}/api/indexer/trpc/explorer.blocks.get?input=${input(height)}`, { headers: { origin: ORIGIN } });
    expect(res.status).toBe(200);
  }).toPass({ timeout: 60_000 });
}

/** Whether the indexer has stored the canonical block at `height`. */
async function blockIndexed(height) {
  const input = encodeURIComponent(JSON.stringify({ chainId: testChain().chainId, height }));
  const res = await fetch(`${EDGE}/api/indexer/trpc/explorer.blocks.get?input=${input}`, { headers: { origin: ORIGIN } });
  if (res.status === 200) return true;
  expect(res.status, 'an unknown block is NOT_FOUND').toBe(404);
  return false;
}

test(`${J} #5 opens the address page: summary, transactions, holdings with unpriced ones counted, internal transactions or "trace unavailable", and a past balance or "not indexed before block N"`, async ({
  page,
}) => {
  const chain = testChain();
  expect(chain.chain, 'the stack runs no TEST chain, so nothing can be sent to an address').toBe('running');
  const viemChain = {
    id: chain.chainId,
    name: 'TEST chain',
    nativeCurrency: { name: 'TEST ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [chain.gateUrl] } },
  };
  // A fresh address this run alone sends to: one TEST token minted to it, and 0.25 TEST ETH reaching it only through a
  // forwarding contract's internal call. It holds nothing else, so every figure below is exact.
  const subject = getAddress(privateKeyToAccount(generatePrivateKey()).address);
  const sender = privateKeyToAccount(generatePrivateKey());
  fundOnTestChain(sender.address);
  const wallet = createWalletClient({ account: sender, chain: viemChain, transport: http(chain.gateUrl) });
  const reader = createPublicClient({ chain: viemChain, transport: http(chain.gateUrl) });
  const symbol = `T${Date.now().toString(36).toUpperCase().slice(-7)}`;
  const deployToken = await wallet.deployContract({ abi: TEST_TOKEN.abi, bytecode: TEST_TOKEN.bytecode, args: ['TEST Token', symbol, 18] });
  const token = getAddress((await reader.waitForTransactionReceipt({ hash: deployToken })).contractAddress);
  const mint = await wallet.writeContract({ address: token, abi: TEST_TOKEN.abi, functionName: 'mint', args: [subject, 10n ** 18n] });
  expect((await reader.waitForTransactionReceipt({ hash: mint })).status).toBe('success');
  const deployForwarder = await wallet.sendTransaction({ data: FORWARDER_DEPLOY });
  const forwarder = getAddress((await reader.waitForTransactionReceipt({ hash: deployForwarder })).contractAddress);
  const forward = await wallet.sendTransaction({ to: forwarder, value: 25n * 10n ** 16n, data: `0x${subject.slice(2).padStart(64, '0')}` });
  const forwarded = await reader.waitForTransactionReceipt({ hash: forward });
  expect(forwarded.status).toBe('success');
  expect(await reader.getBalance({ address: subject, blockNumber: forwarded.blockNumber })).toBe(25n * 10n ** 16n);
  const forwardHeight = Number(forwarded.blockNumber);
  await indexedTo(forwardHeight);

  await page.goto(`/chain/address/${subject}`);
  // "Summary": the kind and the exact native balance.
  const summary = page.getByRole('region', { name: 'Summary' });
  await expect(summary.getByTestId('address-kind')).toHaveText('Account');
  await expect(summary.getByTestId('address-balance')).toHaveText('0.25 (the network’s native unit)');

  // "tx tables": the transactions list holds the mint to this address.
  await expect(tableIn(page, 'Transactions').locator(`tr[data-tx="${mint.toLowerCase()}"]`)).toBeVisible();

  // "holdings with "1 holding has no price"": its one token, at its exact balance, and counted as unpriced.
  const holdings = page.getByRole('region', { name: 'Holdings' });
  const held = holdings.locator('tbody tr');
  await expect(held).toHaveCount(1);
  await expect(held.first()).toHaveAttribute('data-token', token.toLowerCase());
  await expect(held.first().locator('td').first()).toHaveText('1');
  await expect(holdings.getByTestId('address-unpriced')).toHaveText('1 holding has no price: this explorer has no price source.');

  // "internal txs or "trace unavailable"": the forwarder's internal call to this address, with its value.
  await page.getByRole('tab', { name: 'Internal transactions' }).click();
  const internal = page.getByRole('tabpanel', { name: 'Internal transactions' });
  const move = internal.locator(`tr[data-tx="${forward.toLowerCase()}"]`);
  await expect(move).toHaveCount(1);
  await expect(move.locator('td').nth(3)).toHaveAttribute('data-address', forwarder.toLowerCase());
  await expect(move.locator('td').nth(4)).toHaveAttribute('data-address', subject.toLowerCase());
  await expect(move.getByTestId('internal-value')).toHaveText('0.25');

  // "a past balance": the exact balance at the forwarding block, and nothing before it.
  const at = page.getByRole('textbox', { name: /date .* or a block number/ });
  const show = page.getByRole('button', { name: 'Show balance' });
  await at.fill(String(forwardHeight));
  await show.click();
  await expect(page.getByTestId('address-past-balance')).toHaveText(new RegExp(`^0\\.25 at block ${forwardHeight} \\(`));
  await at.fill(String(forwardHeight - 1));
  await show.click();
  await expect(page.getByTestId('address-past-balance')).toHaveText(new RegExp(`^0 at block ${forwardHeight - 1} \\(`));

  // "or "not indexed before block N"": a date before the TEST chain's first block names the first block the indexer
  // holds. Checked against the chain and the block list: block N was mined after that date, block N is stored, and no
  // block before it is (block 0 is the chain's first block, so nothing precedes it).
  await at.fill('2026-01-01');
  await show.click();
  const notIndexed = page.getByTestId('address-past-balance');
  await expect(notIndexed).toHaveText(/^Not indexed before block \d+\.$/);
  const earliest = Number((await notIndexed.textContent()).match(/block (\d+)/)[1]);
  const mined = (await reader.getBlock({ blockNumber: BigInt(earliest) })).timestamp;
  expect(mined, `block ${earliest} was mined after 2026-01-01 ended`).toBeGreaterThan(BigInt(Date.UTC(2026, 0, 2) / 1000));
  expect(await blockIndexed(earliest), `block ${earliest} is indexed`).toBe(true);
  const before = earliest === 0 ? 'no block before the first' : (await blockIndexed(earliest - 1)) ? 'indexed' : 'not indexed';
  expect(before, `the block before ${earliest}`).not.toBe('indexed');
});

test(`${J} #6 adds a watch with a tag and a private note: listed for this person only, adding again changes nothing, another account cannot read it, and the page says the explorer holds no funds`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const watched = { address: ADDRESS.toLowerCase(), tag: 'TEST cold wallet', note: 'TEST note' };
  /** The account's own stored watches, read through identity's preferences door with that account's own sign-in. */
  const storedWatches = async (client) => {
    const input = encodeURIComponent(JSON.stringify({ namespace: 'protocol.address-watches' }));
    const { status, body } = await client.get(`/api/identity/trpc/preferences.get?input=${input}`);
    expect(status).toBe(200);
    return body.result.data;
  };
  const watchButton = page.getByRole('button', { name: 'Watch this address' });
  const add = async () => {
    await watchButton.click();
    const dialog = page.getByRole('dialog', { name: 'Watch this address' });
    await dialog.getByRole('textbox', { name: 'Tag' }).fill(watched.tag);
    await dialog.getByRole('textbox', { name: 'Private note' }).fill(watched.note);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
  };

  const who = await signUp(page, 'cx');
  await signIn(page, who);
  const whoApi = await api(who);
  await page.goto(`/chain/address/${ADDRESS}`);
  // the page says the explorer holds no funds
  await expect(main(page)).toContainText('This explorer holds no funds');
  // The button is enabled only once the account's list is read, so every check below runs on a loaded page.
  await expect(watchButton).toBeEnabled();
  expect(await storedWatches(whoApi)).toEqual({ namespace: 'protocol.address-watches', version: 0, value: null });

  // adds a watch with a tag and a private note
  await add();
  await expect(main(page)).toContainText(`You watch this address as “${watched.tag}”.`);
  await expect(main(page)).toContainText(`Your note: ${watched.note}`);
  const first = await storedWatches(whoApi);
  expect(first).toEqual({ namespace: 'protocol.address-watches', version: 1, value: [watched] });

  // listed for this person
  await page.goto('/chain/watchlist');
  const rows = bodyRows(tableIn(page, 'Your watched addresses'));
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(watched.tag);
  await expect(rows.first()).toContainText(watched.note);

  // adding again changes nothing: the stored record keeps its version and value, and the list still has one row
  await page.goto(`/chain/address/${ADDRESS}`);
  await expect(watchButton).toBeEnabled();
  // The save is sent, and identity answers it stored at the version it already had.
  const saved = page.waitForResponse((res) => res.url().includes('/api/identity/trpc/preferences.set'));
  await add();
  expect((await (await saved).json()).result.data).toEqual({ ...first, outcome: 'stored' });
  await expect(main(page)).toContainText(`You watch this address as “${watched.tag}”.`);
  await expect(main(page)).toContainText(`Your note: ${watched.note}`);
  expect(await storedWatches(whoApi)).toEqual(first);
  await page.goto('/chain/watchlist');
  await expect(rows).toHaveCount(1);

  // another account cannot read it, so it is listed for this person only
  await signOutBrowser(page.context());
  const other = await signUp(page, 'cy');
  await signIn(page, other);
  expect(await storedWatches(await api(other))).toEqual({ namespace: 'protocol.address-watches', version: 0, value: null });
  await page.goto(`/chain/address/${ADDRESS}`);
  await expect(watchButton).toBeEnabled();
  await expect(main(page)).toContainText('This explorer holds no funds');
  await expect(main(page)).not.toContainText(watched.note);
  await expect(main(page)).not.toContainText(watched.tag);
  await page.goto('/chain/watchlist');
  await expect(main(page)).toContainText('You are not watching any address.');
  await expect(bodyRows(tableIn(page, 'Your watched addresses'))).toHaveCount(0);
});

test(`${J} #7 opens a pool page and a token page: candles, volume, buy and sell rows, holders; an address that is not a pool reads "not a pool"`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/dex/pools');
  // A TEST Token A / TEST Token B pool: the funding below hands out those two tokens.
  const listed = tableIn(page, 'Pools').getByRole('link', { name: 'TESTA / TESTB', exact: true }).first();
  await expect(listed).toBeVisible(UNBUILT);
  const poolAddress = getAddress((await listed.getAttribute('href')).split('/').pop());

  // A buy and a sell of the pool's first token, mined here from a fresh funded TEST key, so the rows the page must show
  // are this step's own and not whatever another journey left on the chain.
  const chain = testChain();
  expect(chain.chain, 'the stack runs no TEST chain, so no swap can be mined').toBe('running');
  const viemChain = {
    id: chain.chainId,
    name: 'TEST chain',
    nativeCurrency: { name: 'TEST ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [chain.gateUrl] } },
  };
  const reader = createPublicClient({ chain: viemChain, transport: http(chain.gateUrl) });
  const poolAbi = parseAbi([
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function getReserves() view returns (uint112, uint112, uint32)',
    'function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to) returns (uint256)',
  ]);
  const erc20 = parseAbi([
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ]);
  const [token0, token1] = await Promise.all(
    ['token0', 'token1'].map((functionName) => reader.readContract({ address: poolAddress, abi: poolAbi, functionName })),
  );
  const [decimals0, decimals1, symbol0] = await Promise.all([
    reader.readContract({ address: token0, abi: erc20, functionName: 'decimals' }),
    reader.readContract({ address: token1, abi: erc20, functionName: 'decimals' }),
    reader.readContract({ address: token0, abi: erc20, functionName: 'symbol' }),
  ]);
  const trader = privateKeyToAccount(generatePrivateKey());
  fundOnTestChain(trader.address);
  const wallet = createWalletClient({ account: trader, chain: viemChain, transport: http(chain.gateUrl) });
  const mined = async (request) => {
    const hash = await wallet.writeContract({ ...request, gas: 300_000n });
    expect((await reader.waitForTransactionReceipt({ hash })).status).toBe('success');
    return hash;
  };
  const in1 = 10n ** BigInt(decimals1);
  const in0 = 10n ** BigInt(decimals0);
  await mined({ address: token1, abi: erc20, functionName: 'approve', args: [poolAddress, in1] });
  await mined({ address: token0, abi: erc20, functionName: 'approve', args: [poolAddress, in0] });
  const buy = await mined({ address: poolAddress, abi: poolAbi, functionName: 'swapExactIn', args: [token1, in1, 1n, trader.address] });
  const sell = await mined({ address: poolAddress, abi: poolAbi, functionName: 'swapExactIn', args: [token0, in0, 1n, trader.address] });

  // the pool page, once the indexer holds both swaps
  const trades = () => tableIn(page, 'Trades');
  const tradeRow = (hash) =>
    trades()
      .getByRole('row')
      .filter({ has: page.locator(`a[title="${hash}"]`) });
  await expect(async () => {
    await page.goto(`/dex/pools/${poolAddress.toLowerCase()}`);
    await expect(tradeRow(sell)).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  // buy and sell rows: each labelled from the first token's side, as it was mined
  await expect(tradeRow(buy)).toContainText(`Buy ${symbol0}`);
  await expect(tradeRow(sell)).toContainText(`Sell ${symbol0}`);

  // candles
  const chart = page.getByRole('img', { name: /^Price chart: / });
  await expect(chart).toBeVisible();
  expect(await chart.getByTestId('pool-candle').count()).toBeGreaterThan(0);

  // volume: the last day's swaps, at least the two mined here
  const volume = page.getByTestId('pool-volume');
  await expect(volume).toContainText(/in the last 24 hours, \d+ swaps$/);
  expect(Number(/(\d+) swaps$/.exec(await volume.innerText())[1])).toBeGreaterThanOrEqual(2);

  // the reserves shown are the pool's own getReserves() at the block the page names
  const reservesLabel = page.getByText(/^Reserves after block \d+$/);
  await expect(reservesLabel).toBeVisible();
  const height = BigInt(/(\d+)$/.exec(await reservesLabel.innerText())[1]);
  const [r0, r1] = await reader.readContract({ address: poolAddress, abi: poolAbi, functionName: 'getReserves', blockNumber: height });
  await expect(reservesLabel.locator('xpath=following-sibling::dd')).toHaveText(
    `${formatUnits(r0, decimals0)} ${symbol0} · ${formatUnits(r1, decimals1)} ${await reader.readContract({ address: token1, abi: erc20, functionName: 'symbol' })}`,
  );

  // a token page: holders
  await page
    .getByRole('link', { name: /TEST Token A/ })
    .first()
    .click();
  await expect(page.getByRole('tab', { name: 'Holders' })).toBeVisible();

  // an address that is not a pool reads "not a pool"
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

/** One JSON-RPC call to a TEST network's gate. */
async function rpcAt(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/**
 * One transaction with the same hash on both TEST networks. A legacy transaction signed without a chain id (pre-EIP-155)
 * is valid on any chain, so a fresh key sends the same signed bytes, at nonce 0, to each. Returns the hash and the
 * block each network mined it in, both read from the chains themselves.
 */
async function twinTx() {
  const chain = testChain();
  expect(chain.chain, 'the stack runs no TEST chain, so no transaction can be sent').toBe('running');
  expect(chain.second?.gate, 'the stack runs no second TEST network').toBe('open');
  const account = privateKeyToAccount(generatePrivateKey());
  const urls = [chain.gateUrl, chain.second.gateUrl];
  for (const url of urls) await rpcAt(url, 'anvil_setBalance', [account.address, '0xde0b6b3a7640000']);
  const signed = await account.signTransaction({
    type: 'legacy',
    nonce: 0,
    gas: 100_000n,
    gasPrice: 20_000_000_000n,
    to: null,
    data: FORWARDER_DEPLOY,
  });
  const hashes = [];
  for (const url of urls) hashes.push(await rpcAt(url, 'eth_sendRawTransaction', [signed]));
  expect(hashes[1], 'the same signed transaction has the same hash on both networks').toBe(hashes[0]);
  const blocks = [];
  for (const url of urls) {
    const reader = createPublicClient({ transport: http(url) });
    const receipt = await reader.waitForTransactionReceipt({ hash: hashes[0] });
    expect(receipt.status).toBe('success');
    blocks.push(Number(receipt.blockNumber));
  }
  return { hash: hashes[0], primaryHeight: blocks[0], secondHeight: blocks[1] };
}

test(`${J} #10 searches a hash that exists on two networks: both are listed, and a network that did not answer reads "not checked" with its reason`, async ({
  page,
}) => {
  const { hash, primaryHeight, secondHeight } = await twinTx();
  await indexedTo(primaryHeight);
  const networks = page.getByRole('list', { name: 'Networks searched' }).getByRole('listitem');
  const primary = networks.filter({ hasText: /^Base Sepolia test network: / });
  const second = networks.filter({ hasText: /^Local test chain: / });

  // Both networks hold the hash, and both are listed as Found: the explorer's own from its index, the second network
  // from its node. These are the only two networks the stack's explorer searches, so exactly two read Found.
  await page.goto('/chain');
  await search(page).fill(hash);
  await search(page).press('Enter');
  await expect(primary).toHaveText('Base Sepolia test network: Found (Success) Open transaction');
  await expect(second).toHaveText(`Local test chain: Found (Success, block ${secondHeight})`);
  await expect(networks.filter({ hasText: /: Found \(/ })).toHaveCount(2);

  // The second network's node is made not to answer (the stack's gate for that network is closed), and the same hash
  // is searched again: that network reads "not checked" with its reason, never "Not found", and the first still Found.
  try {
    tool('local-test-chain.mjs', 'gate', 'closed', 'second');
    expect(testChain().second.gate).toBe('closed');
    await search(page).press('Enter');
    await expect(second).toHaveText('Local test chain: not checked: the network’s node didn’t answer', { timeout: 15_000 });
    await expect(primary).toHaveText('Base Sepolia test network: Found (Success) Open transaction');
  } finally {
    tool('local-test-chain.mjs', 'gate', 'open', 'second');
  }
  expect(testChain().second.gate).toBe('open');
});

test(`${J} #11 requests a token info update with the token owner's signature: the proof is stored; a replayed challenge, a non-owner and an ownerless token each refuse with their own reason`, async ({
  page,
}) => {
  const chain = testChain();
  expect(chain.chain, 'the stack runs no TEST chain, so no token can name an owner').toBe('running');
  const viemChain = {
    id: chain.chainId,
    name: 'LOCAL TEST chain',
    nativeCurrency: { name: 'TEST ETH', symbol: 'TESTETH', decimals: 18 },
    rpcUrls: { default: { http: [chain.gateUrl] } },
  };
  const reader = createPublicClient({ chain: viemChain, transport: http(chain.gateUrl) });
  // The owner's key lives only in the TEST wallet; a second fresh key deploys a token contract that names it as owner.
  const ownerKey = testWalletKey();
  const owner = privateKeyToAccount(ownerKey).address;
  const deployer = privateKeyToAccount(generatePrivateKey());
  fundOnTestChain(deployer.address);
  const deploy = await createWalletClient({ account: deployer, chain: viemChain, transport: http(chain.gateUrl) }).sendTransaction({
    data: ownedDeploy(owner),
  });
  const token = (await reader.waitForTransactionReceipt({ hash: deploy })).contractAddress;
  expect(
    await reader.readContract({ address: token, abi: parseAbi(['function owner() view returns (address)']), functionName: 'owner' }),
  ).toBe(owner);

  const wallet = await installTestWallet(page, { chainId: chain.chainId, privateKey: ownerKey });
  await page.goto('/wallet');
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Request an info update' });
  const challengeOf = async () => {
    const text = await dialog.getByTestId('token-update-challenge').innerText();
    expect(text).toContain(`token: ${getAddress(token)}`);
    expect(text).toContain(`chain id: ${chain.chainId}`);
    return { text, nonce: /nonce: ([0-9a-f]{32})/.exec(text)[1] };
  };
  const signIn = async () => {
    await dialog.getByRole('button', { name: 'Sign with your wallet' }).click();
    await page.locator('[data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet' }).click();
  };
  const open = async (address) => {
    await page.goto(`/dex/tokens/${address.toLowerCase()}`);
    await page.getByRole('button', { name: 'Request an info update' }).click(UNBUILT);
    await expect(dialog).toContainText("Sign this challenge with the token owner's wallet");
  };

  // the owner's signature: the proof is stored, naming the owner and the block its ownership was read at
  await open(token);
  const first = await challengeOf();
  await dialog.getByRole('button', { name: 'Sign with your wallet' }).click();
  // a fresh wallet accepts the representation once before its first signing action
  await acceptRepresentation(page);
  await page.locator('[data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet' }).click();
  const proven = dialog.getByRole('status');
  await expect(proven).toContainText(
    new RegExp(`^Ownership proven: ${getAddress(owner)} owns this token \\(read at block \\d+\\)\\. The proof is stored\\.`),
  );
  expect(wallet.requests.filter((r) => r.method === 'personal_sign').length).toBeGreaterThanOrEqual(1);

  // a replayed challenge: the same nonce with the owner's own signature, sent again, is refused as used
  const signature = await privateKeyToAccount(ownerKey).signMessage({ message: first.text });
  const replay = await fetch(`${EDGE}/api/protocol/trpc/listing.verifyOwnership`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: first.nonce, signature }),
  });
  const replayed = await replay.json();
  expect(replay.status).toBe(409);
  expect(JSON.stringify(replayed)).toContain('This challenge was already used.');

  // a non-owner: the wallet signs the next challenge with another key
  await open(token);
  await challengeOf();
  wallet.signWithOtherKeyNext();
  await signIn();
  await expect(dialog).toContainText('The signature is not from the wallet that owns this token.');

  // an ownerless token: TEST Token A's contract names no owner, so no challenge is issued and no one is asked to sign
  const signaturesBefore = wallet.requests.length;
  await page.goto(`/dex/tokens/${TOKEN_A.address.toLowerCase()}`);
  await page.getByRole('button', { name: 'Request an info update' }).click();
  await expect(dialog).toContainText('This token contract names no owner that can be read, so ownership cannot be proven.');
  await expect(dialog.getByTestId('token-update-challenge')).toHaveCount(0);
  expect(wallet.requests.length).toBe(signaturesBefore);
});

/**
 * A contract whose `owner()` (and any other call) answers `owner`: just enough for a token that names its owner. Runtime:
 * PUSH32 owner, MSTORE at 0, RETURN 32 bytes; the init code copies it and returns it.
 */
const ownedDeploy = (owner) => `0x6029600c60003960296000f37f${owner.slice(2).toLowerCase().padStart(64, '0')}60005260206000f3`;
