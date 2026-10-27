import { test, expect } from '@playwright/test';
import { TOKEN_A, TOKEN_B, UNBUILT, connectWallet, dexRun, oneAmount } from './dex.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { api, toUnits, tool } from './stack.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-24, in the running app (docs/roadmap/journeys.json): launch a token with a locked pool and vesting. One
// test per step, titled "J-dex-protocol-24 #<n>", run in order with one TEST wallet that owns a TEST token contract
// (TEST Token A) and holds the quote token (TEST Token B), plus a verified TEST account holding TEST USDT for the priced
// listing request. Tokens lock in contracts under the person's signature; a priced express listing is charged once
// under a business key and a blank price charges nothing. audit.external for any mainnet deploy; rail.crypto while the
// node is absent.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - /protocol/contracts shows Launch token disabled with rail.crypto; there is no launch page with presets, immutable
//   parameters or a lock date (D-launch-listing-08), and no bonding curve (RC-dex-protocol-18);
// - there is no ownership proof, token info update or express verification request (D-launch-listing-01, -03), and no
//   vesting or LP lock form (D-launch-listing-05). The launch, the lock and the vesting cliff are proven on chain in
//   services/svc-protocol (meme-launch.onchain.test.ts, launch-vesting.onchain.test.ts), but no room opens them;
// - #7's priced half needs a TEST express listing price, which no stack tool sets yet (`local-test-gates.mjs
//   listing-price`, proposed); the step clears it again after;
// - the stack has no TEST chain, so nothing a step signs can mine.
const J = 'J-dex-protocol-24';
const dex = dexRun(J);
const TOKENS = [TOKEN_A, TOKEN_B];
const RECIPIENT = '0x52908400098527886E0F7030069857D2E4169EE7';

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const launch = (page) => main(page).getByRole('form', { name: 'Launch a token' });

/** Opens the launch page from the protocol's contracts room with the run's wallet connected. */
async function openLaunch(page) {
  const wallet = await connectWallet(page, dex, { tokens: TOKENS });
  await page.goto('/protocol/contracts');
  await main(page).getByRole('button', { name: 'Launch token' }).click(UNBUILT);
  await expect(launch(page)).toBeVisible();
  return wallet;
}

/** Signs whatever the open sheet asks for. */
async function sign(page) {
  await page.getByRole('dialog', { name: 'Check before you sign' }).getByRole('button', { name: 'Continue in wallet' }).click();
}

/** Opens the token's own page on the DEX (its listing and lock state). */
async function tokenPage(page) {
  await page.goto(`/dex/tokens/${TOKEN_A.address}`);
  await expect(main(page).getByRole('heading', { name: TOKEN_A.name, level: 1 })).toBeVisible(UNBUILT);
}

test(`${J} starts: a connected TEST wallet that owns a TEST token contract`, async ({ page }) => {
  test.setTimeout(240_000);
  dex.start({ who: await fundedTrader(page, 'dex24', '100') });
  await connectWallet(page, dex, { tokens: TOKENS });
});

test(`${J} #1 opens the meme launch page with presets unset: only Custom; the immutable parameters stated; a past lock date refused`, async ({
  page,
}) => {
  await openLaunch(page);
  const presets = launch(page).getByRole('radiogroup', { name: 'Preset' });
  await expect(presets.getByRole('radio')).toHaveCount(1);
  await expect(presets.getByRole('radio', { name: 'Custom' })).toBeChecked();
  await expect(launch(page).getByRole('note').filter({ hasText: 'cannot be changed after launch' })).toBeVisible();
  await launch(page).getByLabel('LP locked until').fill('2020-01-01');
  await launch(page).getByRole('button', { name: 'Review' }).click();
  await expect(launch(page).getByRole('alert')).toContainText('The lock date must be in the future');
});

test(`${J} #2 launches with valid TEST parameters: one transaction creates token, pool and lock; the pool holds the seed and the LP is locked`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const wallet = await openLaunch(page);
  await launch(page).getByRole('textbox', { name: /^Name/ }).fill('TEST Launch');
  await launch(page)
    .getByRole('textbox', { name: /^Symbol/ })
    .fill('TLAUNCH');
  await launch(page)
    .getByRole('textbox', { name: /^Supply/ })
    .fill('1000000');
  await launch(page)
    .getByRole('textbox', { name: /^Seed in TEST Token B/ })
    .fill('100');
  await launch(page).getByLabel('LP locked until').fill('2030-01-01');
  await launch(page).getByRole('button', { name: 'Review' }).click();
  await sign(page);
  await expect.poll(() => wallet.sends.length).toBe(1);
  const result = main(page).getByRole('region', { name: 'Your launch' });
  await expect(result).toContainText('Pool seeded: 100 TEST Token B', { timeout: 120_000 });
  await expect(result).toContainText('LP locked until 1 Jan 2030');
});

test(`${J} #3 chooses the bonding-curve option: the blocker is named and no call is built`, async ({ page }) => {
  const wallet = await openLaunch(page);
  const curve = launch(page).getByRole('radio', { name: /^Bonding curve/ });
  await expect(curve).toBeDisabled();
  await expect(launch(page).getByRole('note').filter({ hasText: 'Bonding curve' })).toContainText(/rail\.crypto|chain\.go/);
  expect(wallet.sends).toHaveLength(0);
});

test(`${J} #4 buys on a bonding curve until it graduates: tokens follow the curve, a sell returns at most what was paid, then the pool is seeded and curve buys refuse`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: TOKENS });
  await page.goto('/dex/launches');
  const curve = main(page).getByRole('region', { name: 'TEST curve token' });
  await expect(curve).toBeVisible(UNBUILT);
  const buy = curve.getByRole('form', { name: 'Buy on the curve' });
  const receive = async () => oneAmount(await buy.getByTestId('curve-receive').innerText());
  // Two buys of 10: the second gets fewer tokens, as the curve's price rises.
  await buy.getByRole('textbox', { name: /^Pay in TEST Token B/ }).fill('10');
  const first = await receive();
  await buy.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  await expect(curve.getByTestId('curve-held')).not.toHaveText(/^You hold 0 /, { timeout: 60_000 });
  await buy.getByRole('textbox', { name: /^Pay in TEST Token B/ }).fill('10');
  expect(await receive()).toBeLessThan(first);
  await buy.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  // Selling everything held returns at most the 20 paid.
  const sell = curve.getByRole('form', { name: 'Sell on the curve' });
  await sell.getByRole('button', { name: 'Sell all' }).click();
  expect(oneAmount(await sell.getByTestId('curve-return').innerText())).toBeLessThanOrEqual(toUnits('20'));
  // A TEST curve token of the stack that already reached its raise target.
  const graduated = main(page).getByRole('region', { name: 'TEST graduated token' });
  await expect(graduated).toContainText('Graduated: pool seeded, LP locked');
  await expect(graduated.getByRole('form', { name: 'Buy on the curve' })).toHaveCount(0);
});

test(`${J} #5 proves ownership with a challenge signature: the proof is stored; a replay, a non-owner and an unreadable owner each refuse with their own reason`, async ({
  page,
  browser,
}) => {
  const wallet = await connectWallet(page, dex, { tokens: TOKENS });
  await tokenPage(page);
  const proof = page.waitForRequest((r) => r.method() === 'POST' && /ownership/.test(r.url()));
  await main(page).getByRole('button', { name: 'Prove you own this token' }).click(UNBUILT);
  await sign(page);
  await expect(main(page).getByRole('status')).toHaveText('Ownership proven');
  expect(wallet.requests.filter((r) => r.method === 'personal_sign')).toHaveLength(1);
  // The same signed challenge sent again is refused as a replay.
  const replay = await page.request.fetch(await proof);
  expect(replay.status()).toBe(409);
  expect((await replay.json()).code).toBe('launch.ownership_challenge_used');
  // Another wallet cannot prove it owns the run's token.
  const other = await browser.newContext();
  try {
    const away = await other.newPage();
    await connectWallet(away, dexRun(`${J}-other`), { tokens: TOKENS });
    await tokenPage(away);
    await main(away).getByRole('button', { name: 'Prove you own this token' }).click();
    await sign(away);
    await expect(main(away).getByRole('alert')).toContainText('This wallet does not own this token');
  } finally {
    await other.close();
  }
  // A token whose owner cannot be read refuses with its own reason.
  await page.goto(`/dex/tokens/${TOKEN_B.address}`);
  await main(page).getByRole('button', { name: 'Prove you own this token' }).click();
  await expect(main(page).getByRole('alert')).toContainText('The owner of this token cannot be read');
});

test(`${J} #6 sends a token info update: refused without the proof; with it, pending review and shown as such`, async ({ page }) => {
  await connectWallet(page, dex, { tokens: TOKENS });
  await page.goto(`/dex/tokens/${TOKEN_B.address}`);
  await main(page).getByRole('button', { name: 'Update token info' }).click(UNBUILT);
  await expect(main(page).getByRole('alert')).toContainText('Prove you own this token first');
  await tokenPage(page);
  await main(page).getByRole('button', { name: 'Update token info' }).click();
  const form = main(page).getByRole('form', { name: 'Token info' });
  await form.getByRole('textbox', { name: /^Website/ }).fill('https://test.invalid');
  await form.getByRole('button', { name: 'Send for review' }).click();
  await expect(main(page).getByTestId('token-info-state')).toHaveText('Pending review');
});

test(`${J} #7 requests an express verification with the price blank, then with a TEST price: "Listing price not set" and nothing charged; then charged once`, async ({
  page,
}) => {
  const { who } = dex.run.read();
  expect(who, 'the start step made the account').toBeTruthy();
  await signIn(page, who);
  await tokenPage(page);
  await main(page).getByRole('button', { name: 'Request express verification' }).click(UNBUILT);
  // The express listing price is blank on the stack: the request refuses and nothing is charged.
  await expect(main(page).getByRole('alert')).toContainText('Listing price not set');
  const requests = tableIn(main(page), 'Listing requests');
  await expect(bodyRows(requests)).toHaveCount(0);
  // With a TEST price the fee posts once; pressing again returns the stored receipt, never a second charge.
  tool('local-test-gates.mjs', 'listing-price', 'express', '10');
  try {
    const before = (await api(who).then((a) => a.balances())).USDT?.free;
    await page.reload();
    for (let i = 0; i < 2; i++) await main(page).getByRole('button', { name: 'Request express verification' }).click();
    await expect(bodyRows(requests)).toHaveCount(1);
    await expect(bodyRows(requests)).toContainText('Charged 10 USDT');
    expect(toUnits((await api(who).then((a) => a.balances())).USDT.free)).toBe(toUnits(before) - toUnits('10'));
  } finally {
    tool('local-test-gates.mjs', 'listing-price', 'express', 'unset');
  }
});

test(`${J} #8 creates a vesting lock of 12 months with a 3-month cliff: nothing claimable before the cliff, the right fraction after`, async ({
  page,
}) => {
  await openLaunch(page);
  await main(page).getByRole('button', { name: 'Vesting' }).click();
  const form = main(page).getByRole('form', { name: 'New vesting lock' });
  await form.getByRole('textbox', { name: /^Recipient/ }).fill(RECIPIENT);
  await form.getByRole('textbox', { name: /^Amount/ }).fill('1200');
  await form.getByRole('spinbutton', { name: /^Duration \(months\)/ }).fill('12');
  await form.getByRole('spinbutton', { name: /^Cliff \(months\)/ }).fill('3');
  await form.getByRole('combobox', { name: 'Who may change the recipient' }).selectOption({ label: 'Nobody' });
  await form.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  const lock = bodyRows(tableIn(main(page), 'Vesting locks')).filter({ hasText: RECIPIENT.slice(0, 10) });
  await expect(lock).toContainText('Claimable now: 0', { timeout: 60_000 });
  // At the cliff a quarter of the lock has vested (3 of 12 months, linear).
  await expect(lock).toContainText('At the cliff: 300');
  await expect(lock.getByRole('button', { name: 'Change recipient' })).toHaveCount(0);
});

test(`${J} #9 locks LP shares and asks for a creator fee share: the LP cannot be claimed before unlock; a fee split is refused`, async ({
  page,
}) => {
  await openLaunch(page);
  await main(page).getByRole('button', { name: 'Lock LP' }).click();
  const locked = bodyRows(tableIn(main(page), 'LP locks')).filter({ hasText: 'TEST Launch' });
  await expect(locked.getByRole('button', { name: 'Claim' })).toBeDisabled();
  await main(page).getByRole('button', { name: 'Ask for a creator fee share' }).click();
  await expect(main(page).getByRole('alert')).toContainText('Pools pay no third share');
});
