// World: book
// Market: live
import { test, expect } from './journey.mjs';
import { api, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { userIdOf } from './copy.mjs';

// J-algo-dev-08, in the running app (docs/roadmap/journeys.json): share a strategy with a teammate and keep the source
// private. One test per step, titled "J-algo-dev-08 #<n>", run in order. A TEST developer (the owner) starts signed in
// with a saved signal-rules strategy, and a TEST teammate has an account. Every strategy and run in Algo dev is
// simulated; nothing here moves money (svc-quant imports no ledger client). Support is the stack's TEST operator, reading
// through svc-quant's own `admin:read` door as the operator console does. The edit lock lasts the stack's TEST 45 seconds
// (tooling/profiles/test-owner-values/quant.json).
const J = 'J-algo-dev-08';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const NAME = 'TEST shared strategy';
const MATE_NAME = 'TEST shared strategy, teammate edit';

test.describe.configure({ mode: 'default' });

function state() {
  const read = run.read();
  if (!read.owner || !read.mate || !read.strategyId)
    throw new Error(`${J} #1 made no owner, teammate and strategy, so this step has no one to act as`);
  return read;
}

const dataOf = (body) => body?.result?.data?.json ?? body?.result?.data;

/** A signed-in tRPC call of svc-quant through Edge, as the person; returns the HTTP status and the data or the error. */
async function quant(who, procedure, input, method = 'GET') {
  const client = await api(who);
  const res =
    method === 'GET'
      ? await client.get(`/api/quant/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`)
      : await client.post(`/api/quant/trpc/${procedure}`, input);
  return { status: res.status, data: dataOf(res.body), error: res.body?.error, body: res.body };
}
async function ok(who, procedure, input, method) {
  const res = await quant(who, procedure, input, method);
  expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 400)}`).toBe(200);
  return res.data;
}

/** The stack's TEST operator, as support: svc-quant's metadata and source read, and the operator's quota door. */
async function operator() {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const founders = await gates.approverSessions(ctx);
  const token = await founders.a.tradeOpsToken();
  const data = (res, what) => {
    const got = res.json?.result?.data;
    if (!got) throw new Error(`${what} refused: ${res.status} ${res.text.slice(0, 300)}`);
    return got;
  };
  return {
    async source(strategyId, ownerId) {
      return data(await ctx.edge.query('quant', 'ops.strategy.source', { strategyId, ownerId }, token), 'ops.strategy.source');
    },
    async plan(profile, limits) {
      for (const [resource, limit] of Object.entries(limits)) {
        data(
          await ctx.edge.mutate(
            'quant',
            'ops.quota.set',
            { profile, resource, limit, reason: `LOCAL TEST ${J}`, idempotencyKey: `quant.quota:${profile}:${resource}:${limit}` },
            token,
          ),
          'ops.quota.set',
        );
      }
    },
    async assign(accountId, profile) {
      data(
        await ctx.edge.mutate(
          'quant',
          'ops.quota.assign',
          { accountId, profile, reason: `LOCAL TEST ${J}`, idempotencyKey: `quant.quota.assign:${accountId}:${profile}` },
          token,
        ),
        'ops.quota.assign',
      );
    },
  };
}

/** Saves a new signal-rules strategy on 1 minute bars of BTC/USDT at version 1. Every figure is a TEST simulation input. */
async function saveSignalStrategy(page) {
  await page.goto('/quant/studio');
  const fresh = page.getByRole('button', { name: 'Start a new strategy' });
  if (await fresh.isVisible()) await fresh.click();
  await page.getByLabel('Strategy name').fill(NAME);
  await page.getByLabel('Simulated starting cash').fill('1000');
  await page.getByLabel('Block 1 symbol').fill('BTC/USDT');
  await page.getByLabel('Block 1 quantity').fill('0.01');
  await page.getByLabel('Max drawdown (service unit unspecified)').fill('100');
  await page.getByLabel('Max notional (service unit unspecified)').fill('500');
  await page.getByLabel('Kill threshold (service unit unspecified)').fill('50');
  await page.getByLabel('How the strategy trades').selectOption('signal');
  const builder = page.getByTestId('quant-signal-builder');
  await builder.getByLabel('Symbol').fill('BTC/USDT');
  await builder.getByLabel('Bar size').selectOption('1m');
  await builder.getByLabel('Fast average (bars)').fill('1');
  await builder.getByLabel('Slow average (bars)').fill('2');
  await builder.getByRole('combobox', { name: /^Size each entry by/ }).selectOption('quantity');
  await builder.getByLabel('Size', { exact: true }).fill('0.01');
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText('Saved as version 1.');
}

/** The owner's team panel on the strategy's page. */
async function ownerTeam(page, strategyId) {
  await page.goto(`/quant/strategies/${encodeURIComponent(strategyId)}`);
  const team = page.getByTestId('quant-team');
  await expect(team.getByTestId('quant-share-form')).toBeVisible();
  return team;
}

/** The owner shares the strategy with one account id, with a permission and live control on or off. */
async function share(team, memberId, role, liveControl) {
  const form = team.getByTestId('quant-share-form');
  await form.getByLabel('Teammate account id').fill(memberId);
  await form.getByLabel('Permission for the teammate').selectOption(role);
  const live = form.getByLabel('Allow live control (stop paper runs)');
  if (liveControl) await live.check();
  else await live.uncheck();
  await form.getByRole('button', { name: 'Save permission' }).click();
  return form;
}

/** The teammate's page of the shared strategy. */
async function mateOpens(page, strategyId) {
  await page.goto('/quant/shared');
  const row = page.getByTestId('quant-shared').locator(`[data-testid="quant-shared-row"][data-id="${strategyId}"]`);
  await row.getByRole('link', { name: `Open ${await row.locator('td').first().innerText()}` }).click();
  const shared = page.getByTestId('quant-shared-strategy');
  await expect(shared).toHaveAttribute('data-id', strategyId);
  return shared;
}

const utc = (iso) => iso.slice(0, 19).replace('T', ' ');

test(`${J} #1 invites a teammate with view only: the teammate can open it; saving gives the typed permission refusal`, async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const owner = await signUp(page, 'jo');
  await verify(page, owner);
  const mate = await signUp(page, 'jm');
  await verify(page, mate);
  run.reset({ owner, mate });
  const mateId = await userIdOf(mate);
  run.write({ mateId, ownerId: await userIdOf(owner) });

  // The teammate finds the account id the owner adds them by under Shared with me, where nothing is shared yet.
  await signIn(page, mate);
  await page.goto('/quant/shared');
  await expect(page.getByTestId('quant-my-account-id')).toHaveAttribute('data-id', mateId);
  await expect(page.getByText('No strategy is shared with you.')).toBeVisible();

  await signIn(page, owner);
  await saveSignalStrategy(page);
  await page.goto('/quant/strategies');
  const strategyId = await page.getByTestId('quant-strategy-row').first().getAttribute('data-id');
  expect(strategyId).toBeTruthy();
  run.write({ strategyId });

  const team = await ownerTeam(page, strategyId);
  await expect(team.getByText('This strategy is not shared with anyone.')).toBeVisible();
  const form = await share(team, mateId, 'view', false);
  await expect(form.getByTestId('quant-share-note')).toHaveText(`Saved: ${mateId} can view it.`);
  const row = team.getByTestId('quant-collaborator');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-member', mateId);
  await expect(row).toHaveAttribute('data-role', 'view');
  await expect(row).toHaveAttribute('data-live', 'false');

  // The teammate opens it: the name, the permission and the source.
  await signIn(page, mate);
  const shared = await mateOpens(page, strategyId);
  await expect(shared).toHaveAttribute('data-role', 'view');
  await expect(shared).toContainText('Your permission: View only. Live control: No.');
  const owned = await ok(owner, 'studio.get', { id: strategyId });
  await expect(shared.getByTestId('quant-shared-source')).toHaveText(owned.source);

  // Saving is refused with the typed permission refusal, and no version is added.
  const save = shared.getByTestId('quant-shared-save');
  await save.getByLabel('Version name').fill(MATE_NAME);
  await save.getByRole('button', { name: 'Save as a new version' }).click();
  const refusal = save.getByTestId('quant-shared-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'quant.permission_denied');
  await expect(refusal).toHaveText('This strategy is shared with you to view only, so you cannot save it. Nothing was saved.');
  const direct = await quant(mate, 'team.save', { strategyId, baseVersion: 1, name: MATE_NAME }, 'POST');
  expect(direct.status).toBe(403);
  expect(JSON.stringify(direct.body)).toMatch(/quant\.permission_denied — /);
  expect((await ok(owner, 'studio.get', { id: strategyId })).versions).toHaveLength(1);
});

test(`${J} #2 changes the teammate to edit without live control: they can save; a manual order or stop is refused as permission denied`, async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  const { owner, mate, mateId, strategyId } = state();
  // The owner has a paper run of the strategy going, on the exchange's own prices.
  await signIn(page, owner);
  await page.goto(`/quant/strategies/${encodeURIComponent(strategyId)}`);
  const paper = page.getByTestId('quant-paper');
  await paper.getByRole('button', { name: 'Start a paper run' }).click();
  const start = paper.getByTestId('quant-paper-start');
  await start.getByLabel('Starting cash (simulated)').fill('1000');
  await start.getByRole('combobox', { name: /^Price data/ }).selectOption('own_venue');
  await start.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await start.getByLabel('Slippage (basis points)').fill('5');
  await start.getByLabel('Delay (bars)').fill('0');
  const reply = page.waitForResponse((res) => res.url().includes('/api/quant/trpc/paper.start') && res.request().method() === 'POST');
  await start.getByRole('button', { name: 'Start', exact: true }).click();
  const runId = dataOf(await (await reply).json()).runId;
  expect(runId).toBeTruthy();
  run.write({ runId });

  const team = await ownerTeam(page, strategyId);
  const form = await share(team, mateId, 'edit', false);
  await expect(form.getByTestId('quant-share-note')).toHaveText(`Saved: ${mateId} can edit it.`);
  await expect(team.getByTestId('quant-collaborator')).toHaveAttribute('data-role', 'edit');
  await expect(team.getByTestId('quant-collaborator')).toHaveAttribute('data-live', 'false');

  // The teammate saves: a new version of the owner's strategy, with their name and note.
  await signIn(page, mate);
  const shared = await mateOpens(page, strategyId);
  await expect(shared).toContainText('Your permission: Edit. Live control: No.');
  const save = shared.getByTestId('quant-shared-save');
  await save.getByLabel('Version name').fill(MATE_NAME);
  await save.getByLabel('Release note').fill('TEST teammate edit');
  await save.getByRole('button', { name: 'Save as a new version' }).click();
  await expect(save.getByTestId('quant-shared-saved')).toHaveText('Saved as version 2.');
  const after = await ok(owner, 'studio.get', { id: strategyId });
  expect(after.versions.map((v) => [v.version, v.name, v.releaseNote])).toEqual([
    [1, NAME, ''],
    [2, MATE_NAME, 'TEST teammate edit'],
  ]);

  // A stop of the owner's running paper run is refused as permission denied, and the run keeps running.
  const runs = shared.getByTestId('quant-shared-runs');
  const runRow = runs.locator(`[data-testid="quant-shared-run"][data-run-id="${runId}"]`);
  await expect(runRow).toHaveAttribute('data-state', 'running');
  await runRow.getByRole('button', { name: /^Stop run / }).click();
  const refusal = runs.getByTestId('quant-shared-run-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'quant.permission_denied');
  await expect(refusal).toHaveText('You were given no live control of this strategy, so you cannot stop its runs. Nothing was stopped.');
  const direct = await quant(mate, 'team.stop', { strategyId, runId }, 'POST');
  expect(direct.status).toBe(403);
  expect(JSON.stringify(direct.body)).toMatch(/quant\.permission_denied — /);
  expect((await ok(owner, 'paper.get', { runId })).state).toBe('running');
});

test(`${J} #3 opens the strategy while the teammate holds the edit lock: a message that the lock is held until it lapses, then the person can take it`, async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  const { owner, mate, mateId, strategyId } = state();
  // The teammate takes the edit lock on their page.
  await signIn(page, mate);
  const shared = await mateOpens(page, strategyId);
  const mateLock = shared.getByTestId('quant-edit-lock');
  // A lock left from the teammate's save is let go first, so the full lock length is ahead.
  const letGo = mateLock.getByRole('button', { name: 'Let the edit lock go' });
  if (await letGo.isVisible()) {
    await letGo.click();
    await expect(mateLock).toHaveAttribute('data-held', 'false');
  }
  await mateLock.getByRole('button', { name: 'Take the edit lock' }).click();
  await expect(mateLock).toHaveAttribute('data-mine', 'true');
  const held = (await ok(mate, 'team.open', { strategyId })).lock;
  expect(held).toMatchObject({ held: true, mine: true, holderId: mateId });

  // The owner opens the strategy: the lock is held by the teammate until its time, and taking it is refused.
  await signIn(page, owner);
  const team = await ownerTeam(page, strategyId);
  const lock = team.getByTestId('quant-edit-lock');
  await expect(lock).toHaveAttribute('data-held', 'true');
  await expect(lock).toHaveAttribute('data-holder', mateId);
  await expect(lock.getByTestId('quant-edit-lock-state')).toHaveText(
    `The edit lock is held by ${mateId} until ${utc(held.expiresAt)} UTC. You can take it once it lapses.`,
  );
  await lock.getByRole('button', { name: 'Take the edit lock' }).click();
  const refusal = lock.getByTestId('quant-edit-lock-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'quant.edit_locked');
  await expect(refusal).toHaveText(`The edit lock is held by another person until ${utc(held.expiresAt)} UTC. Try again once it lapses.`);
  expect((await ok(owner, 'team.get', { strategyId })).lock.holderId).toBe(mateId);

  // Once it lapses, the owner takes it.
  const wait = Date.parse(held.expiresAt) - Date.now() + 1_000;
  if (wait > 0) await page.waitForTimeout(wait);
  await page.reload();
  const lapsed = page.getByTestId('quant-team').getByTestId('quant-edit-lock');
  await expect(lapsed).toHaveAttribute('data-held', 'false');
  await expect(lapsed.getByTestId('quant-edit-lock-state')).toHaveText('No one holds the edit lock. Saving takes it.');
  await lapsed.getByRole('button', { name: 'Take the edit lock' }).click();
  await expect(page.getByTestId('quant-team').getByTestId('quant-edit-lock')).toHaveAttribute('data-mine', 'true');
  const mine = (await ok(owner, 'team.get', { strategyId })).lock;
  expect(mine).toMatchObject({ held: true, mine: true });
  await expect(page.getByTestId('quant-team').getByTestId('quant-edit-lock-state')).toHaveText(
    `You hold the edit lock until ${utc(mine.expiresAt)} UTC.`,
  );
  // While the owner holds it, the teammate's save is held out.
  const blocked = await quant(mate, 'team.save', { strategyId, baseVersion: 2, name: MATE_NAME }, 'POST');
  expect(blocked.status).toBe(409);
  expect(JSON.stringify(blocked.body)).toMatch(/quant\.edit_locked — /);
});

test(`${J} #4 adds collaborators up to the plan limit and one more: the refusal naming the collaborators resource`, async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const { owner, ownerId, strategyId } = state();
  // The owner's plan allows two collaborators per strategy; the rest of it is the TEST developer plan's.
  const ops = await operator();
  const profile = `TEST team ${process.env.JOURNEY_RUN_ID ?? 'local'}`.slice(0, 80);
  await ops.plan(profile, {
    strategies: '200',
    versions: '200',
    concurrent_runs: '20',
    paper_runs: '500',
    runs: '2000',
    log_lines: '1000000',
    storage: '500000000',
    collaborators: '2',
    notifications: '1000',
  });
  await ops.assign(ownerId, profile);
  // Two more TEST accounts to add: the second fills the plan, the third is one more.
  const second = await signUp(page, 'jx');
  const third = await signUp(page, 'jy');
  const secondId = await userIdOf(second);
  const thirdId = await userIdOf(third);

  await signIn(page, owner);
  const team = await ownerTeam(page, strategyId);
  await expect(team.getByTestId('quant-collaborator')).toHaveCount(1);
  const form = await share(team, secondId, 'view', false);
  await expect(form.getByTestId('quant-share-note')).toHaveText(`Saved: ${secondId} can view it.`);
  await expect(team.getByTestId('quant-collaborator')).toHaveCount(2);

  await share(team, thirdId, 'view', false);
  const refusal = form.getByTestId('quant-quota-refusal');
  await expect(refusal).toHaveAttribute('data-resource', 'collaborators');
  await expect(refusal).toHaveAttribute('data-kind', 'exceeded');
  await expect(refusal).toContainText('Your plan allows 2 collaborators per strategy: 2 used of 2 allowed. Nothing was added.');
  const direct = await quant(owner, 'team.set', { strategyId, memberId: thirdId, role: 'view', liveControl: false }, 'POST');
  expect(direct.status).toBe(412);
  expect(JSON.stringify(direct.body)).toMatch(/quant\.quota_exceeded — collaborators: 2 used of 2 allowed/);
  await page.reload();
  await expect(page.getByTestId('quant-team').getByTestId('quant-collaborator')).toHaveCount(2);
  const members = (await ok(owner, 'team.get', { strategyId })).collaborators.map((row) => row.memberId);
  expect(members).not.toContain(thirdId);
  // The plan's usage reads the same count.
  const usage = await ok(owner, 'quota.get', {});
  expect(usage.resources.find((row) => row.resource === 'collaborators')).toEqual({ resource: 'collaborators', used: '2', limit: '2' });
  run.write({ secondId });
});

test(`${J} #5 gives a support agent a time-boxed grant: support sees source and each read writes an audit row; after expiry support sees metadata only`, async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  const { owner, ownerId, strategyId } = state();
  const support = await operator();
  const owned = await ok(owner, 'studio.get', { id: strategyId });

  // Before any grant, support sees the name and versions only.
  const before = await support.source(strategyId, ownerId);
  expect(before).toMatchObject({ granted: false, source: null, name: owned.name, version: owned.version, versions: owned.versions.length });

  // The owner gives support half a minute.
  await signIn(page, owner);
  const team = await ownerTeam(page, strategyId);
  const access = team.getByTestId('quant-support');
  await access.getByLabel('Grant length in minutes').fill('0.5');
  await access.getByRole('button', { name: 'Give support access' }).click();
  await expect(access.getByTestId('quant-grant-note')).toContainText('Support may read the source until ');
  await expect(access.getByTestId('quant-grant')).toHaveAttribute('data-active', 'true');
  const grant = (await ok(owner, 'team.get', { strategyId })).grants[0];

  // Under the grant, support sees the source; the read is in the owner's audit list.
  const during = await support.source(strategyId, ownerId);
  expect(during).toMatchObject({ granted: true, grantExpiresAt: grant.expiresAt });
  expect(during.source).toBe(owned.source);
  await page.reload();
  const reads = page.getByTestId('quant-team').getByTestId('quant-support-read');
  await expect(reads).toHaveCount(2);
  await expect(reads.nth(0)).toHaveAttribute('data-granted', 'false');
  await expect(reads.nth(1)).toHaveAttribute('data-granted', 'true');
  await expect(reads.nth(1)).toContainText('Source, under a grant');

  // After it ends, support sees metadata only, and that read is listed too.
  const wait = Date.parse(grant.expiresAt) - Date.now() + 1_000;
  if (wait > 0) await page.waitForTimeout(wait);
  const after = await support.source(strategyId, ownerId);
  expect(after).toMatchObject({ granted: false, source: null, grantExpiresAt: null, name: owned.name });
  await page.reload();
  const listed = page.getByTestId('quant-team').getByTestId('quant-support-read');
  await expect(listed).toHaveCount(3);
  await expect(listed.nth(2)).toHaveAttribute('data-granted', 'false');
  await expect(listed.nth(2)).toContainText('Name and versions only');
  await expect(page.getByTestId('quant-team').getByTestId('quant-grant')).toHaveAttribute('data-active', 'false');
  const audit = (await ok(owner, 'team.get', { strategyId })).reads;
  expect(audit.map((row) => row.granted)).toEqual([false, true, false]);
  expect(new Set(audit.map((row) => row.reader)).size).toBe(1);
});

test(`${J} #6 removes the teammate: the teammate's next request fails; a run in flight is not undone`, async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const { owner, mate, mateId, strategyId, runId } = state();
  expect((await ok(owner, 'paper.get', { runId })).state).toBe('running');

  await signIn(page, owner);
  const team = await ownerTeam(page, strategyId);
  const row = team.locator(`[data-testid="quant-collaborator"][data-member="${mateId}"]`);
  await row.getByRole('button', { name: `Remove ${mateId}` }).click();
  await expect(team.getByTestId('quant-team-note')).toHaveText(
    'Removed. Their next request is refused; a run already going is left as it is.',
  );
  await expect(team.locator(`[data-testid="quant-collaborator"][data-member="${mateId}"]`)).toHaveCount(0);

  // The teammate's next request fails: the page says it is no longer shared, and the service answers not found.
  await signIn(page, mate);
  await page.goto(`/quant/shared/${encodeURIComponent(strategyId)}`);
  await expect(page.getByTestId('quant-shared-gone')).toHaveText('This strategy is no longer shared with you.');
  const next = await quant(mate, 'team.open', { strategyId });
  expect(next.status).toBe(404);
  expect(JSON.stringify(next.body)).toMatch(/quant\.studio_not_found/);
  await page.goto('/quant/shared');
  await expect(page.getByTestId('quant-shared-row')).toHaveCount(0);

  // The owner's paper run in flight is not undone, and the version the teammate saved stays.
  const still = await ok(owner, 'paper.get', { runId });
  expect(still.state).toBe('running');
  expect((await ok(owner, 'studio.get', { id: strategyId })).versions.map((v) => v.name)).toEqual([NAME, MATE_NAME]);
});
