// World: book, restart, stack
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { signIn, signUp } from './desk.mjs';
import { CHAIN_ID, TOKEN_USD, fundOnTestChain, testChain } from './dex.mjs';
import { api, journeyState, signOutBrowser, tool } from './stack.mjs';
import { installTestWallet, TEST_WALLET } from './test-wallet.mjs';
import { venueForThisFile } from './venue.mjs';
import { chainReceipt, chainUsd, rewardFunds } from './reward-funds.mjs';

// J-campaigns-08, in the running app (docs/roadmap/journeys.json): claim a voucher and use it. One test per step, titled
// "J-campaigns-08 #<n>", run in order. The launch money model (OWNER 226, OWNER 288): a cash voucher's benefit is
// INTAFACED's own money, recorded owed once in the ledger and paid once in USDC to the customer's own connected wallet on
// the stack's TEST chain; it is never credited to a balance of theirs. The voucher campaign is this run's TEST campaign,
// made by the stack's two LOCAL TEST founders through svc-campaigns' operator doors (A creates and asks, B approves, A
// activates), and its vouchers are issued by founder A under codes made for this run. Its budget is INTAFACED's TEST USDC
// reward pot, funded by the founders from builder fees the TEST venue credited us on this file's own sells, and the
// payment leaves INTAFACED's TEST rewards wallet, which those fees are moved to (reward-funds.mjs; the venue door is on for
// this file). A redemption is a reward intent under `voucher:<voucher>:<account>:<n>`. Code checks and claims count
// against the stack's labelled TEST attempt limits (tooling/profiles/test-owner-values/campaigns.json).
const J = 'J-campaigns-08';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const ASSET = 'USDC';
const FACE = '0.02';
const PART = '0.005';
const DAY = 86_400_000;

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

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
const funds = rewardFunds({ J, RUN, operators });

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** A TEST voucher campaign live now, with its claim-by and use-by dates; its reward is each voucher's face value. */
async function liveVoucherCampaign(name, { claimBy, useBy }) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const definition = {
    name,
    type: 'voucher',
    rules: `TEST rules for ${name}: claim a voucher by its code, then redeem it. Its value is TEST ${ASSET}, paid to your connected wallet.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 14 * DAY).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    budget: { asset: ASSET, limit: '0.1' },
    // TEST limits (CM-eligibility-rules-03), wide enough that only a step about limits meets them.
    limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
    reward: { asset: ASSET, amount: FACE },
    vouchers: { claimBy, useBy },
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

async function issue(campaignId, code) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  return data(await ctx.edge.mutate('campaigns', 'ops.campaigns.vouchers.issue', { campaignId, code }, a), 'vouchers.issue');
}

/** Basic verification through the verification room, granted by the stack's TEST reviewer. */
async function verifyBasic(page) {
  await page.goto('/verification');
  await page.getByLabel('Level to request').selectOption({ label: 'Basic' });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
  tool('local-test-gates.mjs', 'verify');
}

/** The person's own TEST wallet: a key made from this run's name, holding nothing real. */
const walletKeyOf = (who) => keccak256(toHex(`intafaced TEST voucher wallet ${J} ${RUN} ${who.handle}`));
const sheet = (page) => page.locator('[data-sheet="sign"]');

/** Connects the person's TEST wallet to their account on Wallet's Venue account tab, as svc-protocol records it. */
async function connectWallet(page, who, privateKey) {
  await installTestWallet(page, { chainId: CHAIN_ID, privateKey, rpcUrl: testChain().gateUrl });
  await signIn(page, who);
  await page.goto('/wallet');
  await page.getByRole('button', { name: 'Venue account', exact: true }).click();
  await expect(page).toHaveURL(/\/wallet\/venue$/);
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  await page.getByRole('button', { name: 'Connect to my account' }).click();
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible();
}

async function connections(who) {
  const { status, body } = await (await api(who)).get('/api/protocol/trpc/venueWallet.status');
  if (status !== 200) throw new Error(`venueWallet.status refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.result.data.connections;
}

/** TEST USD units (6 decimals) of a USDC decimal amount. */
function usdUnits(amount) {
  const [w, f = ''] = String(amount).split('.');
  return BigInt(w + f.padEnd(6, '0').slice(0, 6));
}

/**
 * INTAFACED's TEST USDC reward pot and TEST rewards wallet, funded from builder fees this file earns on the TEST venue:
 * enough for every redemption this file makes.
 */
async function fundRewards(who) {
  const fees = await funds.earnBuilderFees(who, 6);
  await funds.fundPotFromFees(`TEST-${J}-${tag}`, fees);
  await funds.claimOurBuilderFees();
}

/** The caller's reward records (My rewards), each with its attempts log. */
async function myRewards(who) {
  const res = await (await api(who)).get(`/api/campaigns/trpc/rewards.mine?input=${encodeURIComponent('{}')}`);
  if (!res.body?.result) throw new Error(`rewards.mine refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data.rewards;
}

/**
 * A redemption paid exactly once: recorded owed once and paid once in its log, one reward record, its payout to the
 * connected wallet, and the TEST chain's own receipt shows exactly one transfer of exactly its amount to that wallet.
 */
async function paidOnce(who, redemption, wallet) {
  expect(redemption.reward.state).toBe('paid');
  expect(redemption.reward.owed?.txId, JSON.stringify(redemption)).toBeTruthy();
  const rows = (await myRewards(who)).filter((r) => r.rewardKey === redemption.reward.rewardKey);
  expect(rows).toHaveLength(1);
  // Owed for exactly what was redeemed, in the voucher's asset.
  expect(rows[0]).toMatchObject({ asset: ASSET, amount: redemption.amount });
  expect(rows[0].attempts.filter((a) => a.outcome === 'owed')).toHaveLength(1);
  expect(rows[0].attempts.filter((a) => a.outcome === 'paid')).toHaveLength(1);
  const payout = redemption.reward.payout;
  expect(payout?.toWallet).toBe(wallet);
  expect(payout.chainTx).toMatch(/^0x[0-9a-f]{64}$/);
  expect(rows[0].payout?.chainTx).toBe(payout.chainTx);
  const receipt = await chainReceipt(payout.chainTx);
  expect(receipt.transfers.filter((t) => t.to === wallet)).toEqual([
    { token: TOKEN_USD.address, from: receipt.from, to: wallet, value: usdUnits(redemption.amount) },
  ]);
  return receipt;
}

/** A voucher redemption's record, read again. */
const redemptionOf = async (who, voucherId, sequence) =>
  (await walletOf(who)).find((v) => v.id === voucherId).redemptions.find((r) => r.sequence === sequence);

async function walletOf(who) {
  const res = await (await api(who)).get(`/api/campaigns/trpc/vouchers.mine?input=${encodeURIComponent('{}')}`);
  if (!res.body?.result) throw new Error(`vouchers.mine refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data.vouchers;
}

async function openWallet(page) {
  await page.goto('/campaigns/mine');
  const wallet = page.getByTestId('my-vouchers');
  await expect(wallet).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  return wallet;
}

const voucherRow = (page, id) => page.locator(`[data-testid="my-voucher"][data-voucher-id="${id}"]`);
const codeForm = (page) => page.getByRole('form', { name: 'Voucher code' });

test(`${J} #1 opens /campaigns/mine: my vouchers, an honest empty state when none`, async ({ browser }) => {
  test.setTimeout(180_000);
  run.reset({});
  const now = Date.now();
  const useByAt = new Date(now + 7 * DAY).toISOString();
  const campaign = await liveVoucherCampaign(`TEST vouchers ${tag}`, {
    claimBy: new Date(now + 7 * DAY).toISOString(),
    useBy: useByAt,
  });
  const codes = { cash: `JC08-${tag}-A`, other: `JC08-${tag}-B`, shown: `JC08-${tag}-D` };
  for (const code of Object.values(codes)) expect((await issue(campaign.id, code)).state).toBe('published');
  const page = await (await browser.newContext()).newPage();
  const me = await signUp(page, 'jc08me');
  // Starts: a wallet connected. The person's own TEST wallet, connected to their account (svc-protocol's record).
  await verifyBasic(page);
  const walletKey = walletKeyOf(me);
  const ownWallet = privateKeyToAccount(walletKey).address.toLowerCase();
  fundOnTestChain(ownWallet, 'venue');
  const connecting = await (await browser.newContext()).newPage();
  await connectWallet(connecting, me, walletKey);
  expect((await connections(me)).map((c) => c.address.toLowerCase())).toEqual([ownWallet]);
  await connecting.context().close();
  const wallet = await openWallet(page);
  expect(await walletOf(me)).toEqual([]);
  await expect(wallet.getByTestId('vouchers-empty')).toContainText('No voucher on this account');
  // The code form is always laid out, with validate and claim.
  await expect(codeForm(page).getByRole('textbox', { name: 'Code' })).toBeVisible();
  await expect(codeForm(page).getByRole('button', { name: 'Check this code' })).toBeVisible();
  await expect(codeForm(page).getByRole('button', { name: 'Claim this voucher' })).toBeVisible();
  // With a voucher: another person's /campaigns/mine lists it with its state and its expiry.
  const otherPage = await (await browser.newContext()).newPage();
  const holder = await signUp(otherPage, 'jc08hold');
  const held = (await (await api(holder)).post('/api/campaigns/trpc/vouchers.claim', { code: codes.shown })).body?.result?.data;
  expect(held, 'the holder claims a voucher').toMatchObject({ state: 'claimed' });
  await openWallet(otherPage);
  const heldRow = voucherRow(otherPage, held.id);
  await expect(heldRow.getByTestId('voucher-state')).toHaveText('Claimed');
  // Its expiry is the campaign's use-by, shown as a date and time.
  expect(Date.parse(held.useBy)).toBe(Date.parse(useByAt));
  // The date on screen is that use-by, as the voucher room writes it in the page's language and the browser's own zone
  // ("Nov 22, 2026, 02:57 PM UTC").
  const shownUseBy = await otherPage.evaluate(
    (at) =>
      new Intl.DateTimeFormat(document.documentElement.lang || 'en', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(at)),
    held.useBy,
  );
  await expect(heldRow.getByTestId('voucher-use-by')).toHaveText(`Use by ${shownUseBy}`);
  await otherPage.context().close();
  run.write({ me, walletKey, wallet: ownWallet, campaignId: campaign.id, codes });
});

test(`${J} #2 claims a voucher, pressing twice at once: one claim wins, the other gets the generic refusal`, async ({ browser }) => {
  const { me, codes } = state('me', 'codes');
  const client = await api(me);
  const [one, two] = await Promise.all([
    client.post('/api/campaigns/trpc/vouchers.claim', { code: codes.cash }),
    client.post('/api/campaigns/trpc/vouchers.claim', { code: codes.cash }),
  ]);
  const won = [one, two].filter((r) => r.body?.result?.data);
  const lost = [one, two].filter((r) => !r.body?.result?.data);
  expect(won, JSON.stringify([one.body, two.body]).slice(0, 600)).toHaveLength(1);
  expect(lost).toHaveLength(1);
  expect(lost[0].body?.error?.message ?? '').toContain('[campaigns.voucher_invalid]');
  const claimed = won[0].body.result.data;
  expect(claimed).toMatchObject({ state: 'claimed', face: { asset: ASSET, amount: FACE }, remaining: FACE });
  const wallet = await walletOf(me);
  expect(wallet.map((v) => v.id)).toEqual([claimed.id]);
  // On screen: the voucher with its state and expiry; pressing Claim again shows the generic answer.
  const page = await (await browser.newContext()).newPage();
  await signIn(page, me);
  await openWallet(page);
  const row = voucherRow(page, claimed.id);
  await expect(row.getByTestId('voucher-state')).toHaveText('Claimed');
  await expect(row.getByTestId('voucher-use-by')).toContainText('Use by');
  await codeForm(page).getByRole('textbox', { name: 'Code' }).fill(codes.cash);
  await codeForm(page).getByRole('button', { name: 'Claim this voucher' }).click();
  await expect(page.getByTestId('voucher-refusal')).toHaveAttribute('data-code', 'campaigns.voucher_invalid');
  run.write({ ...run.read(), voucherId: claimed.id });
});

test(`${J} #3 types a code that is wrong, or used by someone else: the same generic answer in both cases`, async ({ browser }) => {
  const { codes } = state('codes', 'voucherId');
  const page = await (await browser.newContext()).newPage();
  const someone = await signUp(page, 'jc08x');
  await openWallet(page);
  const answer = async (code) => {
    await codeForm(page).getByRole('textbox', { name: 'Code' }).fill(code);
    await codeForm(page).getByRole('button', { name: 'Claim this voucher' }).click();
    const refusal = page.getByTestId('voucher-refusal');
    await expect(refusal).toBeVisible();
    return { code: await refusal.getAttribute('data-code'), text: await refusal.innerText() };
  };
  const wrong = await answer(`JC08-${tag}-NOPE`);
  await page.reload();
  const taken = await answer(codes.cash);
  expect(wrong).toEqual(taken);
  expect(wrong.code).toBe('campaigns.voucher_invalid');
  expect(await walletOf(someone)).toEqual([]);
});

test(`${J} #4 validates the code: nothing changes, and I see what it would give`, async ({ browser }) => {
  const { me, codes } = state('me', 'codes');
  const page = await (await browser.newContext()).newPage();
  await signIn(page, me);
  await openWallet(page);
  await codeForm(page).getByRole('textbox', { name: 'Code' }).fill(codes.other);
  await codeForm(page).getByRole('button', { name: 'Check this code' }).click();
  const result = page.getByTestId('voucher-validation');
  await expect(result).toContainText(`${FACE} ${ASSET}`);
  await expect(result).toContainText('Claim by');
  // Nothing changed: the voucher is still free to claim, and my wallet still holds only the first one.
  expect((await walletOf(me)).map((v) => v.code)).toEqual([codes.cash]);
  const again = await (
    await api(me)
  ).get(`/api/campaigns/trpc/vouchers.validate?input=${encodeURIComponent(JSON.stringify({ code: codes.other }))}`);
  expect(again.body?.result?.data).toMatchObject({ claimable: true, face: { asset: ASSET, amount: FACE } });
});

test(`${J} #5 redeems the voucher, pressing twice: one redemption, recorded owed once and paid once to the connected wallet with its chain reference; a lost reply leaves it pending retry and the reconciler finishes it`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const { me, wallet, voucherId, campaignId } = state('me', 'wallet', 'voucherId', 'campaignId');
  // INTAFACED's TEST budget: the USDC pot and the rewards wallet hold this file's TEST builder fees.
  await fundRewards(me);
  const walletBefore = await chainUsd(wallet);
  const client = await api(me);
  const [one, two] = await Promise.all([
    client.post('/api/campaigns/trpc/vouchers.redeem', { voucherId, amount: PART, sequence: 1 }),
    client.post('/api/campaigns/trpc/vouchers.redeem', { voucherId, amount: PART, sequence: 1 }),
  ]);
  const answers = [one, two].map((r) => r.body?.result?.data);
  expect(answers.every(Boolean), JSON.stringify([one.body, two.body]).slice(0, 400)).toBe(true);
  expect(answers.filter((a) => a.created)).toHaveLength(1);
  expect(answers[0].redemption.reward.rewardKey).toBe(answers[1].redemption.reward.rewardKey);
  expect(answers[0].redemption.reward.rewardKey).toBe(`voucher:${voucherId}:${client.userId}:1`);
  // Recorded owed by INTAFACED, then paid from its rewards wallet to the connected wallet: never a balance of mine.
  await expect.poll(async () => (await redemptionOf(me, voucherId, 1))?.reward.state, { timeout: 120_000 }).toBe('paid');
  const [v] = (await walletOf(me)).filter((x) => x.id === voucherId);
  expect(v.redemptions).toHaveLength(1);
  const receipt = await paidOnce(me, v.redemptions[0], wallet);
  expect(await chainUsd(wallet)).toBe(walletBefore + usdUnits(PART));
  // On screen: the one redemption, paid to my wallet, with the chain transaction that paid it.
  const page = await (await browser.newContext()).newPage();
  await signIn(page, me);
  await openWallet(page);
  const rows = voucherRow(page, voucherId).getByTestId('voucher-redemptions').locator('li');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-state', 'paid');
  await expect(rows.first()).toContainText(`${PART} ${ASSET}: paid to your connected wallet`);
  await expect(rows.first().getByTestId('voucher-paid-to')).toHaveAttribute('data-wallet', wallet);
  await expect(rows.first().getByTestId('voucher-chain-tx')).toHaveAttribute('data-tx', v.redemptions[0].reward.payout.chainTx);
  await expect(rows.first().getByTestId('voucher-chain-tx')).toHaveAttribute(
    'href',
    `/chain/tx/${encodeURIComponent(v.redemptions[0].reward.payout.chainTx)}`,
  );
  expect(receipt.transfers.filter((t) => t.to === wallet)).toHaveLength(1);

  // A lost reply: a second voucher redeemed whole, for its face value, while the ledger gives no answer (svc-ledger stopped). Nothing is owed or
  // sent; the redemption stays open, pending retry. Once the ledger is back, the reconciler records it owed under the same
  // key and it is paid once.
  const code = `JC08-${tag}-L`;
  await issue(campaignId, code);
  const claimed = (await client.post('/api/campaigns/trpc/vouchers.claim', { code })).body?.result?.data;
  expect(claimed, 'the second voucher is claimed').toMatchObject({ state: 'claimed' });
  const lostBefore = await chainUsd(wallet);
  let lost;
  try {
    tool('local-test-stack.mjs', 'stop', 'ledger');
    lost = (await client.post('/api/campaigns/trpc/vouchers.redeem', { voucherId: claimed.id, amount: FACE, sequence: 1 })).body;
    expect(lost?.result?.data, JSON.stringify(lost).slice(0, 400)).toBeTruthy();
    const open = lost.result.data.redemption.reward;
    // No answer from the ledger: the owe post's outcome is unknown, which the reconciler retries under the same key.
    expect(open.state).toBe('unknown');
    expect(open.owed).toBeNull();
    expect(open.payout).toBeNull();
    await page.reload();
    const pending = voucherRow(page, claimed.id).getByTestId('voucher-redemptions').locator('li');
    await expect(pending).toHaveCount(1, { timeout: 30_000 });
    await expect(pending.first()).not.toHaveAttribute('data-state', 'paid');
    await expect(pending.first()).toContainText('still open');
    expect(await chainUsd(wallet)).toBe(lostBefore);
  } finally {
    tool('local-test-stack.mjs', 'start', '--only', 'ledger');
  }
  await expect.poll(async () => (await redemptionOf(me, claimed.id, 1))?.reward.state, { timeout: 180_000 }).toBe('paid');
  const finished = await redemptionOf(me, claimed.id, 1);
  expect(finished.reward.rewardKey).toBe(lost.result.data.redemption.reward.rewardKey);
  // The voucher's whole face value, recorded owed once and paid once.
  expect(finished.amount).toBe(FACE);
  await paidOnce(me, finished, wallet);
  expect(await chainUsd(wallet)).toBe(lostBefore + usdUnits(FACE));
  // The first voucher's redemption still has its one payment.
  await paidOnce(me, await redemptionOf(me, voucherId, 1), wallet);
  run.write({ ...run.read(), paidVoucherId: claimed.id });
});

test(`${J} #6 uses part of a voucher: the remainder, never more than the face value`, async ({ browser }) => {
  const { me, voucherId } = state('me', 'voucherId');
  const page = await (await browser.newContext()).newPage();
  await signIn(page, me);
  await openWallet(page);
  const row = voucherRow(page, voucherId);
  await expect(row.getByTestId('voucher-remaining')).toHaveText(`0.015 ${ASSET} left of 0.02 ${ASSET}`);
  await expect(row.getByTestId('voucher-state')).toHaveText('Partly used');
  // More than is left refuses, and nothing changes.
  await row.getByRole('textbox', { name: 'Amount to redeem' }).fill('0.016');
  await row.getByRole('button', { name: 'Redeem' }).click();
  await expect(row.getByTestId('voucher-refusal')).toHaveAttribute('data-code', 'campaigns.voucher_exceeds_remaining');
  await expect(row.getByTestId('voucher-remaining')).toHaveText(`0.015 ${ASSET} left of 0.02 ${ASSET}`);
  // The rest redeems; nothing is left and the voucher is used.
  await row.getByRole('textbox', { name: 'Amount to redeem' }).fill('0.015');
  await row.getByRole('button', { name: 'Redeem' }).click();
  await expect(row.getByTestId('voucher-state')).toHaveText('Used', { timeout: 30_000 });
  await expect(row.getByTestId('voucher-remaining')).toHaveText(`0 ${ASSET} left of 0.02 ${ASSET}`);
  const [v] = (await walletOf(me)).filter((x) => x.id === voucherId);
  expect(v.redemptions.map((r) => r.amount)).toEqual([PART, '0.015']);
  await expect(row.getByRole('button', { name: 'Redeem' })).toHaveCount(0);
});

test(`${J} #7 lets a voucher expire: it expires once and a late redemption refuses; what was already paid stays in the wallet and the record says it was paid`, async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const { me, wallet } = state('me', 'wallet');
  const now = Date.now();
  const short = await liveVoucherCampaign(`TEST vouchers short ${tag}`, {
    claimBy: new Date(now + 60_000).toISOString(),
    useBy: new Date(now + 120_000).toISOString(),
  });
  const code = `JC08-${tag}-C`;
  await issue(short.id, code);
  const client = await api(me);
  const claimed = client.post('/api/campaigns/trpc/vouchers.claim', { code });
  const voucher = (await claimed).body?.result?.data;
  expect(voucher, JSON.stringify((await claimed).body).slice(0, 300)).toMatchObject({ state: 'claimed' });
  // Part of it is redeemed and paid to the connected wallet before its use-by.
  const used = await client.post('/api/campaigns/trpc/vouchers.redeem', { voucherId: voucher.id, amount: PART, sequence: 1 });
  expect(used.body?.result?.data?.created, JSON.stringify(used.body).slice(0, 300)).toBe(true);
  await expect.poll(async () => (await redemptionOf(me, voucher.id, 1))?.reward.state, { timeout: 90_000 }).toBe('paid');
  const paid = await redemptionOf(me, voucher.id, 1);
  await paidOnce(me, paid, wallet);
  const walletAtPayment = await chainUsd(wallet);
  // The use-by date passes; the sweep marks it expired once, however many passes run.
  await expect.poll(async () => (await walletOf(me)).find((v) => v.id === voucher.id).expiredAt, { timeout: 180_000 }).toBeTruthy();
  const marked = (await walletOf(me)).find((v) => v.id === voucher.id);
  expect(marked.state).toBe('expired');
  const late = await client.post('/api/campaigns/trpc/vouchers.redeem', { voucherId: voucher.id, amount: '0.001', sequence: 2 });
  expect(late.body?.error?.message ?? '').toContain('[campaigns.voucher_expired]');
  const [v] = (await walletOf(me)).filter((x) => x.id === voucher.id);
  // Expired once: a later pass leaves the first mark as it was.
  expect(v.expiredAt).toBe(marked.expiredAt);
  // What was paid stays paid: the one redemption, its record still paid with the same chain transaction, and the
  // wallet still holds it (expiry pulls nothing back).
  expect(v.redemptions).toHaveLength(1);
  expect(v.redemptions[0].reward.state).toBe('paid');
  expect(v.redemptions[0].reward.payout).toEqual(paid.reward.payout);
  await paidOnce(me, v.redemptions[0], wallet);
  expect(await chainUsd(wallet)).toBeGreaterThanOrEqual(walletAtPayment);
  const page = await (await browser.newContext()).newPage();
  await signIn(page, me);
  await openWallet(page);
  const row = voucherRow(page, voucher.id);
  await expect(row.getByTestId('voucher-state')).toHaveText('Expired');
  await expect(row.getByRole('button', { name: 'Redeem' })).toHaveCount(0);
  const kept = row.getByTestId('voucher-redemptions').locator('li');
  await expect(kept).toHaveCount(1);
  await expect(kept.first()).toHaveAttribute('data-state', 'paid');
  await expect(kept.first().getByTestId('voucher-chain-tx')).toHaveAttribute('data-tx', paid.reward.payout.chainTx);
  await signOutBrowser(page.context());
});
