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

// J-cex-spot-21, "I stake HYPE with a validator, see my trading-fee discount, and unstake", in the running app against the
// stack's TEST venue simulator. One test per step, titled "J-cex-spot-21 #<n>", run in order on one TEST person. Staking
// is the venue's: every figure here is compared with the venue's own record (`/staking`, `/staking-account`,
// `/balances`, `/fee-status`), read straight from the TEST venue and never through our door. Each move and delegation
// is the person's own signed venue action, sent once; the ledger posts nothing.
//
// TEST setup in the journey's start (the "starts:" test): a verified TEST person with a TEST browser wallet whose venue
// spot balance holds TEST 1000 HYPE; the TEST venue lists its validators. The simulator's TEST control `/test/staking`
// stands in for the venue's clock and the venue itself: it passes a delegation's lock-up (#6), lets the unstaking queue
// arrive (#7), pays a TEST reward (#8) and queues withdrawals up to the venue's limit (#9).
const J = 'J-cex-spot-21';
const ROOM = '/trade/staking';
const HYPE = 'HYPE';
const START = '1000';
const STAKE = '200';
const DELEGATE = '150';
const UNSTAKE = '50';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const { state, door, signAndSend } = personDoor(J, run, test);

// ── the TEST venue's own record ──

const terms = async () => {
  const { status, body } = await testVenue('/staking', {});
  expect(status, JSON.stringify(body)).toBe(200);
  return body.value;
};
const mine = async (owner) => (await venueRecord(owner, '/staking-account')).value;
const hypeOf = async (owner) =>
  (await venueRecord(owner, '/balances')).value.find((b) => b.asset === HYPE) ?? { asset: HYPE, free: '0', locked: '0', total: '0' };
const feeStatus = async (owner) => (await venueRecord(owner, '/fee-status')).value;
const staking = async (owner, set) => {
  const { status, body } = await testVenue('/test/staking', { account: await venueAccount(owner), ...set });
  expect(status, JSON.stringify(body)).toBe(200);
  expect(body.label).toBe('TEST');
  return body;
};
const validator = async (name) => {
  const v = (await terms()).validators.find((x) => x.name === name);
  if (!v) throw new Error(`${J}: the TEST venue lists no ${name}`);
  return v;
};
const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;
const localTime = (page, iso) => page.evaluate((x) => new Date(x).toLocaleString(), iso);

// ── the room ──

const openRoom = async (page, path = ROOM) => openVenuePage(page, state().who, path, state().walletKey);
const form = (page) => page.getByTestId('staking-move');
const validatorRow = (page, address) => page.getByTestId('staking-terms').locator(`tr[data-validator="${address}"]`);
const delegationRow = (page, address) => page.getByTestId('staking-delegations').locator(`tr[data-delegation="${address}"]`);
const percent = (bps) => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}`;

/** Fills the open form, reviews and signs; returns the wallet's signature count before signing. */
async function reviewAndSign(page, wallet, amount) {
  if (amount !== undefined) await form(page).getByTestId('staking-amount').fill(amount);
  await form(page).getByTestId('staking-review').click();
  await expect(form(page).getByTestId('staking-review-line')).toBeVisible();
  const asked = signatures(wallet);
  await form(page).getByTestId('staking-sign').click();
  return asked;
}

/** The step's one signed action went through: one signature, one prepare, one submit, accepted by the venue. */
async function sentOnce(page, wallet, calls, asked, intent) {
  await continueInWallet(page);
  const result = form(page).getByTestId('staking-result');
  await expect(result).toHaveAttribute('data-accepted', 'true', { timeout: 30_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  expect(calls.of('prepare')).toHaveLength(1);
  expect(calls.of('submit')).toHaveLength(1);
  const sent = calls.of('prepare')[0].body.intent;
  expect(sent).toMatchObject(intent);
  return { result, sent };
}

/** Sent once: the same action again is the first one's stored answer; nothing more is signed or submitted. */
async function againIsSame(page, wallet, calls, signed) {
  await form(page).getByTestId('staking-again').click();
  await expect(form(page).getByTestId('staking-again-same')).toHaveText('Already sent: nothing more moved. This is the first answer.', {
    timeout: 20_000,
  });
  expect(signatures(wallet)).toBe(signed);
  expect(calls.of('submit')).toHaveLength(1);
}

test(`${J} starts: signed in, verified, a TEST wallet with TEST 1000 HYPE in its venue spot balance; the TEST venue lists its validators`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = await signUp(page, 'js21');
  await verify(page, who);
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  run.reset({ who, walletKey });
  expect(await testDeposit(owner, HYPE, START, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  expect(sameDecimal((await hypeOf(owner)).free, START)).toBe(true);
  expect((await terms()).validators.length).toBeGreaterThan(0);
  expect((await mine(owner)).delegations).toEqual([]);
  // Our builder fee on each market before any staking, to show #4 leaves it as it is.
  const fees = await (await door()).get('/api/v1/venue/fees');
  expect(fees.status, JSON.stringify(fees.body).slice(0, 300)).toBe(200);
  const builder = Object.fromEntries(fees.body.value.markets.map((m) => [m.symbol, m.builderFeeBps]));
  run.write({ ledger: await ledgerView(who), builder });
});

test(`${J} #1 opens Staking: the venue's validators, each with its commission, stake and status as the venue reports them, and the reward rate and the staking fee-discount tiers as the venue publishes them, or "not published", with an as-of time`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openRoom(page);
  const { displayName } = await venueInfo();
  const t = await terms();
  const section = page.getByTestId('staking-terms');
  await expect(section.locator('tr[data-validator]')).toHaveCount(t.validators.length, { timeout: 30_000 });
  await expect(page.getByTestId('staking-source')).toContainText(`From ${displayName}`);
  const asOf = await page.getByTestId('staking-source').locator('[data-as-of]').getAttribute('data-as-of');
  expect(Number.isNaN(Date.parse(asOf ?? ''))).toBe(false);
  // Each validator is the venue's own figures.
  for (const v of t.validators) {
    const row = validatorRow(page, v.address);
    await expect(row.locator('[data-cell="name"]')).toHaveText(v.name);
    await expect(row.locator('[data-cell="commission"]')).toHaveText(
      v.commissionBps === null ? 'not published' : `${percent(v.commissionBps)}%`,
    );
    await expect
      .poll(async () => {
        const live = (await terms()).validators.find((x) => x.address === v.address);
        const shown = await row.locator('[data-cell="stake"]').getAttribute('data-value');
        return live.totalStake === null ? shown === '' : sameDecimal(shown, live.totalStake);
      })
      .toBe(true);
    await expect(row).toHaveAttribute('data-status', v.status);
    await expect(row.locator('[data-cell="status"]')).toHaveText(v.status[0].toUpperCase() + v.status.slice(1));
  }
  // The reward rate and the discount tiers as the venue publishes them.
  expect(t.rewardRateBps).not.toBeNull();
  await expect(page.getByTestId('staking-reward-rate')).toHaveText(`${percent(t.rewardRateBps)}% a year`);
  const tiers = page.getByTestId('staking-tiers').locator('tr[data-tier]');
  await expect(tiers).toHaveCount(t.discountTiers.length);
  for (const tier of t.discountTiers) {
    const row = page.getByTestId('staking-tiers').locator(`tr[data-tier="${tier.name}"]`);
    await expect
      .poll(async () => sameDecimal(await row.locator('[data-cell="from"]').getAttribute('data-value'), tier.fromStaked))
      .toBe(true);
    await expect(row.locator('[data-cell="discount"]')).toHaveText(`${percent(tier.discountBps)}%`);
  }
  // TEST: the venue withholds its reward rate; the room says "not published" and shows no figure of ours.
  const off = await testVenue('/test/staking-published', { rewardRate: false });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  try {
    expect(off.body.rewardRateBps).toBeNull();
    await page.reload();
    await expect(page.getByTestId('staking-reward-rate')).toHaveText('not published', { timeout: 30_000 });
    await expect(page.getByTestId('staking-reward-rate')).toHaveAttribute('data-value', '');
  } finally {
    const on = await testVenue('/test/staking-published', { rewardRate: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
  }
});

test(`${J} #2 moves TEST HYPE from spot to staking and signs: one signed venue action, sent once; the staking balance from the venue`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner } = state();
  const wallet = await openRoom(page);
  const calls = doorCalls(page);
  const before = await mine(owner);
  const spotBefore = (await hypeOf(owner)).free;
  await page.getByTestId('staking-stake').click({ timeout: 30_000 });
  await expect(form(page)).toHaveAttribute('data-action', 'to_staking');
  const asked = await reviewAndSign(page, wallet, STAKE);
  const { sent } = await sentOnce(page, wallet, calls, asked, { kind: 'staking_transfer', direction: 'to_staking', asset: HYPE });
  expect(sameDecimal(sent.amount, STAKE)).toBe(true);
  // The venue's record: the staking balance up by 200 and spot down by 200.
  const after = await mine(owner);
  expect(toUnits(after.staked) - toUnits(before.staked)).toBe(toUnits(STAKE));
  const spotAfter = (await hypeOf(owner)).free;
  expect(toUnits(spotBefore) - toUnits(spotAfter)).toBe(toUnits(STAKE));
  // The room shows the venue's figures.
  await expect(form(page).getByTestId('staking-result-line')).toHaveText(
    `Moved ${STAKE} HYPE from spot to staking: staking balance ${before.staked} → ${after.staked}, spot ${spotBefore} → ${spotAfter}, as ${(await venueInfo()).displayName} reports them.`,
  );
  await expect
    .poll(async () => sameDecimal(await page.getByTestId('staking-balance').getAttribute('data-value'), after.staked), { timeout: 20_000 })
    .toBe(true);
  await againIsSame(page, wallet, calls, asked + 1);
  expect((await mine(owner)).staked).toBe(after.staked);
  expect((await hypeOf(owner)).free).toBe(spotAfter);
  expect(await ledgerView(state().who)).toEqual(state().ledger);
});

test(`${J} #3 delegates it to one validator and signs: one signed venue action, sent once; the delegation from the venue, with the time the venue says its lock-up ends`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner } = state();
  const v = await validator('TEST Validator One');
  const wallet = await openRoom(page);
  const calls = doorCalls(page);
  const stakedBefore = (await mine(owner)).staked;
  await validatorRow(page, v.address).getByTestId('staking-delegate').click({ timeout: 30_000 });
  await expect(form(page)).toHaveAttribute('data-action', 'delegate');
  await expect(form(page)).toHaveAttribute('data-validator', v.address);
  const asked = await reviewAndSign(page, wallet, DELEGATE);
  const { sent } = await sentOnce(page, wallet, calls, asked, {
    kind: 'staking_delegate',
    validator: v.address,
    direction: 'delegate',
    asset: HYPE,
  });
  expect(sameDecimal(sent.amount, DELEGATE)).toBe(true);
  // The venue's record: one delegation of 150 to that validator, with its lock-up end, and the staking balance down by 150.
  const after = await mine(owner);
  expect(after.delegations).toHaveLength(1);
  const d = after.delegations[0];
  expect(d.validator).toBe(v.address);
  expect(sameDecimal(d.amount, DELEGATE)).toBe(true);
  expect(Date.parse(d.lockUpEndsAt)).toBeGreaterThan(Date.now());
  expect(toUnits(stakedBefore) - toUnits(after.staked)).toBe(toUnits(DELEGATE));
  // The room shows the delegation and the venue's lock-up end.
  await expect(form(page).getByTestId('staking-result-line')).toHaveText(
    `Delegated ${DELEGATE} HYPE to ${v.name}: delegated there 0 → ${d.amount}, and the lock-up ends ${await localTime(page, d.lockUpEndsAt)}, as ${(await venueInfo()).displayName} reports them.`,
  );
  const row = delegationRow(page, v.address);
  await expect
    .poll(async () => sameDecimal(await row.locator('[data-cell="amount"]').getAttribute('data-value'), d.amount), { timeout: 20_000 })
    .toBe(true);
  await expect(row.locator('[data-cell="ends"]')).toHaveAttribute('data-value', d.lockUpEndsAt);
  await againIsSame(page, wallet, calls, asked + 1);
  expect(await mine(owner)).toEqual(after);
  run.write({ delegated: { validator: v.address, name: v.name, lockUpEndsAt: d.lockUpEndsAt } });
  expect(await ledgerView(state().who)).toEqual(state().ledger);
});

test(`${J} #4 opens My tier: the venue's staking discount for the staked amount, applied to the venue's fee and named apart from our builder fee, which is unchanged, as the venue reports them`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner, builder } = state();
  await openRoom(page, '/fees/my-tier');
  const discount = (await feeStatus(owner)).account.stakingDiscount;
  // The venue counts the delegated stake and places it in a tier with a discount above zero.
  expect(sameDecimal(discount.countedStake, DELEGATE)).toBe(true);
  expect(discount.tierName).not.toBeNull();
  expect(discount.discountBps).toBeGreaterThan(0);
  const line = page.getByTestId('tier-staking-line');
  await expect(line).toHaveAttribute('data-tier', discount.tierName, { timeout: 30_000 });
  await expect(line).toHaveAttribute('data-discount', String(discount.discountBps));
  await expect(line).toHaveText(
    `The venue counts ${discount.countedStake} HYPE staked: tier ${discount.tierName}, ${percent(discount.discountBps)}% off the venue’s own fee.`,
  );
  // Each market: the venue's fee before and after the discount, as the venue reports them; at least one fee is lowered.
  let lowered = 0;
  for (const m of discount.markets) {
    const row = page.locator(`[data-fees="staking-markets"] tr[data-market="${m.symbol}"]`);
    for (const [cell, rate] of [
      ['maker-before', m.before.makerFeeBps],
      ['maker-after', m.after.makerFeeBps],
      ['taker-before', m.before.takerFeeBps],
      ['taker-after', m.after.takerFeeBps],
    ]) {
      const shown = await row.locator(`[data-cell="${cell}"]`).getAttribute('data-value');
      expect(rate.known ? sameDecimal(shown, rate.value) : shown === '', `${m.symbol} ${cell}`).toBe(true);
    }
    if (m.before.takerFeeBps.known && toUnits(m.after.takerFeeBps.value) < toUnits(m.before.takerFeeBps.value)) lowered += 1;
    // Our builder fee, named apart, the same as before any staking.
    const ours = builder[m.symbol];
    if (ours) {
      const shown = await row.locator('[data-cell="builder-fee"]').getAttribute('data-value');
      expect(ours.known ? sameDecimal(shown, ours.value) : shown === '', `${m.symbol} builder fee`).toBe(true);
    }
  }
  expect(lowered).toBeGreaterThan(0);
  const now = await (await door()).get('/api/v1/venue/fees');
  expect(Object.fromEntries(now.body.value.markets.map((m) => [m.symbol, m.builderFeeBps]))).toEqual(builder);
  await expect(page.getByTestId('tier-staking-builder')).toHaveText(
    'Our builder fee is not the venue’s fee. The staking discount leaves it as it is.',
  );
  expect(await ledgerView(state().who)).toEqual(state().ledger);
});

test(`${J} #5 asks to undelegate before the lock-up ends: refused with the venue's lock-up end time; nothing signed`, async ({ page }) => {
  test.setTimeout(240_000);
  const { owner, delegated } = state();
  const wallet = await openRoom(page);
  const calls = doorCalls(page);
  const before = await mine(owner);
  const d = before.delegations.find((x) => x.validator === delegated.validator);
  expect(Date.parse(d.lockUpEndsAt)).toBeGreaterThan(Date.now());
  await delegationRow(page, delegated.validator).getByTestId('staking-undelegate').click({ timeout: 30_000 });
  await expect(form(page)).toHaveAttribute('data-action', 'undelegate');
  await expect(form(page).getByTestId('staking-amount')).toHaveValue(d.amount);
  const asked = await reviewAndSign(page, wallet);
  const refused = form(page).getByTestId('staking-refused');
  await expect(refused).toBeVisible({ timeout: 20_000 });
  await expect(refused).toContainText(d.lockUpEndsAt);
  await expect(refused.getByTestId('staking-refused-ends')).toHaveAttribute('data-value', d.lockUpEndsAt);
  await expect(refused.getByTestId('staking-nothing-signed')).toHaveText('Nothing was signed or sent.');
  await expect(refused).toHaveAttribute('data-before-wallet', 'true');
  expect(signatures(wallet)).toBe(asked);
  expect(calls.of('prepare')).toHaveLength(1);
  expect(calls.of('submit')).toHaveLength(0);
  expect(await mine(owner)).toEqual(before);
  expect(await ledgerView(state().who)).toEqual(state().ledger);
});

test(`${J} #6 after the lock-up, undelegates and signs: one signed venue action, sent once; the delegation gone and the amount back in the staking balance, from the venue`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner, delegated } = state();
  // TEST: the venue's clock passes this person's lock-up on that delegation.
  const passed = await staking(owner, { passLockUp: delegated.validator });
  expect(Date.parse(passed.delegations.find((x) => x.validator === delegated.validator).lockUpEndsAt)).toBeLessThanOrEqual(Date.now());
  const wallet = await openRoom(page);
  const calls = doorCalls(page);
  const before = await mine(owner);
  const amount = before.delegations.find((x) => x.validator === delegated.validator).amount;
  await delegationRow(page, delegated.validator).getByTestId('staking-undelegate').click({ timeout: 30_000 });
  const asked = await reviewAndSign(page, wallet);
  const { sent } = await sentOnce(page, wallet, calls, asked, {
    kind: 'staking_delegate',
    validator: delegated.validator,
    direction: 'undelegate',
    asset: HYPE,
  });
  expect(sameDecimal(sent.amount, amount)).toBe(true);
  const after = await mine(owner);
  expect(after.delegations.find((x) => x.validator === delegated.validator)).toBeUndefined();
  expect(toUnits(after.staked) - toUnits(before.staked)).toBe(toUnits(amount));
  await expect(form(page).getByTestId('staking-result-line')).toHaveText(
    `Undelegated ${sent.amount} HYPE from ${delegated.name}: delegated there ${amount} → 0, and your staking balance is ${after.staked} HYPE, as ${(await venueInfo()).displayName} reports them.`,
  );
  await expect(page.getByTestId('staking-delegations-empty')).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => sameDecimal(await page.getByTestId('staking-balance').getAttribute('data-value'), after.staked)).toBe(true);
  await againIsSame(page, wallet, calls, asked + 1);
  expect(await mine(owner)).toEqual(after);
  expect(await ledgerView(state().who)).toEqual(state().ledger);
});

test(`${J} #7 unstakes to spot and signs: one signed venue action, sent once; the amount pending in the venue's unstaking queue with the time the venue says it arrives, then in spot, from the venue`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner } = state();
  const wallet = await openRoom(page);
  const calls = doorCalls(page);
  const before = await mine(owner);
  const spotBefore = (await hypeOf(owner)).free;
  await page.getByTestId('staking-unstake').click({ timeout: 30_000 });
  await expect(form(page)).toHaveAttribute('data-action', 'to_spot');
  const asked = await reviewAndSign(page, wallet, UNSTAKE);
  await sentOnce(page, wallet, calls, asked, { kind: 'staking_transfer', direction: 'to_spot', asset: HYPE });
  // The venue's record: one withdrawal of 50 in its queue, with the time it arrives; spot not yet credited.
  const queued = await mine(owner);
  expect(queued.pending).toHaveLength(before.pending.length + 1);
  const p = queued.pending.at(-1);
  expect(sameDecimal(p.amount, UNSTAKE)).toBe(true);
  expect(Date.parse(p.arrivesAt)).toBeGreaterThan(Date.now());
  expect(toUnits(before.staked) - toUnits(queued.staked)).toBe(toUnits(UNSTAKE));
  expect((await hypeOf(owner)).free).toBe(spotBefore);
  await expect(form(page).getByTestId('staking-result')).toHaveAttribute('data-nonce', p.nonce);
  await expect(form(page).getByTestId('staking-result-line')).toHaveText(
    `Asked to move ${UNSTAKE} HYPE from staking to spot: it waits in ${(await venueInfo()).displayName}’s unstaking queue and arrives ${await localTime(page, p.arrivesAt)}, as ${(await venueInfo()).displayName} reports it.`,
  );
  const pendingRow = page.getByTestId('staking-pending').locator(`tr[data-nonce="${p.nonce}"]`);
  await expect(pendingRow.locator('[data-cell="arrives"]')).toHaveAttribute('data-value', p.arrivesAt, { timeout: 20_000 });
  await againIsSame(page, wallet, calls, asked + 1);
  expect((await mine(owner)).pending).toHaveLength(queued.pending.length);
  // TEST: the venue's clock lets the queue arrive; the amount is then in spot, by the venue's record and in the room.
  await staking(owner, { passQueue: true });
  const arrived = await mine(owner);
  expect(arrived.pending).toEqual([]);
  expect(arrived.arrived.find((x) => x.nonce === p.nonce)).toBeTruthy();
  const spotAfter = (await hypeOf(owner)).free;
  expect(toUnits(spotAfter) - toUnits(spotBefore)).toBe(toUnits(UNSTAKE));
  await page.reload();
  await expect(page.getByTestId('staking-arrived').locator(`tr[data-nonce="${p.nonce}"]`)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => sameDecimal(await page.getByTestId('staking-spot').getAttribute('data-value'), spotAfter), { timeout: 20_000 })
    .toBe(true);
  await expect(page.getByTestId('staking-pending-empty')).toBeVisible();
  expect(await ledgerView(state().who)).toEqual(state().ledger);
});

test(`${J} #8 opens /money: staked, delegated and unstaking HYPE under Locked, each from the venue, and rewards as the venue reports them; the parts add to the venue's total`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner } = state();
  // TEST setup for this step: the person's own signed venue actions through our door leave HYPE delegated and HYPE
  // unstaking beside what stays staked, and the TEST venue pays a TEST reward into the delegation.
  const v = await validator('TEST Validator Two');
  const draft = randomBytes(4).toString('hex');
  await signAndSend({
    kind: 'staking_delegate',
    validator: v.address,
    direction: 'delegate',
    asset: HYPE,
    amount: '100',
    moveKey: `delegation:${owner}:${v.address}:delegate:${draft}`,
  });
  await signAndSend({
    kind: 'staking_transfer',
    direction: 'to_spot',
    asset: HYPE,
    amount: '20',
    moveKey: `stake-move:${owner}:to-spot:${draft}`,
  });
  await staking(owner, { reward: { validator: v.address, amount: '1.5', rewardRef: `${J}:${draft}` } });
  const s = await mine(owner);
  const b = await hypeOf(owner);
  expect(toUnits(b.lockedBy.staked)).toBeGreaterThan(0n);
  expect(toUnits(b.lockedBy.delegated)).toBeGreaterThan(0n);
  expect(toUnits(b.lockedBy.unstaking)).toBeGreaterThan(0n);
  expect(toUnits(s.rewards.total)).toBeGreaterThan(0n);

  await openRoom(page, '/money');
  const row = page.getByTestId('source-venue').locator('tr[data-asset="HYPE"]:not([data-vault])');
  await expect(row).toBeVisible({ timeout: 30_000 });
  const split = row.locator('[data-cell="locked"] [data-testid="source-venue-split"]');
  // Under Locked, each part the venue's own figure.
  await expect(split.locator('[data-part="stake"]')).toHaveAttribute('data-amount', b.lockedBy.staked, { timeout: 30_000 });
  await expect(split.locator('[data-part="delegated"]')).toHaveAttribute('data-amount', b.lockedBy.delegated);
  await expect(split.locator('[data-part="unstaking"]')).toHaveAttribute('data-amount', b.lockedBy.unstaking);
  // The venue's own record of each part: staked is its staking balance, delegated its delegations, unstaking its queue.
  expect(sameDecimal(b.lockedBy.staked, s.staked)).toBe(true);
  expect(toUnits(b.lockedBy.delegated)).toBe(s.delegations.reduce((sum, d) => sum + toUnits(d.amount), 0n));
  expect(toUnits(b.lockedBy.unstaking)).toBe(s.pending.reduce((sum, p) => sum + toUnits(p.amount), 0n));
  // Rewards as the venue reports them.
  const rewards = page.getByTestId('source-venue-staking-rewards');
  await expect(rewards).toHaveAttribute('data-value', s.rewards.total);
  await expect(rewards).toContainText(`as ${(await venueInfo()).displayName} reports them`);
  // The parts add to the venue's total, by the room and by the venue's own figures.
  const parts = page.getByTestId('source-venue-staking-parts');
  await expect(parts).toHaveAttribute('data-adds-up', 'true');
  await expect(parts).toHaveAttribute('data-total', b.total);
  const sum = [b.free, b.lockedBy.inOrders, b.lockedBy.margin, b.lockedBy.staked, b.lockedBy.delegated, b.lockedBy.unstaking].reduce(
    (x, y) => x + toUnits(y),
    0n,
  );
  expect(sum).toBe(toUnits(b.total));
  expect(toUnits(b.total)).toBe(toUnits(START) + toUnits(s.rewards.total));
  await expect(row.locator('[data-cell="total"]')).toContainText(b.total.split('.')[0]);
  expect(await ledgerView(state().who)).toEqual(state().ledger);
});

test(`${J} #9 with the venue's maximum of pending staking withdrawals already pending, asks to unstake again: signed and sent once; refused with the venue's reason and limit; nothing retried`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner } = state();
  const limit = (await terms()).maxPendingWithdrawals;
  expect(limit).not.toBeNull();
  // TEST: the venue holds this wallet's pending staking withdrawals at its maximum.
  const held = await staking(owner, { fillPending: '1' });
  expect(held.pending).toHaveLength(limit);
  const wallet = await openRoom(page);
  const calls = doorCalls(page);
  const before = await mine(owner);
  await page.getByTestId('staking-unstake').click({ timeout: 30_000 });
  const asked = await reviewAndSign(page, wallet, '1');
  await continueInWallet(page);
  const result = form(page).getByTestId('staking-result');
  await expect(result).toHaveAttribute('data-accepted', 'false', { timeout: 30_000 });
  // Signed once and sent once.
  expect(signatures(wallet)).toBe(asked + 1);
  expect(calls.of('prepare')).toHaveLength(1);
  expect(calls.of('submit')).toHaveLength(1);
  // Refused with the venue's own reason, naming its limit.
  const line = form(page).getByTestId('staking-result-line');
  await expect(line).toContainText(`Refused by ${(await venueInfo()).displayName}:`);
  await expect(line).toContainText(`at most ${limit} staking withdrawals may be pending at once`);
  await expect(form(page).getByTestId('staking-limit-refused')).toHaveAttribute('data-limit', String(limit));
  // Nothing retried: no "send again", nothing more signed or sent, and the venue's queue and balance are as they were.
  await expect(form(page).getByTestId('staking-again')).toHaveCount(0);
  expect(signatures(wallet)).toBe(asked + 1);
  expect(calls.of('submit')).toHaveLength(1);
  const after = await mine(owner);
  expect(after.pending).toHaveLength(limit);
  expect(after.staked).toBe(before.staked);
  expect(after.pending).toEqual(before.pending);
  expect(await ledgerView(state().who)).toEqual(state().ledger);
});
