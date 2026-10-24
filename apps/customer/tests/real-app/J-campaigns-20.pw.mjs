import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { EDGE, journeyState } from './stack.mjs';

/** The public invitation site on the stack (apps/invitation), where the waitlist lives at /waitlist. */
const JOIN = process.env.JOURNEY_JOIN_URL ?? 'http://127.0.0.1:3220';

// J-campaigns-20, in the running app (docs/roadmap/journeys.json): join the waitlist, climb by inviting, and claim a drop.
// One test per step, titled "J-campaigns-20 #<n>", run in order. Every visitor is signed out on a browser of their own.
// #3's operator is the stack's two TEST operators (tooling/scripts/local-test-gates.mjs): A proposes the release, B
// approves it, A releases, as the founder-ops desk would. The wave size is the stack's labelled TEST value
// (IDENTITY_WAITLIST_WAVE_SIZE, two, in tooling/profiles/test-owner-values/identity.json); the blank-size refusal
// (drop.wave_unset, nobody released) is proved in svc-identity's waitlist and router tests, since the stack runs one value.
// Not built yet: #4-#6 (the drop room, seasons, limited drops and the TGE panel: RC-campaigns-04 and -05).
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
  return { gates, ctx, pair };
}

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** svc-identity's privileged payload hash: the target, then the bound fields, as strings in this order. */
const releaseHash = (wave, size) =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify({ targetId: 'waitlist.wave.release', wave: String(wave), size: String(size) }))
    .digest('hex')}`;

test(`${J} #1 joins the waitlist signed out and sees a queue position`, async ({ browser }) => {
  run.reset({});
  const page = await visitor(browser);
  await page.goto('/join');
  await page.getByRole('link', { name: 'Join the waitlist' }).click();
  await expect(page).toHaveURL(/\/waitlist$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Join the waitlist' })).toBeVisible();
  const code = await joinAs(page, `jc20-me-${tag}@local-test.invalid`);
  const shown = await shownRank(page);
  const read = await standing(code);
  expect(read.release).toBeNull();
  expect(shown).toEqual({ rank: read.rank, waiting: read.waiting });
  await expect(page.getByTestId('waitlist-referred')).toHaveText('0');
  await expect(page.getByLabel('Your invitation link')).toHaveValue(`${JOIN}/waitlist?ref=${code}`);
  // Coming back to the link shows the same place, read again, not remembered.
  await page.goto(`/waitlist?code=${code}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Your place in the queue' })).toBeVisible();
  run.write({ code, firstRank: shown.rank });
});

test(`${J} #2 each friend who joins with my link moves me up; ties go by join order`, async ({ browser }) => {
  const { code, firstRank } = state('code', 'firstRank');
  const page = await visitor(browser);
  await page.goto(`/waitlist?code=${code}`);
  let before = await shownRank(page);
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
  expect(before.rank).toBeLessThan(firstRank);
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
  const bring = async (refCode, who) => {
    const p = await visitor(browser);
    await p.goto(`/waitlist?ref=${refCode}`);
    await joinAs(p, `jc20-${who}-${tag}@local-test.invalid`);
    await p.context().close();
  };
  await bring(yCode, 'yfriend');
  expect((await standing(yCode)).rank).toBeLessThan((await standing(xCode)).rank);
  await bring(xCode, 'xfriend');
  expect((await standing(xCode)).rank).toBeLessThan((await standing(yCode)).rank);
  expect((await shownRank(x)).rank).toBe((await standing(xCode)).rank);
  run.write({ ...run.read(), xCode, yCode });
});

test(`${J} #3 an operator releases a wave: the top N are invited once, the rest wait`, async ({ browser }) => {
  const { code, xCode } = state('code', 'xCode');
  const { ctx, pair, gates } = await operators();
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

  const proposal = {
    actionType: 'waitlist.wave.release',
    targetService: 'svc-identity',
    targetId: 'waitlist.wave.release',
    expectedVersion: '1',
    payloadHash: releaseHash(waves.nextWave, waves.waveSize),
    policyVersion: gates.MARKERS.policyVersion,
  };
  const proposed = data(
    await ctx.edge.mutate('identity', 'actionApproval.propose', proposal, await pair.a.approvalToken()),
    'actionApproval.propose',
  );
  const approved = data(
    await ctx.edge.mutate(
      'identity',
      'actionApproval.approve',
      { approvalId: proposed.approvalId, expectedPayloadHash: proposal.payloadHash },
      await pair.b.approvalToken(),
    ),
    'actionApproval.approve',
  );
  expect(approved.status).toBe('APPROVED');
  const input = { waveNumber: waves.nextWave, approvalId: proposed.approvalId, operationId: proposed.operationId };
  const released = data(
    await ctx.edge.mutate('identity', 'waitlist.waves.release', input, await pair.a.tradeOpsToken()),
    'waitlist.waves.release',
  );
  expect(released).toMatchObject({ created: true, wave: { waveNumber: waves.nextWave, size: 2 } });
  expect(released.wave.releasedCount).toBeLessThanOrEqual(2);
  // The same wave again is the stored wave: nobody else is invited.
  const again = data(
    await ctx.edge.mutate('identity', 'waitlist.waves.release', input, await pair.a.tradeOpsToken()),
    'waitlist.waves.release',
  );
  expect(again).toEqual({ ...released, created: false });

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
  expect(after.waiting).toBe(waves.waiting - released.wave.releasedCount);
  const x = await standing(xCode);
  if (x.release === null) {
    const xPage = await visitor(browser);
    await xPage.goto(`/waitlist?code=${xCode}`);
    await expect(xPage.getByRole('heading', { level: 1, name: 'Your place in the queue' })).toBeVisible();
  }
});

// Unbuilt steps fail at once with the slice they wait on, so the run stays inside its time limit.
const unbuilt = (slices) => {
  throw new Error(`${J}: not built yet (${slices})`);
};

test(`${J} #4 the drop room shows my rank, wave, season points and each limited drop`, async () => {
  unbuilt('RC-campaigns-05, RC-campaigns-04: no /campaigns/drops room yet');
});

test(`${J} #5 a limited drop claimed together: exactly the count succeed, the rest see sold out`, async () => {
  unbuilt('RC-campaigns-04: no limited drop or claim yet');
});

test(`${J} #6 the TGE claim with a blank schedule refuses; mainnet shows the audit refusal`, async () => {
  unbuilt('RC-campaigns-05: no TGE panel yet');
});
