// World: book
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http, maxUint256, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { CHAIN_ID, TOKEN_A, TOKEN_B, UNBUILT, connectWallet, dexRun, fundOnTestChain, testChain } from './dex.mjs';
import { bodyRows, tableIn } from './tables.mjs';
import { chainRecordPath } from '../../../../tooling/scripts/local-test-chain.mjs';

// J-dex-protocol-13, in the running app (docs/roadmap/journeys.json): run advanced pools with ranges, hooks, permissioned
// markets and incentives. One test per step, titled "J-dex-protocol-13 #<n>", run in order with one TEST wallet holding
// TEST tokens A and B, in pools the owner has opened for each pool type. Every position is in a pool contract the
// person's wallet signs; nothing posts to the ledger, and hook and permissioned pools always let liquidity out.
// owner.decision shows for each gated pool type until the owner opens it; rail.crypto while the node is absent.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - /dex/pools is an empty "Liquidity pools" table with no pool types, and /dex/pools/new and pool pages are pending
//   pages, so there are no range positions or range orders (D-liquidity-05), hook pools (D-liquidity-06), permissioned
//   pools (D-liquidity-07), dynamic fees (D-liquidity-08) or incentives and the venue strategy (D-liquidity-09);
// - the stack has no TEST chain, factory, hook or pool, so no price moves and nothing a step signs can mine.
const J = 'J-dex-protocol-13';
// The run's wallet is funded on the stack's LOCAL TEST chain here (not through dex.mjs's ON_TEST_CHAIN list, which
// another open journey PR edits), so #8's shares, stake and reward are real chain state.
const base = dexRun(J);
const dex = {
  ...base,
  onChain: true,
  start(extra = {}) {
    const state = base.start(extra);
    fundOnTestChain(privateKeyToAccount(state.walletKey).address);
    return state;
  },
  key() {
    return base.run.read().walletKey ?? this.start().walletKey;
  },
};

test.describe.configure({ mode: 'default' });

const pools = (page) => tableIn(page.getByRole('main'), 'Liquidity pools');
const position = (page) => page.getByRole('main').getByRole('region', { name: 'Your position' });

/** Opens /dex/pools with the run's wallet connected. */
async function openPools(page) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await page.goto('/dex/pools');
  await expect(pools(page)).toBeVisible();
  return wallet;
}

/** Opens the pool of `type` (Range, Hook, Stable, Permissioned) for TEST tokens A and B, connecting the wallet first. */
async function openPool(page, type) {
  await openPools(page);
  return choosePool(page, type);
}

/** From /dex/pools with the wallet already connected, opens the pool of `type` for TEST tokens A and B. */
async function choosePool(page, type) {
  await page.goto('/dex/pools');
  await page.getByRole('main').getByRole('group', { name: 'Pool type' }).getByRole('button', { name: type }).click(UNBUILT);
  await bodyRows(pools(page)).filter({ hasText: 'TEST Token A / TEST Token B' }).getByRole('link').click();
  const pool = page.getByRole('main').getByRole('region', { name: 'Pool' });
  await expect(pool).toBeVisible();
  return pool;
}

test(`${J} starts: a TEST wallet holding TEST tokens A and B, with a pool of each type the owner opened`, async ({ page }) => {
  dex.start();
  await openPools(page);
  const types = page.getByRole('main').getByRole('group', { name: 'Pool type' });
  for (const type of ['Range', 'Hook', 'Stable', 'Permissioned'])
    await expect(types.getByRole('button', { name: type })).toBeVisible(UNBUILT);
});

test(`${J} #1 opens a range position inside the price: fees accrue; when the price leaves the range it reads out of range and accrual stops`, async ({
  page,
}) => {
  const pool = await openPool(page, 'Range');
  await pool.getByRole('button', { name: 'Add a range position' }).click();
  const form = page.getByRole('form', { name: 'Range position' });
  await form.getByRole('button', { name: 'Around the current price' }).click();
  await form.getByRole('textbox', { name: /^Amount of TEST Token A/ }).fill('10');
  await form.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(position(page).getByRole('status')).toHaveText('In range', { timeout: 60_000 });
  await expect(position(page).getByTestId('fees-earned')).not.toHaveText(/^0(\.0+)? /, { timeout: 60_000 });
  // The TEST price moves outside the range: the position says so and stops earning.
  await expect(position(page).getByRole('status')).toHaveText('Out of range: not earning fees', { timeout: 120_000 });
});

test(`${J} #2 places a range order: after the price crosses it holds only the other token; a blank tick spacing refuses`, async ({
  page,
}) => {
  const pool = await openPool(page, 'Range');
  await pool.getByRole('button', { name: 'Place a range order' }).click();
  const form = page.getByRole('form', { name: 'Range order' });
  await form.getByRole('textbox', { name: /^Sell TEST Token A at/ }).fill('1.1');
  await form.getByRole('textbox', { name: /^Amount/ }).fill('5');
  await form.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(position(page)).toContainText(/Holds only TEST Token B/, { timeout: 120_000 });
  // A pool whose owner left the tick spacing blank refuses the build by name.
  await page.goto('/dex/pools');
  await page.getByRole('main').getByRole('group', { name: 'Pool type' }).getByRole('button', { name: 'Range' }).click();
  await bodyRows(pools(page)).filter({ hasText: 'TEST no tick spacing' }).getByRole('link').click();
  await page.getByRole('button', { name: 'Place a range order' }).click();
  await expect(page.getByRole('alert')).toContainText('dex.pool.tick_spacing_unset');
});

test(`${J} #3 opens a hook pool: the hook, its risk review and the allowlist badge; a reverting hook blocks swaps with "hook reverted" while liquidity can still be removed`, async ({
  page,
}) => {
  const pool = await openPool(page, 'Hook');
  const hook = pool.getByRole('region', { name: 'Hook' });
  await expect(hook.getByRole('link', { name: 'Risk review' })).toBeVisible();
  await expect(hook.getByText('Routing allowlist', { exact: true })).toBeVisible();
  await page.goto('/dex');
  // The TEST hook pool whose hook reverts: the swap is blocked by name, the exit still builds.
  await page.getByRole('form', { name: 'Swap' }).getByRole('combobox', { name: 'Pool' }).selectOption({ label: 'TEST reverting hook' });
  await expect(page.getByRole('form', { name: 'Swap' }).getByRole('alert')).toContainText('hook reverted');
  await page.goBack();
  await pool.getByRole('button', { name: 'Remove liquidity' }).click();
  await expect(page.getByRole('dialog', { name: 'Check before you sign' })).toBeVisible();
});

test(`${J} #4 opens a stable pair and a skewed volatile pair: the stable fee is optimal inside the band and corrective outside; bid and ask fees differ within the cap`, async ({
  page,
}) => {
  const stable = await openPool(page, 'Stable');
  const fees = stable.getByRole('region', { name: 'Fees' });
  await expect(fees.getByTestId('fee-rule')).toHaveText(/^(Inside the band: optimal fee|Outside the band: corrective fee) [\d.]+ ?%$/);
  const volatile = await choosePool(page, 'Range');
  const sides = volatile.getByRole('region', { name: 'Fees' });
  const bid = await sides.getByTestId('fee-bid').innerText();
  const ask = await sides.getByTestId('fee-ask').innerText();
  expect(bid).not.toBe(ask);
  await expect(sides.getByTestId('fee-cap')).toHaveText(/^Cap [\d.]+ ?%$/);
});

test(`${J} #5 asks to change a fee hook parameter: it is a new hook and a new pool; the old pool keeps its rule`, async ({ page }) => {
  const pool = await openPool(page, 'Hook');
  const rule = await pool.getByTestId('fee-rule').innerText(UNBUILT);
  await pool.getByRole('button', { name: 'Change a fee parameter' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change a fee parameter' });
  await expect(dialog).toContainText('A changed parameter is a new hook and a new pool. This pool keeps its rule.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(pool.getByTestId('fee-rule')).toHaveText(rule);
});

test(`${J} #6 tries to swap in a permissioned pool without being allowlisted: "Not eligible", and removing liquidity still succeeds`, async ({
  page,
}) => {
  const pool = await openPool(page, 'Permissioned');
  await pool.getByRole('button', { name: 'Swap in this pool' }).click();
  await expect(page.getByRole('alert')).toContainText('Not eligible');
  await pool.getByRole('button', { name: 'Remove liquidity' }).click();
  await expect(page.getByRole('dialog', { name: 'Check before you sign' })).toBeVisible();
});

test(`${J} #7 reads the issuer controls: a halted swap shows its reason and exits still work; a position token cannot be transferred`, async ({
  page,
}) => {
  const pool = await openPool(page, 'Permissioned');
  const issuer = pool.getByRole('region', { name: 'Issuer controls' });
  await expect(issuer.getByText(/^Swaps halted: .+/)).toBeVisible();
  await expect(pool.getByRole('button', { name: 'Remove liquidity' })).toBeEnabled();
  await expect(issuer).toContainText('Position tokens in this pool cannot be transferred.');
  await expect(pool.getByRole('button', { name: /^Transfer/ })).toHaveCount(0);
});

// ── #8: on-chain incentives on a full-range pool (D-liquidity-09; the in-range split waits for D-liquidity-05) ──────

const ERC20 = parseAbi(['function approve(address, uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const ROUTER = parseAbi([
  'function addLiquidity(address pool, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 minShares, address to, uint256 deadline) returns (uint256, uint256, uint256)',
]);
const FACTORY = parseAbi(['function getPool(address, address, uint16) view returns (address)']);
const INCENTIVES = parseAbi([
  'function create(address pool, address rewardToken, uint256 total, uint64 blocks, address refundee) returns (uint256)',
  'function fund(uint256 id)',
  'function start(uint256 id)',
  'function stake(uint256 id, uint256 shares)',
  'function count() view returns (uint256)',
  'function pending(uint256 id, address account) view returns (uint256)',
  'function stakeOf(uint256 id, address account) view returns (uint256)',
]);
const E18 = 10n ** 18n;

function chainParts() {
  const chain = testChain();
  const viemChain = defineChain({
    id: CHAIN_ID,
    name: 'LOCAL TEST chain',
    nativeCurrency: { name: 'TEST ETH', symbol: 'TESTETH', decimals: 18 },
    rpcUrls: { default: { http: [chain.gateUrl] } },
  });
  const record = JSON.parse(readFileSync(chainRecordPath(), 'utf8'));
  return { viemChain, record, gateUrl: chain.gateUrl, reader: createPublicClient({ chain: viemChain, transport: http(chain.gateUrl) }) };
}
/** A TEST key sending straight to contracts: the run's own wallet (setup only), or a fresh funded outsider. */
function sender(privateKey = null) {
  const { viemChain, reader, gateUrl } = chainParts();
  const account = privateKeyToAccount(privateKey ?? generatePrivateKey());
  if (!privateKey) fundOnTestChain(account.address);
  const wallet = createWalletClient({ account, chain: viemChain, transport: http(gateUrl) });
  return {
    account,
    async send(to, data) {
      const hash = await wallet.sendTransaction({ to, data, gas: 3_000_000n });
      const receipt = await reader.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe('success');
      return receipt;
    },
  };
}
/** `who` adds `amount` of each TEST token to `pool` through the liquidity router, for its own shares. */
async function provide(who, pool, amount) {
  const { record } = chainParts();
  for (const t of [TOKEN_A, TOKEN_B])
    await who.send(t.address, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [record.liquidityRouter, maxUint256] }));
  const [a0, a1] = [amount * 10n ** 6n, amount * E18]; // token0 is TEST Token A (lower address)
  await who.send(
    record.liquidityRouter,
    encodeFunctionData({
      abi: ROUTER,
      functionName: 'addLiquidity',
      args: [pool, a0, a1, 0n, 0n, 1n, who.account.address, BigInt(Math.floor(Date.now() / 1000) + 3600)],
    }),
  );
}

test(`${J} #8 stakes LP shares into a TEST incentive of 1000 over 10 blocks: rewards split 750:250 for LPs holding 3:1; leaving stops accrual; an unfunded incentive cannot start`, async ({
  page,
}) => {
  const { record, reader } = chainParts();
  const pool = getAddress(await reader.readContract({ address: record.factory, abi: FACTORY, functionName: 'getPool', args: [TOKEN_A.address, TOKEN_B.address, 30] }));
  // Setup: this wallet and another TEST provider hold shares 3:1; an outside TEST incentivizer announces and funds 1000
  // TEST Token B over 10 blocks, and announces a second incentive it never funds.
  await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  const me = sender(dex.key());
  const other = sender();
  await provide(me, pool, 300n);
  await provide(other, pool, 100n);
  const shares = async (who) => reader.readContract({ address: pool, abi: ERC20, functionName: 'balanceOf', args: [who] });
  const [mine, theirs] = [await shares(me.account.address), await shares(other.account.address)];
  // the pool is shared with other journeys, so shares are compared, not assumed: 3:1 to within rounding
  expect(Number((mine * 1000n) / theirs) / 1000).toBeCloseTo(3, 2);
  const incentivizer = sender();
  const incentives = record.liquidityIncentives;
  const id = await reader.readContract({ address: incentives, abi: INCENTIVES, functionName: 'count' });
  await incentivizer.send(incentives, encodeFunctionData({ abi: INCENTIVES, functionName: 'create', args: [pool, TOKEN_B.address, 1000n * E18, 10n, incentivizer.account.address] }));
  await incentivizer.send(incentives, encodeFunctionData({ abi: INCENTIVES, functionName: 'create', args: [pool, TOKEN_B.address, 500n * E18, 10n, incentivizer.account.address] }));
  await incentivizer.send(TOKEN_B.address, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [incentives, maxUint256] }));
  await incentivizer.send(incentives, encodeFunctionData({ abi: INCENTIVES, functionName: 'fund', args: [id] }));
  await other.send(pool, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [incentives, maxUint256] }));
  await other.send(incentives, encodeFunctionData({ abi: INCENTIVES, functionName: 'stake', args: [id, theirs] }));

  // The person stakes every share they hold, from the pool page.
  await page.goto(`/dex/pools/${pool.toLowerCase()}`);
  const table = tableIn(page.getByRole('main'), 'Incentives');
  const funded = bodyRows(table).filter({ hasText: '1000 TEST Token B over 10 blocks' }).filter({ hasText: 'Funded, not started' }).last();
  await funded.getByRole('button', { name: 'Stake' }).click(UNBUILT);
  await page.locator('[data-sheet="sequence"]').getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(funded.getByTestId('your-split')).toHaveText(/^75\.\d\d% · 75\d(\.\d+)? of 1000 TEST Token B over the period$/, { timeout: 60_000 });

  // The incentivizer starts it: both stakes accrue 3:1, so over the full period the split is 750:250.
  await incentivizer.send(incentives, encodeFunctionData({ abi: INCENTIVES, functionName: 'start', args: [id] }));
  const at = await reader.getBlockNumber();
  const [p1, p2] = await Promise.all(
    [me.account.address, other.account.address].map((a) => reader.readContract({ address: incentives, abi: INCENTIVES, functionName: 'pending', args: [id, a], blockNumber: at })),
  );
  expect(p1 + p2).toBeGreaterThan(0n);
  expect(Number((p1 * 1000n) / (p1 + p2)) / 1000).toBeCloseTo(0.75, 2);

  // Leaving mid-period: once some reward has accrued, unstake; it stops accruing and keeps what it earned.
  const reward = funded.getByTestId('your-reward');
  await expect(reward).not.toHaveText(/^0 TEST Token B$/, { timeout: 30_000 });
  await funded.getByRole('button', { name: 'Unstake' }).click();
  await page.locator('[data-sheet="sequence"]').getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(funded.getByRole('status')).toHaveText('Not earning', { timeout: 60_000 });
  expect(await reader.readContract({ address: incentives, abi: INCENTIVES, functionName: 'stakeOf', args: [id, me.account.address] })).toBe(0n);
  const left = await reader.readContract({ address: incentives, abi: INCENTIVES, functionName: 'pending', args: [id, me.account.address] });
  expect(left).toBeGreaterThan(0n);
  expect(left).toBeLessThan(750n * E18);
  await expect(funded).toContainText('Period ended', { timeout: 120_000 });
  expect(await reader.readContract({ address: incentives, abi: INCENTIVES, functionName: 'pending', args: [id, me.account.address] })).toBe(left);

  // The unfunded incentive cannot start: Start is off with the reason, and the contract itself refuses it.
  const unfunded = bodyRows(table).filter({ hasText: '500 TEST Token B over 10 blocks' }).last();
  await expect(unfunded).toContainText('Not funded: cannot start');
  await expect(unfunded.getByRole('button', { name: 'Start' })).toBeDisabled();
  await expect(
    reader.simulateContract({ account: incentivizer.account, address: incentives, abi: INCENTIVES, functionName: 'start', args: [id + 1n] }),
  ).rejects.toThrow(/NotFunded|reverted/);
});

test(`${J} #9 reads the protocol-run venue strategy: its orders sit with user orders at one price and get no priority`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await page.goto('/dex/venue');
  const strategy = page.getByRole('main').getByRole('region', { name: 'Protocol strategy' });
  await expect(strategy).toBeVisible(UNBUILT);
  await expect(strategy).toContainText('Its orders queue with yours at the same price and get no priority.');
  await expect(tableIn(strategy, 'Strategy orders').getByRole('columnheader', { name: 'Queue position' })).toBeVisible();
});
