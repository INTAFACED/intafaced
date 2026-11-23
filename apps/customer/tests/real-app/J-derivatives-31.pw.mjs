// World: restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { personDoor } from './person-door.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenuePage,
  sameDecimal,
  testDeposit,
  testVenue,
  venueAccount,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';
import { doorCalls, ledgerView } from './venue-door.mjs';

// J-derivatives-31, "I put money in a venue vault, see it counted, and take it out after its lock-up", in the running app
// against the stack's TEST venue simulator. One test per step, titled "J-derivatives-31 #<n>", run in order on one TEST
// person. The vault and the money in it are the venue's: every figure here is compared with the venue's own record
// (`/vaults`, `/vault-holdings`, `/balances`), read straight from the TEST venue and never through our door. A deposit and
// a withdrawal are the person's own signed venue transfers, each sent once; the ledger posts nothing.
//
// TEST setup in the journey's start (the "starts:" test): a verified TEST person with a TEST browser wallet whose venue
// account holds TEST 500 USDC. The TEST venue lists its protocol vault and a user-led vault. #5 uses the simulator's TEST
// control `/test/vault-lockup`: the venue's clock passes this person's lock-up in the protocol vault, and no one else's.
const J = 'J-derivatives-31';
const ROOM = '/trade/vaults';
const START_USDC = '500';
const DEPOSIT = '100';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const { state } = personDoor(J, run, test);

// ── the TEST venue's own record ──

const vaultsOf = async () => (await testVenue('/vaults', {})).body.value;
const holdingsOf = async (owner) => (await venueRecord(owner, '/vault-holdings')).value;
const freeOf = async (owner) => (await venueRecord(owner, '/balances')).value.find((b) => b.asset === 'USDC')?.free ?? '0';
const protocolVault = async () => {
  const vault = (await vaultsOf()).find((v) => v.kind === 'protocol');
  if (!vault) throw new Error(`${J}: the TEST venue lists no protocol vault`);
  return vault;
};
const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;

// ── the room ──

const openVaults = async (page) => openVenuePage(page, state().who, ROOM, state().walletKey);
const vaultRow = (page, address) => page.getByTestId('vaults-list').locator(`tr[data-vault="${address}"]`);
const positionRow = (page, address) => page.getByTestId('vault-positions').locator(`tr[data-position="${address}"]`);
const form = (page) => page.getByTestId('vault-move');

/** A lock-up in seconds as the room words it: whole days, one day, or hours. */
const lockUpWords = (s) =>
  s === null ? 'not published' : s === 86_400 ? '1 day' : s % 86_400 === 0 ? `${s / 86_400} days` : `${Math.round(s / 3600)} hours`;
const percent = (bps) => `${bps < 0 ? '-' : ''}${Math.floor(Math.abs(bps) / 100)}.${String(Math.abs(bps) % 100).padStart(2, '0')}`;

test(`${J} starts: signed in, verified, a TEST wallet with TEST 500 USDC in its venue account; the TEST venue lists its protocol vault and a user-led vault`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = await signUp(page, 'jd31');
  await verify(page, who);
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  run.reset({ who, walletKey });
  expect(await testDeposit(owner, 'USDC', START_USDC, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  expect(sameDecimal(await freeOf(owner), START_USDC)).toBe(true);
  const kinds = (await vaultsOf()).map((v) => v.kind).sort();
  expect(kinds).toEqual(['protocol', 'user']);
  expect((await holdingsOf(owner)).positions).toEqual([]);
  run.write({ ledger: await ledgerView(who) });
});

test(`${J} #1 opens Vaults: the venue's vaults, each with its lock-up, leader profit share, value and past return as the venue publishes them, with an as-of time; a figure the venue doesn't publish reads "not published"`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openVaults(page);
  const { displayName } = await venueInfo();
  const list = page.getByTestId('vaults-list');
  await expect(list.locator('tr[data-vault]')).toHaveCount((await vaultsOf()).length, { timeout: 30_000 });
  await expect(page.getByTestId('vaults-source')).toContainText(`From ${displayName}`);
  const asOf = await page.getByTestId('vaults-source').locator('[data-as-of]').getAttribute('data-as-of');
  expect(Number.isNaN(Date.parse(asOf ?? ''))).toBe(false);
  // Each row is the venue's own figures, word for word; a figure it doesn't publish reads "not published".
  let unpublished = 0;
  for (const v of await vaultsOf()) {
    const row = vaultRow(page, v.address);
    await expect(row.locator('[data-cell="name"]')).toHaveText(v.name);
    await expect(row.locator('[data-cell="lock-up"]')).toHaveText(lockUpWords(v.lockUpSeconds));
    await expect(row.locator('[data-cell="share"]')).toHaveText(
      v.profitShareBps === null ? 'not published' : `${percent(v.profitShareBps)}%`,
    );
    await expect
      .poll(async () => {
        const live = (await vaultsOf()).find((x) => x.address === v.address);
        const shown = await row.locator('[data-cell="value"]').getAttribute('data-value');
        return live.vaultValue === null ? shown === '' : sameDecimal(shown, live.vaultValue);
      })
      .toBe(true);
    await expect(row.locator('[data-cell="return"]')).toHaveText(
      v.pastReturn === null ? 'not published' : `${percent(v.pastReturn.bps)}% over ${v.pastReturn.days} days`,
    );
    for (const f of [v.lockUpSeconds, v.profitShareBps, v.vaultValue, v.pastReturn]) if (f === null) unpublished += 1;
  }
  // The venue publishes no past return for its user-led vault: the room says so and shows no figure of ours.
  const leader = (await vaultsOf()).find((v) => v.kind === 'user');
  expect(leader.pastReturn).toBeNull();
  await expect(vaultRow(page, leader.address).locator('[data-cell="return"]')).toHaveText('not published');
  expect(unpublished).toBeGreaterThan(0);
  await expect(vaultRow(page, leader.address).locator('[data-cell="run-by"]')).toContainText('Leader');
});

test(`${J} #2 deposits TEST 100 USDC into the protocol vault and signs: one signed venue transfer, sent once; the position with its value and lock-up end from the venue; free USDC falls by the venue's figure`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner } = state();
  const wallet = await openVaults(page);
  const calls = doorCalls(page);
  const vault = await protocolVault();
  const freeBefore = await freeOf(owner);
  await vaultRow(page, vault.address).getByTestId('vault-deposit').click();
  await expect(form(page)).toHaveAttribute('data-direction', 'deposit');
  await form(page).getByTestId('vault-amount').fill(DEPOSIT);
  await form(page).getByTestId('vault-review').click();
  await expect(form(page).getByTestId('vault-review-line')).toContainText(`${DEPOSIT} USDC`);
  await expect(form(page).getByTestId('vault-review-line')).toContainText(lockUpWords(vault.lockUpSeconds));
  const asked = signatures(wallet);
  await form(page).getByTestId('vault-sign').click();
  await continueInWallet(page);
  const result = form(page).getByTestId('vault-result');
  await expect(result).toHaveAttribute('data-accepted', 'true', { timeout: 30_000 });
  // One signature, one prepare and one submit: one signed venue transfer into the protocol vault of exactly 100 USDC.
  expect(signatures(wallet)).toBe(asked + 1);
  expect(calls.of('prepare')).toHaveLength(1);
  expect(calls.of('submit')).toHaveLength(1);
  const intent = calls.of('prepare')[0].body.intent;
  expect(intent).toMatchObject({ kind: 'vault_transfer', vault: vault.address, direction: 'deposit', asset: 'USDC' });
  expect(sameDecimal(intent.amount, DEPOSIT)).toBe(true);
  // The venue's record: one deposit transfer, a position of 100 with its lock-up end, free USDC down by 100.
  const held = await holdingsOf(owner);
  expect(held.transfers.filter((x) => x.direction === 'deposit')).toHaveLength(1);
  const position = held.positions.find((p) => p.vault === vault.address);
  expect(sameDecimal(position.equity, DEPOSIT)).toBe(true);
  const freeAfter = await freeOf(owner);
  expect(toUnits(freeBefore) - toUnits(freeAfter)).toBe(toUnits(DEPOSIT));
  // The room shows the venue's figures: the position, its lock-up end, and free USDC before and after.
  await expect(form(page).getByTestId('vault-result-line')).toHaveText(
    `Deposited ${DEPOSIT} USDC into ${vault.name}: your position there is ${position.equity} USDC and its lock-up ends ${await page.evaluate((iso) => new Date(iso).toLocaleString(), position.lockUpEndsAt)}. Free USDC ${freeBefore} → ${freeAfter}, as ${(await venueInfo()).displayName} reports them.`,
  );
  const row = positionRow(page, vault.address);
  await expect
    .poll(async () => sameDecimal(await row.locator('[data-cell="equity"]').getAttribute('data-value'), position.equity), {
      timeout: 20_000,
    })
    .toBe(true);
  await expect(row.locator('[data-cell="ends"]')).toHaveAttribute('data-value', position.lockUpEndsAt);
  // Sent once: the same transfer again is the first one's stored answer; nothing is signed or submitted, nothing moves.
  await result.getByTestId('vault-again').click();
  await expect(form(page).getByTestId('vault-again-same')).toHaveText(
    'Already sent: nothing more moved. This is the first transfer’s result.',
    {
      timeout: 20_000,
    },
  );
  expect(signatures(wallet)).toBe(asked + 1);
  expect(calls.of('submit')).toHaveLength(1);
  expect((await holdingsOf(owner)).transfers).toHaveLength(held.transfers.length);
  expect(await freeOf(owner)).toBe(freeAfter);
  run.write({ deposited: { vault: vault.address, lockUpEndsAt: position.lockUpEndsAt } });
  expect(await ledgerView(state().who)).toEqual(state().ledger);
});

test(`${J} #3 opens /money: the vault position listed under the venue account with its source, counted in the account's total as the venue counts it in account value; the parts still add to the venue's total`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner } = state();
  await openVenuePage(page, state().who, '/money', state().walletKey);
  const { displayName } = await venueInfo();
  const held = await holdingsOf(owner);
  const position = held.positions.find((p) => p.vault === state().deposited.vault);
  const venuePanel = page.getByTestId('source-venue');
  // Listed under the venue account, with the venue as its source.
  const row = venuePanel.getByTestId('source-venue-vaults').locator(`tr[data-vault="${position.vault}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(position.name);
  await expect(row.locator('[data-cell="amount"]')).toHaveAttribute('data-value', position.equity);
  await expect(row.locator('[data-cell="source"]')).toContainText(`${displayName}’s own figure for your position in this vault`);
  // Counted in the account's total as the venue counts it in account value, and the parts add to the venue's figure.
  const line = venuePanel.getByTestId('source-venue-account-value');
  await expect
    .poll(async () => sameDecimal(await line.getAttribute('data-venue'), (await holdingsOf(owner)).accountValue.amount), {
      timeout: 20_000,
    })
    .toBe(true);
  await expect(line).toHaveAttribute('data-adds-up', 'true');
  await expect.poll(async () => sameDecimal(await line.getAttribute('data-parts'), held.accountValue.amount)).toBe(true);
  // The venue's figure: the 400 USDC left free and the 100 in the vault still make the 500 the account started with.
  const usdcRow = venuePanel.locator('tr[data-asset="USDC"]:not([data-vault])');
  await expect
    .poll(async () => toUnits((await usdcRow.locator('[data-cell="total"]').innerText()).replace(/,/g, '')) + toUnits(position.equity))
    .toBe(toUnits(held.accountValue.amount));
  expect(sameDecimal(held.accountValue.amount, START_USDC)).toBe(true);
  await expect(line).toContainText(`${displayName} counts your venue account’s value at`);
  await expect(line).toContainText('vault balances included');
  expect(await ledgerView(state().who)).toEqual(state().ledger);
});

test(`${J} #4 asks to withdraw before the lock-up ends: refused with the venue's lock-up end time; nothing signed`, async ({ page }) => {
  test.setTimeout(240_000);
  const { owner, deposited } = state();
  const wallet = await openVaults(page);
  const calls = doorCalls(page);
  const before = await holdingsOf(owner);
  const position = before.positions.find((p) => p.vault === deposited.vault);
  expect(Date.parse(position.lockUpEndsAt)).toBeGreaterThan(Date.now());
  await positionRow(page, deposited.vault).getByTestId('vault-withdraw').click({ timeout: 30_000 });
  await expect(form(page)).toHaveAttribute('data-direction', 'withdraw');
  await expect(form(page).getByTestId('vault-amount')).toHaveValue(position.equity);
  await form(page).getByTestId('vault-review').click();
  const asked = signatures(wallet);
  await form(page).getByTestId('vault-sign').click();
  const refused = form(page).getByTestId('vault-refused');
  await expect(refused).toBeVisible({ timeout: 20_000 });
  // The venue's refusal, with the venue's own lock-up end time, and nothing signed or sent.
  await expect(refused).toContainText(position.lockUpEndsAt);
  await expect(refused.getByTestId('vault-refused-ends')).toHaveAttribute('data-value', position.lockUpEndsAt);
  await expect(refused.getByTestId('vault-nothing-signed')).toHaveText('Nothing was signed or sent.');
  await expect(refused).toHaveAttribute('data-before-wallet', 'true');
  await expect(page.getByRole('dialog', { name: 'Check before you sign', exact: true })).toHaveCount(0);
  expect(signatures(wallet)).toBe(asked);
  // The door asked the venue once to prepare it, and the venue refused: nothing was submitted.
  expect(calls.of('prepare')).toHaveLength(1);
  expect(calls.of('submit')).toHaveLength(0);
  expect(await holdingsOf(owner)).toEqual(before);
  expect(await ledgerView(state().who)).toEqual(state().ledger);
});

test(`${J} #5 withdraws after the lock-up ends: one signed venue transfer, sent once; the amount back in free USDC and any profit share the leader took, as the venue reports them`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner, deposited } = state();
  // TEST: the venue's clock passes this person's lock-up in the protocol vault.
  const { status, body } = await testVenue('/test/vault-lockup', { account: await venueAccount(owner), vault: deposited.vault });
  expect(status, JSON.stringify(body)).toBe(200);
  expect(body.label).toBe('TEST');
  expect(Date.parse(body.lockUpEndsAt)).toBeLessThanOrEqual(Date.now());
  const wallet = await openVaults(page);
  const calls = doorCalls(page);
  const before = await holdingsOf(owner);
  const position = before.positions.find((p) => p.vault === deposited.vault);
  const freeBefore = await freeOf(owner);
  await positionRow(page, deposited.vault).getByTestId('vault-withdraw').click({ timeout: 30_000 });
  await form(page).getByTestId('vault-review').click();
  const asked = signatures(wallet);
  await form(page).getByTestId('vault-sign').click();
  await continueInWallet(page);
  const result = form(page).getByTestId('vault-result');
  await expect(result).toHaveAttribute('data-accepted', 'true', { timeout: 30_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  expect(calls.of('prepare')).toHaveLength(1);
  expect(calls.of('submit')).toHaveLength(1);
  expect(calls.of('prepare')[0].body.intent).toMatchObject({ kind: 'vault_transfer', vault: deposited.vault, direction: 'withdraw' });
  // The venue's record of the withdrawal: what came back to free USDC and the leader's share, and the position is gone.
  const after = await holdingsOf(owner);
  const transfer = after.transfers.find((x) => x.direction === 'withdraw');
  expect(after.transfers.filter((x) => x.direction === 'withdraw')).toHaveLength(1);
  expect(sameDecimal(transfer.amount, position.equity)).toBe(true);
  expect(toUnits(transfer.creditedAmount) + toUnits(transfer.leaderShare)).toBe(toUnits(transfer.amount));
  expect(after.positions.find((p) => p.vault === deposited.vault)).toBeUndefined();
  const freeAfter = await freeOf(owner);
  expect(toUnits(freeAfter) - toUnits(freeBefore)).toBe(toUnits(transfer.creditedAmount));
  // The room shows the venue's own figures for both.
  await expect(result).toHaveAttribute('data-credited', transfer.creditedAmount);
  await expect(result).toHaveAttribute('data-leader-share', transfer.leaderShare);
  const vault = await protocolVault();
  await expect(form(page).getByTestId('vault-result-line')).toHaveText(
    `Withdrew ${transfer.amount} USDC from ${vault.name}: ${transfer.creditedAmount} USDC back in free USDC (free ${freeBefore} → ${freeAfter}), and the leader took ${transfer.leaderShare} USDC as its profit share, as ${(await venueInfo()).displayName} reports them.`,
  );
  // Sent once: the same transfer again moves nothing more.
  await result.getByTestId('vault-again').click();
  await expect(form(page).getByTestId('vault-again-same')).toBeVisible({ timeout: 20_000 });
  expect(calls.of('submit')).toHaveLength(1);
  expect(await freeOf(owner)).toBe(freeAfter);
  await expect(page.getByTestId('vault-positions')).toContainText('You have nothing in a vault.', { timeout: 20_000 });
  expect(await ledgerView(state().who)).toEqual(state().ledger);
});
