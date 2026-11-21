// World: restart
import { encodeFunctionData, erc20Abi, formatUnits } from 'viem';
import { test, expect } from './journey.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { journeyState } from './stack.mjs';
import { PASSKEY_ORIGIN } from './identity-factors.mjs';
import { TOKEN_USD, fundOnTestChain } from './dex.mjs';
import { chainRpc, chainTransfers, chainUsd, mineBlocks, withMiningPaused } from './chain-node.mjs';
import { sameDecimal, testVenue, venueBalance, venueForThisFile, venueRecord } from './venue.mjs';
import { ledgerView } from './venue-door.mjs';
import { device, openRoom, recorded } from './embedded-wallet.mjs';

// J-wallet-24, in the running app: my new wallet's first deposit reaches the venue, on the right chain, of the right asset,
// with gas. One test per step, titled "J-wallet-24 #<n>", run in order by one signed-up TEST person whose wallet #1 makes
// as J-wallet-22 does: the stack's labelled TEST embedded-wallet provider (tooling/scripts/local-test-wallet-provider.mjs)
// keeps the key and signs only after the passkey on the person's device (Chromium's virtual authenticator, on
// PASSKEY_ORIGIN). The page reads the TEST chain through the provider's own connection, and the provider sends the person's
// own signed transfer, once per nonce. The whole file runs with the TEST venue door on (venue.mjs `venueForThisFile`); the
// venue's bridge is its TEST deposit address on the stack's TEST chain, taking TEST USD as USDC (local-test-venue.mjs).
// The TEST chain funds the wallet with 100 TEST USD and no TEST ETH (`fund … stable`); #3 gives it TEST ETH with the chain's
// own control (`anvil_setBalance`). The TEST venue's control `/test/deposit-route` publishes another route for BTC (an
// asset of its markets its bridge does not take) and none for XAU; #6 takes BTC's route back off.
// Money: INTAFACED moves nothing and the ledger posts nothing (the person's ledger balances are the same before and after);
// no gas is paid for the person while the owner's gas-sponsor setting is blank (`wallet.gas_sponsor_unset`).
const J = 'J-wallet-24';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const SPONSOR_UNSET = 'wallet.gas_sponsor_unset';
const ROUTED = 'BTC';
const ROUTED_NETWORK = 'TEST bitcoin';
const ROUTED_HOW = 'TEST: send BTC on TEST bitcoin to the address the venue gives you for it. A transfer on TEST chain is not credited.';
const UNROUTED = 'XAU';
const DEPOSIT = '10';
const ONE_ETH = 10n ** 18n;

test.describe.configure({ mode: 'default' });
test.use({ baseURL: PASSKEY_ORIGIN });
venueForThisFile(test);

function walletState() {
  const s = run.read();
  if (!s.who || !s.address || !s.credential) throw new Error(`${J} #1 made no wallet, so this step has no one to act as`);
  return s;
}

/** The deposit route the TEST venue itself publishes: its chain, token, address, asset, minimum and warning. */
async function venueRoute() {
  const { status, body } = await testVenue('/venue');
  expect(status).toBe(200);
  expect(body.deposit, 'the TEST venue publishes a deposit route').toBeTruthy();
  return body.deposit;
}

/** The wallet's TEST ETH and transaction count on the TEST chain, read from the node itself. */
async function chainWallet(address) {
  const [gas, nonce] = await Promise.all([
    chainRpc('eth_getBalance', [address, 'latest']),
    chainRpc('eth_getTransactionCount', [address, 'pending']),
  ]);
  return { gas: BigInt(gas), nonce: Number(BigInt(nonce)) };
}

/** Every send the page asks the wallet provider to sign, counted on the way out. */
function sends(page) {
  const asked = [];
  page.on('request', (r) => r.url().includes('/__test-wallet-provider/client/sendtx') && asked.push(r.url()));
  return asked;
}

const deposit = (page) => page.locator('[data-panel="venue-deposit"]');

async function openDeposit(page, who, credential) {
  await device(page, [credential]);
  await openRoom(page, who);
  await expect(deposit(page).getByRole('heading', { name: 'Deposit to the venue', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(deposit(page).getByTestId('wallet-balances-as-of')).toBeVisible({ timeout: 20_000 });
}

/** The as-of time shown is a real time from the chain's newest block, not older than the step. */
async function shownAsOf(locator, since) {
  const at = await locator.getAttribute('datetime');
  expect(Number.isNaN(Date.parse(at)), `as-of ${at} is a time`).toBe(false);
  expect(Date.parse(at)).toBeGreaterThanOrEqual(since - 60_000);
  return at;
}

test(`${J} #1 opens Deposit to the venue: the chain and asset the venue's bridge takes, named; its minimum or "not published"; its warning for other chains; the wallet's balance of that asset and of the gas token, read from the chain with an as-of time`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  // The person and their wallet, made as in J-wallet-22: signed up, Create my wallet with a passkey on this device.
  const phone = await device(page);
  const who = await signUp(page, 'jwallet24');
  await openRoom(page, who);
  await page.getByRole('button', { name: 'Create my wallet', exact: true }).click();
  const shownAddress = page.locator('[data-embedded-address]');
  await expect(shownAddress).toHaveText(/^0x[0-9a-fA-F]{40}$/, { timeout: 20_000 });
  const { wallet } = await recorded(who);
  const [credential] = await phone.held();
  // The venue door reads an account for a verified person only (the trade jurisdiction's tier), as J-wallet-22's person
  // verifies before trading there; this person verifies once, then comes back to the room.
  await verify(page, who);
  await signIn(page, who);
  await page.goto('/wallet/embedded');
  // TEST USD on the venue bridge's chain, and none of that chain's gas token.
  fundOnTestChain(wallet.address, 'stable');
  // The TEST venue publishes another route for one asset its bridge does not take, and none for a second.
  expect((await testVenue('/test/deposit-route', { asset: ROUTED, route: { network: ROUTED_NETWORK, how: ROUTED_HOW } })).status).toBe(200);
  expect((await testVenue('/test/deposit-route', { asset: UNROUTED, route: null })).status).toBe(200);
  run.reset({ who, address: wallet.address, credential, ledger: await ledgerView(who) });

  const since = Date.now();
  await page.reload();
  await expect(deposit(page).getByTestId('wallet-balances-as-of')).toBeVisible({ timeout: 20_000 });
  const route = await venueRoute();
  // The venue's own terms, word for word.
  await expect(deposit(page).getByTestId('deposit-chain')).toHaveText(route.network);
  await expect(deposit(page).getByTestId('deposit-asset')).toHaveText(route.asset);
  await expect(deposit(page).getByTestId('deposit-minimum')).toHaveText(
    route.minimum ? `${route.minimum} ${route.asset}` : 'not published',
  );
  await expect(deposit(page).getByTestId('deposit-warning')).toHaveText(route.warning);
  // The wallet's balances, as the TEST chain itself reports them: 100 TEST USD and no TEST ETH.
  expect(await chainUsd(wallet.address)).toBe(100_000_000n);
  expect((await chainWallet(wallet.address)).gas).toBe(0n);
  await expect(deposit(page).getByTestId('wallet-token-balance')).toHaveText(`100 ${route.asset}`);
  await expect(deposit(page).getByTestId('wallet-gas-balance')).toHaveText('0 ETH');
  await shownAsOf(deposit(page).getByTestId('wallet-balances-as-of'), since);
  await expect(deposit(page).locator('[data-deposit-test-label]')).toHaveText('TEST venue and TEST chain: TEST figures, no real money.');
});

test(`${J} #2 tries to deposit with none of the chain's gas token: stopped before signing, the gas token named, the estimated network fee or "not known", how to add it; no sponsored deposit while the gas-sponsor setting is blank; nothing signed`, async ({
  page,
}) => {
  const { who, address, credential, ledger } = walletState();
  const asked = sends(page);
  await openDeposit(page, who, credential);
  const before = await chainWallet(address);
  expect(before.gas).toBe(0n);

  await deposit(page)
    .getByLabel(/^Amount/)
    .fill(DEPOSIT);
  const route = await venueRoute();
  const stop = deposit(page).locator('[data-deposit-stop="no_gas"]');
  // With no block mined in between, the page and this test ask the chain the same thing at the same gas price.
  const chainFee = await withMiningPaused(async () => {
    await deposit(page).getByRole('button', { name: 'Deposit', exact: true }).click();
    await expect(stop).toBeVisible({ timeout: 20_000 });
    // The chain's own estimate for this very transfer (the venue's token, `transfer` to its bridge, of the amount typed),
    // times its own gas price: the TEST chain answers both, so the fee shown is that figure, never "not known".
    const units = BigInt(DEPOSIT) * 10n ** BigInt(route.tokenDecimals);
    const call = {
      from: address,
      to: route.token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [route.address, units] }),
      value: '0x0',
    };
    const [gas, price] = await Promise.all([chainRpc('eth_estimateGas', [call]), chainRpc('eth_gasPrice')]);
    return formatUnits(BigInt(gas) * BigInt(price), 18);
  });
  await expect(stop).toContainText(
    'Stopped before signing: your wallet holds no ETH, the gas token on TEST chain that pays this transfer’s network fee.',
  );
  const feeShown = stop.getByTestId('deposit-fee-estimate');
  await expect(feeShown).toHaveText(/^\d+(?:\.\d+)? ETH$/);
  const [feeFigure] = (await feeShown.textContent()).split(' ');
  expect(sameDecimal(feeFigure, chainFee), `the fee shown, ${feeFigure} ETH, is the chain's own estimate, ${chainFee} ETH`).toBe(true);
  await expect(stop).toContainText(`To add it, send ETH on TEST chain to your wallet address ${address}`);
  // No sponsored deposit: the owner's setting is blank, by its code, as svc-protocol reports it.
  expect((await recorded(who)).gasSponsor).toEqual({ set: false, code: SPONSOR_UNSET });
  await expect(stop.locator(`[data-gas-sponsor="${SPONSOR_UNSET}"]`)).toContainText('No sponsored deposit is offered');
  await expect(stop).toContainText('Nothing was signed.');
  // Nothing signed: the provider was never asked to send, and the chain has no transaction from the wallet.
  expect(asked).toEqual([]);
  expect(await chainWallet(address)).toEqual(before);
  expect(await chainUsd(address)).toBe(100_000_000n);
  expect(await ledgerView(who)).toEqual(ledger);
});

test(`${J} #3 adds TEST gas and types an amount below the venue's minimum: refused before signing, naming the venue's minimum; nothing sent`, async ({
  page,
}) => {
  const { who, address, credential } = walletState();
  // TEST ETH from the TEST chain's own control, as the person sending gas to their wallet from elsewhere.
  await chainRpc('anvil_setBalance', [address, `0x${ONE_ETH.toString(16)}`]);
  const asked = sends(page);
  await openDeposit(page, who, credential);
  await expect(deposit(page).getByTestId('wallet-gas-balance')).toHaveText('1 ETH', { timeout: 20_000 });
  const route = await venueRoute();
  expect(route.minimum).toBe('5');
  const before = await chainWallet(address);

  await deposit(page)
    .getByLabel(/^Amount/)
    .fill('4.5');
  await deposit(page).getByRole('button', { name: 'Deposit', exact: true }).click();
  await expect(deposit(page).locator('[data-deposit-stop="below_minimum"]')).toHaveText(
    `Refused before signing: the venue’s minimum deposit is 5 ${route.asset}. A smaller deposit is not credited. Nothing was sent.`,
  );
  expect(asked).toEqual([]);
  expect(await chainWallet(address)).toEqual(before);
  expect((await venueRecord(address, '/deposits')).value).toEqual([]);
});

test(`${J} #4 deposits TEST USDC and signs: one signed transfer to the venue's bridge, sent once; pending with its chain hash and network fee, then the venue credits it and the app shows the venue's figure with an as-of time; the ledger posts nothing`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { who, address, credential, ledger } = walletState();
  const route = await venueRoute();
  const asked = sends(page);
  await openDeposit(page, who, credential);
  await expect(deposit(page).getByTestId('wallet-gas-balance')).toHaveText('1 ETH', { timeout: 20_000 });
  const before = await chainWallet(address);

  const hash = await withMiningPaused(async () => {
    await deposit(page)
      .getByLabel(/^Amount/)
      .fill(DEPOSIT);
    const button = deposit(page).getByRole('button', { name: 'Deposit', exact: true });
    await button.click();
    const shown = deposit(page).getByTestId('deposit-hash');
    await expect(shown).toHaveText(/^0x[0-9a-f]{64}$/, { timeout: 30_000 });
    const sent = await shown.textContent();
    // Pending: the chain holds it, not yet mined, and the page says it waits for the chain.
    await expect(deposit(page).getByText('Waiting for TEST chain to include it.', { exact: true })).toBeVisible();
    const pending = await chainRpc('eth_getTransactionByHash', [sent]);
    expect(pending, 'the TEST chain holds the sent transaction').toBeTruthy();
    expect(pending.blockNumber).toBeNull();
    expect(pending.from.toLowerCase()).toBe(address.toLowerCase());
    expect(pending.to.toLowerCase()).toBe(route.token.toLowerCase());
    // The Deposit button is gone once it is sent: no second press can send it again.
    await expect(button).toHaveCount(0);
    await chainRpc('evm_mine');
    return sent;
  });

  // One transfer, of the deposit, to the venue's deposit address, of the bridge's token; sent once, at the next nonce.
  expect(asked).toHaveLength(1);
  expect(await chainTransfers(hash)).toEqual([
    { token: TOKEN_USD.address.toLowerCase(), to: route.address.toLowerCase(), value: 10_000_000n },
  ]);
  expect((await chainWallet(address)).nonce).toBe(before.nonce + 1);
  expect(await chainUsd(address)).toBe(90_000_000n);
  // The network fee the chain charged: its receipt's gas used times its effective price, in ETH.
  const receipt = await chainRpc('eth_getTransactionReceipt', [hash]);
  const fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  const feeCell = deposit(page).getByTestId('deposit-network-fee');
  await expect(feeCell).toHaveText(/^\d+(?:\.\d+)? ETH$/, { timeout: 20_000 });
  const feeShown = ((await feeCell.textContent()) ?? '').replace(/ ETH$/, '');
  expect(fee > 0n).toBe(true);
  expect(sameDecimal(feeShown, formatUnits(fee, 18)), `fee shown ${feeShown} is the chain's ${formatUnits(fee, 18)}`).toBe(true);

  // The venue credits it after its published confirmations: the app shows the venue's own figure with the venue's time.
  await mineBlocks(route.confirmations);
  const credited = deposit(page).locator('[data-deposit-status="credited"]');
  await expect(credited).toBeVisible({ timeout: 60_000 });
  const onVenue = await venueBalance(address, route.asset);
  expect(sameDecimal(onVenue.total, DEPOSIT)).toBe(true);
  await expect(deposit(page).getByTestId('deposit-venue-figure')).toHaveText(`${DEPOSIT} ${route.asset}`);
  await shownAsOf(deposit(page).getByTestId('deposit-venue-as-of'), Date.now() - 120_000);
  const deposits = (await venueRecord(address, '/deposits')).value;
  expect(deposits).toHaveLength(1);
  expect(deposits[0]).toMatchObject({ txHash: hash, asset: route.asset, status: 'credited' });
  // INTAFACED moved nothing: the person's ledger is as it was before the journey.
  expect(await ledgerView(who)).toEqual(ledger);
});

test(`${J} #5 picks the TEST asset the venue's bridge doesn't take on that chain but takes by another route: named as not taken there, with the venue's route for it, as the venue publishes it; nothing signed`, async ({
  page,
}) => {
  const { who, address, credential } = walletState();
  const asked = sends(page);
  await openDeposit(page, who, credential);
  const before = await chainWallet(address);
  await deposit(page).getByRole('combobox').selectOption(ROUTED);
  const way = deposit(page).locator('[data-asset-way="other_route"]');
  await expect(way).toContainText(
    `${ROUTED} is not taken on TEST chain. The venue takes it by another route: ${ROUTED_NETWORK}. Nothing was signed.`,
  );
  await expect(way).toContainText(`The venue says: ${ROUTED_HOW}`);
  // As the venue publishes it, read from the TEST venue itself.
  const published = (await venueRecord(address, '/deposit-routes')).value.find((r) => r.asset === ROUTED);
  expect(published).toEqual({ asset: ROUTED, network: ROUTED_NETWORK, how: ROUTED_HOW });
  // No amount and no Deposit for an asset not taken here; nothing asked of the wallet.
  await expect(deposit(page).getByRole('button', { name: 'Deposit', exact: true })).toHaveCount(0);
  expect(asked).toEqual([]);
  expect(await chainWallet(address)).toEqual(before);
});

test(`${J} #6 picks the TEST asset for which the venue publishes no route: named as not taken there, with "not offered"; nothing signed`, async ({
  page,
}) => {
  const { who, address, credential, ledger } = walletState();
  const asked = sends(page);
  try {
    await openDeposit(page, who, credential);
    const before = await chainWallet(address);
    const published = (await venueRecord(address, '/deposit-routes')).value.find((r) => r.asset === UNROUTED);
    expect(published).toEqual({ asset: UNROUTED, network: null, how: null });
    await deposit(page).getByRole('combobox').selectOption(UNROUTED);
    await expect(deposit(page).locator('[data-asset-way="not_offered"]')).toHaveText(
      `${UNROUTED} is not taken on TEST chain. Not offered: the venue publishes no route for ${UNROUTED}. Nothing was signed.`,
    );
    await expect(deposit(page).getByRole('button', { name: 'Deposit', exact: true })).toHaveCount(0);
    expect(asked).toEqual([]);
    expect(await chainWallet(address)).toEqual(before);
    expect(await ledgerView(who)).toEqual(ledger);
  } finally {
    // The TEST venue's route for BTC came from #1's control; it is taken back off so no other file sees it.
    await testVenue('/test/deposit-route', { asset: ROUTED, route: null });
  }
});
