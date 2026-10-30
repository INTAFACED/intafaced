import { test, expect } from '@playwright/test';
import { signIn, signUp } from './desk.mjs';
import { api, journeyState, signOutBrowser } from './stack.mjs';

// J-campaigns-08, in the running app (docs/roadmap/journeys.json): claim a voucher and use it. One test per step, titled
// "J-campaigns-08 #<n>", run in order. The voucher campaign is this run's TEST campaign, made by the stack's two LOCAL TEST
// founders through svc-campaigns' operator doors (A creates and asks, B approves, A activates), and its vouchers are
// issued by founder A under codes made for this run. A cash voucher pays TEST USDT from the one reward pot, which the
// founders fund from trade fees the platform earned. Validate and claim attempts count against the stack's labelled TEST
// attempt limit (tooling/profiles/test-owner-values/campaigns.json).
const J = 'J-campaigns-08';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const FACE = '0.02';
const PART = '0.005';
const DAY = 86_400_000;

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

/** A TEST voucher campaign live now, with its claim-by and use-by dates; its reward is each voucher's face value. */
async function liveVoucherCampaign(name, { claimBy, useBy }) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const definition = {
    name,
    type: 'voucher',
    rules: `TEST rules for ${name}: claim a voucher by its code, then redeem it to your account. Its value is TEST USDT.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 14 * DAY).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    budget: { asset: 'USDT', limit: '0.1' },
    reward: { asset: 'USDT', amount: FACE },
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

/** Founder A asks to sweep earned trade fees into the reward pot; founder B approves, which posts it. */
async function fundPot(reference, amount) {
  const { ctx, pair } = await operators();
  data(
    await ctx.edge.mutate(
      'campaigns',
      'ops.pot.request',
      { reference, sourceModule: 'trade', asset: 'USDT', amount },
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
  const campaign = await liveVoucherCampaign(`TEST vouchers ${tag}`, {
    claimBy: new Date(now + 7 * DAY).toISOString(),
    useBy: new Date(now + 7 * DAY).toISOString(),
  });
  const codes = { cash: `JC08-${tag}-A`, other: `JC08-${tag}-B` };
  for (const code of Object.values(codes)) expect((await issue(campaign.id, code)).state).toBe('published');
  const page = await (await browser.newContext()).newPage();
  const me = await signUp(page, 'jc08me');
  const wallet = await openWallet(page);
  expect(await walletOf(me)).toEqual([]);
  await expect(wallet.getByTestId('vouchers-empty')).toContainText('No voucher on this account');
  // The code form is always laid out, with validate and claim.
  await expect(codeForm(page).getByRole('textbox', { name: 'Code' })).toBeVisible();
  await expect(codeForm(page).getByRole('button', { name: 'Check this code' })).toBeVisible();
  await expect(codeForm(page).getByRole('button', { name: 'Claim this voucher' })).toBeVisible();
  run.write({ me, campaignId: campaign.id, codes });
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
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  expect(lost[0].body?.error?.message ?? '').toContain('[campaigns.voucher_invalid]');
  const claimed = won[0].body.result.data;
  expect(claimed).toMatchObject({ state: 'claimed', face: { asset: 'USDT', amount: FACE }, remaining: FACE });
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
  await expect(result).toContainText(`${FACE} USDT`);
  await expect(result).toContainText('Claim by');
  // Nothing changed: the voucher is still free to claim, and my wallet still holds only the first one.
  expect((await walletOf(me)).map((v) => v.code)).toEqual([codes.cash]);
  const again = await (
    await api(me)
  ).get(`/api/campaigns/trpc/vouchers.validate?input=${encodeURIComponent(JSON.stringify({ code: codes.other }))}`);
  expect(again.body?.result?.data).toMatchObject({ claimable: true, face: { asset: 'USDT', amount: FACE } });
});

test(`${J} #5 redeems the voucher, pressing twice: one redemption, my account credited once`, async ({ browser }) => {
  test.setTimeout(180_000);
  const { me, voucherId } = state('me', 'voucherId');
  await fundPot(`TEST-${J}-${tag}`, FACE);
  const client = await api(me);
  const [one, two] = await Promise.all([
    client.post('/api/campaigns/trpc/vouchers.redeem', { voucherId, amount: PART, sequence: 1 }),
    client.post('/api/campaigns/trpc/vouchers.redeem', { voucherId, amount: PART, sequence: 1 }),
  ]);
  const answers = [one, two].map((r) => r.body?.result?.data);
  expect(answers.every(Boolean), JSON.stringify([one.body, two.body]).slice(0, 400)).toBe(true);
  expect(answers.filter((a) => a.created)).toHaveLength(1);
  expect(answers[0].redemption.key).toBe(answers[1].redemption.key);
  await expect
    .poll(async () => (await walletOf(me)).find((v) => v.id === voucherId).redemptions.map((r) => r.reward?.state), { timeout: 60_000 })
    .toEqual(['posted']);
  const [v] = (await walletOf(me)).filter((x) => x.id === voucherId);
  expect(v.redemptions).toHaveLength(1);
  expect(v.redemptions[0].reward.rewardKey).toBe(`voucher:${voucherId}:${client.userId.toLowerCase()}:1`);
  // My rewards shows the credit once, posted with its transaction.
  const page = await (await browser.newContext()).newPage();
  await signIn(page, me);
  await page.goto('/uc/promotion');
  const rows = page.locator(`[data-testid="reward-row"][data-reward-key="${v.redemptions[0].reward.rewardKey}"]`);
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(rows.getByTestId('reward-status')).toHaveText('Posted');
  await expect(rows.getByTestId('reward-amount')).toHaveText(`${PART} USDT`);
});

test(`${J} #6 uses part of a voucher: the remainder, never more than the face value`, async ({ browser }) => {
  const { me, voucherId } = state('me', 'voucherId');
  const page = await (await browser.newContext()).newPage();
  await signIn(page, me);
  await openWallet(page);
  const row = voucherRow(page, voucherId);
  await expect(row.getByTestId('voucher-remaining')).toHaveText('0.015 USDT left of 0.02 USDT');
  await expect(row.getByTestId('voucher-state')).toHaveText('Partly used');
  // More than is left refuses, and nothing changes.
  await row.getByRole('textbox', { name: 'Amount to redeem' }).fill('0.016');
  await row.getByRole('button', { name: 'Redeem' }).click();
  await expect(row.getByTestId('voucher-refusal')).toHaveAttribute('data-code', 'campaigns.voucher_exceeds_remaining');
  await expect(row.getByTestId('voucher-remaining')).toHaveText('0.015 USDT left of 0.02 USDT');
  // The rest redeems; nothing is left and the voucher is used.
  await row.getByRole('textbox', { name: 'Amount to redeem' }).fill('0.015');
  await row.getByRole('button', { name: 'Redeem' }).click();
  await expect(row.getByTestId('voucher-state')).toHaveText('Used', { timeout: 30_000 });
  await expect(row.getByTestId('voucher-remaining')).toHaveText('0 USDT left of 0.02 USDT');
  const [v] = (await walletOf(me)).filter((x) => x.id === voucherId);
  expect(v.redemptions.map((r) => r.amount)).toEqual([PART, '0.015']);
  await expect(row.getByRole('button', { name: 'Redeem' })).toHaveCount(0);
});

test(`${J} #7 lets a voucher expire: it expires once, and a late redemption refuses`, async ({ browser }) => {
  test.setTimeout(180_000);
  const { me } = state('me');
  const now = Date.now();
  const short = await liveVoucherCampaign(`TEST vouchers short ${tag}`, {
    claimBy: new Date(now + 20 * 60_000).toISOString(),
    useBy: new Date(now + 40_000).toISOString(),
  });
  const code = `JC08-${tag}-C`;
  await issue(short.id, code);
  const client = await api(me);
  const claimed = client.post('/api/campaigns/trpc/vouchers.claim', { code });
  const voucher = (await claimed).body?.result?.data;
  expect(voucher, JSON.stringify((await claimed).body).slice(0, 300)).toMatchObject({ state: 'claimed' });
  // The use-by date passes; the sweep marks it expired once, however many passes run.
  await expect.poll(async () => (await walletOf(me)).find((v) => v.id === voucher.id).state, { timeout: 90_000 }).toBe('expired');
  const late = await client.post('/api/campaigns/trpc/vouchers.redeem', { voucherId: voucher.id, amount: '0.001', sequence: 1 });
  expect(late.body?.error?.message ?? '').toContain('[campaigns.voucher_expired]');
  const [v] = (await walletOf(me)).filter((x) => x.id === voucher.id);
  expect(v.redemptions).toEqual([]);
  expect(v.expiredAt).toBeTruthy();
  const page = await (await browser.newContext()).newPage();
  await signIn(page, me);
  await openWallet(page);
  await expect(voucherRow(page, voucher.id).getByTestId('voucher-state')).toHaveText('Expired');
  await expect(voucherRow(page, voucher.id).getByRole('button', { name: 'Redeem' })).toHaveCount(0);
  await signOutBrowser(page.context());
});
