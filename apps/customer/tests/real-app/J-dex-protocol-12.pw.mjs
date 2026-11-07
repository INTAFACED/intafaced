// World: restart
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  maxUint256,
  parseAbi,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { CHAIN_ID, TOKEN_A, TOKEN_B, UNBUILT, acceptRepresentation, connectWallet, dexRun, fundOnTestChain, testChain } from './dex.mjs';
import { restartWith } from './stack.mjs';
import { tableIn, bodyRows } from './tables.mjs';
import { installTestWallet, testWalletKey, TEST_WALLET } from './test-wallet.mjs';
import { chainRecordPath } from '../../../../tooling/scripts/local-test-chain.mjs';

// J-dex-protocol-12, in the running app (docs/roadmap/journeys.json): add liquidity to a pool, see impermanent loss and
// take it out. One test per step, titled "J-dex-protocol-12 #<n>", run in order with one TEST wallet holding TEST tokens
// A and B on the stack's LOCAL TEST chain (anvil, chain 84532; tooling/scripts/local-test-chain.mjs). Liquidity goes
// into pool contracts the person's wallet signs for, for the pool's own ERC-20 shares; nothing posts to the ledger. Every
// money move a step names is checked on the chain itself, not only on the page.
//
// The pools: the seeded TEST A/B pool at 0.30% (#1, #2); the person's own A/B pool at 0.05%, created and seeded at
// 1000:2000 in #3, which is the position of #5, #6 and #8; and a second A/B pool at 0.25% seeded at 1000:2000 by an outside
// TEST provider for #4, so the person's own position stays entered at 1000:2000 and #6's price move reads 1414:1414.
// #3's blank tier list and zero factory restart svc-protocol with that owner setting blank, and put it back.
// The person's wallet is funded on the TEST chain here (not through dex.mjs's ON_TEST_CHAIN list, which another open
// journey PR edits).
const J = 'J-dex-protocol-12';
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

const A = 10n ** 6n; // TEST Token A: 6 decimals
const B = 10n ** 18n; // TEST Token B: 18 decimals
const NAME = 'TEST Token A / TEST Token B';
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const POOL = parseAbi([
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function token0() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to) returns (uint256)',
]);
const FACTORY = parseAbi(['function getPool(address, address, uint16) view returns (address)']);
const ROUTER = parseAbi([
  'function createAndSeed(address tokenA, address tokenB, uint16 feeBps, uint256 amountA, uint256 amountB, uint256 minShares, address to, uint256 deadline) returns (address, uint256)',
]);

function chainParts() {
  const chain = testChain();
  const viemChain = defineChain({
    id: CHAIN_ID,
    name: 'LOCAL TEST chain',
    nativeCurrency: { name: 'TEST ETH', symbol: 'TESTETH', decimals: 18 },
    rpcUrls: { default: { http: [chain.gateUrl] } },
  });
  const record = JSON.parse(readFileSync(chainRecordPath(), 'utf8'));
  const reader = createPublicClient({ chain: viemChain, transport: http(chain.gateUrl) });
  return { viemChain, record, reader, gateUrl: chain.gateUrl };
}

/** A fresh TEST key outside the app (a provider or a trader), funded on the TEST chain, sending straight to contracts. */
function outsider() {
  const { viemChain, reader, gateUrl } = chainParts();
  const account = privateKeyToAccount(generatePrivateKey());
  fundOnTestChain(account.address);
  const wallet = createWalletClient({ account, chain: viemChain, transport: http(gateUrl) });
  return {
    account,
    async send(to, data) {
      const hash = await wallet.sendTransaction({ to, data, gas: 6_000_000n });
      expect((await reader.waitForTransactionReceipt({ hash })).status).toBe('success');
    },
  };
}

const person = () => privateKeyToAccount(dex.key()).address;
const poolFor = async (feeBps) => {
  const { reader, record } = chainParts();
  return getAddress(
    await reader.readContract({
      address: record.factory,
      abi: FACTORY,
      functionName: 'getPool',
      args: [TOKEN_A.address, TOKEN_B.address, feeBps],
    }),
  );
};
/** Reserves as (TEST Token A, TEST Token B), whatever the pool's own token order. */
async function reservesAB(pool) {
  const { reader } = chainParts();
  const [[r0, r1], t0] = await Promise.all([
    reader.readContract({ address: pool, abi: POOL, functionName: 'getReserves' }),
    reader.readContract({ address: pool, abi: POOL, functionName: 'token0' }),
  ]);
  return getAddress(t0) === getAddress(TOKEN_A.address) ? { a: r0, b: r1 } : { a: r1, b: r0 };
}
async function balances(who) {
  const { reader } = chainParts();
  const [a, b] = await Promise.all(
    [TOKEN_A, TOKEN_B].map((t) => reader.readContract({ address: t.address, abi: ERC20, functionName: 'balanceOf', args: [who] })),
  );
  return { a, b };
}
const sharesOf = async (pool, who) =>
  chainParts().reader.readContract({ address: pool, abi: POOL, functionName: 'balanceOf', args: [who] });
const supplyOf = async (pool) => chainParts().reader.readContract({ address: pool, abi: POOL, functionName: 'totalSupply' });
/** "1,234.5 TEST Token A · 6.7 TEST Token B" → [1234.5, 6.7]. */
const pairNumbers = (text) => {
  const m = /^(-?[\d.]+) TEST Token A · (-?[\d.]+) TEST Token B$/.exec(text.trim());
  expect(m, `a TEST Token A · TEST Token B pair in "${text}"`).not.toBeNull();
  return [Number(m[1]), Number(m[2])];
};

async function openPools(page) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await page.goto('/dex/pools');
  await expect(tableIn(page, 'Pools')).toBeVisible();
  return wallet;
}
/** The sheet before the wallet prompt: every step listed, then the TEST wallet signs and sends each. */
async function continueInWallet(page) {
  await page.locator('[data-sheet="sequence"], [data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet' }).click();
}
const position = (page) => page.getByRole('main').getByRole('region', { name: 'Your position' });
async function openPosition(page, fee = '0.05') {
  await openPools(page);
  await page.goto('/dex/positions');
  await page
    .getByRole('main')
    .getByRole('link', { name: `${NAME} · ${fee}%` })
    .click(UNBUILT);
  await expect(position(page)).toBeVisible();
}

/** A second TEST wallet of this run, in its own browser, for a share moved out of the person's wallet. */
async function otherWallet(browser) {
  const state = dex.run.read();
  const privateKey = state.otherKey ?? dex.run.write({ ...state, otherKey: testWalletKey() }).otherKey;
  const context = await browser.newContext();
  const page = await context.newPage();
  const wallet = await installTestWallet(page, { chainId: CHAIN_ID, privateKey, rpcUrl: testChain().gateUrl });
  await page.goto('/wallet');
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  return { context, page, wallet };
}

test(`${J} starts: a TEST wallet holding TEST tokens A and B`, async ({ page }) => {
  dex.start();
  await openPools(page);
  const held = await balances(person());
  expect(held.a).toBeGreaterThanOrEqual(10_000n * A);
  expect(held.b).toBeGreaterThanOrEqual(10_000n * B);
});

test(`${J} #1 opens the pool list: pools with fee tier, reserves in token amounts and volume`, async ({ page }) => {
  await openPools(page);
  const table = tableIn(page, 'Pools');
  for (const header of ['Fee tier', 'Reserves', 'Volume (24 h)'])
    await expect(table.getByRole('columnheader', { name: header, exact: true })).toBeVisible(UNBUILT);
  // The seeded TEST A/B pool at 0.30%: its fee tier, its reserves in token amounts as the pool holds them, its volume.
  const deep = await poolFor(30);
  const row = bodyRows(table).filter({ has: page.locator(`a[href="/dex/pools/${deep.toLowerCase()}" i]`) });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('0.30%');
  await expect(async () => {
    const { a, b } = await reservesAB(deep);
    await expect(row).toContainText(`${formatUnits(a, 6)} TESTA · ${formatUnits(b, 18)} TESTB`, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(row).toContainText(/[\d.]+ TESTB, \d+ swaps/);
});

test(`${J} #2 starts a pool for a pair that already has one at 30 basis points: "This pool exists" and Add liquidity instead`, async ({
  page,
}) => {
  await openPools(page);
  await page.getByRole('link', { name: 'New pool' }).click(UNBUILT);
  const form = page.getByRole('form', { name: 'New pool' });
  await form.getByRole('combobox', { name: 'First token' }).selectOption({ label: 'TEST Token A' });
  await form.getByRole('combobox', { name: 'Second token' }).selectOption({ label: 'TEST Token B' });
  await form.getByRole('combobox', { name: 'Fee tier' }).selectOption({ label: '0.30%' });
  await expect(form.getByRole('status')).toHaveText('This pool exists');
  const deep = await poolFor(30);
  await expect(form.getByRole('link', { name: 'Add liquidity' })).toHaveAttribute('href', `/dex/pools/${deep.toLowerCase()}/add`);
  await expect(form.getByRole('button', { name: 'Create pool' })).toHaveCount(0);
});

test(`${J} #3 creates a pool at a fee tier and seeds it: price equals the deposit ratio; a fee over the cap refused; blank tiers show only custom; no factory names the network`, async ({
  page,
}) => {
  const form = page.getByRole('form', { name: 'New pool' });
  const tierOptions = () => form.getByRole('combobox', { name: 'Fee tier' }).locator('option').allInnerTexts();

  // A blank tier list: only the custom entry is offered.
  restartWith('protocol', 'LOCAL_STACK_PROTOCOL_FEE_TIERS', false);
  try {
    await openPools(page);
    await page.goto('/dex/pools/new');
    await expect(form.getByRole('note').filter({ hasText: 'has not published fee tiers' })).toBeVisible();
    expect(await tierOptions()).toEqual(['Choose a fee tier', 'Custom']);
  } finally {
    restartWith('protocol', 'LOCAL_STACK_PROTOCOL_FEE_TIERS', true);
  }

  // A zero factory address: the form keeps its layout and shows the crypto network notice.
  restartWith('protocol', 'LOCAL_STACK_PROTOCOL_AMM_FACTORY', false);
  try {
    await page.goto('/dex/pools/new');
    await expect(form).toBeVisible();
    const notice = page.locator('[data-not-connected="rail.crypto"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Creating a pool needs');
  } finally {
    restartWith('protocol', 'LOCAL_STACK_PROTOCOL_AMM_FACTORY', true);
  }

  await page.goto('/dex/pools/new');
  await form.getByRole('combobox', { name: 'First token' }).selectOption({ label: 'TEST Token A' });
  await form.getByRole('combobox', { name: 'Second token' }).selectOption({ label: 'TEST Token B' });
  // A fee above the cap is refused.
  await form.getByRole('combobox', { name: 'Fee tier' }).selectOption({ label: 'Custom' });
  await form.getByRole('textbox', { name: /^Custom fee/ }).fill('99');
  await expect(form.getByRole('alert')).toContainText('above the fee cap');
  await form.getByRole('textbox', { name: /^First amount/ }).fill('1000');
  await form.getByRole('textbox', { name: /^Second amount/ }).fill('2000');
  await expect(form.getByRole('button', { name: 'Create pool' })).toBeDisabled();

  // At the 0.05% tier, seeded 1000:2000: the starting price is the deposit ratio.
  await form.getByRole('combobox', { name: 'Fee tier' }).selectOption({ label: '0.05%' });
  await expect(form.getByTestId('starting-price')).toHaveText('1 TEST Token A = 2 TEST Token B');
  const before = await balances(person());
  await form.getByRole('button', { name: 'Create pool' }).click();
  await acceptRepresentation(page);
  await continueInWallet(page);
  await expect(page.getByRole('status').filter({ hasText: 'Pool created at' })).toBeVisible({ timeout: 60_000 });

  // On the chain: the pool exists at 0.05%, holds exactly the deposit, and the deposit left the person's wallet.
  const pool = await poolFor(5);
  expect(pool).not.toBe('0x0000000000000000000000000000000000000000');
  expect(await reservesAB(pool)).toEqual({ a: 1000n * A, b: 2000n * B });
  const after = await balances(person());
  expect(before.a - after.a).toBe(1000n * A);
  expect(before.b - after.b).toBe(2000n * B);
  expect(await sharesOf(pool, person())).toBeGreaterThan(0n);
  dex.run.write({ ...dex.run.read(), pool });
});

test(`${J} #4 enters 100:100 into a 1000:2000 pool: only 50:100 is pulled; a minimum above what the pool takes reverts; a stale quote asks to refresh`, async ({
  page,
}) => {
  // An outside TEST provider's A/B pool at 0.25%, seeded 1000:2000.
  const { record } = chainParts();
  const provider = outsider();
  for (const t of [TOKEN_A, TOKEN_B])
    await provider.send(t.address, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [record.liquidityRouter, maxUint256] }));
  await provider.send(
    record.liquidityRouter,
    encodeFunctionData({
      abi: ROUTER,
      functionName: 'createAndSeed',
      args: [
        TOKEN_A.address,
        TOKEN_B.address,
        25,
        1000n * A,
        2000n * B,
        1n,
        provider.account.address,
        BigInt(Math.floor(Date.now() / 1000) + 3600),
      ],
    }),
  );
  const second = await poolFor(25);
  expect(await reservesAB(second)).toEqual({ a: 1000n * A, b: 2000n * B });

  await openPools(page);
  // The list is the indexer's: the new pool appears once it has read the PoolCreated log.
  const listed = () =>
    bodyRows(tableIn(page, 'Pools'))
      .filter({ has: page.locator(`a[href="/dex/pools/${second.toLowerCase()}" i]`) })
      .getByRole('link', { name: 'Add liquidity' });
  await expect(async () => {
    await page.goto('/dex/pools');
    await expect(listed()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await listed().click();
  const add = page.getByRole('form', { name: 'Add liquidity' });
  await add.getByRole('textbox', { name: /^TEST Token A/ }).fill('100');
  await add.getByRole('textbox', { name: /^TEST Token B/ }).fill('100');
  await expect(add.getByTestId('pulled')).toHaveText('Deposits 50 TEST Token A and 100 TEST Token B');

  // A minimum above what the pool takes: the call reverts with the contract's reason, and no token moves.
  const before = await balances(person());
  await add.getByRole('textbox', { name: /^Minimum shares/ }).fill('1');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await continueInWallet(page);
  await expect(add.getByRole('alert')).toContainText('Fewer shares than your minimum', { timeout: 60_000 });
  expect(await balances(person())).toEqual(before);
  expect(await sharesOf(second, person())).toBe(0n);

  // The quote goes stale after the owner's quote lifetime: the form asks to refresh it, and Add waits.
  await expect(add.getByRole('button', { name: 'Refresh quote' })).toBeVisible({ timeout: 60_000 });
  await expect(add.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await add.getByRole('button', { name: 'Refresh quote' }).click();
  await expect(add.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();

  // With the quoted minimum: only 50 TEST Token A and 100 TEST Token B leave the wallet, for shares in the pool.
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await continueInWallet(page);
  await expect(page.getByRole('status').filter({ hasText: 'Added.' })).toBeVisible({ timeout: 60_000 });
  const after = await balances(person());
  expect(before.a - after.a).toBe(50n * A);
  expect(before.b - after.b).toBe(100n * B);
  expect(await sharesOf(second, person())).toBeGreaterThan(0n);
});

test(`${J} #5 opens the position: LP shares, share of the pool and fees earned; a share moved to another wallet shows as that wallet's`, async ({
  page,
  browser,
}) => {
  const { pool } = dex.run.read();
  await openPosition(page);
  for (const term of ['LP shares', 'Share of the pool', 'Fees earned'])
    await expect(position(page).getByRole('term').filter({ hasText: term })).toBeVisible();
  const held = await sharesOf(pool, person());
  await expect(position(page).getByTestId('lp-shares')).toHaveText(formatUnits(held, 18));
  // the person seeded the pool: every share but the 1,000 locked for good, 99.99% of it
  await expect(
    position(page)
      .getByRole('definition')
      .filter({ hasText: /^99\.99%$/ }),
  ).toBeVisible();
  await expect(position(page).getByTestId('fees-earned')).toContainText('TEST Token A');

  // A tenth of the shares moves to another wallet: that wallet now holds them, as its own position.
  const other = await otherWallet(browser);
  try {
    const tenth = held / 10n;
    await position(page).getByRole('button', { name: 'Send shares' }).click();
    const move = page.getByRole('dialog', { name: 'Send shares' });
    await move.getByRole('textbox', { name: /^To/ }).fill(other.wallet.address);
    await move.getByRole('textbox', { name: /^Shares/ }).fill(formatUnits(tenth, 18));
    await move.getByRole('button', { name: 'Continue', exact: true }).click();
    await continueInWallet(page);
    await expect(position(page).getByRole('status').filter({ hasText: 'Sent' })).toBeVisible({ timeout: 60_000 });
    expect(await sharesOf(pool, other.wallet.address)).toBe(tenth);
    await other.page.goto('/dex/positions');
    await expect(other.page.getByRole('main').getByRole('link', { name: `${NAME} · 0.05%` })).toBeVisible({ timeout: 60_000 });
  } finally {
    await other.context.close();
  }
});

test(`${J} #6 opens the impermanent-loss card after the price moves to 1414:1414: held amounts, share amounts and the difference; a transferred share reads "Entry unknown"`, async ({
  page,
  browser,
}) => {
  const { pool } = dex.run.read();
  // An outside TEST trader swaps TEST Token A in until the pool's price is 1:1: 1000:2000 moves to 1414:1414.
  const before = await reservesAB(pool);
  const target = sqrtBig((before.a * before.b) / 10n ** 12n); // TEST A base units at a 1:1 price in whole tokens
  if (target > before.a) {
    const trader = outsider();
    await trader.send(TOKEN_A.address, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [pool, maxUint256] }));
    await trader.send(
      pool,
      encodeFunctionData({
        abi: POOL,
        functionName: 'swapExactIn',
        args: [TOKEN_A.address, target - before.a, 1n, trader.account.address],
      }),
    );
  }
  const moved = await reservesAB(pool);
  expect(moved.a / A).toBe(1414n);
  expect(moved.b / B).toBe(1414n);

  await openPosition(page);
  const card = position(page).getByRole('region', { name: 'Impermanent loss' });
  for (const term of ['If held', 'In the pool', 'Difference']) await expect(card.getByRole('term').filter({ hasText: term })).toBeVisible();
  // Held: the 1000:2000 entry for the nine tenths still held. In the pool: the shares' part of the reserves now.
  const [shares, supply] = await Promise.all([sharesOf(pool, person()), supplyOf(pool)]);
  const [heldA, heldB] = pairNumbers(await card.getByTestId('il-held').innerText());
  expect(heldA).toBeCloseTo(900, 0);
  expect(heldB).toBeCloseTo(1800, 0);
  const [nowA, nowB] = pairNumbers(await card.getByTestId('il-now').innerText());
  expect(nowA).toBeCloseTo(Number(formatUnits((shares * moved.a) / supply, 6)), 4);
  expect(nowB).toBeCloseTo(Number(formatUnits((shares * moved.b) / supply, 18)), 4);
  const [diffA, diffB] = pairNumbers(await card.getByTestId('il-diff').innerText());
  expect(diffA).toBeCloseTo(nowA - heldA, 4);
  expect(diffB).toBeCloseTo(nowB - heldB, 4);
  // Valued at the pool's price now, the difference matches the closed form 2√r/(1+r) − 1 for r = 1/2 (−5.72%), less fees.
  const closed = Number(/(-?[\d.]+)%/.exec(await card.getByTestId('il-closed-form').innerText())[1]);
  expect(closed).toBeCloseTo(-5.72, 1);
  const measured = Number(/(-?[\d.]+)%\.$/.exec(await card.getByTestId('il-value').innerText())[1]);
  expect(Math.abs(measured - closed)).toBeLessThan(0.1);

  // The wallet that received shares in #5 never deposited, so its entry is unknown rather than guessed.
  const other = await otherWallet(browser);
  try {
    await other.page.goto('/dex/positions');
    await other.page
      .getByRole('main')
      .getByRole('link', { name: `${NAME} · 0.05%` })
      .click(UNBUILT);
    await expect(other.page.getByRole('region', { name: 'Impermanent loss' })).toContainText('Entry unknown');
  } finally {
    await other.context.close();
  }
});

test(`${J} #7 adds a single token with swap-and-add: about half swapped, shares at least the minimum; a failed second step leaves nothing half done`, async ({
  page,
}) => {
  const { pool } = dex.run.read();
  await openPools(page);
  await page.goto(`/dex/pools/${pool.toLowerCase()}/add`);
  const add = page.getByRole('form', { name: 'Add liquidity' });
  await add.getByRole('checkbox', { name: 'Add one token (swap half first)' }).check();
  await add.getByRole('textbox', { name: /^TEST Token A/ }).fill('100');
  await expect(add.getByTestId('swap-half')).toHaveText(/^Swaps about [\d.]+ TEST Token A first$/);
  const swapped = Number(/about ([\d.]+)/.exec(await add.getByTestId('swap-half').innerText())[1]);
  expect(swapped).toBeGreaterThan(45);
  expect(swapped).toBeLessThan(50);
  await expect(add.getByRole('note')).toContainText('Both steps happen in one transaction, or neither does.');

  // The add after the swap needs more shares than it can mint: the one transaction reverts, the swap with it.
  const before = { held: await balances(person()), reserves: await reservesAB(pool), shares: await sharesOf(pool, person()) };
  await add.getByRole('textbox', { name: /^Minimum shares/ }).fill('1');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await continueInWallet(page);
  await expect(add.getByRole('alert')).toContainText('Fewer shares than your minimum', { timeout: 60_000 });
  await expect(add.getByRole('alert')).toContainText('Nothing was swapped or added');
  expect(await balances(person())).toEqual(before.held);
  expect(await reservesAB(pool)).toEqual(before.reserves);
  expect(await sharesOf(pool, person())).toBe(before.shares);

  // With the quoted minimum: shares at least that minimum, and at most the 100 TEST Token A offered left the wallet.
  await add.getByRole('textbox', { name: /^TEST Token A/ }).fill('99');
  await add.getByRole('textbox', { name: /^TEST Token A/ }).fill('100');
  await expect(add.getByTestId('swap-half')).toBeVisible();
  const minimum = BigInt(Math.round(Number(await add.getByRole('textbox', { name: /^Minimum shares/ }).inputValue()) * 1e18));
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await continueInWallet(page);
  await expect(page.getByRole('status').filter({ hasText: 'Added.' })).toBeVisible({ timeout: 60_000 });
  // the minimum was read from text as a float: allow its rounding, never a shortfall beyond it
  expect((await sharesOf(pool, person())) - before.shares).toBeGreaterThanOrEqual((minimum * 999_999n) / 1_000_000n);
  const after = await balances(person());
  expect(before.held.a - after.a).toBeLessThanOrEqual(100n * A);
  expect(before.held.a - after.a).toBeGreaterThan(99n * A);
});

test(`${J} #8 collects fees, then removes all shares: fees compound into the position; removal pays both tokens pro rata and the position goes`, async ({
  page,
}) => {
  const { pool } = dex.run.read();
  await openPosition(page);
  // The position earned fees (the price move in #6 was a swap through it), and collecting says they are already in it.
  const [feeA, feeB] = pairNumbers(await position(page).getByTestId('fees-earned').innerText());
  expect(feeA + feeB).toBeGreaterThan(0);
  await position(page).getByRole('button', { name: 'Collect fees' }).click();
  await expect(position(page).getByRole('status')).toContainText('Fees added to your position');

  // Remove all: both tokens come back pro rata to the shares, and the position goes.
  const [shares, supply, reserves, before] = await Promise.all([
    sharesOf(pool, person()),
    supplyOf(pool),
    reservesAB(pool),
    balances(person()),
  ]);
  await position(page).getByRole('button', { name: 'Remove all' }).click();
  await continueInWallet(page);
  await expect(
    position(page)
      .getByRole('status')
      .filter({ hasText: /^Returned [\d.]+ TEST Token A and [\d.]+ TEST Token B/ }),
  ).toBeVisible({
    timeout: 60_000,
  });
  const after = await balances(person());
  expect(after.a - before.a).toBe((shares * reserves.a) / supply);
  expect(after.b - before.b).toBe((shares * reserves.b) / supply);
  expect(await sharesOf(pool, person())).toBe(0n);
  await page.goto('/dex/positions');
  await expect(page.getByRole('main').getByRole('link', { name: `${NAME} · 0.05%` })).toHaveCount(0);
});

function sqrtBig(y) {
  if (y < 2n) return y;
  let z = y;
  let x = y / 2n + 1n;
  while (x < z) {
    z = x;
    x = (y / x + x) / 2n;
  }
  return z;
}
