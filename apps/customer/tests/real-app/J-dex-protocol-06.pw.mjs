// World: gates, stack
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { chainRecordPath, GATE_URL } from '../../../../tooling/scripts/local-test-chain.mjs';
import { CHAIN_ID, TOKEN_A, TOKEN_B, UNBUILT, connectWallet, dexRun, fundOnTestChain, walletSection } from './dex.mjs';
import { signIn } from './desk.mjs';
import { signUpInBrowser, tool } from './stack.mjs';
import { testWalletKey } from './test-wallet.mjs';

// J-dex-protocol-06, in the running app (docs/roadmap/journeys.json): see my portfolio, profit and loss, and track any
// public address. Independent tests (OWNER 212), written from the step's own words. One test per step, titled
// "J-dex-protocol-06 #<n>", run in order. Read-only for the person: their wallet signs and sends nothing.
//
// What the tests set up on the stack's TEST chain (tooling/scripts/local-test-chain.mjs), so every figure is known:
// - The person's wallet holds 80 TEST Token A, 20 TEST USD and 5 TEST Thin when it starts. TEST Thin's only pool is so
//   thin that the seed says a price is not honest to show: it is the token with no price.
// - USD prices are the stack's TEST USD pools (seed-test-chain.ts: "so each TEST token has a USD price on the stack"),
//   read as each pool's reserve ratio. A second TEST wallet (the "mover", funded on the chain) sets that ratio exactly by
//   adding TEST tokens to the pool (anyone may mint TEST tokens) and taking one base unit out, and sends the transfers.
//   A test that moves a price puts it back to 1 TEST USD before it ends.
// - The value history is the chain's: holdings and prices read at each block, so a state that lasts a few blocks is in
//   it. No step moves the chain's clock.
//
// Names the builder implements: the wallet room's Overview holds region "Portfolio" (test id "portfolio-total", region
// "Holdings" with its table, button "Profit and loss", button "Positions"); region "Profit and loss" (test ids "pnl",
// "pnl-excludes", "max-drawdown", list "Conventions"); region "Positions" with one list "Positions"; the section "Track
// an address" with form "Track an address" (textbox "Address", button "Track"), a region "Tracked <address>" holding
// regions "Holdings" and "History", and a list "Watchlist"; Accounts holds region "Account mode" (button "Ask for
// portfolio margin") and switch "Auto-earn" with region "Auto-earn key".
// A token's name in Holdings links to its page: a region named by the token, with test id "entry-price".
// Stack parts the builder adds: `local-test-chain.mjs fund <address> positions` (a TEST lending supply and a TEST venue
// position for that address) and `local-test-gates.mjs auto-earn-assets unset|test` (the owner's auto-earn list blank, or
// its TEST value), as `withdraw-fee <network> unset|test` does for a fee.
const J = 'J-dex-protocol-06';
const base = dexRun(J);
// The person's wallet reads the TEST chain; it needs no TEST ETH, since it sends nothing.
const dex = {
  ...base,
  onChain: true,
  start(extra = {}) {
    return base.run.reset({ walletKey: testWalletKey(), ...extra });
  },
  key() {
    return base.run.read().walletKey ?? this.start().walletKey;
  },
};
const moverRun = dexRun(`${J}-mover`);
const accountRun = dexRun(`${J}-account`);

test.describe.configure({ mode: 'default' });

const TOKEN_USD = { address: '0x000000000000000000000000000000000000d011', name: 'TEST USD', decimals: 6 };
const TOKEN_THIN = { address: '0x00000000000000000000000000000000000071a0', name: 'TEST Thin', decimals: 18 };

const chain = createPublicClient({ transport: http(GATE_URL) });
const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
]);
const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function swap(uint256 amount0Out, uint256 amount1Out, address to)',
  'function mint(address to, uint256 amount0Desired, uint256 amount1Desired) returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);
const factoryAbi = parseAbi(['function getPool(address, address, uint16) view returns (address)']);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const owner = () => privateKeyToAccount(dex.key()).address;
const units = (token, amount) => parseUnits(amount, token.decimals);

/** The mover: a second TEST wallet funded on the chain, kept for the run. */
function mover() {
  let { walletKey } = moverRun.run.read();
  if (!walletKey) {
    walletKey = testWalletKey();
    fundOnTestChain(privateKeyToAccount(walletKey).address);
    moverRun.run.reset({ walletKey });
  }
  const account = privateKeyToAccount(walletKey);
  const client = createWalletClient({
    account,
    chain: defineChain({
      id: CHAIN_ID,
      name: 'LOCAL TEST chain',
      nativeCurrency: { name: 'TEST ETH', symbol: 'TESTETH', decimals: 18 },
      rpcUrls: { default: { http: [GATE_URL] } },
    }),
    transport: http(GATE_URL),
  });
  return {
    address: account.address,
    /** One contract call from the mover, mined; returns its receipt. */
    async call(address, abi, functionName, args) {
      const hash = await client.writeContract({ address, abi, functionName, args });
      const receipt = await chain.waitForTransactionReceipt({ hash });
      expect(receipt.status, `${functionName} on the TEST chain`).toBe('success');
      return receipt;
    },
  };
}

async function poolOf(a, b, feeBps = 30) {
  expect(existsSync(chainRecordPath()), 'this stack runs a TEST chain (LOCAL_STACK_ANVIL_BIN)').toBe(true);
  const { factory } = JSON.parse(readFileSync(chainRecordPath(), 'utf8'));
  return chain.readContract({ address: factory, abi: factoryAbi, functionName: 'getPool', args: [a.address, b.address, feeBps] });
}

/** `token`'s TEST USD pool reserves: { pool, rToken, rUsd, tokenIs0 }. */
async function usdReserves(token) {
  const pool = await poolOf(token, TOKEN_USD);
  const tokenIs0 = same(await chain.readContract({ address: pool, abi: poolAbi, functionName: 'token0' }), token.address);
  const [r0, r1] = await chain.readContract({ address: pool, abi: poolAbi, functionName: 'getReserves' });
  return { pool, tokenIs0, rToken: tokenIs0 ? r0 : r1, rUsd: tokenIs0 ? r1 : r0 };
}
const ceilDiv = (a, b) => (a + b - 1n) / b;

/**
 * Sets `token`'s TEST USD price to `num/den` TEST USD exactly (to one base unit of the pool's reserves): adds TEST USD to
 * raise it or the token to lower it, then takes one base unit of the other side out, which records the new reserves.
 */
async function setUsdPrice(token, num, den = 1n) {
  const m = mover();
  const { pool, tokenIs0, rToken, rUsd } = await usdReserves(token);
  const scaleT = 10n ** BigInt(token.decimals);
  const scaleU = 10n ** BigInt(TOKEN_USD.decimals);
  // price = (rUsd / scaleU) / (rToken / scaleT) = num / den
  const lhs = rUsd * scaleT * den;
  const rhs = num * rToken * scaleU;
  if (lhs === rhs) return;
  if (lhs < rhs) {
    const add = ceilDiv(num * rToken * scaleU, scaleT * den) - rUsd;
    if (add * 1_000_000_000n < rUsd) return; // already there, to one part in a billion
    await m.call(TOKEN_USD.address, erc20Abi, 'mint', [pool, add]);
    await m.call(pool, poolAbi, 'swap', tokenIs0 ? [1n, 0n, m.address] : [0n, 1n, m.address]);
  } else {
    const add = ceilDiv(rUsd * scaleT * den, num * scaleU) - rToken;
    if (add * 1_000_000_000n < rToken) return; // already there, to one part in a billion
    await m.call(token.address, erc20Abi, 'mint', [pool, add]);
    await m.call(pool, poolAbi, 'swap', tokenIs0 ? [0n, 1n, m.address] : [1n, 0n, m.address]);
  }
  const after = await usdReserves(token);
  const price = Number((after.rUsd * scaleT * 1_000_000_000n) / (after.rToken * scaleU)) / 1e9;
  expect(price, `${token.name} at ${num}/${den} TEST USD`).toBeCloseTo(Number(num) / Number(den), 8);
}

/** A dollar figure shown on the page, as a number: "$1,250.50" is 1250.5, "−$30.00" is -30. */
function dollars(text) {
  const m = /([−-])?\s*\$\s*([\d,]+(?:\.\d+)?)/.exec(text);
  expect(m, `a dollar figure in "${text}"`).toBeTruthy();
  return (m[1] ? -1 : 1) * Number(m[2].replaceAll(',', ''));
}

const portfolio = (page) => page.getByRole('region', { name: 'Portfolio' });
const holdingRow = (page, name) =>
  portfolio(page).getByRole('region', { name: 'Holdings' }).getByRole('table').getByRole('row').filter({ hasText: name });

async function openPortfolio(page) {
  // No token answers of the wallet's own: every token read goes to the TEST chain.
  const wallet = await connectWallet(page, dex);
  await walletSection(page, 'Overview');
  await expect(portfolio(page)).toBeVisible(UNBUILT);
  await expect(portfolio(page).getByTestId('portfolio-total')).toBeVisible(UNBUILT);
  return wallet;
}

/** Waits until the portfolio total reads `value` dollars (to the cent). */
async function totalReads(page, value) {
  await expect
    .poll(async () => dollars(await portfolio(page).getByTestId('portfolio-total').innerText()), { timeout: 60_000 })
    .toBeCloseTo(value, 2);
}

async function openTracker(page) {
  await walletSection(page, 'Track an address');
  const tracker = page.getByRole('form', { name: 'Track an address' });
  await expect(tracker).toBeVisible(UNBUILT);
  return tracker;
}

test(`${J} starts: a connected wallet with several TEST token balances, one with no price`, async ({ page }) => {
  dex.start();
  const m = mover();
  // Prices as the seed made them: TEST Token A and TEST Token B at 1 TEST USD each.
  await setUsdPrice(TOKEN_A, 1n);
  await setUsdPrice(TOKEN_B, 1n);
  const sent = await m.call(TOKEN_A.address, erc20Abi, 'transfer', [owner(), units(TOKEN_A, '80')]);
  await m.call(TOKEN_USD.address, erc20Abi, 'mint', [owner(), units(TOKEN_USD, '20')]);
  await m.call(TOKEN_THIN.address, erc20Abi, 'mint', [owner(), units(TOKEN_THIN, '5')]);
  base.run.write({ moverToPerson: sent.transactionHash });
  expect(await chain.readContract({ address: TOKEN_A.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner()] })).toBe(
    units(TOKEN_A, '80'),
  );
  await openPortfolio(page);
});

test(`${J} #1 opens the wallet portfolio: the total value; tokens with no price are left out of the total and a warning names how many`, async ({
  page,
}) => {
  await openPortfolio(page);
  // 80 TEST Token A at 1 + 20 TEST USD at 1; TEST Thin has no price and is left out.
  await totalReads(page, 100);
  await expect(holdingRow(page, 'TEST Token A')).toHaveCount(1);
  await expect(holdingRow(page, 'TEST USD')).toHaveCount(1);
  const thin = holdingRow(page, 'TEST Thin');
  await expect(thin).toHaveCount(1);
  await expect(thin).toContainText(/no price/i);
  const warning = portfolio(page)
    .getByRole('note')
    .filter({ hasText: /no price/i });
  await expect(warning).toHaveCount(1);
  await expect(warning).toContainText(/\b1 token\b/);
  await expect(warning).toContainText(/left out of the total|not in the total/i);
});

test(`${J} #2 opens the profit and loss view after a deposit and a price move: profit and loss excluding the deposit; a drawdown from 120 to 90 shown as 25 percent; the convention links open`, async ({
  page,
}) => {
  await openPortfolio(page);
  await totalReads(page, 100);
  const m = mover();
  try {
    // A deposit of 20 TEST Token A: the wallet is worth 120.
    await m.call(TOKEN_A.address, erc20Abi, 'transfer', [owner(), units(TOKEN_A, '20')]);
    await totalReads(page, 120);
    // The price move: TEST Token A to 0.70, so 100 x 0.70 + 20 = 90.
    await setUsdPrice(TOKEN_A, 7n, 10n);
    await totalReads(page, 90);
    await portfolio(page).getByRole('button', { name: 'Profit and loss', exact: true }).click();
    const pnl = page.getByRole('region', { name: 'Profit and loss' });
    // Worth 100, then 20 deposited, now 90: a loss of 30. The deposit is not counted as a gain (it would read -10).
    await expect.poll(async () => dollars(await pnl.getByTestId('pnl').innerText()), { timeout: 60_000 }).toBeCloseTo(-30, 2);
    await expect(pnl.getByTestId('pnl-excludes')).toContainText(/deposit/i);
    // From 120 at its peak to 90: 25 percent.
    const drawdown = pnl.getByTestId('max-drawdown');
    await expect(drawdown).toContainText(/\b25(?:\.0+)?\s?%/);
    await expect(drawdown).toContainText(/\$120(?:\.00)?\b/);
    await expect(drawdown).toContainText(/\$90(?:\.00)?\b/);
    // Each convention link opens its page.
    const links = pnl.getByRole('list', { name: 'Conventions' }).getByRole('link');
    const count = await links.count();
    expect(count, 'the view links its conventions').toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const link = pnl.getByRole('list', { name: 'Conventions' }).getByRole('link').nth(i);
      const name = (await link.innerText()).trim();
      const back = page.url();
      await link.click();
      await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText(name);
      await expect(page.getByRole('main')).not.toContainText(/page not found/i);
      await page.goto(back);
      await portfolio(page).getByRole('button', { name: 'Profit and loss', exact: true }).click();
    }
  } finally {
    await setUsdPrice(TOKEN_A, 1n);
  }
});

test(`${J} #3 opens a token that was transferred in: the entry price is the arrival-block price and the row says so`, async ({ page }) => {
  await openPortfolio(page);
  const m = mover();
  try {
    // 10 TEST Token B, the wallet's first, arrive while TEST Token B is at 2 TEST USD; then it goes back to 1.
    await setUsdPrice(TOKEN_B, 2n);
    await m.call(TOKEN_B.address, erc20Abi, 'transfer', [owner(), units(TOKEN_B, '10')]);
  } finally {
    await setUsdPrice(TOKEN_B, 1n);
  }
  const row = holdingRow(page, 'TEST Token B');
  await expect(row).toHaveCount(1, { timeout: 60_000 });
  await row.getByRole('link', { name: 'TEST Token B' }).click();
  const token = page.getByRole('region', { name: 'TEST Token B' });
  // The entry price is the price at the arrival block (2), not today's (1), and the row says that is what it is.
  const entry = token.getByTestId('entry-price');
  await expect.poll(async () => dollars(await entry.innerText()), { timeout: 60_000 }).toBeCloseTo(2, 2);
  await expect(entry).toContainText(/arrival block|block it arrived/i);
});

test(`${J} #4 opens the positions dashboard: pool, lending and venue positions in one list with links to each room`, async ({ page }) => {
  await openPortfolio(page);
  await portfolio(page).getByRole('button', { name: 'Positions', exact: true }).click(UNBUILT);
  // A pool position, made on the chain: the mover adds TEST Token A and B to the deep A/B pool for the person.
  const m = mover();
  const pool = await poolOf(TOKEN_A, TOKEN_B);
  if ((await chain.readContract({ address: pool, abi: poolAbi, functionName: 'balanceOf', args: [owner()] })) === 0n) {
    await m.call(TOKEN_A.address, erc20Abi, 'approve', [pool, units(TOKEN_A, '50')]);
    await m.call(TOKEN_B.address, erc20Abi, 'approve', [pool, units(TOKEN_B, '50')]);
    await m.call(pool, poolAbi, 'mint', [owner(), units(TOKEN_A, '50'), units(TOKEN_B, '50')]);
  }
  expect(await chain.readContract({ address: pool, abi: poolAbi, functionName: 'balanceOf', args: [owner()] })).toBeGreaterThan(0n);
  // A lending supply and a venue position, from the stack's TEST chain.
  fundOnTestChain(owner(), 'positions');
  await page.reload();
  await walletSection(page, 'Overview');
  await portfolio(page).getByRole('button', { name: 'Positions', exact: true }).click();
  const list = page.getByRole('region', { name: 'Positions' }).getByRole('list', { name: 'Positions' });
  await expect(list).toHaveCount(1);
  for (const [kind, room] of [
    ['Pool', new RegExp(`^/dex/(?:pools/${pool}|positions/[^/]+)$`, 'i')],
    ['Lending', /^\/dex\/lend(?:\/|$)/],
    ['Venue', /^\/dex\/venue(?:\/|$)/],
  ]) {
    const item = list.getByRole('listitem').filter({ hasText: kind });
    await expect(item.first(), `a ${kind} position in the list`).toBeVisible({ timeout: 60_000 });
    const href = await item.first().getByRole('link').first().getAttribute('href');
    expect(new URL(href ?? '', page.url()).pathname, `${kind} links to its room`).toMatch(room);
  }
});

test(`${J} #5 pastes a public address into the tracker: its holdings and history; an address with no history shows an empty state, not zeros labelled as value`, async ({
  page,
}) => {
  await connectWallet(page, dex);
  const tracker = await openTracker(page);
  // The mover's public address: it holds TEST Token A and sent the person's first transfer.
  const tracked = mover().address;
  await tracker.getByRole('textbox', { name: /^Address/ }).fill(tracked);
  await tracker.getByRole('button', { name: 'Track' }).click();
  const region = page.getByRole('region', { name: new RegExp(`^Tracked ${tracked}$`, 'i') });
  const holdings = region.getByRole('region', { name: 'Holdings' }).getByRole('table');
  const a = await chain.readContract({ address: TOKEN_A.address, abi: erc20Abi, functionName: 'balanceOf', args: [tracked] });
  const whole = (a / 10n ** BigInt(TOKEN_A.decimals)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  await expect(holdings.getByRole('row').filter({ hasText: 'TEST Token A' })).toContainText(whole, { timeout: 60_000 });
  const history = region.getByRole('region', { name: 'History' });
  const first = base.run.read().moverToPerson;
  expect(first, 'the transfer made when the run started').toMatch(/^0x[0-9a-f]{64}$/);
  await expect(history.locator(`a[href$="/chain/tx/${first}"]`)).toHaveCount(1);
  // A new address with no history: an empty state, and no zero shown as its value.
  const fresh = privateKeyToAccount(generatePrivateKey()).address;
  await tracker.getByRole('textbox', { name: /^Address/ }).fill(fresh);
  await tracker.getByRole('button', { name: 'Track' }).click();
  const empty = page.getByRole('region', { name: new RegExp(`^Tracked ${fresh}$`, 'i') });
  await expect(empty).toContainText(/no history/i);
  await expect(empty).not.toContainText(/\$\s?0(?:\.0+)?\b/);
  await expect(empty.getByRole('table')).toHaveCount(0);
});

test(`${J} #6 looks at the tracker request while signed in: no cookie, no authorisation header, no session id; no analytics script; the watchlist cannot be exported`, async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  const scripts = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') scripts.push(request.url());
  });
  let { who } = accountRun.run.read();
  if (!who) {
    const handle = `jd06${Date.now().toString(36)}`;
    who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
    await signUpInBrowser(page, who);
    accountRun.run.reset({ who });
  } else {
    await signIn(page, who);
  }
  const session = await context.cookies();
  expect(session.length, 'signed in: the browser holds the session').toBeGreaterThan(0);
  await page.goto('/wallet');
  const tracker = await openTracker(page);
  const tracked = mover().address;
  const sent = [];
  page.on('request', (request) => {
    const body = request.postData() ?? '';
    if (`${request.url()} ${body}`.toLowerCase().includes(tracked.toLowerCase().slice(2))) sent.push(request);
  });
  await tracker.getByRole('textbox', { name: /^Address/ }).fill(tracked);
  await tracker.getByRole('button', { name: 'Track' }).click();
  await expect.poll(() => sent.length, { timeout: 30_000, message: 'the tracker asked for the address' }).toBeGreaterThan(0);
  for (const request of sent) {
    const headers = await request.allHeaders();
    expect(headers.cookie, `${request.url()} carries no cookie`).toBeUndefined();
    expect(headers.authorization, `${request.url()} carries no authorisation header`).toBeUndefined();
    expect(
      Object.keys(headers).filter((name) => /session/i.test(name)),
      'no session header',
    ).toEqual([]);
    const all = `${request.url()} ${JSON.stringify(headers)} ${request.postData() ?? ''}`;
    for (const cookie of session)
      if (cookie.value.length >= 8) expect(all.includes(cookie.value), `${cookie.name} is not sent`).toBe(false);
    expect(all, 'no session id').not.toMatch(/session[_-]?id/i);
  }
  // No analytics script: every script the room loaded is the app's own.
  const origin = new URL(page.url()).origin;
  expect(scripts.filter((src) => new URL(src).origin !== origin)).toEqual([]);
  expect(scripts.filter((src) => /analytic|gtag|segment|mixpanel|posthog|amplitude|hotjar/i.test(src))).toEqual([]);
  // The address is on the watchlist, and nothing exports it.
  await expect(page.getByRole('list', { name: 'Watchlist' })).toContainText(new RegExp(tracked.slice(2, 10), 'i'));
  await expect(page.getByRole('main').getByRole('button', { name: /export|download/i })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('link', { name: /export|download/i })).toHaveCount(0);
});

test(`${J} #7 opens Accounts and asks for portfolio margin: Standard only, with a link, and the typed refusal for portfolio margin`, async ({
  page,
}) => {
  await connectWallet(page, dex);
  await walletSection(page, 'Accounts');
  const mode = page.getByRole('region', { name: 'Account mode' });
  await expect(mode).toContainText('Standard', UNBUILT);
  // Standard is the only mode: nothing else to pick.
  await expect(mode.getByRole('radio')).toHaveCount(0);
  await expect(mode.getByRole('combobox')).toHaveCount(0);
  const link = mode.getByRole('link').first();
  await expect(link).toBeVisible();
  expect(await link.getAttribute('href')).toMatch(/^\/|^https?:/);
  await mode.getByRole('button', { name: 'Ask for portfolio margin' }).click();
  await expect(mode.getByRole('alert')).toContainText('trade.portfolio_margin_unset');
  await expect(mode).toContainText('Standard');
});

test(`${J} #8 turns on wallet auto-earn: a list of assets chosen by the owner; with the list blank the refusal names it; the key may only supply, never transfer`, async ({
  page,
}) => {
  const wallet = await connectWallet(page, dex);
  await walletSection(page, 'Accounts');
  const autoEarn = page.getByRole('switch', { name: 'Auto-earn' });
  await expect(autoEarn).toBeVisible(UNBUILT);
  try {
    // With the owner's TEST list published: the assets to choose from are the owner's, and the key's grant is supply only.
    tool('local-test-gates.mjs', 'auto-earn-assets', 'test');
    await page.reload();
    await walletSection(page, 'Accounts');
    await autoEarn.click();
    const assets = page.getByRole('listbox', { name: 'Assets to earn on' });
    await expect(assets.getByRole('option')).not.toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Auto-earn' })).toContainText(/chosen by (?:the owner|INTAFACED)/i);
    const key = page.getByRole('region', { name: 'Auto-earn key' });
    await expect(key.getByRole('listitem').filter({ hasText: /^Can\b/ })).toHaveCount(1);
    await expect(key.getByRole('listitem').filter({ hasText: /^Can\b/ })).toContainText(/supply/i);
    await expect(key.getByRole('listitem').filter({ hasText: /^Cannot\b/ })).toContainText(/transfer/i);
    // Nothing is signed here: the person stops before the wallet.
    await page.getByRole('button', { name: 'Cancel' }).click();
    // With the list blank: refused by name, and the switch stays off.
    tool('local-test-gates.mjs', 'auto-earn-assets', 'unset');
    await page.reload();
    await walletSection(page, 'Accounts');
    await autoEarn.click();
    await expect(page.getByRole('alert')).toContainText('protocol.auto_earn_assets_unset');
    await expect(autoEarn).not.toBeChecked();
    expect({ requests: wallet.requests.length, sends: wallet.sends.length }).toEqual({ requests: 0, sends: 0 });
  } finally {
    try {
      tool('local-test-gates.mjs', 'auto-earn-assets', 'test');
    } catch {
      /* the switch is not built yet; nothing to put back */
    }
  }
});
