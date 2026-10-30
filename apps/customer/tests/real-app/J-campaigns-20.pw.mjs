import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signIn } from './desk.mjs';
import { EDGE, api, journeyState, signUpInBrowser } from './stack.mjs';

/** The public invitation site on the stack (apps/invitation), where the waitlist lives at /waitlist. */
const JOIN = process.env.JOURNEY_JOIN_URL ?? 'http://127.0.0.1:3220';

// J-campaigns-20, in the running app (docs/roadmap/journeys.json): join the waitlist, climb by inviting, and claim a drop.
// One test per step, titled "J-campaigns-20 #<n>", run in order. Every visitor is signed out on a browser of their own.
// #3's operators are the stack's two LOCAL TEST founders on the founder console's Waitlist waves room
// (/more-ops/campaigns/waves): A asks for the release, B approves the same packet on their own console, A runs it. The wave size is the stack's labelled TEST value
// (IDENTITY_WAITLIST_WAVE_SIZE, two, in tooling/profiles/test-owner-values/identity.json); the blank-size refusal
// (drop.wave_unset, nobody released) is proved in svc-identity's waitlist and router tests, since the stack runs one value.
// #4-#6 are the drop room on the Customer app (/campaigns/drops): I sign up with the email I joined the waitlist with, the
// two TEST founders make a TEST season and a TEST drop of three (A creates, B publishes, through svc-campaigns' operator
// doors), and four friends claim alongside me. The TGE schedule is the stack's blank owner value, so its claim refuses.
const J = 'J-campaigns-20';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.describe.configure({ mode: 'default' });

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

test(`${J} #1 joins the waitlist signed out and sees a queue position`, async ({ browser }) => {
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
  run.write({ code, email });
});

test(`${J} #2 each friend who joins with my link moves me up; ties go by join order`, async ({ browser }) => {
  const { code } = state('code');
  const bring = async (refCode, who) => {
    const p = await visitor(browser);
    await p.goto(`/waitlist?ref=${refCode}`);
    await joinAs(p, `jc20-${who}-${tag}@local-test.invalid`);
    await p.context().close();
  };
  // A rival joins after me and brings three friends, so they are ahead of me and my friends have someone to move me past
  // (on a fresh stack I would otherwise be first already).
  const rival = await visitor(browser);
  await rival.goto('/waitlist');
  const rivalCode = await joinAs(rival, `jc20-rival-${tag}@local-test.invalid`);
  await rival.context().close();
  for (const n of [1, 2, 3]) await bring(rivalCode, `rivalfriend${n}`);
  expect((await standing(rivalCode)).rank).toBeLessThan((await standing(code)).rank);

  const page = await visitor(browser);
  await page.goto(`/waitlist?code=${code}`);
  let before = await shownRank(page);
  const start = before.rank;
  expect(start).toBeGreaterThan(1);
  // Two friends at least; on a long-lived stack an earlier run may have left people waiting with friends of their own, so
  // keep inviting (twenty-five at most) until I am first in the queue, which #3's wave then reaches.
  for (let n = 1; n <= 2 || (before.rank > 1 && n <= 25); n++) {
    const friend = await visitor(browser);
    await friend.goto(`/waitlist?ref=${code}`);
    await expect(friend.getByTestId('waitlist-invited-by')).toContainText(code);
    await joinAs(friend, `jc20-friend${n}-${tag}@local-test.invalid`);
    await friend.context().close();
    const after = await shownRank(page);
    await expect(page.getByTestId('waitlist-referred')).toHaveText(String(n));
    expect(after.rank).toBeLessThanOrEqual(before.rank);
    before = after;
  }
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
  run.write({ ...run.read(), xCode, yCode });
});

test(`${J} #3 an operator releases a wave: the top N are invited once, the rest wait`, async ({ browser }) => {
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
  run.write({ ...run.read(), waveNumber: waves.nextWave });
});

const DROP_COUNT = 3;
const person = (handle, email = `${handle}@local-test.invalid`) => ({
  handle,
  email,
  password: `TEST-${randomBytes(9).toString('base64url')}-9a`,
});

/** A signed-in customer on a device of its own. */
async function customer(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  return context.newPage();
}

async function openRoom(page) {
  await page.goto('/campaigns/drops');
  await expect(page.getByRole('heading', { level: 1, name: 'Drop room' })).toBeVisible();
  await expect(page.getByTestId('drop-tge')).toBeVisible({ timeout: 30_000 });
}

const dropRow = (page, dropId) => page.locator(`[data-testid="drop-row"][data-drop-id="${dropId}"]`);

test(`${J} #4 the drop room shows my rank, wave, season points and each limited drop`, async ({ browser }) => {
  const { email } = state('code', 'email');
  const { ctx, pair } = await operators();
  // The founders make this run's TEST season and TEST drop of three: A creates, B publishes. The creator cannot publish.
  const now = Date.now();
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
      { title: `TEST drop ${tag}`, seasonId: season.id, count: String(DROP_COUNT), opensAt: new Date(now - 60_000).toISOString() },
      await pair.a.campaignsOpsToken(),
    ),
    'ops.drops.create',
  );
  data(await ctx.edge.mutate('campaigns', 'ops.drops.publish', { id: drop.id }, await pair.b.campaignsOpsToken()), 'ops.drops.publish');

  // My wave was released in #3: I open my account with the email I joined with, and the room finds my place by it.
  const me = person(`jc20me${tag}`.slice(0, 20), email);
  const page = await customer(browser);
  await signUpInBrowser(page, me);
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
  await expect(page.getByTestId('drop-season-points')).toHaveText('0');
  await expect(page.getByTestId('drop-season')).toContainText('From 0 task campaigns in this season');
  const row = dropRow(page, drop.id);
  await expect(row.getByTestId('drop-left')).toHaveText(`${DROP_COUNT} of ${DROP_COUNT}`);
  await expect(row.getByTestId('drop-state')).toHaveText('Open');
  await expect(row.getByRole('button', { name: `Claim TEST drop ${tag}` })).toBeEnabled();
  run.write({ ...run.read(), me, dropId: drop.id });
});

test(`${J} #5 a limited drop claimed together: exactly the count succeed, the rest see sold out`, async ({ browser }) => {
  const { me, dropId } = state('me', 'dropId');
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
  const mine = await api(me);
  const again = await mine.post('/api/campaigns/trpc/drops.claim', { dropId });
  expect(again.body?.result?.data).toMatchObject({ created: false, remaining: 0, claim: { dropId } });
  const room = await mine.get('/api/campaigns/trpc/drops.room');
  const seen = room.body?.result?.data?.drops?.find((d) => d.id === dropId);
  expect(seen).toMatchObject({ remaining: 0, state: 'sold_out', mine: { claimKey: again.body.result.data.claim.claimKey } });
});

test(`${J} #6 the TGE claim with a blank schedule refuses; mainnet shows the audit refusal`, async ({ browser }) => {
  const { me } = state('me');
  const page = await customer(browser);
  await signIn(page, me);
  await openRoom(page);
  const tge = page.getByTestId('drop-tge');
  await expect(page.getByTestId('tge-schedule')).toHaveText('Not set');
  await expect(page.getByTestId('tge-testnet-label')).toHaveText('Testnet');
  await page.getByTestId('tge-testnet').getByRole('button', { name: 'Claim on Testnet' }).click();
  await expect(page.getByTestId('tge-testnet-refusal')).toHaveAttribute('data-code', 'launch.schedule_unset');
  await expect(page.getByTestId('tge-testnet-refusal')).toContainText('The token schedule is not set');
  await page.getByTestId('tge-mainnet').getByRole('button', { name: 'Claim on Mainnet' }).click();
  await expect(page.getByTestId('tge-mainnet-refusal')).toHaveAttribute('data-code', 'audit.external');
  await expect(page.getByTestId('tge-mainnet-refusal')).toContainText('external security audit');
  // Never "audited", never Base called the INTACHAIN mainnet.
  await expect(tge).not.toContainText(/audited/i);
  await expect(page.locator('body')).not.toContainText(/INTACHAIN mainnet/i);
  // Nothing posted: the stored room reads the same after both presses.
  const read = await (await api(me)).get('/api/campaigns/trpc/drops.room');
  expect(read.body?.result?.data?.tge?.schedule).toBeNull();
});
