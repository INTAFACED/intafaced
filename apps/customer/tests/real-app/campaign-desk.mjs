import { privateKeyToAccount } from 'viem/accounts';
import { expect } from './journey.mjs';
import { chosePro, signIn, signUp } from './desk.mjs';
import { CHAIN_ID, fundOnTestChain, testChain } from './dex.mjs';
import { api, tool } from './stack.mjs';
import { installTestWallet, TEST_WALLET } from './test-wallet.mjs';
import { testVenue, venueRecord } from './venue.mjs';
import { sheet } from './venue-room.mjs';

// What the campaigns journeys share: the two TEST operators' campaign desk, the person's own rewards and vouchers, and
// the TEST trader who connects a wallet to the venue. Each journey file names its own run, asset and wallet seed; the
// parts that hold a file's own state are made per file (`operatorPair()`, `traderOf(walletKeyOf)`).

/** A campaigns reply's row, or a refusal that names the call and the answer. */
export const data = (res, what) => {
  const row = res.json?.result?.data;
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** The stack's two TEST operators (A asks, B approves), made once per journey file on first use. */
export function operatorPair() {
  let gates;
  let ctx;
  let pair;
  return async function operators() {
    gates ??= await import('../../../../tooling/scripts/local-test-gates.mjs');
    ctx ??= await gates.makeContext({ log: () => {} });
    pair ??= await gates.approverSessions(ctx);
    return { ctx, pair };
  };
}

/** The operators' reward pot: A asks for `amount` of `asset`, B approves, and it posts. */
export function potFunding(operators, asset) {
  async function fundPot(reference, amount) {
    const { ctx, pair } = await operators();
    const a = await pair.a.campaignsOpsToken();
    const b = await pair.b.campaignsOpsToken();
    data(
      await ctx.edge.mutate('campaigns', 'ops.pot.request', { reference, sourceModule: 'builder', asset, amount }, a),
      'ops.pot.request',
    );
    const funded = data(await ctx.edge.mutate('campaigns', 'ops.pot.approve', { reference }, b), 'ops.pot.approve');
    expect(funded.state, JSON.stringify(funded)).toBe('posted');
  }
  /** Funds the pot once the builder fees it draws on have arrived, asking again until it posts. */
  async function fundPotFromFees(reference, amount) {
    await expect
      .poll(
        async () => {
          try {
            await fundPot(`${reference}-${Date.now().toString(36)}`, amount);
            return 'posted';
          } catch (err) {
            return String(err).slice(0, 200);
          }
        },
        { timeout: 90_000, intervals: [5_000] },
      )
      .toBe('posted');
  }
  return { fundPot, fundPotFromFees };
}

/** A campaign the operators create, submit, approve (the other operator) and activate; returns it live. */
export function campaignLauncher(operators) {
  return async function liveCampaign(definition) {
    const { ctx, pair } = await operators();
    const a = await pair.a.campaignsOpsToken();
    const b = await pair.b.campaignsOpsToken();
    const made = data(await ctx.edge.mutate('campaigns', 'ops.campaigns.create', definition, a), 'ops.campaigns.create');
    data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'submit', revision: 1 }, a), 'submit');
    data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'approve', revision: 1 }, b), 'approve');
    const live = data(
      await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'activate', revision: 1 }, a),
      'activate',
    );
    expect(live.state).toBe('active');
    return live;
  };
}

/** The person joins the campaign, and it is a new participation. */
export const join = async (who, campaignId) => {
  const joined = await (await api(who)).post('/api/campaigns/trpc/participation.join', { campaignId });
  expect(joined.body?.result?.data?.created, JSON.stringify(joined.body).slice(0, 300)).toBe(true);
};

const trpc = (procedure, input) => `/api/campaigns/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;

/** One campaigns call as the person, a query (`GET`) or a mutation. */
export async function call(who, method, procedure, input) {
  const client = await api(who);
  const res = method === 'GET' ? await client.get(trpc(procedure, input)) : await client.post(`/api/campaigns/trpc/${procedure}`, input);
  if (!res.body?.result) throw new Error(`${procedure} refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}

/** The person's own rewards, as svc-campaigns answers them. */
export async function myRewards(who) {
  const res = await (await api(who)).get(`/api/campaigns/trpc/rewards.mine?input=${encodeURIComponent('{}')}`);
  if (!res.body?.result) throw new Error(`rewards.mine refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data.rewards;
}

/** The person's own vouchers, as svc-campaigns answers them. */
export async function walletOf(who) {
  const res = await (await api(who)).get(`/api/campaigns/trpc/vouchers.mine?input=${encodeURIComponent('{}')}`);
  if (!res.body?.result) throw new Error(`vouchers.mine refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data.vouchers;
}

/** The rewards hub, once it has loaded. */
export async function openHub(page) {
  await page.goto('/uc/promotion');
  const hub = page.getByTestId('rewards-hub');
  await expect(hub).toBeVisible();
  await expect(hub).not.toHaveAttribute('data-state', 'loading', { timeout: 30_000 });
  return hub;
}

/** USD to its 6-decimal units, digits past the sixth dropped. */
export function usdUnits(amount) {
  const [w, f = ''] = String(amount).split('.');
  return BigInt(w + f.padEnd(6, '0').slice(0, 6));
}

/** Basic verification through the verification room, granted by the stack's TEST reviewer. */
export async function verifyBasic(page) {
  await page.goto('/verification');
  await page.getByLabel('Level to request').selectOption({ label: 'Basic' });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
  tool('local-test-gates.mjs', 'verify');
}

/** Connects the person's TEST wallet to their account on Wallet's Venue account tab, as svc-protocol records it. */
export async function connectWallet(page, who, privateKey) {
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

/**
 * A new Pro person, verified, whose TEST wallet (from the file's own `walletKeyOf`) is funded on the TEST chain and
 * connected to their venue account: `{ who, key, wallet }`. A file that verifies or connects its own way passes its own.
 */
export function traderOf(walletKeyOf, ways = {}) {
  const { verifyBasic: verify = verifyBasic, connectWallet: connect = connectWallet } = ways;
  return async function trader(browser, prefix) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await chosePro(page);
    const who = await signUp(page, prefix);
    await verify(page);
    const key = walletKeyOf(who);
    const wallet = privateKeyToAccount(key).address.toLowerCase();
    fundOnTestChain(wallet, 'venue');
    const connecting = await (await browser.newContext()).newPage();
    await connect(connecting, who, key);
    await connecting.context().close();
    await context.close();
    return { who, key, wallet };
  };
}

/** One venue action through our door, signed by the trader's own TEST wallet; the venue accepts it definitely. */
export async function traderDoor(p, intent, actionKey) {
  const session = await api(p.who);
  const signer = { role: 'owner', address: p.wallet };
  const prepared = await session.post('/api/v1/venue/prepare', { owner: p.wallet, signer, intent, ...(actionKey ? { actionKey } : {}) });
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
  const t = prepared.body.prepared.typedData;
  const signature = await privateKeyToAccount(p.key).signTypedData({
    domain: t.domain,
    types: t.types,
    primaryType: t.primaryType,
    message: t.message,
  });
  const sent = await session.post('/api/v1/venue/submit', {
    actionKey: prepared.body.actionKey,
    signature: { digest: prepared.body.prepared.digest, signature, signedBy: p.wallet },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
  expect(sent.body.outcome, JSON.stringify(sent.body.outcome).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
  return sent.body;
}

/** The trader approves our builder fee at the market's cap, so their orders route through us (one approval per run). */
export function signsThroughUs(J, RUN) {
  return async function signedThroughUs(p) {
    const status = (await (await api(p.who)).get('/api/v1/venue/status')).body;
    expect(status, JSON.stringify(status).slice(0, 300)).toMatchObject({ enabled: true, test: true });
    const markets = await testVenue('/markets', { account: null });
    const cap = markets.body.value.find((m) => m.symbol === 'BTC-USDC').builderFeeCapBps.value;
    await traderDoor(
      p,
      { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: cap },
      `approve-builder:${p.wallet}:${J}:${RUN}`,
    );
  };
}

/** The TEST venue's own fills of the person's wallet since `since`, of orders placed through INTAFACED (our builder fee above zero). */
export async function ourVenueFills(p, since) {
  const body = await venueRecord(p.wallet, '/fills', { since });
  return body.value.filter((f) => !/^-?0(\.0+)?$/.test(f.builderFee) && !f.builderFee.startsWith('-'));
}

/** A venue fill's notional, price x amount, as an exact decimal string. */
export function fillNotional(f) {
  const [pw, pf = ''] = f.price.split('.');
  const [aw, af = ''] = f.amount.split('.');
  const n = ((BigInt(pw + pf.padEnd(18, '0')) * BigInt(aw + af.padEnd(18, '0'))) / 10n ** 18n).toString().padStart(19, '0');
  const frac = n.slice(-18).replace(/0+$/, '');
  return frac ? `${n.slice(0, -18)}.${frac}` : n.slice(0, -18);
}
