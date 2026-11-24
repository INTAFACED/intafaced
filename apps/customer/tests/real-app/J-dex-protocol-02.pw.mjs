// World: restart
import { existsSync, readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, getAddress, http, parseAbi, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainRecordPath, GATE_URL } from '../../../../tooling/scripts/local-test-chain.mjs';
import { CHAIN_ID, TOKEN_A, TOKEN_B, UNBUILT, acceptRepresentation, connectWallet, dexRun, walletSection } from './dex.mjs';
import { withMiningPaused } from './chain-node.mjs';
import { restartService } from './stack.mjs';
import { chainBalance } from './venue.mjs';

// J-dex-protocol-02, in the running app (docs/roadmap/journeys.json): swap one token for another. One test per step,
// titled "J-dex-protocol-02 #<n>", run in order with one TEST wallet on Base Sepolia holding TEST token A and no
// allowance. The swap is signed by the person's own wallet; nothing posts to the ledger and no fee is invented (a blank
// fee schedule refuses). A missing node or router shows rail.crypto.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - /dex's Swap tab is today's route-quote desk (symbol, side, quantity); the token-in/token-out form with Simple and
//   Manual modes, prices, slippage, route options, fee levels and the swap status (D-swap-01 to -06, -10, -11) is not
//   built, so every step stops at the first of those controls;
// - the stack has no TEST chain, router or pool, so the quote, approve and sign steps (#3 to #9) have nothing to call;
// - #11 (paying the network fee in a TEST stable token, RC-dex-protocol-02) runs on the stack's TEST fee relay: the seed's
//   FeeTokenRelay with the fail-closed oracle, and local-test-chain.mjs's TEST relayer, which sends and pays the gas.
const J = 'J-dex-protocol-02';
const dex = dexRun(J);

test.describe.configure({ mode: 'default' });

const swap = (page) => page.getByRole('form', { name: 'Swap' });
const tokenIn = (page) => swap(page).getByRole('combobox', { name: 'You pay' });
const tokenOut = (page) => swap(page).getByRole('combobox', { name: 'You receive' });
const amountIn = (page) => swap(page).getByRole('textbox', { name: /^Amount you pay/ });
const swapButton = (page) => swap(page).getByRole('button', { name: 'Swap', exact: true });

/** The stack's TEST chain, read through the gate the way svc-protocol reads it, never through the service. */
const chain = createPublicClient({ transport: http(GATE_URL) });
const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
]);
const factoryAbi = parseAbi(['function allPoolsLength() view returns (uint256)', 'function allPools(uint256) view returns (address)']);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
/** The fee relay and its oracle (RC-dex-protocol-02), read straight from the chain. */
const relayAbi = parseAbi([
  'function oracle() view returns (address)',
  'function markupBps() view returns (uint16)',
  'function allowlisted(address token) view returns (bool)',
  'event FeeCharged(address indexed owner, address indexed relayer, address indexed feeToken, uint256 gasWei, uint256 markWad, uint16 markupBps, uint256 charge)',
]);
const oracleAbi = parseAbi([
  'function getMark(address asset) view returns (uint256 priceWad, uint64 updatedAt)',
  'error Stale()',
  'error MissingReport()',
  'error Disagreement()',
]);
const erc20Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);
/** The stack's TEST stable tokens (services/svc-protocol/scripts/seed-test-chain.ts): TEST USD pays fees, TEST EUR's oracle is stale. */
const TEST_USD = { address: '0x000000000000000000000000000000000000d011', decimals: 6 };
const TEST_EUR = '0x00000000000000000000000000000000000e0e00';
/** Native gas `gasWei` in TEST USD base units at the oracle mark (wei per whole token) plus `markupBps`, rounded up. */
function chargeFor(gasWei, markWad, markupBps) {
  const numerator = gasWei * 10n ** BigInt(TEST_USD.decimals) * (10_000n + BigInt(markupBps));
  const denominator = markWad * 10_000n;
  return (numerator + denominator - 1n) / denominator;
}
/** Basis points as the fee line writes a percentage: 500 is "5", 125 is "1.25". */
const percent = (bps) =>
  `${Math.trunc(bps / 100)}${
    bps % 100
      ? `.${String(bps % 100)
          .padStart(2, '0')
          .replace(/0+$/, '')}`
      : ''
  }`;

/** Every factory pool trading `a` against `b`, from the chain; refuses by name on a stack with no TEST chain. */
async function poolsOf(a, b) {
  expect(existsSync(chainRecordPath()), 'this stack runs a TEST chain (LOCAL_STACK_ANVIL_BIN)').toBe(true);
  const { factory } = JSON.parse(readFileSync(chainRecordPath(), 'utf8'));
  const count = await chain.readContract({ address: factory, abi: factoryAbi, functionName: 'allPoolsLength' });
  const all = await Promise.all(
    Array.from({ length: Number(count) }, (_, i) =>
      chain.readContract({ address: factory, abi: factoryAbi, functionName: 'allPools', args: [BigInt(i)] }),
    ),
  );
  const pairs = await Promise.all(
    all.map((pool) =>
      Promise.all(['token0', 'token1'].map((functionName) => chain.readContract({ address: pool, abi: poolAbi, functionName }))),
    ),
  );
  return all.filter((_, i) => {
    const [t0, t1] = pairs[i];
    return (same(t0, a) && same(t1, b)) || (same(t0, b) && same(t1, a));
  });
}

/**
 * The chain's own best quote for `units` of `tokenIn` across `pools`: each pool contract's getAmountOut. A pool that
 * refuses to quote (an empty side reverts) is left out, as the form leaves out a refused quote.
 */
async function bestOut(pools, tokenIn, units) {
  const outs = await Promise.allSettled(
    pools.map((address) => chain.readContract({ address, abi: poolAbi, functionName: 'getAmountOut', args: [units, tokenIn] })),
  );
  return outs.reduce((best, out) => (out.status === 'fulfilled' && out.value > best ? out.value : best), 0n);
}

/** Base units written the way the swap form writes them: grouped whole part, at most `places` decimals cut, not rounded. */
function shown(units, decimals, places = 6) {
  const scale = 10n ** BigInt(decimals);
  const whole = (units / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (units % scale).toString().padStart(decimals, '0').slice(0, Math.min(places, decimals)).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Uncached client on the stack's TEST chain for reads right after an on-chain write (revoke, reset-token approve, feeHistory). */
const chainFresh = createPublicClient({ transport: http(GATE_URL), cacheTime: 0 });
const poolDetailAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function feeBps() view returns (uint16)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)',
]);
const erc20AllowanceAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const TEST_THIN = { address: '0x00000000000000000000000000000000000071a0', decimals: 18 };
const TEST_RESET = { address: '0x0000000000000000000000000000000000007e57', name: 'TEST Reset', decimals: 6 };
const USD_SCALE = 10n ** 18n;
const MIN_RESERVE_USD = 1_000n;
const STALE_SURPLUS_BPS = 100n;
const TEST_SLIPPAGE_CEILING_BPS = 300n;
const shortContract = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const toGwei = (wei) => shown(wei, 9, 9);
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Half-up USD formatting matching SwapForm (`formatUsd(usdText(price18))`). */
function formatUsd18(price18) {
  const whole = (price18 / USD_SCALE).toString();
  const fraction = (price18 % USD_SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  const lead = /^0*/.exec(fraction)[0].length;
  const places = whole === '0' && lead >= 2 ? lead + 6 : 2;
  const scale = 10n ** BigInt(places);
  const digits = BigInt(whole + fraction.padEnd(places + 1, '0').slice(0, places + 1));
  const rounded = (digits + 5n) / 10n;
  const shownWhole = (rounded / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let shownFraction = (rounded % scale).toString().padStart(places, '0');
  if (places > 2) shownFraction = shownFraction.replace(/0+$/, '');
  return `$${shownWhole}.${shownFraction}`;
}

/** A token's USD price from its deepest on-chain pool against TEST USD with at least MIN_RESERVE_USD on the USD side. */
async function poolUsdPrice(tokenAddress, tokenDecimals) {
  const pools = await poolsOf(tokenAddress, TEST_USD.address);
  let chosen = null;
  for (const pool of pools) {
    const [t0, [r0, r1]] = await Promise.all([
      chainFresh.readContract({ address: pool, abi: poolDetailAbi, functionName: 'token0' }),
      chainFresh.readContract({ address: pool, abi: poolDetailAbi, functionName: 'getReserves' }),
    ]);
    const tokenIs0 = same(t0, tokenAddress);
    const mine = tokenIs0 ? r0 : r1;
    const usd = tokenIs0 ? r1 : r0;
    const depth = (usd * USD_SCALE) / 10n ** BigInt(TEST_USD.decimals);
    if (mine === 0n || depth < MIN_RESERVE_USD * USD_SCALE) continue;
    const price = (usd * USD_SCALE * 10n ** BigInt(tokenDecimals)) / (mine * 10n ** BigInt(TEST_USD.decimals));
    if (!chosen || depth > chosen.depth) chosen = { price, depth };
  }
  expect(chosen, `${tokenAddress} has a TEST USD pool above the minimum reserve`).not.toBeNull();
  return formatUsd18(chosen.price);
}

function floorMean(values) {
  let sum = 0n;
  for (const value of values) sum += value;
  return sum / BigInt(values.length);
}

/** Opens /dex's Swap form with the run's wallet connected. */
async function openSwap(page) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await page.goto('/dex');
  await expect(swap(page)).toBeVisible(UNBUILT);
  return wallet;
}

/** Switches the form to Manual, accepting its one-time notice when this browser has not seen it yet. */
async function chooseManual(page) {
  await swap(page).getByRole('radio', { name: 'Manual' }).check(UNBUILT);
  const notice = page.getByRole('dialog', { name: 'Manual mode' });
  if (await notice.isVisible()) await notice.getByRole('button', { name: 'I understand' }).click();
}

/** Picks token A in, token B out and types `amount`. */
async function quoteAB(page, amount = '10') {
  await tokenIn(page).selectOption({ label: 'TEST Token A' });
  await tokenOut(page).selectOption({ label: 'TEST Token B' });
  await amountIn(page).fill(amount);
}

test(`${J} starts: a TEST wallet on Base Sepolia holding TEST token A and no allowance`, async ({ page }) => {
  dex.start();
  await openSwap(page);
  // A swap is a signing action, so a new wallet accepts the representation once (J-dex-protocol-01 #8). The swap's own
  // sheet that follows is cancelled: nothing is approved or sent, so the run starts with no allowance.
  await quoteAB(page, '1');
  await swapButton(page).click();
  await acceptRepresentation(page);
  await page.locator('[data-sheet="sequence"]').getByRole('button', { name: 'Cancel' }).click();
});

test(`${J} #1 opens the swap form as a new viewer: Simple mode, no advanced controls; Manual shows its notice once and is remembered; blocked storage still works`, async ({
  page,
  browser,
}) => {
  await openSwap(page);
  const mode = swap(page).getByRole('radiogroup', { name: 'Mode' });
  await expect(mode.getByRole('radio', { name: 'Simple' })).toBeChecked(UNBUILT);
  await expect(swap(page).getByRole('button', { name: 'Route options' })).toHaveCount(0);
  await expect(swap(page).getByRole('textbox', { name: /^Slippage/ })).toHaveCount(0);

  await mode.getByRole('radio', { name: 'Manual' }).check();
  await expect(page.getByRole('dialog', { name: 'Manual mode' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Manual mode' }).getByRole('button', { name: 'I understand' }).click();
  await page.reload();
  await expect(mode.getByRole('radio', { name: 'Manual' })).toBeChecked();
  await expect(page.getByRole('dialog', { name: 'Manual mode' })).toHaveCount(0);

  // With storage blocked the form still opens and works in Simple.
  const blocked = await browser.newContext();
  try {
    const away = await blocked.newPage();
    // Both stores blocked, as a browser that blocks site data does; the page is reached in the app, never reloaded.
    await away.addInitScript(() => {
      for (const store of ['localStorage', 'sessionStorage'])
        Object.defineProperty(window, store, {
          get() {
            throw new DOMException('blocked', 'SecurityError');
          },
        });
    });
    await connectWallet(away, dex, { tokens: [TOKEN_A, TOKEN_B] });
    await away.locator('header nav[data-testid="tb-nav"] a', { hasText: 'Swap' }).click();
    await expect(swap(away).getByRole('radio', { name: 'Simple' })).toBeChecked();
    // And it works: a quote is read and Swap is offered.
    await quoteAB(away);
    await expect(swap(away).getByTestId('minimum-received')).toHaveText(/^Minimum received [\d,.]+ TEST Token B$/);
    await expect(swapButton(away)).toBeEnabled();
  } finally {
    await blocked.close();
  }
});

test(`${J} #2 picks token A in and token B out: a USD price with its as-of time for each; a token with too little reserve shows no price and the reason`, async ({
  page,
  stepPicture,
}) => {
  await openSwap(page);
  const [usdA, usdB, thinPools] = await Promise.all([
    poolUsdPrice(TOKEN_A.address, TOKEN_A.decimals),
    poolUsdPrice(TOKEN_B.address, TOKEN_B.decimals),
    poolsOf(TOKEN_A.address, TEST_THIN.address),
  ]);
  expect(thinPools.length, 'TEST Thin has a seeded pool on the TEST chain').toBeGreaterThan(0);
  const [thinT0, [thinR0, thinR1]] = await Promise.all([
    chainFresh.readContract({ address: thinPools[0], abi: poolDetailAbi, functionName: 'token0' }),
    chainFresh.readContract({ address: thinPools[0], abi: poolDetailAbi, functionName: 'getReserves' }),
  ]);
  const thinSideA = same(thinT0, TOKEN_A.address) ? thinR0 : thinR1;
  expect(thinSideA, 'TEST Thin pool holds less than the $1,000 reserve floor').toBeLessThan(
    MIN_RESERVE_USD * 10n ** BigInt(TOKEN_A.decimals),
  );

  const asOfRe = (usd) => new RegExp(`^${escapeRe(usd)} · as of (?:[A-Z][a-z]{2} \\d{1,2} )?\\d{2}:\\d{2}:\\d{2}$`);
  await tokenIn(page).selectOption({ label: 'TEST Token A' }, UNBUILT);
  await tokenOut(page).selectOption({ label: 'TEST Token B' });
  await expect(swap(page).getByTestId('price-pay')).toHaveText(asOfRe(usdA));
  await expect(swap(page).getByTestId('price-receive')).toHaveText(asOfRe(usdB));
  // A thin token has no price, and says why rather than showing $0, while token A keeps its exact pool USD price.
  await tokenOut(page).selectOption({ label: 'TEST Thin' });
  await expect(swap(page).getByTestId('price-pay')).toHaveText(asOfRe(usdA));
  await expect(swap(page).getByTestId('price-receive')).toHaveText('No price: too little reserve to price this token.');
  await stepPicture();
});

test(`${J} #3 types an amount: a quote with a countdown; when it expires "Quote expired" and Swap is off until refreshed`, async ({
  page,
}) => {
  await openSwap(page);
  await tokenIn(page).selectOption({ label: 'TEST Token A' }, UNBUILT);
  await quoteAB(page);
  await expect(swap(page).getByTestId('quote-countdown')).toHaveText(/^Refreshes in \d+ s$/);
  await expect(swap(page).getByRole('status')).toHaveText('Quote expired', { timeout: 120_000 });
  await expect(swapButton(page)).toBeDisabled();
  await swap(page).getByRole('button', { name: 'Refresh quote' }).click();
  await expect(swapButton(page)).toBeEnabled();
});

test(`${J} #4 opens the route options and excludes the better pool: legs listed best first with why the other lost; a stale pool reads "unavailable: stale"`, async ({
  page,
  stepPicture,
}) => {
  await openSwap(page);
  await chooseManual(page);
  await tokenIn(page).selectOption({ label: 'TEST Token A' }, UNBUILT);
  await quoteAB(page);

  // Read every factory A/B pool directly from the chain: its reserves, held token balances, fee and exact getAmountOut.
  const tenA = 10n * 10n ** BigInt(TOKEN_A.decimals);
  const pools = await poolsOf(TOKEN_A.address, TOKEN_B.address);
  const isStale = (held, reserve) => held < reserve || (held - reserve) * 10_000n > reserve * STALE_SURPLUS_BPS;
  const legs = await Promise.all(
    pools.map(async (pool) => {
      const [t0, t1, [r0, r1], feeBps] = await Promise.all([
        chainFresh.readContract({ address: pool, abi: poolDetailAbi, functionName: 'token0' }),
        chainFresh.readContract({ address: pool, abi: poolDetailAbi, functionName: 'token1' }),
        chainFresh.readContract({ address: pool, abi: poolDetailAbi, functionName: 'getReserves' }),
        chainFresh.readContract({ address: pool, abi: poolDetailAbi, functionName: 'feeBps' }),
      ]);
      const [held0, held1] = await Promise.all([
        chainFresh.readContract({ address: t0, abi: erc20AllowanceAbi, functionName: 'balanceOf', args: [pool] }),
        chainFresh.readContract({ address: t1, abi: erc20AllowanceAbi, functionName: 'balanceOf', args: [pool] }),
      ]);
      const stale = isStale(held0, r0) || isStale(held1, r1);
      const out = stale
        ? null
        : await chainFresh.readContract({ address: pool, abi: poolDetailAbi, functionName: 'getAmountOut', args: [tenA, TOKEN_A.address] });
      return { pool, feeBps: Number(feeBps), stale, out };
    }),
  );
  const usable = legs.filter((l) => !l.stale).sort((a, b) => (a.out > b.out ? -1 : a.out < b.out ? 1 : 0));
  const staleLegs = legs.filter((l) => l.stale);
  expect(usable, 'two usable A/B pools on the TEST chain').toHaveLength(2);
  expect(staleLegs, 'one stale A/B pool on the TEST chain').toHaveLength(1);
  const [best, second] = usable;
  const [stale] = staleLegs;
  expect(best.out).toBeGreaterThan(second.out);
  const shortfall = best.out - second.out;

  await swap(page).getByRole('button', { name: 'Route options' }).click();
  const routes = page.getByRole('region', { name: 'Routes' }).getByRole('table');
  const rows = routes.getByRole('row');
  await expect(rows).toHaveCount(1 + pools.length);
  // Row 1: best pool from the chain; row 2: losing pool with its exact shortfall; row 3: stale pool never dropped.
  await expect(rows.nth(1).getByRole('cell').nth(0)).toHaveText(shortContract(best.pool));
  await expect(rows.nth(1).getByRole('cell').nth(2)).toHaveText(`${shown(best.out, TOKEN_B.decimals)} TEST Token B`);
  await expect(rows.nth(1).getByRole('cell').nth(3)).toHaveText('Best');
  await expect(rows.nth(2).getByRole('cell').nth(0)).toHaveText(shortContract(second.pool));
  await expect(rows.nth(2).getByRole('cell').nth(2)).toHaveText(`${shown(second.out, TOKEN_B.decimals)} TEST Token B`);
  await expect(rows.nth(2).getByRole('cell').nth(3)).toHaveText(
    `Lost: ${shown(shortfall, TOKEN_B.decimals)} TEST Token B less than the best`,
  );
  await expect(rows.nth(3).getByRole('cell').nth(0)).toHaveText(shortContract(stale.pool));
  await expect(rows.nth(3).getByRole('cell').nth(2)).toHaveText('—');
  await expect(rows.nth(3).getByRole('cell').nth(3)).toHaveText(
    'unavailable: stale (its token balances differ from the reserves it prices from)',
  );
  await expect(swap(page).getByTestId('amount-out')).toHaveText(`${shown(best.out, TOKEN_B.decimals)} TEST Token B`);

  // Excluding the better pool moves Best and the swap quote to the second pool; the stale pool stays listed.
  await rows.nth(1).getByRole('checkbox', { name: 'Exclude' }).check();
  await expect(rows.nth(1).getByRole('cell').nth(3)).toHaveText('Excluded');
  await expect(rows.nth(2).getByRole('cell').nth(3)).toHaveText('Best');
  await expect(rows.nth(3).getByRole('cell').nth(3)).toContainText('unavailable: stale');
  await expect(swap(page).getByTestId('amount-out')).toHaveText(`${shown(second.out, TOKEN_B.decimals)} TEST Token B`);
  await stepPicture();
});

test(`${J} #5 sets slippage to 1 percent, then above the ceiling: the derived minimum shown; above the ceiling refused by name; a thin pool warns of price impact`, async ({
  page,
}) => {
  await openSwap(page);
  await chooseManual(page);
  await quoteAB(page);
  const slippage = swap(page).getByRole('textbox', { name: /^Slippage/ });
  await slippage.fill('1');
  // The derived minimum is the quote less 1%: read the chain's own best quote for 10 TEST Token A and take 99% of it.
  const tenA = 10n * 10n ** BigInt(TOKEN_A.decimals);
  const out = await bestOut(await poolsOf(TOKEN_A.address, TOKEN_B.address), TOKEN_A.address, tenA);
  expect(out).toBeGreaterThan(0n);
  await expect(swap(page).getByTestId('amount-out')).toHaveText(`${shown(out, TOKEN_B.decimals)} TEST Token B`);
  await expect(swap(page).getByTestId('minimum-received')).toHaveText(
    `Minimum received ${shown((out * 9_900n) / 10_000n, TOKEN_B.decimals)} TEST Token B`,
  );
  await slippage.fill('60');
  await expect(swap(page).getByRole('alert')).toContainText(/above the slippage ceiling of [\d.]+ ?%/);
  await tokenOut(page).selectOption({ label: 'TEST Thin' });
  await expect(swap(page).getByRole('note')).toContainText('Price impact');
});

test(`${J} #6 presses Swap with no allowance: one approve step for the exact amount (or a reset pair where needed), then the swap`, async ({
  page,
  browser,
  stepPicture,
}) => {
  const wallet = await openSwap(page);
  const owner = privateKeyToAccount(dex.key()).address;
  const tenA = 10n * 10n ** BigInt(TOKEN_A.decimals);
  const abPools = await poolsOf(TOKEN_A.address, TOKEN_B.address);
  for (const pool of abPools) {
    expect(
      await chainFresh.readContract({ address: TOKEN_A.address, abi: erc20AllowanceAbi, functionName: 'allowance', args: [owner, pool] }),
    ).toBe(0n);
  }
  const expectedOutA = await bestOut(abPools, TOKEN_A.address, tenA);
  const expectedMinA = (expectedOutA * (10_000n - TEST_SLIPPAGE_CEILING_BPS)) / 10_000n;

  await tokenIn(page).selectOption({ label: 'TEST Token A' }, UNBUILT);
  await quoteAB(page, '10');
  await swapButton(page).click();
  const steps = page.getByRole('list', { name: 'Swap steps' });
  // Exactly two steps: one approve for the exact amount (TEST Token A needs no reset pair), then the swap of that amount.
  await expect(steps.getByRole('listitem')).toHaveCount(2);
  await expect(steps.getByRole('listitem').first()).toHaveText('Approve exactly 10 TEST Token A');
  await expect(steps.getByRole('listitem').last()).toHaveText(
    `Swap 10 TEST Token A for at least ${shown(expectedMinA, TOKEN_B.decimals)} TEST Token B`,
  );
  // Nothing is signed or sent before the person continues in the wallet.
  expect(wallet.requests).toHaveLength(0);
  expect(wallet.sends).toHaveLength(0);
  await stepPicture(page);

  // Reset-pair branch: a second TEST wallet holding TEST Reset (which reverts on a non-zero to non-zero approve) with an
  // existing 1 TEST Reset allowance to the pool presses Swap for 10 TEST Reset and sees [Reset to 0, Approve 10, Swap].
  const record = JSON.parse(readFileSync(chainRecordPath(), 'utf8'));
  expect(record.resetToken && record.resetPool, 'the TEST chain seeded TEST Reset and its pool').toBeTruthy();
  const resetDex = dexRun(`${J}-reset`);
  resetDex.start({}, { funding: 'reset' });
  const resetAccount = privateKeyToAccount(resetDex.key());
  const localChain = defineChain({
    id: CHAIN_ID,
    name: 'LOCAL TEST',
    nativeCurrency: { name: 'TEST ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [GATE_URL] } },
  });
  const resetClient = createWalletClient({ account: resetAccount, chain: localChain, transport: http(GATE_URL) });
  const oneReset = 1n * 10n ** BigInt(TEST_RESET.decimals);
  const tenReset = 10n * 10n ** BigInt(TEST_RESET.decimals);
  const approveHash = await resetClient.writeContract({
    address: TEST_RESET.address,
    abi: erc20AllowanceAbi,
    functionName: 'approve',
    args: [record.resetPool, oneReset],
  });
  const approveReceipt = await chainFresh.waitForTransactionReceipt({ hash: approveHash });
  expect(approveReceipt.status).toBe('success');
  expect(
    await chainFresh.readContract({
      address: TEST_RESET.address,
      abi: erc20AllowanceAbi,
      functionName: 'allowance',
      args: [resetAccount.address, record.resetPool],
    }),
  ).toBe(oneReset);
  await expect(
    chainFresh.simulateContract({
      address: TEST_RESET.address,
      abi: erc20AllowanceAbi,
      functionName: 'approve',
      args: [record.resetPool, tenReset],
      account: resetAccount.address,
    }),
  ).rejects.toThrow(/ResetRequired|revert/i);
  const resetOut = await chainFresh.readContract({
    address: record.resetPool,
    abi: poolDetailAbi,
    functionName: 'getAmountOut',
    args: [tenReset, TEST_RESET.address],
  });
  const resetMin = (resetOut * (10_000n - TEST_SLIPPAGE_CEILING_BPS)) / 10_000n;

  const resetCtx = await browser.newContext();
  try {
    const resetPage = await resetCtx.newPage();
    const resetWallet = await connectWallet(resetPage, resetDex);
    await resetPage.goto('/dex');
    await expect(swap(resetPage)).toBeVisible(UNBUILT);
    await tokenIn(resetPage).selectOption({ label: TEST_RESET.name });
    await tokenOut(resetPage).selectOption({ label: 'TEST Token B' });
    await amountIn(resetPage).fill('10');
    await swapButton(resetPage).click();
    await acceptRepresentation(resetPage);
    const resetSteps = resetPage.getByRole('list', { name: 'Swap steps', exact: true });
    await expect(resetSteps.getByRole('listitem')).toHaveCount(3);
    await expect(resetSteps.getByRole('listitem').nth(0)).toHaveText(
      `Reset the allowance for ${TEST_RESET.name} to 0 first (this token requires it)`,
    );
    await expect(resetSteps.getByRole('listitem').nth(1)).toHaveText(`Approve exactly 10 ${TEST_RESET.name}`);
    await expect(resetSteps.getByRole('listitem').nth(2)).toHaveText(
      `Swap 10 ${TEST_RESET.name} for at least ${shown(resetMin, TOKEN_B.decimals)} TEST Token B`,
    );
    expect(resetWallet.sends, 'nothing sent before continuing in the wallet').toHaveLength(0);
  } finally {
    await resetCtx.close();
  }
});

test(`${J} #7 chooses a network fee level and reads the fee line: three levels from the last blocks; a custom value over the cap refused; who pays named`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  const fees = swap(page).getByRole('radiogroup', { name: 'Network fee' });

  // Pause block mining while the page reads `amm.feeLevels` so the page and this test read the exact same last 20 blocks.
  const expected = await withMiningPaused(async () => {
    await page.goto('/dex');
    await expect(swap(page)).toBeVisible(UNBUILT);
    await expect(swap(page).getByTestId('fee-line')).toHaveText('You pay the network fee');
    const history = await chainFresh.getFeeHistory({ blockCount: 20, rewardPercentiles: [10, 50, 90] });
    const base = history.baseFeePerGas[history.baseFeePerGas.length - 1];
    const col = (i) => (history.reward ?? []).map((row) => row[i]).filter((v) => v !== undefined);
    const slow = floorMean(col(0));
    const normal = floorMean(col(1));
    const fast = floorMean(col(2));
    return {
      slow: { max: base * 2n + slow, priority: slow },
      normal: { max: base * 2n + normal, priority: normal },
      fast: { max: base * 2n + fast, priority: fast },
    };
  });

  await expect(fees.getByRole('radio')).toHaveCount(4, UNBUILT);
  for (const [label, level] of [
    ['Slow', expected.slow],
    ['Normal', expected.normal],
    ['Fast', expected.fast],
  ]) {
    await expect(fees.locator('label').filter({ hasText: new RegExp(`^${label}\\b`) })).toHaveText(
      `${label} at most ${toGwei(level.max)} gwei per gas, ${toGwei(level.priority)} gwei priority`,
    );
  }
  await expect(fees.locator('label').filter({ hasText: /^Custom\b/ })).toHaveText('Custom your own most per gas');
  await expect(swap(page)).toContainText(/Levels from the priority fees paid in the last 20 blocks, read at /);

  await quoteAB(page, '10');
  await fees.getByRole('radio', { name: /^Custom/ }).check();
  await swap(page)
    .getByRole('textbox', { name: /^Custom fee/ })
    .fill('100000');
  await expect(swap(page).getByRole('alert')).toHaveText('That fee is above the fee cap of 100 gwei per gas. Choose a lower one.');
  await expect(swapButton(page)).toBeDisabled();
  await expect(swap(page).getByTestId('fee-line')).toHaveText('You pay the network fee');
  await stepPicture();

  await fees.getByRole('radio', { name: /^Normal/ }).check();
  await expect(swap(page).getByRole('alert')).toHaveCount(0);
  await expect(swapButton(page)).toBeEnabled();

  // Sponsored gas branch: point svc-protocol at the seeded funded ScopedPaymaster on the TEST chain, verify on chain that
  // it holds a positive ETH float, and confirm the fee line switches to "Network fee sponsored"; then restore the default.
  const record = JSON.parse(readFileSync(chainRecordPath(), 'utf8'));
  expect(record.swapPaymaster, 'the TEST chain seeded a swap paymaster').toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(await chainFresh.getCode({ address: record.swapPaymaster })).not.toBe('0x');
  expect(await chainFresh.getBalance({ address: record.swapPaymaster })).toBeGreaterThan(0n);
  await restartService('protocol', { LOCAL_STACK_PROTOCOL_SWAP_PAYMASTER: 'on' });
  try {
    await page.reload();
    await expect(swap(page)).toBeVisible(UNBUILT);
    await expect(swap(page).getByTestId('fee-line')).toHaveText('Network fee sponsored');
  } finally {
    await restartService('protocol', { LOCAL_STACK_PROTOCOL_SWAP_PAYMASTER: null });
  }
});

test(`${J} #8 signs the swap in the wallet: submitted, confirming, filled; the card's input, output and gas match the Swap event`, async ({
  page,
}) => {
  const wallet = await openSwap(page);
  await tokenIn(page).selectOption({ label: 'TEST Token A' }, UNBUILT);
  await quoteAB(page, '10');
  await swapButton(page).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  const card = page.getByRole('region', { name: 'Swap status' });
  for (const state of ['Submitted', 'Confirming', 'Filled']) await expect(card.getByRole('status')).toHaveText(state, { timeout: 60_000 });
  for (const term of ['You paid', 'You received', 'Network fee'])
    await expect(card.getByRole('term').filter({ hasText: term })).toBeVisible();
  const link = card.getByRole('link', { name: 'Swap event' });
  await expect(link).toBeVisible();
  // The card's three figures are the Swap event's: read the receipt from the chain and decode the pool's own event.
  const hash = /\/chain\/tx\/(0x[0-9a-f]{64})$/.exec((await link.getAttribute('href')) ?? '')?.[1];
  expect(hash, 'the Swap event link names the transaction').toBeTruthy();
  const receipt = await chain.getTransactionReceipt({ hash });
  const events = receipt.logs.flatMap((log) => {
    try {
      return [{ pool: log.address, ...decodeEventLog({ abi: poolAbi, eventName: 'Swap', data: log.data, topics: log.topics }) }];
    } catch {
      return [];
    }
  });
  expect(events, 'exactly one Swap event in the transaction').toHaveLength(1);
  const [event] = events;
  // The swap went through a factory A/B pool and paid the person's own wallet.
  expect((await poolsOf(TOKEN_A.address, TOKEN_B.address)).some((pool) => same(pool, event.pool))).toBe(true);
  expect(same(event.args.to, privateKeyToAccount(dex.key()).address)).toBe(true);
  const tokenAIs0 = same(await chain.readContract({ address: event.pool, abi: poolAbi, functionName: 'token0' }), TOKEN_A.address);
  const paidIn = tokenAIs0 ? event.args.amount0In : event.args.amount1In;
  const gotOut = tokenAIs0 ? event.args.amount1Out : event.args.amount0Out;
  expect(paidIn).toBe(10n * 10n ** BigInt(TOKEN_A.decimals));
  const fact = (term) => card.getByRole('term').filter({ hasText: term }).locator('xpath=following-sibling::dd[1]');
  await expect(fact('You paid')).toHaveText(`${shown(paidIn, TOKEN_A.decimals, TOKEN_A.decimals)} TEST Token A`);
  await expect(fact('You received')).toHaveText(`${shown(gotOut, TOKEN_B.decimals)} TEST Token B`);
  await expect(fact('Network fee')).toHaveText(`${shown(receipt.gasUsed * receipt.effectiveGasPrice, 18, 9)} ETH`);
  // The chain's own record of the wallet agrees with the event: across the swap's block, token A fell by exactly what the
  // card says was paid and token B rose by exactly what it says was received.
  const owner = privateKeyToAccount(dex.key()).address;
  const [before, after] = [receipt.blockNumber - 1n, receipt.blockNumber];
  expect((await chainBalance(TOKEN_A.address, owner, before)) - (await chainBalance(TOKEN_A.address, owner, after))).toBe(paidIn);
  expect((await chainBalance(TOKEN_B.address, owner, after)) - (await chainBalance(TOKEN_B.address, owner, before))).toBe(gotOut);
  // The swap was sent by the wallet itself (the TEST wallet keeps sent transactions in `sends`, signatures in `requests`).
  expect(wallet.sends.length).toBeGreaterThan(0);
});

test(`${J} #9 retries after the price moved: failed with the reason in a sentence, no automatic retry, a new quote needed`, async ({
  page,
  browser,
}) => {
  const wallet = await openSwap(page);
  await chooseManual(page);
  await quoteAB(page, '10');
  await swap(page)
    .getByRole('textbox', { name: /^Slippage/ })
    .fill('0.1');
  await swapButton(page).click();

  // Before this swap is signed, another TEST wallet (funded on the TEST chain like this run's) swaps a large amount in the
  // same pool and moves the price. It is new too, so it accepts the representation first.
  const other = await browser.newContext();
  try {
    const mover = await other.newPage();
    const moverDex = dexRun(`${J}-mover`);
    moverDex.start();
    await connectWallet(mover, moverDex, { tokens: [TOKEN_A, TOKEN_B] });
    await mover.goto('/dex');
    await quoteAB(mover, '1000');
    await swapButton(mover).click();
    await acceptRepresentation(mover);
    await mover.getByRole('button', { name: 'Continue in wallet' }).click();
    await expect(mover.getByRole('region', { name: 'Swap status' }).getByRole('status')).toHaveText('Filled', { timeout: 60_000 });
  } finally {
    await other.close();
  }

  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  const card = page.getByRole('region', { name: 'Swap status' });
  await expect(card.getByRole('status')).toHaveText('Failed', { timeout: 60_000 });
  await expect(card).toContainText('The price moved past your minimum, so nothing was swapped.');
  await expect(card.getByRole('button', { name: 'Get a new quote' })).toBeVisible();
  await expect(card.getByRole('button', { name: /retry/i })).toHaveCount(0);
  // No automatic retry: after the failure nothing more is signed or sent, however long the page waits.
  const asked = { requests: wallet.requests.length, sends: wallet.sends.length };
  await page.waitForTimeout(5_000);
  expect({ requests: wallet.requests.length, sends: wallet.sends.length }).toEqual(asked);
  // A new quote is needed: the failed one cannot be swapped again; Get a new quote reads one and offers Swap.
  await expect(swapButton(page)).toBeDisabled();
  await expect(swap(page)).toContainText('That swap failed on this quote. Get a new quote to swap again.');
  await card.getByRole('button', { name: 'Get a new quote' }).click();
  await expect(swap(page).getByTestId('minimum-received')).toBeVisible();
  await expect(swapButton(page)).toBeEnabled();
  expect({ requests: wallet.requests.length, sends: wallet.sends.length }).toEqual(asked);
});

test(`${J} #10 opens the approvals list and revokes the allowance: spender and amount listed; revoke sets it to zero and the row goes`, async ({
  page,
  stepPicture,
}) => {
  const owner = privateKeyToAccount(dex.key()).address;
  const abPools = await poolsOf(TOKEN_A.address, TOKEN_B.address);
  const allowances = await Promise.all(
    abPools.map(async (pool) => ({
      pool,
      value: await chainFresh.readContract({
        address: TOKEN_A.address,
        abi: erc20AllowanceAbi,
        functionName: 'allowance',
        args: [owner, pool],
      }),
    })),
  );
  const live = allowances.filter((entry) => entry.value > 0n);
  expect(live, 'one live TEST Token A allowance left from #9').toHaveLength(1);
  const [{ pool: spender, value: beforeAllowance }] = live;
  expect(beforeAllowance).toBe(10n * 10n ** BigInt(TOKEN_A.decimals));

  await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await walletSection(page, 'Approvals');
  const approvals = page.getByRole('region', { name: 'Approvals' }).getByRole('table');
  const row = approvals.getByRole('row').filter({ hasText: 'TEST Token A' });
  await expect(row).toHaveCount(1, UNBUILT);
  await expect(row.getByRole('cell').nth(0)).toContainText('TEST Token A');
  await expect(row.getByRole('cell').nth(0)).toContainText(shortContract(getAddress(TOKEN_A.address)));
  await expect(row.getByRole('cell').nth(1)).toHaveText(`Pool TESTA/TESTB · ${shortContract(getAddress(spender))}`);
  await expect(row.getByRole('cell').nth(2)).toHaveText(`${shown(beforeAllowance, TOKEN_A.decimals, TOKEN_A.decimals)} TESTA`);
  await row.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(row).toHaveCount(0, { timeout: 60_000 });
  await expect(approvals).toContainText(
    'No live approvals: this wallet has not allowed anyone to move the tokens the network’s pools trade.',
  );
  expect(
    await chainFresh.readContract({
      address: TOKEN_A.address,
      abi: erc20AllowanceAbi,
      functionName: 'allowance',
      args: [owner, spender],
    }),
  ).toBe(0n);
  await stepPicture();
});

test(`${J} #11 swaps from a wallet holding only TEST USD and no native currency, paying the fee in TEST USD at the oracle rate plus the published markup; an off-list token or a stale oracle is refused and the fee is paid in native currency instead`, async ({
  page,
  browser,
}) => {
  // The relay, its oracle and its published markup, read from the chain the way svc-protocol reads it, never through the service.
  expect(existsSync(chainRecordPath()), 'this stack runs a TEST chain (LOCAL_STACK_ANVIL_BIN)').toBe(true);
  const record = JSON.parse(readFileSync(chainRecordPath(), 'utf8'));
  expect(record.feeRelay, 'the TEST chain was seeded with a fee relay').toMatch(/^0x[0-9a-fA-F]{40}$/);
  const relay = record.feeRelay;
  const oracle = await chain.readContract({ address: relay, abi: relayAbi, functionName: 'oracle' });
  const markupBps = Number(await chain.readContract({ address: relay, abi: relayAbi, functionName: 'markupBps' }));
  const balanceOf = (token, who) => chain.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });

  // A new wallet that holds only TEST USD: no TEST ETH, no TEST Token A or B.
  const stable = dexRun(`${J}-stable`);
  stable.start({}, { funding: 'stable' });
  const owner = privateKeyToAccount(stable.key()).address;
  expect(await chain.getBalance({ address: owner })).toBe(0n);
  const usdBefore = await balanceOf(TEST_USD.address, owner);
  expect(usdBefore).toBeGreaterThan(0n);
  for (const token of [TOKEN_A, TOKEN_B]) expect(await balanceOf(token.address, owner)).toBe(0n);

  const wallet = await connectWallet(page, stable);
  await page.goto('/dex');
  await expect(swap(page)).toBeVisible(UNBUILT);
  await tokenIn(page).selectOption({ label: 'TEST USD' });
  await tokenOut(page).selectOption({ label: 'TEST Token A' });
  await amountIn(page).fill('10');
  const pay = swap(page).getByRole('combobox', { name: 'Pay the network fee in' });
  await pay.selectOption({ label: 'TEST USD' }, UNBUILT);
  const feeLine = swap(page).getByTestId('fee-line');
  // The fee line names the token charge, the oracle rate and the markup the relay publishes on the chain.
  await expect(feeLine).toHaveText(new RegExp(`^Network fee [\\d.]+ TEST USD at the oracle rate plus a ${percent(markupBps)}% markup$`));
  await expect(swapButton(page)).toBeEnabled();
  // The charge on the line is the gas it covers at the oracle's own mark for TEST USD, plus the markup, rounded up.
  const [markNow] = await chain.readContract({ address: oracle, abi: oracleAbi, functionName: 'getMark', args: [TEST_USD.address] });
  const basis = swap(page).getByTestId('fee-token-basis');
  await expect(basis).toContainText(`Oracle rate: 1 TEST USD = ${shown(markNow, 18, 18)} ETH`);
  const lineCharge = /^Network fee ([\d.]+) TEST USD/.exec((await feeLine.textContent()) ?? '')?.[1];
  const gasCovered = /^Covers up to ([\d.]+) ETH of gas/.exec((await basis.textContent()) ?? '')?.[1];
  expect(lineCharge && gasCovered, 'the fee line names the charge and the gas it covers').toBeTruthy();
  expect(lineCharge).toBe(shown(chargeFor(parseUnits(gasCovered, 18), markNow, markupBps), TEST_USD.decimals, TEST_USD.decimals));

  // Swap: the new wallet accepts the representation once, then signs a permit and the order. It sends nothing itself.
  await swapButton(page).click();
  await acceptRepresentation(page);
  const typed = () => wallet.requests.filter((request) => request.method === 'eth_signTypedData_v4').length;
  const signedBefore = typed();
  for (const n of [1, 2]) {
    await page.locator('[data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet' }).click();
    await expect.poll(typed).toBe(signedBefore + n);
  }
  const card = page.getByRole('region', { name: 'Swap status' });
  await expect(card.getByRole('status')).toHaveText('Filled', { timeout: 60_000 });
  const fact = (term) => card.getByRole('term').filter({ hasText: term }).locator('xpath=following-sibling::dd[1]');
  await expect(fact('You paid')).toHaveText('10 TEST USD');
  await expect(fact('Network fee')).toHaveText(/^[\d.]+ TEST USD$/);
  const charged = /^([\d.]+) TEST USD$/.exec((await fact('Network fee').textContent()) ?? '')?.[1];

  // The chain: the relayer sent the swap and paid its gas in TEST ETH; the relay charged the person in TEST USD.
  const hash = /\/chain\/tx\/(0x[0-9a-f]{64})$/.exec(
    (await card.getByRole('link', { name: 'Swap event' }).getAttribute('href')) ?? '',
  )?.[1];
  expect(hash, 'the Swap event link names the transaction').toBeTruthy();
  const receipt = await chain.getTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
  expect(same(receipt.from, record.feeRelayer), 'sent by the fee relayer, not by the person').toBe(true);
  const fees = receipt.logs.flatMap((log) => {
    if (!same(log.address, relay)) return [];
    try {
      return [decodeEventLog({ abi: relayAbi, eventName: 'FeeCharged', data: log.data, topics: log.topics }).args];
    } catch {
      return [];
    }
  });
  expect(fees, 'exactly one fee charged in the transaction').toHaveLength(1);
  const [fee] = fees;
  expect(same(fee.owner, owner) && same(fee.feeToken, TEST_USD.address) && same(fee.relayer, record.feeRelayer)).toBe(true);
  // At the oracle rate: the relay used the oracle's own mark for TEST USD at that block, plus the markup it publishes.
  const [markWad] = await chain.readContract({
    address: oracle,
    abi: oracleAbi,
    functionName: 'getMark',
    args: [TEST_USD.address],
    blockNumber: receipt.blockNumber,
  });
  expect(fee.markWad).toBe(markWad);
  expect(Number(fee.markupBps)).toBe(markupBps);
  expect(fee.charge).toBe(chargeFor(fee.gasWei, markWad, markupBps));
  // The card's fee is what the chain charged.
  expect(shown(fee.charge, TEST_USD.decimals, TEST_USD.decimals)).toBe(charged);
  // The gas the relayer paid is within the gas the person was charged for.
  expect(receipt.gasUsed * receipt.effectiveGasPrice <= fee.gasWei).toBe(true);
  // The swap: one pool Swap event, 10 TEST USD in, TEST Token A out to the person's own wallet.
  const swaps = receipt.logs.flatMap((log) => {
    try {
      return [{ pool: log.address, ...decodeEventLog({ abi: poolAbi, eventName: 'Swap', data: log.data, topics: log.topics }).args }];
    } catch {
      return [];
    }
  });
  expect(swaps).toHaveLength(1);
  const [swapped] = swaps;
  expect(same(swapped.to, owner)).toBe(true);
  const usdIs0 = same(await chain.readContract({ address: swapped.pool, abi: poolAbi, functionName: 'token0' }), TEST_USD.address);
  expect(usdIs0 ? swapped.amount0In : swapped.amount1In).toBe(10n * 10n ** BigInt(TEST_USD.decimals));
  const gotA = usdIs0 ? swapped.amount1Out : swapped.amount0Out;
  // Balances: still no native currency; TEST USD down by exactly the swap and the charge; the TEST Token A received.
  expect(await chain.getBalance({ address: owner })).toBe(0n);
  expect(await balanceOf(TEST_USD.address, owner)).toBe(usdBefore - 10n * 10n ** BigInt(TEST_USD.decimals) - fee.charge);
  expect(await balanceOf(TOKEN_A.address, owner)).toBe(gotA);
  expect(wallet.sends, 'the person sent no transaction').toHaveLength(0);

  // An off-list token and a stale oracle: the run's wallet (TEST ETH, Token A and B) chooses each, is refused by name,
  // and the fee goes back to native currency; then it swaps and pays the fee in TEST ETH from its own wallet.
  expect(await chain.readContract({ address: relay, abi: relayAbi, functionName: 'allowlisted', args: [TOKEN_B.address] })).toBe(false);
  expect(await chain.readContract({ address: relay, abi: relayAbi, functionName: 'allowlisted', args: [TEST_EUR] })).toBe(true);
  await expect(chain.readContract({ address: oracle, abi: oracleAbi, functionName: 'getMark', args: [TEST_EUR] })).rejects.toThrow(/Stale/);
  const other = await browser.newContext();
  try {
    const native = await other.newPage();
    const nativeWallet = await connectWallet(native, dex, { tokens: [TOKEN_A, TOKEN_B] });
    const person = privateKeyToAccount(dex.key()).address;
    await native.goto('/dex');
    await quoteAB(native, '1');
    const payNative = swap(native).getByRole('combobox', { name: 'Pay the network fee in' });
    const nativeChosen = async () => {
      await expect(payNative).toHaveValue('native');
      await expect(payNative.locator('option:checked')).toHaveText('ETH (the network’s own currency)');
      await expect(swap(native).getByTestId('fee-line')).toHaveText('You pay the network fee');
    };
    await payNative.selectOption({ label: 'TEST Token B' });
    await expect(swap(native).getByRole('alert')).toHaveText(
      'TEST Token B cannot pay the network fee: it is not on the list of tokens that can. You pay in the network’s own currency (ETH) instead.',
    );
    await nativeChosen();
    await payNative.selectOption({ label: 'TEST EUR' });
    await expect(swap(native).getByRole('alert')).toHaveText(
      'TEST EUR cannot pay the network fee: its oracle price is stale. You pay in the network’s own currency (ETH) instead.',
    );
    await nativeChosen();
    const ethBefore = await chain.getBalance({ address: person });
    await swapButton(native).click();
    const representation = native.locator('[data-panel="representation"]');
    await expect(representation.or(native.getByRole('button', { name: 'Continue in wallet' })).first()).toBeVisible();
    if (await representation.isVisible()) await acceptRepresentation(native);
    await native.getByRole('button', { name: 'Continue in wallet' }).click();
    const nativeCard = native.getByRole('region', { name: 'Swap status' });
    await expect(nativeCard.getByRole('status')).toHaveText('Filled', { timeout: 60_000 });
    const nativeHash = /\/chain\/tx\/(0x[0-9a-f]{64})$/.exec(
      (await nativeCard.getByRole('link', { name: 'Swap event' }).getAttribute('href')) ?? '',
    )?.[1];
    const nativeReceipt = await chain.getTransactionReceipt({ hash: nativeHash });
    // Sent by the person's own wallet, and the fee on the card is the gas it paid in TEST ETH.
    expect(same(nativeReceipt.from, person)).toBe(true);
    expect(nativeWallet.sends.length).toBeGreaterThan(0);
    expect(nativeReceipt.logs.some((log) => same(log.address, relay))).toBe(false);
    const gasPaid = nativeReceipt.gasUsed * nativeReceipt.effectiveGasPrice;
    await expect(nativeCard.getByRole('term').filter({ hasText: 'Network fee' }).locator('xpath=following-sibling::dd[1]')).toHaveText(
      `${shown(gasPaid, 18, 9)} ETH`,
    );
    expect(await chain.getBalance({ address: person })).toBeLessThan(ethBefore);
  } finally {
    await other.close();
  }
});
