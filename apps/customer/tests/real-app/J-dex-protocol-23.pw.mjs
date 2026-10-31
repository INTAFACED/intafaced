import { test, expect } from './journey.mjs';
import { TOKEN_A, TOKEN_B, UNBUILT, connectWallet, dexRun } from './dex.mjs';
import { signUp } from './desk.mjs';
import { EDGE, ORIGIN, json } from './stack.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-23, in the running app (docs/roadmap/journeys.json): build on the DEX with the swap API, the widget and
// the docs. One test per step, titled "J-dex-protocol-23 #<n>", run in order as one TEST developer account with one TEST
// wallet. Swaps are the developer's own signed TEST transactions; integrator fees are paid first entry first under the
// cap; nothing posts to the ledger. rail.crypto while the node is absent; a blank order cap schedule refuses.
// Step 4 (a production key behind the terms) waits for launch prep (owner decision 2026-10-27) and has no test.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - /developers has no DEX and Protocol section: no swap API limits, signed actions, session key, protocol errors,
//   testnet kit, protocol streams, widget or deep link pages (D-developer-compliance-04, -05, -03);
// - there is no public swap API on Edge (`/api/v1/dex/quote`, `/api/v1/dex/swaps`) with limits, managed submission or
//   integrator fee entries (D-swap-07, D-fees-governance-03), and no embeddable widget (`/embed/swap`);
// - the stack has no TEST chain, so #5's submission cannot broadcast or fill.
const J = 'J-dex-protocol-23';
const dex = dexRun(J);
const TOKENS = [TOKEN_A, TOKEN_B];

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');

/** Opens one page of the portal's DEX and Protocol section by its link, as a developer reading /developers would. */
async function devPage(page, link) {
  await page.goto('/developers');
  await main(page).getByRole('region', { name: 'DEX and Protocol' }).getByRole('link', { name: link }).click(UNBUILT);
  await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(link);
}

/** A swap quote from the public API, as the developer's own program asks for it. */
const quote = (query) =>
  fetch(`${EDGE}/api/v1/dex/quote?${new URLSearchParams(query)}`, { headers: { origin: ORIGIN } }).then(async (res) => ({
    ...(await json(res)),
    headers: res.headers,
  }));
const PAIR = { chainId: '84532', sellToken: TOKEN_A.address, buyToken: TOKEN_B.address, sellAmount: '1000000' };

test(`${J} starts: a developer with an account, reading /developers`, async ({ page }) => {
  test.setTimeout(120_000);
  const who = await signUp(page, 'dex23');
  dex.start({ who });
  await page.goto('/developers');
  await expect(main(page).getByRole('heading', { name: 'Developers', level: 1 })).toBeVisible();
});

test(`${J} #1 reads the limits page: the values equal the live config; a blank cap schedule shows its refusal`, async ({ page }) => {
  await devPage(page, 'Swap API limits');
  const limits = tableIn(main(page), 'Swap API limits');
  const live = await fetch(`${EDGE}/api/v1/dex/limits`, { headers: { origin: ORIGIN } }).then(json);
  expect(live.status).toBe(200);
  // Every published limit is one row, with the value the live config answers.
  for (const { name, value } of live.body.limits) await expect(bodyRows(limits).filter({ hasText: name })).toContainText(String(value));
  // The order cap schedule is blank on the stack: the page shows its refusal, never a number.
  await expect(bodyRows(limits).filter({ hasText: 'Order cap schedule' })).toContainText('Not set');
});

test(`${J} #2 bursts requests past the limit: a 429 with the headers the page documents`, async ({ page }) => {
  await devPage(page, 'Swap API limits');
  const documented = await main(page).getByRole('list', { name: 'Rate limit headers' }).getByRole('listitem').allInnerTexts();
  expect(documented.length, 'the page documents the rate limit headers').toBeGreaterThan(0);
  let refused;
  for (let i = 0; i < 300 && !refused; i++) {
    const res = await quote(PAIR);
    if (res.status === 429) refused = res;
  }
  expect(refused, 'a burst past the limit is refused with 429').toBeTruthy();
  for (const header of documented) expect(refused.headers.get(header.split(/\s/)[0]), header).not.toBeNull();
});

test(`${J} #3 reads the signed-actions, session key and error pages: the session key page links to the wallet and its limits equal the contract's; every refusal code is listed`, async ({
  page,
}) => {
  await devPage(page, 'Signed actions');
  await expect(main(page).getByRole('region', { name: 'What you sign' })).toBeVisible();
  await devPage(page, 'Session keys');
  await expect(main(page).getByRole('link', { name: 'Session keys in your wallet' })).toHaveAttribute('href', /^\/wallet/);
  // The limits on the page are the ones the session key contract enforces, read from the protocol's contracts list.
  const documented = await bodyRows(tableIn(main(page), 'Session key limits')).allInnerTexts();
  expect(documented.length, 'the page lists the session key limits').toBeGreaterThan(0);
  await page.goto('/protocol/contracts');
  const contract = bodyRows(tableIn(main(page), 'Deployed contracts')).filter({ hasText: 'Session key' });
  for (const row of documented) await expect(contract).toContainText(row.split('\t').at(-1).trim());
  await devPage(page, 'Protocol errors');
  const codes = await bodyRows(tableIn(main(page), 'Refusal codes'))
    .getByRole('cell')
    .allInnerTexts();
  // The refusals this journey meets are in the catalogue.
  for (const code of ['dex.order_cap_unset', 'rate_limited', 'chain.go', 'rail.crypto']) expect(codes).toContain(code);
});

test(`${J} #5 lands a signed swap through the API: one intent row, broadcast, status follows to filled; a retry sends the same raw transaction`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const wallet = await connectWallet(page, dex, { tokens: TOKENS });
  await devPage(page, 'Swap API');
  // The developer's program: quote, sign the returned transaction with its own wallet, then hand the raw transaction over.
  const q = await quote({ ...PAIR, taker: wallet.address });
  expect(q.status).toBe(200);
  const submit = (raw) =>
    fetch(`${EDGE}/api/v1/dex/swaps`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ quoteId: q.body.quoteId, rawTransaction: raw }),
    }).then(json);
  const raw = q.body.transaction?.raw;
  expect(raw, 'the quote carries the transaction to sign').toBeTruthy();
  const first = await submit(raw);
  const again = await submit(raw);
  expect(again.body.intentId).toBe(first.body.intentId);
  expect(again.body.hash).toBe(first.body.hash);
  await expect
    .poll(async () => (await fetch(`${EDGE}/api/v1/dex/swaps/${first.body.intentId}`).then(json)).body.status, { timeout: 120_000 })
    .toBe('filled');
});

test(`${J} #6 adds three integrator fee entries under the cap and one above: each entry and the output after fees; over the cap refused with its code`, async () => {
  const fee = (bps, recipient) => ({ recipient, bps });
  const R = (n) => `0x${String(n).padStart(40, '0')}`;
  const ok = await quote({ ...PAIR, integratorFees: JSON.stringify([fee(10, R(1)), fee(10, R(2)), fee(5, R(3))]) });
  expect(ok.status, JSON.stringify(ok.body).slice(0, 200)).toBe(200);
  expect(ok.body.fees.integrator).toHaveLength(3);
  expect(ok.body.buyAmountAfterFees).toMatch(/^\d+$/);
  const tooMany = await quote({ ...PAIR, integratorFees: JSON.stringify([fee(10, R(1)), fee(10, R(2)), fee(5, R(3)), fee(500, R(4))]) });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.code).toMatch(/^dex\.integrator_fee_(entry_over_max|total_over_cap)$/);
});

test(`${J} #7 opens the testnet kit and the WebSocket streams docs: the faucet, a sample stream and the supported chains`, async ({
  page,
}) => {
  await devPage(page, 'Testnet kit');
  await expect(main(page).getByRole('region', { name: 'Faucet' })).toBeVisible();
  await expect(bodyRows(tableIn(main(page), 'Supported chains')).filter({ hasText: 'Base Sepolia' })).toHaveCount(1);
  await devPage(page, 'Protocol streams');
  await expect(main(page).getByRole('region', { name: 'Sample stream' }).getByRole('code')).toBeVisible();
});

test(`${J} #8 embeds the swap widget in a host page: it quotes in the page and the confirm step opens a top-level window`, async ({
  page,
}) => {
  await page.setContent(
    `<main><h1>TEST host page</h1><iframe title="Swap" src="${ORIGIN}/embed/swap" width="420" height="640"></iframe></main>`,
  );
  const widget = page.getByTitle('Swap').contentFrame();
  await widget.getByRole('textbox', { name: /^Amount you pay/ }).fill('10', UNBUILT);
  await expect(widget.getByTestId('output-after-fees')).toHaveText(/^You receive [\d,.]+ /);
  const opened = page.context().waitForEvent('page');
  await widget.getByRole('button', { name: 'Confirm in Intafaced' }).click();
  expect(new URL((await opened).url()).origin).toBe(ORIGIN);
});

test(`${J} #9 opens a deep link with an unknown output token: the token shows as unknown with its address and nothing is pre-signed`, async ({
  page,
}) => {
  const wallet = await connectWallet(page, dex, { tokens: TOKENS });
  const unknown = '0x00000000000000000000000000000000deadbeef';
  await page.goto(`/dex?sell=${TOKEN_A.address}&buy=${unknown}&amount=1`);
  const swap = page.getByRole('form', { name: 'Swap' });
  await expect(swap.getByRole('note').filter({ hasText: 'Unknown token' })).toContainText(unknown, UNBUILT);
  expect(wallet.requests).toHaveLength(0);
  expect(wallet.sends).toHaveLength(0);
});

test(`${J} #10 opens a support path and a trading explanation: the route to support from the DEX and each order type explained`, async ({
  page,
}) => {
  await page.goto('/dex');
  await main(page).getByRole('link', { name: 'Get help with a swap' }).click(UNBUILT);
  await expect(page).toHaveURL(/\/support/);
  await devPage(page, 'Order types');
  for (const type of ['Swap', 'Limit', 'TWAP', 'Cross-chain']) await expect(main(page).getByRole('region', { name: type })).toBeVisible();
});
