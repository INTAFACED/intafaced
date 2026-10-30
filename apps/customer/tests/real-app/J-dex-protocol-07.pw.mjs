import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { createPublicClient, getAddress, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainRecordPath, GATE_URL, TEST_CHAIN_ID } from '../../../../tooling/scripts/local-test-chain.mjs';
import { signIn, signUp } from './desk.mjs';
import { acceptRepresentation, CHAIN_ID, fundOnTestChain, testChain, TOKEN_A, TOKEN_B } from './dex.mjs';
import { api, fromUnits, ROOT, toUnits } from './stack.mjs';
import { installTestWallet, testWalletKey, TEST_WALLET } from './test-wallet.mjs';
import { tableIn } from './tables.mjs';

// J-dex-protocol-07, in the running app (docs/roadmap/journeys.json): find a token, read its page and judge how much to
// trust it. One test per step, titled "J-dex-protocol-07 #<n>". Signed out unless a step says otherwise; a quick trade is a
// wallet-signed TEST swap (J-dex-protocol-02) and nothing posts to the ledger. Step 10 (a real-world asset blocked by
// region) waits for launch prep (owner decision 2026-10-27) and has no test.
// Steps 1-6 run on the stack's LOCAL TEST chain (tooling/scripts/local-test-chain.mjs). Before them the run adds TEST
// fixtures there (services/svc-protocol/scripts/seed-token-pages.ts): a TEST token copying TEST Token A's name and symbol
// with no trade, a TEST token with no symbol, and TEST swaps by two TEST traders in the TEST A/B pool. Every figure a step
// shows is compared with what the running service lists and with the chain itself, at the block the page read.
// The stack prices tokens in TEST Token B, a labelled LOCAL TEST value (tooling/profiles/test-owner-values/protocol.json);
// a blank quote token refuses protocol.tokens_quote_unset (services/svc-protocol/src/amm/tokens.router.test.ts).
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #3's market brief: no market data source exists on the platform, so the room names that blocker (market_data).
// - #4's dollar price: no dollar price source exists on the stack, so the page names that blocker (price_feed).
const J = 'J-dex-protocol-07';
const UNBUILT = { timeout: 5_000 };
const TOKEN = '0x4200000000000000000000000000000000000006';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const ZERO = '0x0000000000000000000000000000000000000000';

test.describe.configure({ mode: 'default' });

const erc20 = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function feeBps() view returns (uint16)',
  'function getReserves() view returns (uint112, uint112, uint32)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
]);
const factoryAbi = parseAbi(['function allPoolsLength() view returns (uint256)', 'function allPools(uint256) view returns (address)']);

/** The stack's TEST chain, read the way svc-protocol reads it: through the gate. */
const chain = createPublicClient({ transport: http(GATE_URL) });
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** Base units with `decimals` places, written in full the way the token pages write them. */
function exact(amount, decimals) {
  const digits = amount.toString().padStart(decimals + 1, '0');
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${digits.slice(0, digits.length - decimals)}${fraction ? `.${fraction}` : ''}`;
}
const percent = (bps) =>
  `${bps > 0 ? '+' : bps < 0 ? '-' : ''}${Math.trunc(Math.abs(bps) / 100)}.${String(Math.abs(bps) % 100).padStart(2, '0')}%`;
const isoTime = (seconds) => new Date(Number(seconds) * 1000).toISOString();
const sum = (values) => values.reduce((a, b) => a + b, 0n);
const units = async (locator) => (await locator.evaluateAll((items) => items.map((i) => i.getAttribute('data-units')))).map(BigInt);

/** The running service's own answer, through Edge as the page asks it (signed out). */
async function service(request, procedure, input) {
  const query = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await request.get(`/api/protocol/trpc/${procedure}${query}`);
  expect(res.ok(), `protocol.${procedure}: ${res.status()} ${(await res.text()).slice(0, 300)}`).toBe(true);
  return (await res.json()).result.data;
}

/** The fixtures the run added, read once per worker. */
let fixtures = null;
test.beforeAll(() => {
  const status = testChain();
  expect(status.chain, 'this step reads the stack TEST chain; with no anvil the stack runs none').toBe('running');
  const tsx = path.join(ROOT, 'services/svc-protocol/node_modules/.bin/tsx');
  const run = spawnSync(tsx, ['scripts/seed-token-pages.ts', chainRecordPath()], {
    cwd: path.join(ROOT, 'services/svc-protocol'),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PROTOCOL_RPC_URL: GATE_URL, PROTOCOL_CHAIN_ID: String(TEST_CHAIN_ID) },
    encoding: 'utf8',
    timeout: 120_000,
  });
  expect(run.status, `seed-token-pages.ts: ${run.stdout}${run.stderr}`).toBe(0);
  fixtures = JSON.parse(run.stdout.trim().split('\n').at(-1));
});

/** Every factory pool that trades `token`, with its tokens and fee, from the chain. */
async function poolsOf(token) {
  const { factory } = JSON.parse(readFileSync(chainRecordPath(), 'utf8'));
  const count = await chain.readContract({ address: factory, abi: factoryAbi, functionName: 'allPoolsLength' });
  const pools = [];
  for (let i = 0n; i < count; i++) {
    const pool = await chain.readContract({ address: factory, abi: factoryAbi, functionName: 'allPools', args: [i] });
    const [token0, token1, feeBps] = await Promise.all(
      ['token0', 'token1', 'feeBps'].map((functionName) => chain.readContract({ address: pool, abi: poolAbi, functionName })),
    );
    if (same(token0, token) || same(token1, token)) pools.push({ pool, token0, token1, feeBps: Number(feeBps) });
  }
  return pools;
}

/** A pool's reserves at `block`, with `token`'s side first. */
async function reserves(pool, token, block) {
  const [r0, r1] = await chain.readContract({ address: pool.pool, abi: poolAbi, functionName: 'getReserves', blockNumber: block });
  return same(pool.token0, token) ? [r0, r1] : [r1, r0];
}

const decimalsOf = (address, block) =>
  chain.readContract({ address, abi: erc20, functionName: 'decimals', blockNumber: block }).then(Number);
const symbolOf = (address, block) => chain.readContract({ address, abi: erc20, functionName: 'symbol', blockNumber: block });

/** `token`'s price in TEST Token B at `block` (1e18-scaled), through its deepest pool with B by its own reserve. */
async function priceInB(token, block) {
  if (same(token, TOKEN_B.address)) return 10n ** 18n;
  let best = null;
  for (const pool of await poolsOf(token)) {
    if (!same(pool.token0, TOKEN_B.address) && !same(pool.token1, TOKEN_B.address)) continue;
    const [mine, theirs] = await reserves(pool, token, block);
    if (!best || mine > best.mine) best = { mine, theirs };
  }
  expect(best, `${token} has a pool with TEST Token B (this check prices directly, not through a hop)`).not.toBeNull();
  const dec = await decimalsOf(token, block);
  return (best.theirs * 10n ** BigInt(18 + dec)) / (best.mine * 10n ** BigInt(TOKEN_B.decimals));
}

/** Every Swap in `pools` up to `block`, with its block time. */
async function swapsIn(pools, block) {
  const logs = await chain.getLogs({ address: pools.map((p) => p.pool), event: poolAbi[4], fromBlock: 0n, toBlock: block });
  const times = new Map();
  for (const log of logs)
    if (!times.has(log.blockNumber)) times.set(log.blockNumber, Number((await chain.getBlock({ blockNumber: log.blockNumber })).timestamp));
  return logs.map((log) => ({ ...log.args, pool: log.address, tx: log.transactionHash, time: times.get(log.blockNumber) }));
}

/** The block a token page read, from its as-of line. */
async function pageBlock(page) {
  const asOf = page.getByTestId('token-as-of');
  await expect(asOf).toHaveText(/^as of \d{2}:\d{2}, block \d+$/);
  return BigInt((await asOf.textContent()).match(/block (\d+)$/)[1]);
}

async function openTokens(page) {
  await page.goto('/dex');
  await page.getByRole('navigation').getByRole('link', { name: 'Tokens', exact: true }).click(UNBUILT);
  await expect(page.getByRole('heading', { name: 'Tokens', level: 1 })).toBeVisible();
}

const listed = (page) => tableIn(page, 'Tokens').locator('tr[data-token]');
const addressesIn = (rows) => rows.evaluateAll((items) => items.map((r) => r.getAttribute('data-token').toLowerCase()));

/**
 * Trending for `window` against the service's own list: every token with a growth figure exactly once and no other,
 * each growth the service's for that window, highest first, and at least two different growths so the order means something.
 */
async function expectTrending(page, window) {
  const answer = await service(page.request, 'tokens.list', { window });
  const ranked = answer.tokens.filter((t) => t.growthBps !== null);
  expect(new Set(ranked.map((t) => t.growthBps)).size, 'two different growths, so an order can be checked').toBeGreaterThanOrEqual(2);
  await expect(listed(page)).toHaveCount(ranked.length);
  const shown = await addressesIn(listed(page));
  expect(new Set(shown).size).toBe(shown.length);
  expect([...shown].sort()).toEqual(ranked.map((t) => t.token.address.toLowerCase()).sort());
  const growth = tableIn(page, 'Tokens').getByTestId('token-growth');
  await expect(growth).toHaveCount(ranked.length);
  const read = await growth.evaluateAll((items) =>
    items.map((g) => ({ window: g.getAttribute('data-window'), bps: Number(g.getAttribute('data-bps')), text: g.textContent })),
  );
  for (const [i, g] of read.entries()) {
    expect(g.window).toBe(window);
    expect(g.bps).toBe(ranked.find((t) => same(t.token.address, shown[i])).growthBps);
    expect(g.text).toBe(percent(g.bps));
  }
  expect(read.map((g) => g.bps)).toEqual([...read.map((g) => g.bps)].sort((a, b) => b - a));
}

test(`${J} #1 opens Tokens and the Trending tab: rows by growth for the window with the formula link; a saved filter survives reload; blocked storage still works`, async ({
  page,
  browser,
}) => {
  await openTokens(page);
  await page.getByRole('tab', { name: 'Trending' }).click();
  await expect(page.getByRole('tab', { name: 'Trending' })).toHaveAttribute('aria-selected', 'true');
  const link = page.getByRole('link', { name: 'How trending is worked out' });
  await expect(link).toHaveAttribute('href', '#how-trending');
  await link.click();
  await expect(page.locator('#how-trending').getByTestId('trending-formula')).toContainText(
    'Growth = (price now − price at the start of the window) ÷ price at the start of the window.',
  );
  await expect(page.getByRole('combobox', { name: 'Window' })).toHaveValue('1h');
  await expectTrending(page, '1h');
  await page.getByRole('combobox', { name: 'Window' }).selectOption('24h');
  await expect(page.getByRole('columnheader', { name: 'Growth (24 hours)' })).toBeVisible();
  await expectTrending(page, '24h');
  await page.reload();
  await page.getByRole('tab', { name: 'Trending' }).click();
  await expect(page.getByRole('combobox', { name: 'Window' })).toHaveValue('24h');
  await expectTrending(page, '24h');

  // A browser that keeps no site data: the rows still list with their growth and a window can still be chosen.
  const blocked = await browser.newContext();
  await blocked.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
  });
  try {
    const other = await blocked.newPage();
    await openTokens(other);
    await expect(other.getByRole('combobox', { name: 'Window' })).toHaveValue('1h');
    await expectTrending(other, '1h');
    await other.getByRole('combobox', { name: 'Window' }).selectOption('6h');
    await expectTrending(other, '6h');
    await expect(other.getByRole('main')).not.toContainText(/error/i);
  } finally {
    await blocked.close();
  }
});

test(`${J} #2 opens New listings and Top traded: Top traded by volume, New by listing time; an address search finds a token with no symbol`, async ({
  page,
}) => {
  await openTokens(page);
  const answer = await service(page.request, 'tokens.list', { window: '1h' });
  const byAddress = new Map(answer.tokens.map((t) => [t.token.address.toLowerCase(), t]));
  expect(byAddress.size).toBe(answer.tokens.length);
  const everyTokenOnce = async () => {
    await expect(listed(page)).toHaveCount(answer.tokens.length);
    const shown = await addressesIn(listed(page));
    expect([...shown].sort()).toEqual([...byAddress.keys()].sort());
    return shown;
  };

  await page.getByRole('tab', { name: 'Top traded' }).click();
  const top = await everyTokenOnce();
  const volumes = (await tableIn(page, 'Tokens').getByTestId('token-volume').allTextContents()).map(toUnits);
  for (const [i, address] of top.entries()) expect(volumes[i]).toBe(toUnits(byAddress.get(address).volume));
  expect(new Set(volumes).size, 'two different volumes, so an order can be checked').toBeGreaterThanOrEqual(2);
  for (let i = 1; i < volumes.length; i++) expect(volumes[i - 1] >= volumes[i], `volume ${i} is not above the one before`).toBe(true);

  await page.getByRole('tab', { name: 'New listings' }).click();
  const fresh = await everyTokenOnce();
  const times = await tableIn(page, 'Tokens')
    .getByTestId('token-listed-at')
    .evaluateAll((items) => items.map((t) => t.getAttribute('datetime')));
  for (const [i, address] of fresh.entries()) expect(times[i]).toBe(isoTime(byAddress.get(address).listedAt));
  expect(times).toEqual([...times].sort().reverse());
  // The fixtures were listed after the seeded pools, so New listings puts one of them above TEST Token A.
  expect(fresh.indexOf(fixtures.noSymbol.toLowerCase())).toBeLessThan(fresh.indexOf(TOKEN_A.address.toLowerCase()));

  expect(byAddress.get(fixtures.noSymbol.toLowerCase()).token.symbol).toBe('');
  await page.getByRole('searchbox', { name: 'Search tokens' }).fill(fixtures.noSymbol);
  await expect(listed(page)).toHaveCount(1);
  expect(await addressesIn(listed(page))).toEqual([fixtures.noSymbol.toLowerCase()]);
  await expect(listed(page)).toContainText('No symbol');
});

test(`${J} #3 opens the market brief and the stablecoin screener: a brief or "No brief today"; a blank stablecoin list shows its refusal; the leaderboard equals realised trades`, async ({
  page,
}) => {
  await openTokens(page);
  await page.getByRole('tab', { name: 'Market brief' }).click();
  // No service writes a brief: there is no market data source on the platform. The room shows the empty state and names
  // that blocker; the clause stays red by that name at the end of this step, after the other clauses have run.
  const brief = page.getByRole('tabpanel', { name: 'Market brief' });
  await expect(brief).toContainText('No brief today.');
  await expect(brief).toContainText('There is no market data source here.');
  await expect(brief.locator('[data-code]')).toHaveAttribute('data-code', 'market_data');
  await page.getByRole('tab', { name: 'Stablecoins' }).click();
  // The owner has listed no stablecoins on the stack, so the screener refuses with that reason and its one code.
  const stable = page.getByRole('tabpanel', { name: 'Stablecoins' });
  await expect(stable).toContainText('The stablecoin list is not set');
  await expect(stable.locator('[data-code]')).toHaveCount(1);
  await expect(stable.locator('[data-code]')).toHaveAttribute('data-code', 'indexer.stablecoins_unset');
  await expect(stable.getByRole('row')).toHaveCount(0);

  await page.getByRole('tab', { name: 'Leaderboard' }).click();
  const board = await service(page.request, 'tokens.leaderboard');
  const rows = tableIn(page, 'Leaderboard').locator('tr[data-wallet]');
  await expect(rows).toHaveCount(board.rows.length);
  const wallets = await rows.evaluateAll((items) => items.map((r) => r.getAttribute('data-wallet').toLowerCase()));
  expect([...wallets].sort()).toEqual(board.rows.map((r) => r.wallet.toLowerCase()).sort());
  for (const trader of fixtures.traders) expect(wallets).toContain(trader.toLowerCase());
  // Every row: its realised result is the sum of the realised results of the trades it lists, to the last place.
  let realisedSeen = 0;
  for (const wallet of wallets) {
    const row = rows.and(page.locator(`[data-wallet="${board.rows.find((r) => same(r.wallet, wallet)).wallet}"]`));
    const total = toUnits(await row.getByTestId('leaderboard-realised').textContent());
    await row.getByRole('link').click();
    const trades = page.getByRole('region', { name: `Trades by ${board.rows.find((r) => same(r.wallet, wallet)).wallet}` });
    const listedTrades = tableIn(trades, 'Trades')
      .getByRole('row')
      .filter({ has: page.getByRole('cell') });
    await expect(listedTrades).toHaveCount(board.rows.find((r) => same(r.wallet, wallet)).trades.length);
    const realised = (await trades.getByTestId('trade-realised').allTextContents()).map(toUnits);
    realisedSeen += realised.length;
    expect(sum(realised), `realised for ${wallet}`).toBe(total);
  }
  expect(realisedSeen, 'at least one sell, so a realised result exists').toBeGreaterThan(0);

  await page.getByRole('tab', { name: 'Market brief' }).click();
  expect(
    await brief.getByText(/^Brief for /).count(),
    'BLOCKED (market_data): no market data source exists on the platform, so no brief is written and the empty state reads nothing',
  ).toBeGreaterThan(0);
});

test(`${J} #4 opens a token page: price, liquidity in token amounts, fees and growth; market cap "Not available" with no supply source; a USD price with its as-of time`, async ({
  page,
}) => {
  await page.goto(`/dex/tokens/${TOKEN_A.address}`);
  const facts = page.getByRole('region', { name: 'Token facts' });
  await expect(facts).toBeVisible(UNBUILT);
  const block = await pageBlock(page);
  const asOf = Date.parse(await page.getByTestId('token-as-of').getAttribute('datetime'));
  expect(Math.abs(Date.now() - asOf)).toBeLessThan(10 * 60_000);

  // The price: TEST Token B per TEST Token A from the reserves of A's deepest pool with B, at the block the page read.
  const quoteSymbol = await symbolOf(TOKEN_B.address, block);
  const price = await priceInB(TOKEN_A.address, block);
  await expect(facts.getByTestId('token-price')).toHaveText(`${fromUnits(price)} ${quoteSymbol}`);

  // Liquidity in token amounts: each of A's pools, both sides, exactly as the chain holds them.
  const pools = await poolsOf(TOKEN_A.address);
  const symbolA = await symbolOf(TOKEN_A.address, block);
  const expected = [];
  for (const pool of pools) {
    const other = same(pool.token0, TOKEN_A.address) ? pool.token1 : pool.token0;
    const [mine, theirs] = await reserves(pool, TOKEN_A.address, block);
    expected.push(
      `${exact(mine, TOKEN_A.decimals)} ${symbolA} · ${exact(theirs, await decimalsOf(other, block))} ${await symbolOf(other, block)}`,
    );
  }
  const liquidity = (await facts.getByTestId('token-liquidity').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
  expect([...liquidity].sort()).toEqual([...expected].sort());

  // Fees: what every swap in A's pools paid, each input's fee valued in B at today's price, summed exactly.
  let fees = 0n;
  const prices = new Map();
  for (const swap of await swapsIn(pools, block)) {
    const pool = pools.find((p) => same(p.pool, swap.pool));
    const [token, amount] = swap.amount0In > 0n ? [pool.token0, swap.amount0In] : [pool.token1, swap.amount1In];
    if (!prices.has(token.toLowerCase())) prices.set(token.toLowerCase(), await priceInB(token, block));
    const dec = await decimalsOf(token, block);
    fees += (((amount * BigInt(pool.feeBps)) / 10_000n) * 10n ** BigInt(18 - dec) * prices.get(token.toLowerCase())) / 10n ** 18n;
  }
  expect(fees, 'swaps on record, so fees were paid').toBeGreaterThan(0n);
  await expect(facts.getByTestId('token-fees')).toHaveText(`${fromUnits(fees)} ${quoteSymbol}`);

  // Growth over 24 hours, as the service's 24-hour list states it for the same token.
  const day = await service(page.request, 'tokens.list', { window: '24h' });
  const growth = day.tokens.find((t) => same(t.token.address, TOKEN_A.address)).growthBps;
  expect(growth).not.toBeNull();
  await expect(facts.getByTestId('token-growth-24h')).toHaveText(percent(growth));

  // No supply source is set, so market cap names that blocker instead of a figure.
  await expect(facts.locator('[data-blocker="supply_source"]')).toHaveText(/^Not available: /);
  await expect(facts).not.toContainText(/Market cap\s*\$/);

  // The dollar price: no dollar price source exists on the stack, so this clause stays red by that name.
  await expect(facts.locator('[data-blocker="price_feed"]')).toHaveText(/^Not available: /);
  expect(
    await facts.getByText(/\$\d[\d,]*(\.\d+)?/).count(),
    'BLOCKED (price_feed): no dollar price source is set on the stack, so the page shows no USD price with its as-of time',
  ).toBeGreaterThan(0);
});

test(`${J} #5 reads the trust tier and the organic score: "unknown" with a note with no history, "Not scored" while inputs are blank, suspicious flags, and a lookalike name masked`, async ({
  page,
}) => {
  const lookalike = getAddress(fixtures.lookalike);
  // The lookalike TEST token has no trade on record: the service lists none and its Trades tab says so.
  const record = await service(page.request, 'tokens.page', { address: lookalike });
  expect(record.trades).toEqual([]);
  await page.goto(`/dex/tokens/${lookalike}`);
  await page.getByRole('tab', { name: 'Trades' }).click();
  const tradesTab = page.getByRole('tabpanel', { name: 'Trades' });
  await expect(tradesTab).toContainText('No trade of this token is on record.');
  await expect(tradesTab.getByTestId('trade-amount')).toHaveCount(0);

  const trust = page.getByRole('region', { name: 'Trust' });
  await expect(trust).toBeVisible(UNBUILT);
  // With no history its tier is "unknown" and a note says why, never another tier.
  await expect(trust.getByTestId('token-trust-tier')).toHaveText(/^unknown$/i);
  await expect(trust.getByTestId('token-trust-note')).toContainText(/^No history:/);
  // The stack publishes no organic-score inputs, so the score is "Not scored" with that one code, never a number.
  await expect(trust.getByTestId('token-organic-score')).toHaveText('Not scored');
  await expect(trust.getByTestId('token-organic-score').locator('[data-code]')).toHaveAttribute(
    'data-code',
    'protocol.organic_score_unset',
  );
  // No lock and no vesting on record, a copied name and no history: the flags name each once, and nothing else.
  const flags = trust.getByRole('list', { name: 'Suspicious flags' }).getByRole('listitem');
  const named = await flags.evaluateAll((items) => items.map((i) => i.getAttribute('data-flag')));
  expect([...named].sort()).toEqual(['lookalike', 'no_history', 'no_lp_lock', 'no_vesting']);
  await expect(flags.filter({ hasText: /^No LP lock/ })).toHaveCount(1);
  await expect(flags.filter({ hasText: /^No vesting/ })).toHaveCount(1);

  // A token with trades is graded only by the owner's criteria, which are blank: it refuses by that code, not "unknown".
  await page.goto(`/dex/tokens/${TOKEN_A.address}`);
  const traded = page.getByRole('region', { name: 'Trust' }).getByTestId('token-trust-tier');
  await expect(traded).not.toHaveText(/^unknown$/i);
  await expect(traded.locator('[data-code]')).toHaveAttribute('data-code', 'protocol.trust_criteria_unset');

  // The lookalike is masked in the list and, on its page, shows the banner naming what it copies, and its full address.
  await openTokens(page);
  await page.getByRole('tab', { name: 'New listings' }).click();
  const symbolA = await symbolOf(TOKEN_A.address);
  const masked = listed(page).and(page.locator(`[data-token="${lookalike}"]`));
  await expect(masked).toHaveCount(1);
  await expect(masked.getByTestId('token-symbol-masked')).toHaveText(`Symbol hidden: copies ${TOKEN_A.name}`);
  await expect(masked).not.toContainText(symbolA);
  await masked.getByRole('link').first().click();
  await expect(page).toHaveURL(new RegExp(`/dex/tokens/${lookalike}$`, 'i'));
  await expect(page.getByRole('alert')).toHaveText(
    `May be impersonating ${TOKEN_A.name} (${symbolA}, ${getAddress(TOKEN_A.address)}). Check the full address before you trade.`,
  );
  await expect(page.getByRole('main')).toContainText(lookalike);
});

test(`${J} #6 opens the pairs, holders and trades tabs: candles at the swap times, volume equal to the swaps, holders summing to supply less burned`, async ({
  page,
}) => {
  await page.goto(`/dex/tokens/${TOKEN_A.address}`);
  for (const tab of ['Pairs', 'Holders', 'Trades']) {
    await page.getByRole('tab', { name: tab }).click(UNBUILT);
    await expect(page.getByRole('tabpanel', { name: tab })).toBeVisible();
  }
  const block = await pageBlock(page);
  const pools = await poolsOf(TOKEN_A.address);
  const swaps = await swapsIn(pools, block);
  expect(swaps.length, 'the run swapped in the TEST A/B pool').toBeGreaterThanOrEqual(3);
  const side = (swap) => {
    const pool = pools.find((p) => same(p.pool, swap.pool));
    return same(pool.token0, TOKEN_A.address) ? swap.amount0In + swap.amount0Out : swap.amount1In + swap.amount1Out;
  };

  // Trades: every swap of the token up to the page's block, each once, with its time and its token amount.
  await page.getByRole('tab', { name: 'Trades' }).click();
  const tradesTab = page.getByRole('tabpanel', { name: 'Trades' });
  const trades = tableIn(tradesTab, 'Trades').locator('tr[data-tx]');
  await expect(trades).toHaveCount(swaps.length);
  const tradeRows = await trades.evaluateAll((items) =>
    items.map((r) => ({
      tx: r.getAttribute('data-tx').toLowerCase(),
      time: r.querySelector('time').getAttribute('datetime'),
      units: r.querySelector('[data-testid="trade-amount"]').getAttribute('data-units'),
    })),
  );
  const remaining = swaps.map((s) => ({ tx: s.tx.toLowerCase(), time: isoTime(s.time), units: side(s).toString() }));
  for (const row of tradeRows) {
    const at = remaining.findIndex((s) => s.tx === row.tx && s.time === row.time && s.units === row.units);
    expect(at, `trade ${row.tx} matches one swap on the chain`).toBeGreaterThanOrEqual(0);
    remaining.splice(at, 1);
  }
  expect(remaining).toEqual([]);
  const traded = sum(tradeRows.map((r) => BigInt(r.units)));

  // Pairs: one chart per pool, a candle in every minute a swap happened and in no other, opening at that minute's
  // first swap; each pool's volume is its swaps' token amounts, and the pools together equal the Trades tab.
  await page.getByRole('tab', { name: 'Pairs' }).click();
  const pairsTab = page.getByRole('tabpanel', { name: 'Pairs' });
  const pairRows = tableIn(pairsTab, 'Pairs').locator('tr[data-pool]');
  await expect(pairRows).toHaveCount(pools.length);
  for (const pool of pools) {
    const mine = swaps.filter((s) => same(s.pool, pool.pool)).sort((a, b) => a.time - b.time);
    const chart = pairsTab.locator(`figure[data-pool="${pool.pool}"]`);
    await expect(chart).toHaveCount(1);
    await expect(chart).toHaveAttribute('aria-label', /^Price chart: /);
    const candles = await chart
      .getByTestId('candle')
      .evaluateAll((items) => items.map((c) => ({ time: c.getAttribute('data-time'), period: c.getAttribute('data-period') })));
    const firstOfMinute = new Map();
    for (const s of mine) if (!firstOfMinute.has(Math.floor(s.time / 60))) firstOfMinute.set(Math.floor(s.time / 60), isoTime(s.time));
    expect(candles.map((c) => c.time)).toEqual([...firstOfMinute.values()]);
    for (const c of candles) {
      expect(c.period).toBe('60');
      expect(mine.map((s) => isoTime(s.time))).toContain(c.time);
    }
    const volume = await units(pairRows.and(page.locator(`[data-pool="${pool.pool}"]`)).getByTestId('pair-volume'));
    expect(volume).toEqual([sum(mine.map(side))]);
  }
  expect(sum(await units(pairRows.getByTestId('pair-volume')))).toBe(traded);

  // Holders: the list sums to the supply less burned, and both figures are the chain's own at the page's block.
  await page.getByRole('tab', { name: 'Holders' }).click();
  const holders = page.getByRole('tabpanel', { name: 'Holders' });
  await expect(holders).toContainText(/supply less burned/i);
  const read = (functionName, args) => chain.readContract({ address: TOKEN_A.address, abi: erc20, functionName, args, blockNumber: block });
  const supply = await read('totalSupply');
  const burned = (await read('balanceOf', [ZERO])) + (await read('balanceOf', [DEAD]));
  expect(await units(holders.getByTestId('total-supply'))).toEqual([supply]);
  expect(await units(holders.getByTestId('burned'))).toEqual([burned]);
  expect(await units(holders.getByTestId('supply-less-burned'))).toEqual([supply - burned]);
  const held = await units(tableIn(holders, 'Holders').getByTestId('holder-amount'));
  expect(held.length).toBeGreaterThan(0);
  expect(sum(held)).toBe(supply - burned);
  await expect(holders.getByTestId('supply-less-burned')).toHaveText(exact(supply - burned, TOKEN_A.decimals));
});

test(`${J} #7 creates a watchlist while signed out, then signs in: it persists in the browser and is offered for import on sign-in`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto(`/dex/tokens/${TOKEN}`);
  await page.getByRole('button', { name: 'Add to watchlist' }).click(UNBUILT);
  await page.reload();
  await expect(page.getByRole('button', { name: 'On your watchlist' })).toBeVisible();
  const who = await signUp(page, 'tw');
  await signIn(page, who);
  await openTokens(page);
  // The offer names the token this browser watched, and only it.
  const offer = page.getByRole('dialog', { name: /Import your watchlist/ });
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('kept 1 token(s)');
  await expect(offer.getByRole('listitem')).toHaveCount(1);
  await expect(offer.getByRole('listitem')).toHaveText(new RegExp(`^${TOKEN}$`, 'i'));
  // Before the import the account's own list does not hold it; importing fills the account's list with it.
  const account = await api(who);
  const watched = async () => {
    const input = encodeURIComponent(JSON.stringify({ namespace: 'protocol.token-watchlist' }));
    const res = await account.get(`/api/identity/trpc/preferences.get?input=${input}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return (res.body.result.data.value ?? []).map((entry) => String(entry).toLowerCase());
  };
  expect(await watched()).not.toContain(TOKEN.toLowerCase());
  await offer.getByRole('button', { name: 'Import' }).click();
  await expect(offer).toBeHidden();
  expect(await watched()).toEqual([TOKEN.toLowerCase()]);
});

test(`${J} #8 opens the stocks screener with no asset registered: an empty state with its blocker, not a made-up list`, async ({
  page,
}) => {
  await openTokens(page);
  await page.getByRole('tab', { name: 'Stocks' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Stocks' });
  await expect(panel).toContainText(/No stock is registered/);
  await expect(panel).toContainText(/Blocked:/);
  await expect(panel.locator('[data-code]')).toHaveCount(1);
  await expect(panel.locator('[data-code]')).toHaveAttribute('data-code', 'licence');
  await expect(panel.getByRole('row')).toHaveCount(0);
});

test(`${J} #9 uses the 50 percent shortcut in the quick ticket: the amount is half the balance and Review opens the swap sheet`, async ({
  page,
}) => {
  // A fresh TEST wallet on the TEST chain, funded with TEST ETH and TEST Token A and B; the ticket buys TEST Token A in the
  // deep TEST A/B pool, paying TEST Token B.
  const privateKey = testWalletKey();
  const owner = privateKeyToAccount(privateKey).address;
  fundOnTestChain(owner);
  await installTestWallet(page, { chainId: CHAIN_ID, tokens: [TOKEN_A, TOKEN_B], privateKey, rpcUrl: testChain().gateUrl });
  await page.goto(`/dex/tokens/${TOKEN_A.address}`);
  const ticket = page.getByRole('form', { name: 'Quick trade' });
  await expect(ticket).toBeVisible(UNBUILT);
  await expect(ticket.getByRole('button', { name: 'Buy TESTA' })).toHaveAttribute('aria-pressed', 'true');
  await ticket.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  const balance = await chain.readContract({ address: TOKEN_B.address, abi: erc20, functionName: 'balanceOf', args: [owner] });
  expect(balance > 0n).toBe(true);
  await expect(ticket.getByTestId('quick-balance')).toHaveAttribute('data-units', balance.toString());
  await ticket.getByRole('button', { name: '50%' }).click();
  const half = exact(balance / 2n, TOKEN_B.decimals);
  await expect(ticket.getByRole('textbox', { name: 'Amount' })).toHaveValue(half);
  await ticket.getByRole('button', { name: 'Review' }).click();
  // A fresh wallet accepts the representation once before its first signing action; then the swap sheet opens.
  await acceptRepresentation(page);
  const sheet = page.getByRole('dialog', { name: 'Check before you sign' }).locator('[data-sheet="sequence"]');
  const swapStep = new RegExp(`^Swap ${half.replace('.', '\\.')} ${TOKEN_B.name} for at least \\d+(\\.\\d+)? ${TOKEN_A.name}$`);
  await expect(sheet.getByRole('list', { name: 'Swap steps' }).getByRole('listitem')).toHaveText([
    `Approve exactly ${half} ${TOKEN_B.name}`,
    swapStep,
  ]);
  await expect(sheet).toContainText(new RegExp(TOKEN_A.address, 'i'));
  await expect(sheet).toContainText(new RegExp(TOKEN_B.address, 'i'));
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(ticket.getByRole('alert')).toHaveText('You cancelled. Nothing was sent.');
  expect(await chain.readContract({ address: TOKEN_B.address, abi: erc20, functionName: 'balanceOf', args: [owner] })).toBe(balance);
});
