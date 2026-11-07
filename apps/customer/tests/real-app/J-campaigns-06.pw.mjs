// World: book, gates
import { test, expect } from './journey.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { api, fund, journeyState, signOutBrowser, staffFreeze, staffRestore, toUnits, tool } from './stack.mjs';

// J-campaigns-06, in the running app (docs/roadmap/journeys.json): watch my invitees qualify and get paid. One test per
// step, titled "J-campaigns-06 #<n>", run in order. Written from the step's words by a test-writer, before the feature
// (OWNER 212): where the screen a step names does not exist yet, the step fails at its first missing part, quickly.
//
// The people: a verified TEST referrer, and TEST invitees who sign up and attach to the referrer inside the stack's TEST
// attach window (`affiliates.attribute`, J-campaigns-05). An invitee "deposits" with a real TEST chain deposit
// (`local-test-stack.mjs chain-deposit`) and "trades" with a TEST market order that fills against the TEST market maker.
// The referral programme is this run's TEST referral campaign, made by the stack's two LOCAL TEST founders through
// svc-campaigns' operator doors (A creates and asks, B approves, A activates), with TEST thresholds, a TEST reward for
// each side, TEST commission tiers by qualified count, a TEST cycle cap and a TEST owner maximum for a rebate share.
// Every figure is a TEST figure. The reward pays from the one reward pot, which the founders fund from fees the
// platform earned (as J-campaigns-08 does). The empty-pot branch of #3 uses a second TEST programme that rewards in ETH,
// a pot no journey funds before this one does.
//
// What the referrer's screen names (the contract the steps read): on /uc/promotion/mypromotion, a region "Your invitees"
// with one row per invitee (`[data-invitee]`, its state in `data-status`: in_progress or qualified) and its progress
// (`[data-progress=verified|deposited|traded]`, `data-done` true or false); a region "Invitee summary" with the counts
// (`[data-summary=in_progress|qualified]`); a region "Referral rewards" with one line per reward (`[data-reward]`,
// `data-side` referrer or invitee, `data-state`); a region "Commissions" with one row per accrual (`[data-commission]`,
// `data-state` pending, paid, refused or skipped, the amount in `[data-amount]`); and a "Commission statement".
const J = 'J-campaigns-06';
const UNBUILT = { timeout: 5_000 };
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const DAY = 86_400_000;
const SYMBOL = 'BTC/USDT';
const TRADE = '0.0002';
// TEST programme values (CM-referral-02 to -04): a deposit of at least 10 USDT and one trade qualify an invitee; each
// side gets 0.01 USDT; the commission rate steps up from 10% to 20% at two qualified invitees; the cycle cap is 0.0001
// USDT; a rebate share may be at most 30% of the referrer's commission.
const DEPOSIT = '12';
const REWARD = { referrer: '0.01', invitee: '0.01' };
const TIERS = [
  { qualified: 1, rate: '0.1' },
  { qualified: 2, rate: '0.2' },
];
const CYCLE_CAP = '0.0001';
const REBATE_MAX = '0.3';
const PRIVATE_FIELDS = ['email', 'userId'];

test.describe.configure({ mode: 'default' });

function state(...keys) {
  const s = run.read();
  for (const k of keys) if (!s[k]) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
  return s;
}

let gates;
let ctx;
let pair;
async function operators() {
  gates ??= await import('../../../../tooling/scripts/local-test-gates.mjs');
  ctx ??= await gates.makeContext({ log: () => {} });
  pair ??= await gates.approverSessions(ctx);
  return { ctx, pair };
}

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** A TEST referral programme live now: thresholds, a reward for each side, commission tiers, a cycle cap, a rebate max. */
async function liveReferralProgramme(name, rewardAsset) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const definition = {
    name,
    type: 'referral',
    rules: `TEST rules for ${name}: an invitee who verifies, deposits at least ${DEPOSIT} USDT and trades once qualifies. Each side gets a TEST reward once.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 14 * DAY).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    budget: { asset: rewardAsset, limit: '1' },
    limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
    reward: { asset: rewardAsset, amount: REWARD.referrer },
    referral: {
      thresholds: { verified: true, depositMin: { asset: 'USDT', amount: DEPOSIT }, trades: 1 },
      reward: { asset: rewardAsset, referrer: REWARD.referrer, invitee: REWARD.invitee },
      commission: { tiers: TIERS, cycleCap: { asset: 'USDT', amount: CYCLE_CAP } },
      rebateShareMax: REBATE_MAX,
    },
  };
  const made = data(await ctx.edge.mutate('campaigns', 'ops.campaigns.create', definition, a), 'ops.campaigns.create');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'submit', revision: 1 }, a), 'submit');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'approve', revision: 1 }, b), 'approve');
  const live = data(
    await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'activate', revision: 1 }, a),
    'activate',
  );
  expect(live.state).toBe('active');
  return live;
}

/** Founder A asks to sweep earned fees in `asset` into the reward pot; founder B approves, which posts it. */
async function fundPot(reference, asset, amount) {
  const { ctx, pair } = await operators();
  data(
    await ctx.edge.mutate(
      'campaigns',
      'ops.pot.request',
      { reference, sourceModule: 'trade', asset, amount },
      await pair.a.campaignsOpsToken(),
    ),
    'ops.pot.request',
  );
  const funded = data(
    await ctx.edge.mutate('campaigns', 'ops.pot.approve', { reference }, await pair.b.campaignsOpsToken()),
    'ops.pot.approve',
  );
  expect(funded.state, JSON.stringify(funded)).toBe('posted');
}

/** A new verified invitee, attached to `referrer` through identity's own door inside the TEST attach window. */
async function invitee(page, prefix, referrerId) {
  await signOutBrowser(page.context());
  const who = await signUp(page, prefix);
  const attached = await (await api(who)).post('/api/identity/trpc/affiliates.attribute', { referrerId });
  expect(attached.status, JSON.stringify(attached.body).slice(0, 300)).toBe(200);
  await verify(page, who);
  const id = (await api(who)).userId;
  return { ...who, userId: id };
}

/** The invitee's TEST USDT deposit address, read on Deposit as a person reads it. */
async function depositAddress(page, who) {
  await signIn(page, who);
  await page.goto('/uc/recharge');
  await page.mouse.move(0, 600);
  await page.getByRole('combobox', { name: /^Asset Coins you hold/ }).selectOption('USDT');
  await page.getByRole('combobox', { name: 'Network', exact: true }).selectOption({ label: 'TEST Ethereum' });
  await page.getByRole('checkbox', { name: 'I will send only USDT on TEST Ethereum.' }).check();
  await page.getByRole('button', { name: 'Show my deposit address' }).click();
  const address = (await page.getByTestId('deposit-address').locator('strong[data-testid="numeric"]').innerText()).trim();
  await signOutBrowser(page.context());
  return address;
}

/** A real TEST chain deposit to the invitee, credited by the deposit pipeline. */
async function deposit(page, who, label) {
  const address = await depositAddress(page, who);
  expect(tool('local-test-stack.mjs', 'chain-deposit', address, 'USDT', DEPOSIT, '6', '--tx', label)).toContain('"received":true');
  await expect
    .poll(async () => toUnits((await (await api(who)).balances()).USDT?.free ?? '0'), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(toUnits(DEPOSIT));
}

/** One TEST market buy on the real book through the invitee's own API: it fills against the market maker and pays a fee. */
async function trade(who, n) {
  const res = await (
    await api(who)
  ).post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'market',
    side: 'buy',
    amount: TRADE,
    clientOrderId: `${J}-${tag}-${n}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
}

/** The referrer's referral records screen. */
async function records(page, who) {
  await signOutBrowser(page.context());
  await signIn(page, who);
  await page.goto('/uc/promotion/mypromotion');
}
const invitees = (page) => page.getByRole('region', { name: 'Your invitees' });
const rowOf = (page, who) => invitees(page).locator(`[data-invitee="${who.handle}"]`);
const summary = (page, status) => page.getByRole('region', { name: 'Invitee summary' }).locator(`[data-summary="${status}"]`);
const commissions = (page) => page.getByRole('region', { name: 'Commissions' });

/** The ledger's free balance of `asset`, as the person's own API answers it. */
const freeOf = async (who, asset) => (await (await api(who)).balances())[asset]?.free ?? '0';

test(`${J} #1 opens /uc/promotion/mypromotion: the invitee list with per-invitee progress (verified, deposited, traded) and no private invitee detail`, async ({
  page,
}) => {
  run.reset({});
  const referrer = await signUp(page, 'jc6r');
  await verify(page, referrer);
  const referrerId = (await api(referrer)).userId;
  run.write({ referrer: { ...referrer, userId: referrerId } });
  const programme = await liveReferralProgramme(`TEST referral programme ${tag}`, 'USDT');
  run.write({ programme: programme.id });
  const first = await invitee(page, 'jc6a', referrerId);
  run.write({ first });

  await records(page, referrer);
  await expect(invitees(page)).toBeVisible(UNBUILT);
  const row = rowOf(page, first);
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-status', 'in_progress');
  // Per-invitee progress: verified done, deposited and traded not yet.
  await expect(row.locator('[data-progress="verified"]')).toHaveAttribute('data-done', 'true');
  await expect(row.locator('[data-progress="deposited"]')).toHaveAttribute('data-done', 'false');
  await expect(row.locator('[data-progress="traded"]')).toHaveAttribute('data-done', 'false');
  await expect(row.locator('[data-progress="verified"]')).toContainText('Verified');
  await expect(row.locator('[data-progress="deposited"]')).toContainText('Deposited');
  await expect(row.locator('[data-progress="traded"]')).toContainText('Traded');
  // No private invitee detail: not their email, not their account ID, anywhere on the referrer's page or in its answers.
  const body = await page.locator('body').innerText();
  for (const field of PRIVATE_FIELDS) expect(body, `the invitee's ${field} is private`).not.toContain(first[field]);
  const html = await page.content();
  for (const field of PRIVATE_FIELDS) expect(html, `the invitee's ${field} is private`).not.toContain(first[field]);
});

test(`${J} #2 an invitee finishes the last step: the summary moves from in progress to qualified exactly once even if events repeat; an internal transfer does not count`, async ({
  page,
}) => {
  const { referrer, first } = state('referrer', 'first');
  // An internal transfer is not a deposit: a second invitee receives TEST USDT from the referrer by handle and trades.
  const second = await invitee(page, 'jc6b', referrer.userId);
  run.write({ second });
  expect(fund(referrer.email, 'USDT', '40').tx).toBeTruthy();
  await signIn(page, referrer);
  await page.goto('/pay');
  const to = page.getByRole('textbox', { name: 'Handle', exact: true });
  await to.fill(second.handle);
  await to.press('Tab');
  await expect(page.getByTestId('recipient-handle').first()).toHaveText(`@${second.handle}`);
  await page.getByLabel('Amount to send').fill(DEPOSIT);
  await page.getByTestId('pay-review').click();
  await page.getByTestId('pay-send').click();
  await expect.poll(async () => toUnits(await freeOf(second, 'USDT')), { timeout: 30_000 }).toBeGreaterThanOrEqual(toUnits(DEPOSIT));
  await trade(second, 'b1');

  // The first invitee deposits on the chain and trades: the last step.
  await deposit(page, first, `${J}-${tag}-dep-a`);
  await trade(first, 'a1');

  await records(page, referrer);
  await expect(invitees(page)).toBeVisible(UNBUILT);
  const row = rowOf(page, first);
  await expect(async () => {
    await page.reload();
    await expect(row).toHaveAttribute('data-status', 'qualified', { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(row.locator('[data-progress="deposited"]')).toHaveAttribute('data-done', 'true');
  await expect(row.locator('[data-progress="traded"]')).toHaveAttribute('data-done', 'true');
  await expect(summary(page, 'qualified')).toContainText('1');
  await expect(summary(page, 'in_progress')).toContainText('1');
  const qualifiedAt = await row.locator('time[data-qualified-at]').getAttribute('datetime');
  expect(qualifiedAt).toBeTruthy();

  // Events repeat: the same deposit arrives again (the chain replays the same transaction) and the invitee trades again.
  expect(
    tool('local-test-stack.mjs', 'chain-deposit', await depositAddress(page, first), 'USDT', DEPOSIT, '6', '--tx', `${J}-${tag}-dep-a`),
  ).toContain('"received"');
  await trade(first, 'a2');
  await records(page, referrer);
  await expect(rowOf(page, first)).toHaveAttribute('data-status', 'qualified');
  await expect(rowOf(page, first).locator('time[data-qualified-at]')).toHaveAttribute('datetime', qualifiedAt);
  await expect(summary(page, 'qualified')).toContainText('1');

  // The internal transfer did not count: the second invitee is still in progress with no deposit.
  const other = rowOf(page, second);
  await expect(other).toHaveAttribute('data-status', 'in_progress');
  await expect(other.locator('[data-progress="deposited"]')).toHaveAttribute('data-done', 'false');
  await expect(other.locator('[data-progress="traded"]')).toHaveAttribute('data-done', 'true');
  run.write({ qualifiedAt });
});

test(`${J} #3 the reward is paid: a reward line for me and one for my invitee, each posted once; an empty pot shows pending funding and pays once after funding; a frozen invitee at pay time keeps the intent pending`, async ({
  page,
}) => {
  const { referrer, first } = state('referrer', 'first', 'qualifiedAt');
  // The USDT pot is funded from trade fees the platform earned (BTC/USDT sells pay fees in USDT).
  await fundPot(`${J}-${tag}-usdt`, 'USDT', '0.03');

  await records(page, referrer);
  const rewards = page.getByRole('region', { name: 'Referral rewards' });
  await expect(rewards).toBeVisible(UNBUILT);
  const mine = rewards.locator(`[data-reward][data-side="referrer"][data-invitee="${first.handle}"]`);
  await expect(async () => {
    await page.reload();
    await expect(mine).toHaveAttribute('data-state', 'paid', { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(mine).toHaveCount(1);
  await expect(mine.locator('[data-amount]')).toHaveText(`${REWARD.referrer} USDT`);
  const mineTx = await mine.getAttribute('data-tx');
  expect(mineTx).toBeTruthy();

  await records(page, first);
  const theirs = page.getByRole('region', { name: 'Referral rewards' }).locator('[data-reward][data-side="invitee"]');
  await expect(theirs).toHaveCount(1);
  await expect(theirs).toHaveAttribute('data-state', 'paid');
  await expect(theirs.locator('[data-amount]')).toHaveText(`${REWARD.invitee} USDT`);
  // Posted once: a reload and a replayed qualification event leave one line each, with the same ledger transaction.
  await records(page, referrer);
  await expect(rewards.locator(`[data-reward][data-side="referrer"][data-invitee="${first.handle}"]`)).toHaveCount(1);
  await expect(rewards.locator(`[data-reward][data-side="referrer"][data-invitee="${first.handle}"]`)).toHaveAttribute('data-tx', mineTx);

  // An empty pot: a second TEST programme rewards in ETH, a pot nobody has funded. Its reward waits as pending funding.
  const eth = await liveReferralProgramme(`TEST referral programme ETH ${tag}`, 'ETH');
  run.write({ ethProgramme: eth.id });
  // Two more invitees qualify while the ETH pot is empty; the fourth is frozen before the founders fund it, so at pay
  // time the third is paid and the fourth's own reward intent stays pending.
  const third = await invitee(page, 'jc6c', referrer.userId);
  await deposit(page, third, `${J}-${tag}-dep-c`);
  await trade(third, 'c1');
  const fourth = await invitee(page, 'jc6d', referrer.userId);
  await deposit(page, fourth, `${J}-${tag}-dep-d`);
  await trade(fourth, 'd1');
  await records(page, referrer);
  const pending = rewards.locator(`[data-reward][data-side="referrer"][data-invitee="${third.handle}"][data-asset="ETH"]`);
  await expect(async () => {
    await page.reload();
    await expect(pending).toHaveAttribute('data-state', 'pending_funding', { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(pending).toContainText('Waiting for the reward pot to be funded');
  const fourthEthBefore = await freeOf(fourth, 'ETH');
  const frozenId = await staffFreeze(fourth, 'LOCAL TEST J-campaigns-06 #3 frozen at pay time');
  try {
    // ETH fees the platform earns: an ETH/USDT market buy by the referrer (a buy pays its fee in ETH), then the
    // founders sweep them into the ETH pot. The pending reward pays once.
    expect(fund(referrer.email, 'USDT', '20').tx).toBeTruthy();
    const buy = await (
      await api(referrer)
    ).post('/api/v1/orders', {
      symbol: 'ETH/USDT',
      type: 'market',
      side: 'buy',
      amount: '0.005',
      clientOrderId: `${J}-${tag}-ethfee`,
    });
    expect(buy.status, JSON.stringify(buy.body).slice(0, 300)).toBeLessThan(300);
    await fundPot(`${J}-${tag}-eth`, 'ETH', '0.000005');
    await records(page, referrer);
    await expect(async () => {
      await page.reload();
      await expect(pending).toHaveAttribute('data-state', 'paid', { timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await expect(pending).toHaveCount(1);
    // The frozen invitee's own reward stays pending, and nothing was paid to them.
    const held = rewards.locator(`[data-reward][data-side="invitee"][data-invitee="${fourth.handle}"][data-asset="ETH"]`);
    await expect(held).toHaveAttribute('data-state', 'pending');
    await expect(held).toContainText('frozen');
  } finally {
    await staffRestore(frozenId);
  }
  expect(await freeOf(fourth, 'ETH')).toBe(fourthEthBefore);
});

test(`${J} #4 sets a rebate share for my invitee: the share is accepted up to the owner maximum and refused above it`, async ({ page }) => {
  const { referrer, first } = state('referrer', 'first');
  await records(page, referrer);
  const row = rowOf(page, first);
  await expect(row).toBeVisible(UNBUILT);
  const share = row.getByRole('spinbutton', { name: 'Rebate share for this invitee (%)' });
  await expect(share).toBeVisible(UNBUILT);
  await expect(row.getByText(`Up to ${Number(REBATE_MAX) * 100}%`)).toBeVisible();

  // At the owner maximum: accepted, and it stays after a reload.
  await share.fill(String(Number(REBATE_MAX) * 100));
  await row.getByRole('button', { name: 'Save rebate share' }).click();
  await expect(row.getByRole('status')).toContainText(`Rebate share set to ${Number(REBATE_MAX) * 100}%`);
  await page.reload();
  await expect(rowOf(page, first).getByRole('spinbutton', { name: 'Rebate share for this invitee (%)' })).toHaveValue(
    String(Number(REBATE_MAX) * 100),
  );

  // Above it: refused by name, and the saved share is unchanged.
  const again = rowOf(page, first);
  await again.getByRole('spinbutton', { name: 'Rebate share for this invitee (%)' }).fill(String(Number(REBATE_MAX) * 100 + 1));
  await again.getByRole('button', { name: 'Save rebate share' }).click();
  await expect(again.getByRole('alert')).toContainText(`above the maximum of ${Number(REBATE_MAX) * 100}%`);
  await expect(again.getByRole('alert')).toContainText('referral.rebate_share_above_max');
  await page.reload();
  await expect(rowOf(page, first).getByRole('spinbutton', { name: 'Rebate share for this invitee (%)' })).toHaveValue(
    String(Number(REBATE_MAX) * 100),
  );
});

test(`${J} #5 opens commissions: each row shows pending, paid or the refusal (rates not published); amounts as decimal strings`, async ({
  page,
}) => {
  const { referrer, first } = state('referrer', 'first');
  await trade(first, 'a3');
  await records(page, referrer);
  const list = commissions(page);
  await expect(list).toBeVisible(UNBUILT);
  const rows = list.locator('[data-commission]');
  await expect(async () => {
    await page.reload();
    expect(await rows.count()).toBeGreaterThan(0);
  }).toPass({ timeout: 60_000 });
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const s = await row.getAttribute('data-state');
    expect(['pending', 'paid', 'refused'], `commission row ${i} state`).toContain(s);
    if (s === 'refused') await expect(row).toContainText('Commission rates are not published');
    // The amount exactly as the ledger keeps it: a plain decimal string, no rounding, no exponent, no grouping.
    await expect(row.locator('[data-amount]')).toHaveText(/^\d+(\.\d+)? [A-Z]+$/);
  }
});

test(`${J} #6 reaches a higher tier by qualified count, then a cycle cap: the rate steps up; at the cap the next row stays pending with the budget reason and nothing posts`, async ({
  page,
}) => {
  const { referrer, first, second } = state('referrer', 'first', 'second');
  await records(page, referrer);
  const tier = page.getByRole('region', { name: 'Your commission tier' });
  await expect(tier).toBeVisible(UNBUILT);
  await expect(tier.locator('[data-rate]')).toHaveText(`${Number(TIERS[0].rate) * 100}%`);

  // The second invitee makes a real deposit and so qualifies: two qualified invitees, the next tier.
  await deposit(page, second, `${J}-${tag}-dep-b`);
  await records(page, referrer);
  await expect(async () => {
    await page.reload();
    await expect(summary(page, 'qualified')).toContainText('2', { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(tier.locator('[data-rate]')).toHaveText(`${Number(TIERS[1].rate) * 100}%`);
  await trade(first, 'a4');
  await page.reload();
  const newest = commissions(page).locator('[data-commission]').first();
  await expect(newest.locator('[data-rate]')).toHaveText(`${Number(TIERS[1].rate) * 100}%`);

  // Trading on until the cycle's commission reaches the TEST cap: the next row stays pending with the budget reason.
  const before = await freeOf(referrer, 'USDT');
  for (let i = 0; i < 6; i++) await trade(first, `cap${i}`);
  await page.reload();
  const capped = commissions(page).locator('[data-commission][data-reason="cycle_cap"]').first();
  await expect(capped).toHaveAttribute('data-state', 'pending');
  await expect(capped).toContainText('The cycle budget is used up');
  // Nothing posts for it: the referrer's balance moved by paid commission only, never by the capped row.
  const paid = await commissions(page).locator('[data-commission][data-state="paid"] [data-amount]').allInnerTexts();
  const paidSinceTotal = paid.map((t) => toUnits(t.split(' ')[0])).reduce((a, b) => a + b, 0n);
  expect(toUnits(await freeOf(referrer, 'USDT')) - toUnits(before)).toBeLessThanOrEqual(paidSinceTotal);
  expect(paidSinceTotal).toBeLessThanOrEqual(toUnits(CYCLE_CAP));
});

test(`${J} #7 a beneficiary is frozen: new commission to them is skipped and the reason is recorded`, async ({ page }) => {
  const { referrer, first } = state('referrer', 'first');
  const before = await freeOf(referrer, 'USDT');
  await records(page, referrer);
  await expect(commissions(page)).toBeVisible(UNBUILT);
  const count = await commissions(page).locator('[data-commission]').count();
  await signOutBrowser(page.context());
  const frozenId = await staffFreeze(referrer, 'LOCAL TEST J-campaigns-06 #7 beneficiary frozen');
  try {
    await trade(first, 'frozen');
    await new Promise((r) => setTimeout(r, 5_000));
  } finally {
    await staffRestore(frozenId);
  }
  await records(page, referrer);
  const rows = commissions(page).locator('[data-commission]');
  await expect.poll(async () => rows.count(), { timeout: 30_000 }).toBe(count + 1);
  const skipped = rows.first();
  await expect(skipped).toHaveAttribute('data-state', 'skipped');
  await expect(skipped).toContainText('Skipped: the account was frozen');
  expect(await freeOf(referrer, 'USDT')).toBe(before);
});

test(`${J} #8 opens the statement: a time-stamped statement of accruals and payouts for the cycle`, async ({ page }) => {
  const { referrer } = state('referrer');
  await records(page, referrer);
  await page.getByRole('button', { name: 'Open commission statement' }).click(UNBUILT);
  const statement = page.getByRole('region', { name: 'Commission statement' });
  await expect(statement).toBeVisible();
  // Time-stamped: when it was made, and the cycle it covers.
  await expect(statement.locator('time[data-generated-at]')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await expect(statement.locator('time[data-cycle-start]')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await expect(statement.locator('time[data-cycle-end]')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  // Accruals and payouts: every commission row on the page is on the statement, each with its own time.
  const accruals = statement.locator('[data-statement-line="accrual"]');
  expect(await accruals.count()).toBe(await commissions(page).locator('[data-commission]').count());
  await expect(statement.locator('[data-statement-line="payout"]').first()).toBeVisible();
  for (const line of await statement.locator('[data-statement-line]').all())
    await expect(line.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
});
