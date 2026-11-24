// World: restart
import { randomBytes } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signIn } from './desk.mjs';
import { TOKEN_USD, fundOnTestChain } from './dex.mjs';
import { api, EDGE, journeyState, restartService, signUpInBrowser, stackUrl } from './stack.mjs';
import { chainBalance, venueForThisFile } from './venue.mjs';
import { chainReceipt, rewardFunds } from './reward-funds.mjs';
import { campaignLauncher, connectWallet, myRewards, usdUnits, verifyBasic } from './campaign-desk.mjs';

/** The public invitation site on the stack (apps/invitation), where the waitlist lives at /waitlist. */
const JOIN = process.env.JOURNEY_JOIN_URL ?? stackUrl('invitation');

// J-campaigns-20, in the running app (docs/roadmap/journeys.json): join the waitlist, climb by inviting, and claim a drop.
// One test per step, titled "J-campaigns-20 #<n>", run in order. Every visitor is signed out on a browser of their own.
// #3's operators are the stack's two LOCAL TEST founders on the founder console's Waitlist waves room
// (/more-ops/campaigns/waves): A asks for the release, B approves the same packet on their own console, A runs it. The wave size is the stack's labelled TEST value
// (IDENTITY_WAITLIST_WAVE_SIZE, two, in tooling/profiles/test-owner-values/identity.json). For the blank size, #3 first
// restarts identity with it left blank (LOCAL_STACK_IDENTITY_WAVE_SIZE=off): a release refuses drop.wave_unset and nobody
// is released; a plain restart puts the TEST value back.
// #4-#6 are the drop room on the Customer app (/campaigns/drops): I sign up with the email I joined the waitlist with, the
// two TEST founders make a TEST season and a TEST drop of three (A creates, B publishes, through svc-campaigns' operator
// doors), and four friends claim alongside me. The drop has value: it names this run's TEST drop campaign, whose reward
// (0.01 TEST USDC) is what each claim is worth and whose budget pays it, funded from INTAFACED's TEST reward pot, which the
// founders fund from builder fees the TEST venue credited us on this file's own sells (reward-funds.mjs). My claim is
// owed once and paid once to my own connected TEST wallet on the stack's TEST chain, read back from the chain itself.
// The TGE schedule is the stack's blank owner value, so its claim refuses.
const J = 'J-campaigns-20';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state(...keys) {
  const s = run.read();
  for (const k of keys) if (!s[k]) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
  return s;
}

/** A signed-out visitor on a device of its own. */
async function visitor(browser) {
  const context = await browser.newContext({ baseURL: JOIN, viewport: { width: 1280, height: 900 } });
  return context.newPage();
}

/** Joins from the page it is on (the waitlist, or a friend's link) and returns the visitor's own code from the address. */
async function joinAs(page, email) {
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Join the waitlist' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your place in the queue' })).toBeVisible();
  const code = new URL(page.url()).searchParams.get('code');
  expect(code).toMatch(/^[0-9a-f]{12}$/);
  return code;
}

/** The public place-in-line read, as the page makes it. */
async function standing(code) {
  const res = await fetch(
    `${EDGE}/api/identity/trpc/waitlist.position?input=${encodeURIComponent(JSON.stringify({ referralCode: code }))}`,
  );
  const body = await res.json();
  if (!body.result) throw new Error(`waitlist.position refused (${res.status}): ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
  return body.result.data;
}

/** The rank the page shows: "#<rank>" and "of <n> waiting". */
async function shownRank(page) {
  const read = page.waitForResponse((res) => res.url().includes('/waitlist.position'));
  await page.getByRole('button', { name: 'Check my place again' }).click();
  await read;
  await expect(page.locator('section[role="main"]')).toHaveAttribute('aria-busy', 'false');
  const text = await page.locator('.waitlist-rank').innerText();
  const m = /#(\d+)\s+of\s+(\d+)\s+waiting/.exec(text);
  if (!m) throw new Error(`no rank on the page: ${text}`);
  return { rank: Number(m[1]), waiting: Number(m[2]) };
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

test(`${J} #1 joins the waitlist signed out and sees a queue position`, async ({ browser, stepPicture }) => {
  run.reset({});
  const page = await visitor(browser);
  await page.goto('/join');
  await page.getByRole('link', { name: 'Join the waitlist' }).click();
  await expect(page).toHaveURL(/\/waitlist$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Join the waitlist' })).toBeVisible();
  const email = `jc20-me-${tag}@local-test.invalid`;
  const code = await joinAs(page, email);
  const shown = await shownRank(page);
  const read = await standing(code);
  expect(read.release).toBeNull();
  expect(shown).toEqual({ rank: read.rank, waiting: read.waiting });
  await expect(page.getByTestId('waitlist-referred')).toHaveText('0');
  await expect(page.getByLabel('Your invitation link')).toHaveValue(`${JOIN}/waitlist?ref=${code}`);
  // Coming back to the link shows the same place, read again, not remembered.
  await page.goto(`/waitlist?code=${code}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Your place in the queue' })).toBeVisible();
  await stepPicture(page);
  run.write({ code, email });
});

test(`${J} #2 each friend who joins with my link moves me up; ties go by join order`, async ({ browser, stepPicture }) => {
  const { code } = state('code');
  const bring = async (refCode, who) => {
    const p = await visitor(browser);
    await p.goto(`/waitlist?ref=${refCode}`);
    await joinAs(p, `jc20-${who}-${tag}@local-test.invalid`);
    await p.context().close();
  };
  // Three rivals join after me and bring one, two and three friends, so all three are ahead of me. Each friend of mine
  // then ties the next rival up, and I joined first, so each one moves me past exactly that rival.
  const rivals = [];
  for (const k of [1, 2, 3]) {
    const rival = await visitor(browser);
    await rival.goto('/waitlist');
    const rivalCode = await joinAs(rival, `jc20-rival${k}-${tag}@local-test.invalid`);
    await rival.context().close();
    for (let n = 1; n <= k; n++) await bring(rivalCode, `rival${k}friend${n}`);
    rivals.push(rivalCode);
  }
  for (const rivalCode of rivals) expect((await standing(rivalCode)).rank).toBeLessThan((await standing(code)).rank);

  const page = await visitor(browser);
  await page.goto(`/waitlist?code=${code}`);
  let before = await shownRank(page);
  const start = before.rank;
  expect(start).toBeGreaterThan(1);
  const inviteOne = async (n) => {
    const friend = await visitor(browser);
    await friend.goto(`/waitlist?ref=${code}`);
    await expect(friend.getByTestId('waitlist-invited-by')).toContainText(code);
    await joinAs(friend, `jc20-friend${n}-${tag}@local-test.invalid`);
    await friend.context().close();
    await expect(page.getByTestId('waitlist-referred')).toHaveText(String(n));
    return shownRank(page);
  };
  // Each of my first three friends moves me up: past the rival with one, then two, then three friends.
  for (const n of [1, 2, 3]) {
    const after = await inviteOne(n);
    expect(after.rank, `friend ${n} moves me up`).toBeLessThan(before.rank);
    expect(after.rank).toBe((await standing(code)).rank);
    before = after;
  }
  expect((await standing(rivals[2])).rank).toBeGreaterThan(before.rank);
  // On a long-lived stack an earlier run may have left people waiting with more friends; keep inviting (twenty-five at
  // most) until I am first in the queue, which #3's wave then reaches. On a fresh stack I already am.
  for (let n = 4; before.rank > 1 && n <= 25; n++) before = await inviteOne(n);
  expect(before.rank).toBeLessThan(start);
  expect(before.rank).toBe(1);

  // Ties: x joins before y. With no friends each, x is ahead; one friend moves y past x; one friend for x too is a tie,
  // and x, who joined first, is ahead again.
  const x = await visitor(browser);
  await x.goto('/waitlist');
  const xCode = await joinAs(x, `jc20-x-${tag}@local-test.invalid`);
  const y = await visitor(browser);
  await y.goto('/waitlist');
  const yCode = await joinAs(y, `jc20-y-${tag}@local-test.invalid`);
  expect((await standing(xCode)).rank).toBeLessThan((await standing(yCode)).rank);
  await bring(yCode, 'yfriend');
  expect((await standing(yCode)).rank).toBeLessThan((await standing(xCode)).rank);
  await bring(xCode, 'xfriend');
  expect((await standing(xCode)).rank).toBeLessThan((await standing(yCode)).rank);
  expect((await shownRank(x)).rank).toBe((await standing(xCode)).rank);
  // On my own page: first in the queue, with every friend I brought.
  expect((await shownRank(page)).rank).toBe(1);
  await stepPicture(page);
  run.write({ ...run.read(), xCode, yCode });
});

test(`${J} #3 an operator releases a wave: the top N are invited once, the rest wait`, async ({ browser, stepPicture }) => {
  const { code, xCode } = state('code', 'xCode');
  const { ctx, pair } = await operators();
  const waves = data(
    await ctx.edge.query('identity', 'waitlist.waves.list', undefined, await pair.a.tradeOpsToken()),
    'waitlist.waves.list',
  );
  expect(waves.waveSize).toBe(2);
  const mine = await standing(code);
  // #2 brought friends until I was first in the queue, so this wave reaches me.
  expect(mine.rank).toBe(1);

  // A blank wave size releases nobody: identity restarted with the size left blank refuses the release by name, before any
  // approval is asked for, and nobody waiting is invited. A plain restart puts the TEST size back.
  await restartService('identity', { LOCAL_STACK_IDENTITY_WAVE_SIZE: 'off' });
  try {
    const blank = data(
      await ctx.edge.query('identity', 'waitlist.waves.list', undefined, await pair.a.tradeOpsToken()),
      'waitlist.waves.list',
    );
    expect(blank.waveSize).toBeNull();
    const unset = await ctx.edge.mutate('identity', 'waitlist.waves.release', { waveNumber: waves.nextWave }, await pair.a.tradeOpsToken());
    expect(unset.json?.error?.message ?? '').toContain('drop.wave_unset');
    const still = data(
      await ctx.edge.query('identity', 'waitlist.waves.list', undefined, await pair.a.tradeOpsToken()),
      'waitlist.waves.list',
    );
    expect(still).toMatchObject({ nextWave: waves.nextWave, waiting: waves.waiting, waves: waves.waves });
    expect((await standing(code)).release).toBeNull();
  } finally {
    await restartService('identity', { LOCAL_STACK_IDENTITY_WAVE_SIZE: undefined });
  }
  expect(
    data(await ctx.edge.query('identity', 'waitlist.waves.list', undefined, await pair.a.tradeOpsToken()), 'waitlist.waves.list').waveSize,
  ).toBe(2);

  // A release without a second person's approval refuses and invites nobody.
  const bare = await ctx.edge.mutate('identity', 'waitlist.waves.release', { waveNumber: waves.nextWave }, await pair.a.tradeOpsToken());
  expect(bare.json?.error?.message ?? '').toContain('action_approval.missing');
  expect((await standing(code)).release).toBeNull();

  // Founder A asks for the release on the console's Waitlist waves room; founder B approves the same packet on their own
  // console; A runs it.
  const phrase = `RELEASE WAVE ${waves.nextWave}`;
  const a = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  await a.goto(`${ADMIN}/more-ops/campaigns/waves`, { waitUntil: 'load' });
  await expect(a.getByTestId('waves-next')).toHaveText(String(waves.nextWave), { timeout: 60_000 });
  await expect(a.getByTestId('waves-size')).toHaveText('2');
  const desk = a.getByTestId('control-desk');
  await expect(desk.getByRole('heading', { name: `Release wave ${waves.nextWave}: the top 2 waiting` })).toBeVisible();
  await desk.getByLabel(/to confirm$/).fill(phrase);
  await desk.getByRole('button', { name: 'Ask a second founder to approve the release' }).click();
  await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  const packetText = (await desk.getByLabel('Request packet').inputValue()).trim();
  const packet = JSON.parse(Buffer.from(packetText.slice('ifa1.'.length), 'base64url').toString('utf8'));
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await expect(desk.getByRole('button', { name: 'Approve this request' })).toBeDisabled();

  const b = await (await browser.newContext()).newPage();
  await founderSignIn(b, 'b');
  await b.goto(`${ADMIN}/more-ops/campaigns/waves`, { waitUntil: 'load' });
  const deskB = b.getByTestId('control-desk');
  await deskB.getByLabel('Request packet').fill(packetText);
  await expect(deskB.getByTestId('packet-summary')).toContainText(`wave ${waves.nextWave}`);
  await deskB.getByLabel(/to approve or run it$/).fill(phrase);
  await deskB.getByRole('button', { name: 'Approve this request' }).click();
  await expect(deskB.getByTestId('step-reply')).toContainText('Approved.');

  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(desk.getByTestId('step-reply')).toContainText(`wave ${waves.nextWave} released`, { timeout: 60_000 });
  const row = a
    .getByTestId('waves-released')
    .locator('tbody tr')
    .filter({ has: a.locator('td:first-child', { hasText: new RegExp(`^${waves.nextWave}$`) }) });
  await expect(row).toHaveCount(1);
  await expect(a.getByTestId('waves-next')).toHaveText(String(waves.nextWave + 1));

  const input = { waveNumber: waves.nextWave, approvalId: packet.approvalId, operationId: packet.operationId };
  const released = data(
    await ctx.edge.query('identity', 'waitlist.waves.list', undefined, await pair.a.tradeOpsToken()),
    'waitlist.waves.list',
  ).waves.find((w) => w.waveNumber === waves.nextWave);
  expect(released).toMatchObject({ waveNumber: waves.nextWave, size: 2 });
  // The top N, N being the wave size: everyone waiting when fewer were.
  expect(released.releasedCount).toBe(Math.min(2, waves.waiting));
  // The same wave again is the stored wave: nobody else is invited.
  const again = data(
    await ctx.edge.mutate('identity', 'waitlist.waves.release', input, await pair.a.tradeOpsToken()),
    'waitlist.waves.release',
  );
  expect(again).toEqual({ created: false, wave: released });

  // I was in the top two: my page shows the invitation for this wave.
  const page = await visitor(browser);
  await page.goto(`/waitlist?code=${code}`);
  await expect(page.getByRole('heading', { level: 1, name: `You are invited: wave ${waves.nextWave}` })).toBeVisible();
  expect((await standing(code)).release).toMatchObject({ waveNumber: waves.nextWave });

  // Whoever was not in the top two still waits, with a place in the queue.
  const after = data(
    await ctx.edge.query('identity', 'waitlist.waves.list', undefined, await pair.a.tradeOpsToken()),
    'waitlist.waves.list',
  );
  expect(after.nextWave).toBe(waves.nextWave + 1);
  expect(after.waiting).toBe(waves.waiting - released.releasedCount);
  // x has one friend; my rival, who #2 made, has three and is ahead of x, so the top two never reach x.
  const x = await standing(xCode);
  expect(x.release).toBeNull();
  expect(x.rank).toBeGreaterThan(0);
  const xPage = await visitor(browser);
  await xPage.goto(`/waitlist?code=${xCode}`);
  await expect(xPage.getByRole('heading', { level: 1, name: 'Your place in the queue' })).toBeVisible();
  // My own page, invited in this wave.
  await expect(page.getByRole('heading', { level: 1, name: `You are invited: wave ${waves.nextWave}`, exact: true })).toBeVisible();
  await stepPicture(page);
  run.write({ ...run.read(), waveNumber: waves.nextWave });
});

const DROP_COUNT = 3;
/** What one claim of this run's drop is worth, in TEST USDC: its drop campaign's reward. */
const DROP_VALUE = '0.01';
const DROP_BUDGET = '0.03';
const ASSET = 'USDC';
const DAY = 86_400_000;
const person = (handle, email = `${handle}@local-test.invalid`) => ({
  handle,
  email,
  password: `TEST-${randomBytes(9).toString('base64url')}-9a`,
});

/** My own TEST wallet, made in #4 from this run's name and kept in the run's state: it holds nothing real. */
const walletOf = (key) => privateKeyToAccount(key).address.toLowerCase();
const funds = rewardFunds({ J, RUN: `${process.env.JOURNEY_RUN_ID ?? 'local'}-${tag}`, operators });
const liveCampaign = campaignLauncher(operators);

/** A signed-in customer on a device of its own. */
async function customer(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  return context.newPage();
}

async function openRoom(page) {
  await page.goto('/campaigns/drops');
  await expect(page.getByRole('heading', { level: 1, name: 'Drop room', exact: true })).toBeVisible();
  await expect(page.getByTestId('drop-tge')).toBeVisible({ timeout: 30_000 });
}

const dropRow = (page, dropId) => page.locator(`[data-testid="drop-row"][data-drop-id="${dropId}"]`);

test(`${J} #4 the drop room shows my rank, wave, season points and each limited drop`, async ({ browser, stepPicture }) => {
  test.setTimeout(900_000);
  const { email } = state('code', 'email');
  const { ctx, pair } = await operators();
  // INTAFACED's TEST reward pot and rewards wallet: builder fees this file's own TEST sells earned us.
  // The house trader is verified (Basic) before it trades through our door, as any trader must be.
  const house = person(`jc20h${tag}`.slice(0, 20));
  const housePage = await customer(browser);
  await signUpInBrowser(housePage, house);
  await verifyBasic(housePage);
  await housePage.context().close();
  const fees = await funds.earnBuilderFees(house, 4);
  await funds.fundPotFromFees(`TEST-${J}-${tag}`, fees);
  await funds.claimOurBuilderFees();
  // The drop's value: this run's TEST drop campaign, its reward what one claim is worth and its budget the drop count's.
  const now = Date.now();
  const campaign = await liveCampaign({
    name: `TEST drop campaign ${tag}`,
    type: 'drop',
    rules: `TEST rules: each claim of TEST drop ${tag} is worth ${DROP_VALUE} ${ASSET}, paid once to your connected wallet.`,
    startsAt: new Date(now - 60_000).toISOString(),
    endsAt: new Date(now + 7 * DAY).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    budget: { asset: ASSET, limit: DROP_BUDGET },
    limits: { perCustomer: { count: 1, periodSeconds: 86_400 }, totalRedemptions: null },
    reward: { asset: ASSET, amount: DROP_VALUE },
  });
  // The founders make this run's TEST season and TEST drop of three: A creates, B publishes. The creator cannot publish.
  const season = data(
    await ctx.edge.mutate(
      'campaigns',
      'ops.seasons.create',
      { name: `TEST season ${tag}`, startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 30 * 86_400_000).toISOString() },
      await pair.a.campaignsOpsToken(),
    ),
    'ops.seasons.create',
  );
  const self = await ctx.edge.mutate('campaigns', 'ops.seasons.publish', { id: season.id }, await pair.a.campaignsOpsToken());
  expect(self.json?.error?.message ?? '').toContain('campaigns.second_person_required');
  data(
    await ctx.edge.mutate('campaigns', 'ops.seasons.publish', { id: season.id }, await pair.b.campaignsOpsToken()),
    'ops.seasons.publish',
  );
  const drop = data(
    await ctx.edge.mutate(
      'campaigns',
      'ops.drops.create',
      {
        title: `TEST drop ${tag}`,
        seasonId: season.id,
        count: String(DROP_COUNT),
        opensAt: new Date(now - 60_000).toISOString(),
        campaignId: campaign.id,
      },
      await pair.a.campaignsOpsToken(),
    ),
    'ops.drops.create',
  );
  expect(drop).toMatchObject({ kind: 'value', value: { campaignId: campaign.id, asset: ASSET, amount: DROP_VALUE } });
  data(await ctx.edge.mutate('campaigns', 'ops.drops.publish', { id: drop.id }, await pair.b.campaignsOpsToken()), 'ops.drops.publish');

  // My wave was released in #3: I open my account with the email I joined with, and the room finds my place by it. I am
  // verified and connect my own TEST wallet, which a drop with value is paid to.
  const me = person(`jc20me${tag}`.slice(0, 20), email);
  const myWalletKey = keccak256(toHex(`intafaced TEST drop wallet ${J} ${process.env.JOURNEY_RUN_ID ?? 'local'} ${tag}`));
  const myWallet = walletOf(myWalletKey);
  const page = await customer(browser);
  await signUpInBrowser(page, me);
  await verifyBasic(page);
  fundOnTestChain(myWallet, 'venue');
  const connecting = await customer(browser);
  await connectWallet(connecting, me, myWalletKey);
  await connecting.context().close();
  await openRoom(page);
  const mine = data(
    await ctx.edge.query('identity', 'waitlist.waves.list', undefined, await pair.a.tradeOpsToken()),
    'waitlist.waves.list',
  );
  expect(mine.waves.length).toBeGreaterThan(0);
  // The wave #3 released, by its number.
  await expect(page.getByTestId('drop-wave')).toHaveText(`Wave ${state('waveNumber').waveNumber}, released`);
  await expect(page.getByTestId('drop-rank')).toHaveText('—');
  await expect(page.getByTestId('drop-season-name')).toHaveText(`TEST season ${tag}`);
  // Season points read "not running" with the blocker J-campaigns-15 names: the owner's points decision.
  const points = page.getByTestId('drop-season-points');
  await expect(points).toHaveAttribute('data-state', 'not_running');
  await expect(points).toHaveAttribute('data-code', 'owner.decision');
  await expect(points).toContainText('Not running');
  await expect(page.getByTestId('drop-season')).toContainText(
    'Waits for the owner to decide whether INTAFACED runs a points programme whose points have value.',
  );
  const roomRead = await (await api(me)).get('/api/campaigns/trpc/drops.room');
  expect(roomRead.body?.result?.data?.season).toMatchObject({ id: season.id, pointsBlocker: 'owner.decision' });
  const row = dropRow(page, drop.id);
  await expect(row.getByTestId('drop-value')).toHaveText(`${DROP_VALUE} ${ASSET}`);
  await expect(row.getByTestId('drop-left')).toHaveText(`${DROP_COUNT} of ${DROP_COUNT}`);
  await expect(row.getByTestId('drop-state')).toHaveText('Open');
  await expect(row.getByRole('button', { name: `Claim TEST drop ${tag}` })).toBeEnabled();
  await stepPicture(page);
  run.write({ ...run.read(), me, myWalletKey, dropId: drop.id, campaignId: campaign.id });
});

test(`${J} #5 a limited drop claimed together: exactly the count succeed, the rest see sold out`, async ({ browser, stepPicture }) => {
  test.setTimeout(600_000);
  const { me, dropId, myWalletKey } = state('me', 'dropId', 'myWalletKey');
  const myWallet = walletOf(myWalletKey);
  const claimKey = `drop:${dropId}:`;
  // What my own wallet holds on the TEST chain before I claim, read from the chain itself.
  const before = await chainBalance(TOKEN_USD.address, myWallet);
  const page = await customer(browser);
  await signIn(page, me);
  await openRoom(page);
  await dropRow(page, dropId)
    .getByRole('button', { name: /^Claim / })
    .click();
  await expect(dropRow(page, dropId).getByTestId('drop-claimed')).toBeVisible();
  await expect(dropRow(page, dropId).getByTestId('drop-left')).toHaveText(`${DROP_COUNT - 1} of ${DROP_COUNT}`);

  // Four friends claim the two that are left at the same moment.
  const friends = [];
  for (let i = 0; i < 4; i++) {
    const who = person(`jc20f${i}${tag}`.slice(0, 20));
    await signUpInBrowser(await customer(browser), who);
    friends.push({ who, api: await api(who) });
  }
  const answers = await Promise.all(friends.map((f) => f.api.post('/api/campaigns/trpc/drops.claim', { dropId })));
  const won = answers.filter((a) => a.body?.result?.data?.created === true);
  const sold = answers.filter((a) => /\[drop\.sold_out\]/.test(a.body?.error?.message ?? ''));
  expect(won).toHaveLength(DROP_COUNT - 1);
  expect(sold).toHaveLength(friends.length - (DROP_COUNT - 1));

  // One who lost opens the room: the drop reads sold out, and pressing claim says so.
  const loser = friends[answers.findIndex((a) => /\[drop\.sold_out\]/.test(a.body?.error?.message ?? ''))];
  const theirs = await customer(browser);
  await signIn(theirs, loser.who);
  await openRoom(theirs);
  await expect(dropRow(theirs, dropId).getByTestId('drop-state')).toHaveText('Sold out');
  await expect(dropRow(theirs, dropId).getByTestId('drop-left')).toHaveText(`0 of ${DROP_COUNT}`);
  await dropRow(theirs, dropId)
    .getByRole('button', { name: /^Claim / })
    .click();
  await expect(dropRow(theirs, dropId).getByTestId('drop-refusal')).toHaveText('This drop is sold out.');

  // My second claim returns my first: one claim, the same key.
  const mineApi = await api(me);
  const again = await mineApi.post('/api/campaigns/trpc/drops.claim', { dropId });
  expect(again.body?.result?.data).toMatchObject({ created: false, remaining: 0, claim: { dropId, kind: 'value' } });
  const myKey = again.body.result.data.claim.claimKey;
  expect(myKey.startsWith(claimKey)).toBe(true);

  // The money: each claim that succeeded is owed once, and only those; nobody who saw sold out is owed anything.
  const dropRewards = async (who) => (await myRewards(who)).filter((r) => r.rewardKey.startsWith(claimKey));
  for (const [i, f] of friends.entries()) {
    const theirsOwed = await dropRewards(f.who);
    if (answers[i].body?.result?.data?.created === true) {
      expect(theirsOwed).toHaveLength(1);
      expect(theirsOwed[0]).toMatchObject({ asset: ASSET, amount: DROP_VALUE });
    } else {
      expect(theirsOwed).toEqual([]);
    }
  }
  // Mine is paid once to my connected wallet: owed once, paid once, and the TEST chain's own receipt shows one transfer
  // of exactly the drop's value to my wallet, and my wallet's balance on the chain rose by exactly that.
  await expect.poll(async () => (await dropRewards(me)).map((r) => r.state), { timeout: 240_000 }).toEqual(['paid']);
  const [paid] = await dropRewards(me);
  expect(paid).toMatchObject({ rewardKey: myKey, asset: ASSET, amount: DROP_VALUE, state: 'paid' });
  expect(paid.attempts.filter((a) => a.outcome === 'owed')).toHaveLength(1);
  expect(paid.attempts.filter((a) => a.outcome === 'paid')).toHaveLength(1);
  expect(paid.payout?.toWallet).toBe(myWallet);
  expect(paid.payout.chainTx).toMatch(/^0x[0-9a-f]{64}$/);
  const receipt = await chainReceipt(paid.payout.chainTx);
  expect(receipt.transfers).toEqual([{ token: TOKEN_USD.address, from: receipt.from, to: myWallet, value: usdUnits(DROP_VALUE) }]);
  expect(await chainBalance(TOKEN_USD.address, myWallet)).toBe(before + usdUnits(DROP_VALUE));
  // Claimed again after it was paid: still the one claim, and nothing more is paid.
  const third = await mineApi.post('/api/campaigns/trpc/drops.claim', { dropId });
  expect(third.body?.result?.data).toMatchObject({
    created: false,
    claim: { claimKey: myKey, reward: { state: 'paid', chainTx: paid.payout.chainTx } },
  });
  expect((await dropRewards(me)).map((r) => r.state)).toEqual(['paid']);
  expect(await chainBalance(TOKEN_USD.address, myWallet)).toBe(before + usdUnits(DROP_VALUE));

  const room = await mineApi.get('/api/campaigns/trpc/drops.room');
  const seen = room.body?.result?.data?.drops?.find((d) => d.id === dropId);
  expect(seen).toMatchObject({ remaining: 0, state: 'sold_out', mine: { claimKey: myKey } });
  // On screen: my claim, paid to my wallet on the chain with its chain reference.
  await openRoom(page);
  const reward = dropRow(page, dropId).getByTestId('drop-reward');
  await expect(reward).toHaveAttribute('data-state', 'paid', { timeout: 30_000 });
  await expect(reward).toHaveAttribute('data-tx', paid.payout.chainTx);
  await expect(reward).toContainText(`Paid ${DROP_VALUE} ${ASSET} to ${myWallet} on the chain`);
  await expect(dropRow(page, dropId).getByTestId('drop-state')).toHaveText('Sold out');
  await stepPicture(page);
});

test(`${J} #6 the TGE claim with a blank schedule refuses; mainnet shows the audit refusal`, async ({ browser, stepPicture }) => {
  const { me } = state('me');
  const page = await customer(browser);
  await signIn(page, me);
  await openRoom(page);
  // What is stored before the presses: my claims and my rewards.
  const mineApi = await api(me);
  const stored = async () => {
    const room = await mineApi.get('/api/campaigns/trpc/drops.room');
    return {
      drops: room.body?.result?.data?.drops?.map((d) => ({ id: d.id, remaining: d.remaining, mine: d.mine })),
      rewards: await myRewards(me),
    };
  };
  const storedBefore = await stored();
  expect(storedBefore.drops?.length).toBeGreaterThan(0);
  // Every write the page sends to campaigns while I press: only the two TGE claims, each refused.
  const writes = [];
  const onRequest = (req) => {
    if (req.method() !== 'GET' && /\/api\/campaigns\//.test(req.url())) writes.push(req);
  };
  page.on('request', onRequest);
  const tge = page.getByTestId('drop-tge');
  await expect(page.getByTestId('tge-schedule')).toHaveText('Not set');
  await expect(page.getByTestId('tge-testnet-label')).toHaveText('Testnet');
  await page.getByTestId('tge-testnet').getByRole('button', { name: 'Claim on Testnet', exact: true }).click();
  await expect(page.getByTestId('tge-testnet-refusal')).toHaveAttribute('data-code', 'launch.schedule_unset');
  await expect(page.getByTestId('tge-testnet-refusal')).toContainText('The token schedule is not set');
  await page.getByTestId('tge-mainnet').getByRole('button', { name: 'Claim on Mainnet', exact: true }).click();
  await expect(page.getByTestId('tge-mainnet-refusal')).toHaveAttribute('data-code', 'audit.external');
  await expect(page.getByTestId('tge-mainnet-refusal')).toContainText('external security audit');
  // Never "audited", never Base called the INTACHAIN mainnet.
  await expect(tge).not.toContainText(/audited/i);
  await expect(page.locator('body')).not.toContainText(/INTACHAIN mainnet/i);
  page.off('request', onRequest);
  // Nothing posted: the only writes were the two refused TGE claims, and my claims, rewards and the schedule read the same.
  expect(writes.map((r) => new URL(r.url()).pathname.split('/').pop())).toEqual(['tge.claim', 'tge.claim']);
  for (const w of writes) expect((await w.response())?.status()).toBeGreaterThanOrEqual(400);
  expect(await stored()).toEqual(storedBefore);
  const read = await mineApi.get('/api/campaigns/trpc/drops.room');
  expect(read.body?.result?.data?.tge?.schedule).toBeNull();
  await stepPicture(page);
});
