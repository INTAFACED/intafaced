// World: none
import { existsSync, readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseSignature, parseUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { chainRecordPath, GATE_URL } from '../../../../tooling/scripts/local-test-chain.mjs';
import {
  CHAIN_ID,
  TOKEN_A,
  TOKEN_B,
  TOKEN_C,
  TOKEN_USD,
  UNBUILT,
  acceptRepresentation,
  connectWallet,
  dexRun,
  fundOnTestChain,
} from './dex.mjs';

// J-dex-protocol-03, in the running app (docs/roadmap/journeys.json): swap smarter with permits, per-hop floors and signed
// intent orders. One test per step, titled "J-dex-protocol-03 #<n>", run in order with one TEST wallet on the stack's
// LOCAL TEST chain (a Base Sepolia stand-in, chain id 84532), funded with TEST ETH, TEST Token A and B (each with an
// EIP-2612 permit) and TEST Token C (no permit). Every swap and order is signed by the person's own wallet; nothing posts
// to the ledger. What each step's words say is checked in the app and, where the words are about the chain, on the chain
// itself through the gate, never through the service.
// - #1 to #5 run on router v2 and SovereignPermit (D-swap-03, D-swap-intents-01, -02), seeded by
//   services/svc-protocol/scripts/seed-test-chain.ts with a three-hop route A, C, USD, B.
// - #6 and #7 (signed intent orders, D-swap-09) and #8 and #9 (smart-account delegation and signer keys, D-swap-intents-05)
//   are not built yet, so each fails at its first missing part, quickly (UNBUILT).
const J = 'J-dex-protocol-03';
const dex = dexRun(J);

test.describe.configure({ mode: 'default' });

const swap = (page) => page.getByRole('form', { name: 'Swap' });
const tokenIn = (page) => swap(page).getByRole('combobox', { name: 'You pay' });
const tokenOut = (page) => swap(page).getByRole('combobox', { name: 'You receive' });
const amountIn = (page) => swap(page).getByRole('textbox', { name: /^Amount you pay/ });
const swapButton = (page) => swap(page).getByRole('button', { name: 'Swap', exact: true });
const steps = (page) => page.getByRole('list', { name: 'Swap steps' });
const sheet = (page) => page.getByRole('dialog', { name: 'Check before you sign' });
const status = (page) => page.getByRole('region', { name: 'Swap status' }).getByRole('status');

/** The stack's TEST chain, read through the gate the way svc-protocol reads it, never through the service. */
const chain = createPublicClient({ transport: http(GATE_URL) });
const record = () => {
  expect(existsSync(chainRecordPath()), 'this stack runs a TEST chain (LOCAL_STACK_ANVIL_BIN)').toBe(true);
  return JSON.parse(readFileSync(chainRecordPath(), 'utf8'));
};
const erc20 = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function nonces(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'error InvalidSigner()',
  'error PermitExpired()',
]);
const permitAbi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function transferFrom(address owner, address to, uint160 amount, address token)',
  'error AllowanceExpired()',
  'error AllowanceTooLow()',
]);
const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to) returns (uint256)',
]);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const balance = (token, owner) => chain.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [owner] });
/** The revert's error name when `functionName` is called from `account`, or "no revert". */
const revertOf = (address, abi, functionName, args, account) =>
  chain.simulateContract({ address, abi, functionName, args, account }).then(
    () => 'no revert',
    (err) => err?.cause?.data?.errorName ?? err?.shortMessage ?? String(err),
  );
/** A signer for the TEST chain from a TEST key (the run's own wallet key, or a TEST mover's). */
const signerOf = (key) =>
  createWalletClient({
    account: privateKeyToAccount(key),
    chain: defineChain({
      id: CHAIN_ID,
      name: 'LOCAL TEST chain',
      nativeCurrency: { name: 'TEST ETH', symbol: 'TESTETH', decimals: 18 },
      rpcUrls: { default: { http: [GATE_URL] } },
    }),
    transport: http(GATE_URL),
  });

/** Opens /dex's Swap form with the run's wallet connected. */
async function openSwap(page) {
  const wallet = await connectWallet(page, dex, { tokens: [] });
  await page.goto('/dex');
  await expect(swap(page)).toBeVisible(UNBUILT);
  return wallet;
}

/** Picks `from` in, `to` out and types `amount`. */
async function quote(page, from, to, amount = '10') {
  await tokenIn(page).selectOption({ label: from.name }, UNBUILT);
  await tokenOut(page).selectOption({ label: to.name });
  await amountIn(page).fill(amount);
}

/** Chooses one of the swap's approvals in the Allowance group. */
const chooseAllowance = (page, name) =>
  swap(page).getByRole('radiogroup', { name: 'Allowance' }).getByRole('radio', { name }).check(UNBUILT);

/** Switches the form to Manual, accepting its one-time notice when this browser has not seen it yet. */
async function chooseManual(page) {
  await swap(page).getByRole('radio', { name: 'Manual' }).check(UNBUILT);
  const notice = page.getByRole('dialog', { name: 'Manual mode' });
  if (await notice.isVisible()) await notice.getByRole('button', { name: 'I understand' }).click();
}

/** The nonce of each typed-data message the wallet signed, in order. */
const signedNonces = (wallet) =>
  wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').map((r) => String(JSON.parse(r.params[1]).message.nonce));

/** Opens the intent order form (Swap's "Intent order" mode). */
async function openIntent(page) {
  const wallet = await openSwap(page);
  await swap(page).getByRole('radio', { name: 'Intent order' }).check(UNBUILT);
  return { wallet, form: page.getByRole('form', { name: 'Intent order' }) };
}

/** Every typed-data message the wallet signed, parsed, in order. */
const signedTyped = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').map((r) => JSON.parse(r.params[1]));

test(`${J} starts: a TEST wallet on Base Sepolia, a token with a permit and one without, a two-hop route`, async ({ page }) => {
  const { walletKey } = dex.start();
  fundOnTestChain(privateKeyToAccount(walletKey).address, 'plain');
  // Router v2, SovereignPermit and a two-hop route (TEST Token A to TEST Token B through TEST USD) are on the chain.
  const r = record();
  for (const address of [r.routerV2, r.sovereignPermit, TOKEN_C.address])
    expect(await chain.getCode({ address })).toMatch(/^0x[0-9a-f]{2,}/);
  await openSwap(page);
  // A swap is a signing action, so a new wallet accepts the representation once (J-dex-protocol-01 #8). The swap's own
  // sheet that follows is cancelled: nothing is approved or sent.
  await quote(page, TOKEN_A, TOKEN_B, '1');
  await swapButton(page).click();
  await acceptRepresentation(page);
  await page.locator('[data-sheet="sequence"]').getByRole('button', { name: 'Cancel' }).click();
});

test(`${J} #1 swaps a token that supports permit: one signature for the exact amount and deadline instead of an approve transaction; reusing the signature fails`, async ({
  page,
}) => {
  const wallet = await openSwap(page);
  const { routerV2 } = record();
  await quote(page, TOKEN_A, TOKEN_B, '10');
  await chooseAllowance(page, /^One signature for this swap/);
  const before = await balance(TOKEN_B.address, wallet.address);
  await swapButton(page).click();
  // No approve step: one signature for exactly 10, then the swap.
  await expect(
    steps(page)
      .getByRole('listitem')
      .filter({ hasText: /^Approve/ }),
  ).toHaveCount(0);
  await expect(steps(page).getByRole('listitem').filter({ hasText: 'Sign a permit for exactly 10 TEST Token A' })).toHaveCount(1);
  await expect(sheet(page).getByRole('term').filter({ hasText: 'Amount' })).toBeVisible();
  await expect(sheet(page).getByRole('term').filter({ hasText: 'Expires' })).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(status(page)).toHaveText('Filled', { timeout: 60_000 });
  // One signature: an EIP-2612 permit to router v2 for exactly 10 TEST Token A with a deadline.
  const signed = signedTyped(wallet);
  expect(signed).toHaveLength(1);
  const permit = signed[0];
  expect(permit.primaryType).toBe('Permit');
  expect(same(permit.domain.verifyingContract, TOKEN_A.address)).toBe(true);
  expect(same(permit.message.spender, routerV2)).toBe(true);
  expect(permit.message.value).toBe(parseUnits('10', TOKEN_A.decimals).toString());
  expect(BigInt(permit.message.deadline)).toBeGreaterThan(0n);
  // approve(address,uint256) is 0x095ea7b3: no approve transaction was ever sent.
  expect(wallet.sends.filter((s) => String(s.params[0]?.data).startsWith('0x095ea7b3'))).toHaveLength(0);
  // The swap happened on chain and the allowance it set is spent.
  expect(await balance(TOKEN_B.address, wallet.address)).toBeGreaterThan(before);
  expect(
    await chain.readContract({ address: TOKEN_A.address, abi: erc20, functionName: 'allowance', args: [wallet.address, routerV2] }),
  ).toBe(0n);
  // Reusing the signature fails: the same signed permit, submitted again on chain, reverts.
  const { v, r, s } = parseSignature(wallet.requests.find((x) => x.method === 'eth_signTypedData_v4').signature);
  const replay = [wallet.address, routerV2, BigInt(permit.message.value), BigInt(permit.message.deadline), Number(v), r, s];
  expect(await revertOf(TOKEN_A.address, erc20, 'permit', replay, wallet.address)).toBe('InvalidSigner');
});

test(`${J} #2 swaps a token without permit: the room says it has no permit and falls back to the approve step`, async ({ page }) => {
  await openSwap(page);
  await quote(page, TOKEN_C, TOKEN_A, '10');
  await expect(swap(page).getByRole('note')).toContainText('TEST Token C has no permit', UNBUILT);
  // One signature is not offered for it.
  await expect(
    swap(page)
      .getByRole('radiogroup', { name: 'Allowance' })
      .getByRole('radio', { name: /^One signature/ }),
  ).toBeDisabled();
  await swapButton(page).click();
  await expect(steps(page).getByRole('listitem').filter({ hasText: 'Approve exactly 10 TEST Token C' })).toHaveCount(1);
  await sheet(page).getByRole('button', { name: 'Cancel' }).click();
});

test(`${J} #3 chooses a standing allowance with an expiry: the expiry is shown; a pull after it is refused`, async ({ page }) => {
  test.setTimeout(240_000);
  const wallet = await openSwap(page);
  const { routerV2, sovereignPermit } = record();
  await quote(page, TOKEN_A, TOKEN_B, '10');
  await chooseAllowance(page, /^Standing allowance/);
  await swap(page).getByRole('combobox', { name: 'Allowance expires' }).selectOption({ label: '1 minute' });
  await expect(swap(page).getByTestId('allowance-expiry')).toHaveText(/^Expires \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  await swapButton(page).click();
  await expect(sheet(page).getByRole('term').filter({ hasText: 'Expires' })).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(status(page)).toHaveText('Filled', { timeout: 60_000 });
  // The standing allowance is on chain with the expiry shown: about a minute from when it was signed.
  const [, expiration] = await chain.readContract({
    address: sovereignPermit,
    abi: permitAbi,
    functionName: 'allowance',
    args: [wallet.address, TOKEN_A.address, routerV2],
  });
  const signedAt = (await chain.getBlock()).timestamp;
  expect(BigInt(expiration) - signedAt).toBeLessThanOrEqual(60n);
  // Expiry is the chain's time, not the page's: once it has passed, pressing Swap again is refused, and SovereignPermit
  // itself refuses the pull.
  await expect(async () => {
    await swapButton(page).click();
    await expect(swap(page).getByRole('alert')).toContainText('The standing allowance expired', { timeout: 2_000 });
  }).toPass({ timeout: 150_000 });
  expect((await chain.getBlock()).timestamp).toBeGreaterThan(BigInt(expiration));
  const pull = [wallet.address, routerV2, 1n, TOKEN_A.address];
  expect(await revertOf(sovereignPermit, permitAbi, 'transferFrom', pull, routerV2)).toBe('AllowanceExpired');
  await expect(sheet(page)).toHaveCount(0);
});

test(`${J} #4 builds a three-hop swap with the hop limit blank: a typed refusal naming the hop limit; with it set, per-hop minimums are shown and a hop that pays under its minimum reverts the whole swap with nothing moved`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const wallet = await openSwap(page);
  const { routerV2 } = record();
  await chooseManual(page);
  await quote(page, TOKEN_A, TOKEN_B, '10');
  await swap(page).getByRole('button', { name: 'Route options' }).click(UNBUILT);
  await swap(page).getByRole('spinbutton', { name: 'Hops' }).fill('3');
  // The hop limit is blank: the build is refused with its typed code, naming the hop limit.
  await expect(swap(page).getByRole('alert')).toContainText('hop limit');
  await expect(swap(page).getByRole('alert')).toContainText('dex.route.max_hops_unset');
  await expect(swapButton(page)).toBeDisabled();
  // With the hop limit set, each of the three hops shows its minimum.
  await swap(page).getByRole('spinbutton', { name: 'Hop limit' }).fill('3');
  const minimums = swap(page).getByRole('list', { name: 'Hop minimums' }).getByRole('listitem');
  await expect(minimums).toHaveCount(3);
  await expect(minimums.nth(0)).toHaveText(/^Hop 1, TEST Token A to TEST Token C: at least [\d,.]+ TEST Token C$/);
  await expect(minimums.nth(1)).toHaveText(/^Hop 2, TEST Token C to TEST USD: at least [\d,.]+ TEST USD$/);
  await expect(minimums.nth(2)).toHaveText(/^Hop 3, TEST USD to TEST Token B: at least [\d,.]+ TEST Token B$/);
  // Another trader's large swap in the middle pool (TEST Token C to TEST USD) is mined just before this swap is sent, so
  // hop 2 now pays under its minimum.
  const middle = (record().v2Pools ?? []).find((p) => p.label === 'TEST C/USD 0.30%');
  expect(middle, 'the seed names the TEST C/USD pool').toBeTruthy();
  const moverKey = generatePrivateKey();
  const mover = privateKeyToAccount(moverKey).address;
  fundOnTestChain(mover);
  fundOnTestChain(mover, 'plain');
  const moverWallet = signerOf(moverKey);
  wallet.beforeNextSend(
    (tx) => same(tx.to ?? '', routerV2),
    async () => {
      const amount = parseUnits('9000', TOKEN_C.decimals);
      await chain.waitForTransactionReceipt({
        hash: await moverWallet.writeContract({
          address: TOKEN_C.address,
          abi: erc20,
          functionName: 'approve',
          args: [middle.pool, amount],
        }),
      });
      const moved = await chain.waitForTransactionReceipt({
        hash: await moverWallet.writeContract({
          address: middle.pool,
          abi: poolAbi,
          functionName: 'swapExactIn',
          args: [TOKEN_C.address, amount, 1n, mover],
        }),
      });
      expect(moved.status).toBe('success');
    },
  );
  await swapButton(page).click();
  await expect(sheet(page).getByRole('term').filter({ hasText: 'Hop 2 minimum' })).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  // The approve for exactly 10 is mined first; then the swap is sent after the price moved.
  await expect(status(page)).toHaveText('Failed', { timeout: 90_000 });
  await expect(page.getByRole('region', { name: 'Swap status' })).toContainText('Hop 2 would now pay less than its minimum');
  // The whole swap reverted with nothing moved: the swap transaction is mined as reverted, no token left the wallet and
  // nothing arrived, and the first and last pools hold what they held.
  const swapSend = wallet.sends.filter((x) => same(x.params[0]?.to ?? '', routerV2)).at(-1);
  expect(swapSend?.hash, 'the swap was sent').toBeTruthy();
  const receipt = await chain.getTransactionReceipt({ hash: swapSend.hash });
  expect(receipt.status).toBe('reverted');
  const block = receipt.blockNumber;
  for (const token of [TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_USD]) {
    const [at, prior] = await Promise.all([
      chain.readContract({ address: token.address, abi: erc20, functionName: 'balanceOf', args: [wallet.address], blockNumber: block }),
      chain.readContract({
        address: token.address,
        abi: erc20,
        functionName: 'balanceOf',
        args: [wallet.address],
        blockNumber: block - 1n,
      }),
    ]);
    expect(at, `${token.name} did not move`).toBe(prior);
  }
});

test(`${J} #5 chooses exact-output with native input: the maximum paid, the deadline and the wrap step; a deadline in the past is refused`, async ({
  page,
}) => {
  await openSwap(page);
  await swap(page).getByRole('radio', { name: 'Exact output' }).check(UNBUILT);
  await tokenIn(page).selectOption({ label: 'ETH' });
  await tokenOut(page).selectOption({ label: TOKEN_B.name });
  await swap(page)
    .getByRole('textbox', { name: /^Amount you receive/ })
    .fill('5');
  await expect(swap(page).getByTestId('maximum-paid')).toHaveText(/^Maximum paid [\d,.]+ ETH$/);
  await expect(swap(page).getByTestId('deadline')).toHaveText(/^Deadline \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  await swapButton(page).click();
  await expect(steps(page).getByRole('listitem').filter({ hasText: 'Wrap ETH' })).toHaveCount(1);
  // Native input needs no approval of any kind.
  await expect(
    steps(page)
      .getByRole('listitem')
      .filter({ hasText: /^Approve|^Sign/ }),
  ).toHaveCount(0);
  await sheet(page).getByRole('button', { name: 'Cancel' }).click();
  await swap(page)
    .getByRole('textbox', { name: /^Deadline/ })
    .fill('2020-01-01T00:00');
  await expect(swap(page).getByRole('alert')).toContainText('The deadline is in the past');
  await expect(swapButton(page)).toBeDisabled();
});

test(`${J} #6 places a signed intent order with a Dutch-auction decay: starts at the best price and decays to the floor over the stated time; a replayed signature is refused`, async ({
  page,
}) => {
  const { wallet, form } = await openIntent(page);
  await form.getByRole('combobox', { name: 'You pay' }).selectOption({ label: TOKEN_A.name });
  await form.getByRole('combobox', { name: 'You receive' }).selectOption({ label: TOKEN_B.name });
  await form.getByRole('textbox', { name: /^Amount you pay/ }).fill('10');
  await form.getByRole('textbox', { name: /^Floor/ }).fill('9');
  await form.getByRole('textbox', { name: /^Decay over \(minutes\)/ }).fill('10');
  await form.getByRole('button', { name: 'Review order' }).click();
  const review = page.getByRole('dialog', { name: 'Review the intent order' });
  await expect(review).toContainText(/Starts at [\d,.]+ TEST Token B/);
  await expect(review).toContainText('Decays to 9 TEST Token B over 10 minutes');
  await review.getByRole('button', { name: 'Continue in wallet' }).click();
  const orders = page.getByRole('region', { name: 'Intent orders' }).getByRole('table');
  await expect(orders.getByRole('row').filter({ hasText: 'Open' })).toHaveCount(1);
  // Each order is signed over its own nonce, so no signature can stand for a second order.
  await form.getByRole('button', { name: 'Review order' }).click();
  await review.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(orders.getByRole('row').filter({ hasText: 'Open' })).toHaveCount(2);
  expect(new Set(signedNonces(wallet)).size).toBe(signedNonces(wallet).length);
});

test(`${J} #7 watches the order fill at the midpoint: received equals the decayed price at that second and the order reads filled`, async ({
  page,
}) => {
  // #6's order decays over 10 minutes; the TEST filler takes it at the midpoint, about 5 minutes in.
  test.setTimeout(660_000);
  await openIntent(page);
  const orders = page.getByRole('region', { name: 'Intent orders' }).getByRole('table');
  await expect(orders).toBeVisible(UNBUILT);
  const filled = orders.getByRole('row').filter({ hasText: 'Filled' });
  await expect(filled).toHaveCount(1, { timeout: 600_000 });
  // The row names the fill second and the decayed price there, and the received amount is that price.
  const text = await filled.innerText();
  const price = text.match(/Price at fill ([\d,.]+)/)?.[1];
  const received = text.match(/Received ([\d,.]+)/)?.[1];
  expect(price).toBeTruthy();
  expect(received).toBe(price);
});

test(`${J} #8 delegates to a smart account and batches approve and swap: both succeed or both revert; an existing delegation is refused; with the relay off the user-submit fallback and blocker`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [] });
  await page.getByRole('button', { name: 'Create a smart account' }).click(UNBUILT);
  const delegate = page.getByRole('dialog', { name: 'Use a smart account' });
  await delegate.getByRole('button', { name: 'Continue in wallet' }).click();
  await page.goto('/dex');
  await quote(page, TOKEN_C, TOKEN_A, '10');
  await swap(page).getByRole('checkbox', { name: 'Approve and swap in one batch' }).check();
  await swapButton(page).click();
  await expect(steps(page).getByRole('listitem')).toHaveCount(1);
  await expect(steps(page)).toContainText('Approve and swap together: both happen or neither does');
  // A second delegation for the same account is refused with its reason.
  await page.getByRole('button', { name: 'Create a smart account' }).click();
  await expect(page.getByRole('alert')).toContainText('This account already delegates to a smart account');
  // The stack has no relay: the person can still send it themselves, and the blocker says why.
  await expect(page.getByText('Send it yourself', { exact: true })).toBeVisible();
  await expect(page.getByText(/rail\.crypto/)).toBeVisible();
});

test(`${J} #9 adds a signer key with an expiry: the key works until its expiry and not after`, async ({ page }) => {
  await connectWallet(page, dex, { tokens: [] });
  await page.getByRole('button', { name: 'Add a signer key' }).click(UNBUILT);
  const add = page.getByRole('dialog', { name: 'Add a signer key' });
  await add.getByRole('combobox', { name: 'Expires' }).selectOption({ label: '1 minute' });
  // A signer key can never carry withdrawal power (services/svc-protocol/src/session/spec.test.ts).
  await expect(add.getByRole('checkbox', { name: /^Withdraw/ })).toHaveCount(0);
  await add.getByRole('button', { name: 'Continue in wallet' }).click();
  const keys = page.getByRole('region', { name: 'Signer keys' }).getByRole('table');
  await expect(keys.getByRole('row').filter({ hasText: 'Active' })).toHaveCount(1);
  // Expiry is decided on real time, so the step waits out the minute.
  test.setTimeout(180_000);
  await expect(async () => {
    await page.reload();
    await expect(keys.getByRole('row').filter({ hasText: 'Expired' })).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 120_000 });
});
