import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, api, journeyState, mailedLines, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-more-catalogue-06, in the running app (docs/roadmap/journeys.json): watch my fleet and get told when a worker goes
// quiet. One test per step, titled "J-more-catalogue-06 #<n>", run in order. The person is a verified TEST account on the
// local stack; no money moves. Shares come from the stack's TEST rig through the pool's miner door, as in
// J-more-catalogue-05, so every hashrate below is made from real stored shares. Each step asserts the row against the
// pool's own answers through the edge (and svc-notify's for the outside channels), never against the page's own text.
// A part that is not built fails within UNBUILT, or at once, with a message that starts "BLOCKED" and names it.
const J = 'J-more-catalogue-06';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
// The values the stack's pool is started with: the labelled LOCAL TEST owner values, read from their own file.
const PROFILE = 'tooling/profiles/test-owner-values/mining-pool.json';
const PUBLISHED = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(path.join(ROOT, PROFILE), 'utf8')).values).map(([key, { value }]) => [key, value]),
);
/** The hashrate lookback every read in this journey asks for (the rooms offer 15, 60 and 1440 minutes). */
const WINDOW = 60;
/** The reason the pool already gives a worker with no accepted share in the window (services/svc-mining-pool/src/reads.ts). */
const NO_SHARES = 'no_shares_in_window';
/** What each fleet reading says for a pool that measures nothing of the rig itself. */
const NOT_REPORTED = 'mining.not_reported_by_pool';
/** The subject a quiet worker's notice rides on; it must be declared in packages/events before anything publishes it. */
const OFFLINE_SUBJECT = 'intafaced.mining.worker.offline';

/** An owner value the TEST profile must carry for a step to run at all; a missing one fails by name. */
function owner(key, why) {
  const value = PUBLISHED[key];
  if (value === undefined || value === '') throw new Error(`BLOCKED owner value ${key} (${why}) is not in ${PROFILE}`);
  return value;
}

/** A signed-in read of `service`'s tRPC `procedure`; a procedure the service does not have fails as BLOCKED `missing`. */
async function read(who, service, procedure, input, missing) {
  const client = await api(who);
  const query = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await client.get(`/api/${service}/trpc/${procedure}${query}`);
  if (res.status === 404) throw new Error(`BLOCKED ${missing}: ${service} has no ${procedure} (404)`);
  expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  return res.body.result.data;
}

/** A signed-in tRPC mutation; a procedure the service does not have fails as BLOCKED `missing`. */
async function write(who, service, procedure, input, missing) {
  const client = await api(who);
  const res = await client.post(`/api/${service}/trpc/${procedure}`, input);
  if (res.status === 404) throw new Error(`BLOCKED ${missing}: ${service} has no ${procedure} (404)`);
  expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  return res.body.result.data;
}

const HASHRATE = 'svc-mining-pool hashrate.mine (fleet nominal and effective hashrate, unit, newest sample, series)';
const WORKER = 'svc-mining-pool workers.one (hashing, connectivity, last share, quiet interval, alert limit)';
const STATES = 'svc-mining-pool workers.stateChanges and the worker evaluator job (mining_pool.worker_state_changes)';
const MAINTENANCE = 'svc-mining-pool workers.setMaintenance and workers.maintenance (mining_pool.worker_maintenance)';

const fleet = (who) => read(who, 'mining', 'hashrate.mine', { windowMinutes: WINDOW }, HASHRATE);
const worker = (who, workerId) => read(who, 'mining', 'workers.one', { workerId, windowMinutes: WINDOW }, WORKER);
const stateChanges = (who, workerId) => read(who, 'mining', 'workers.stateChanges', { workerId }, STATES);

/** This account's roster as the pool answers `workers.mine` (built), filtered to one name when given. */
async function roster(who, name) {
  const data = await read(who, 'mining', 'workers.mine', { windowMinutes: WINDOW, ...(name ? { name } : {}) }, 'workers.mine');
  return name ? data.workers.filter((row) => row.name === name) : data.workers;
}

/** One TEST share from the stack's TEST rig through the miner door, as J-more-catalogue-05 sends them. */
function share(rig, label, ...extra) {
  const { who, secret } = run.read();
  return tool('local-test-stack.mjs', 'mining-share', who.email, '--secret', secret, '--worker', rig, '--share', label, ...extra);
}
const accepted = (rig, label) => expect(share(rig, label)).toMatch(/^accepted TEST share /);
const tagged = (name) => `jmc06-${run.read().tag}-${name}-${Date.now().toString(36)}`;

/** Decimal-string arithmetic for whole share weights, never a JS number. */
const plus = (a, b) => String(BigInt(a) + BigInt(b));
const sumWeights = (rows) => rows.reduce((sum, row) => (row.hashrate === null ? sum : plus(sum, row.hashrate)), '0');

/** The pool's quiet interval and how often it looks, in milliseconds, from the TEST owner values. */
function quietTiming() {
  const quiet = Number(owner('MINING_WORKER_QUIET_SECONDS', 'how long without a share before a worker is offline')) * 1000;
  const every = Number(owner('MINING_WORKER_EVALUATE_SECONDS', 'how often the pool looks for quiet workers')) * 1000;
  return { quiet, every, wait: quiet + 3 * every + 15_000 };
}

async function openMining(page, at = '/mining') {
  await signIn(page, run.read().who);
  await page.goto(at);
}

/** The fleet hashrate panel the rooms share, its two readings and its chart. */
const hashratePanel = (page) => page.getByRole('region', { name: 'Hashrate', exact: true });

test.describe.configure({ mode: 'serial' });

test(`${J} starts: a signed-up TEST account with a miner secret and no shares`, async ({ page }) => {
  const who = await signUp(page, 'mf');
  await verify(page, who);
  // The rig's secret is issued by the pool's own procedure (J-more-catalogue-05 #5 drives the same one from the room).
  const { secret } = await write(who, 'mining', 'minerSecret.issue', undefined, 'minerSecret.issue');
  expect(secret).toMatch(/^msk_[A-Za-z0-9_-]{43}$/);
  // Share ids are global to the pool, so each run labels its TEST shares with its own tag.
  run.reset({ who, secret, tag: Date.now().toString(36) });
});

test(`${J} #1 opens /mining with no shares: both hashrates read "no shares in the window" and the chart is empty`, async ({ page }) => {
  const { who } = run.read();
  expect(await roster(who)).toEqual([]);
  // The pool's own answer: no nominal and no effective hashrate, each with its reason, and no sample in the series.
  const answer = await fleet(who);
  expect(answer).toMatchObject({
    windowMinutes: WINDOW,
    nominal: null,
    nominalReason: NO_SHARES,
    effective: null,
    effectiveReason: NO_SHARES,
    newestSampleAt: null,
    series: [],
  });

  await openMining(page);
  const panel = hashratePanel(page);
  await expect(panel, 'BLOCKED customer /mining Hashrate panel').toBeVisible(UNBUILT);
  for (const reading of ['nominal', 'effective']) {
    const cell = panel.getByTestId(`mining-hashrate-${reading}`);
    await expect(cell).toHaveAttribute('data-reason', NO_SHARES, UNBUILT);
    await expect(cell).toHaveText('no shares in the window');
  }
  const chart = panel.getByTestId('mining-hashrate-chart');
  await expect(chart).toHaveAttribute('data-points', '0', UNBUILT);
  await expect(panel.getByTestId('mining-hashrate-delay')).toHaveCount(0);
});

test(`${J} #2 opens /mining/shares with shares in: nominal and effective hashrate in the pool unit, a delay line, power and temperature "not reported by the pool"`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { who } = run.read();
  const unit = owner('MINING_HASHRATE_UNIT', 'the unit the pool reports hashrate in');
  // Two rigs send accepted work, and one share fails the proof-of-work check: a refused share is weight the rig spent
  // that the pool did not credit, so it counts in nominal and not in effective.
  const before = await fleet(who);
  const base = { nominal: before.nominal ?? '0', effective: before.effective ?? '0' };
  const sentFrom = Date.now();
  accepted('Rig-Q', tagged('q1'));
  accepted('Rig-Q', tagged('q2'));
  accepted('Rig-A', tagged('a1'));
  expect(share('Rig-A', tagged('bad'), '--invalid-pow')).toMatch(/^refused mining\.pow_invalid: /);

  const answer = await fleet(who);
  expect(answer.unit, 'the unit is the published one').toBe(unit);
  expect(answer.unitReason).toBeNull();
  expect(answer.nominalReason).toBeNull();
  expect(answer.effectiveReason).toBeNull();
  for (const value of [answer.nominal, answer.effective]) expect(value).toMatch(/^(0|[1-9]\d*)(\.\d+)?$/);
  // Effective is the accepted weight, the same sum the roster already answers per worker; nominal adds the refused one.
  expect(answer.effective).toBe(sumWeights(await roster(who)));
  expect(answer.effective).toBe(plus(base.effective, '3'));
  expect(answer.nominal).toBe(plus(base.nominal, '4'));
  // The newest sample is one of the shares just sent, and the delay is measured from it to the answer.
  const newest = Date.parse(answer.newestSampleAt);
  expect(newest).toBeGreaterThanOrEqual(sentFrom - 1_000);
  expect(newest).toBeLessThanOrEqual(Date.parse(answer.asOf));
  expect(answer.series.length).toBeGreaterThan(0);
  expect(answer).toMatchObject({ power: null, powerReason: NOT_REPORTED, temperature: null, temperatureReason: NOT_REPORTED });

  await openMining(page, '/mining/shares');
  const panel = hashratePanel(page);
  await expect(panel, 'BLOCKED customer /mining/shares Hashrate panel').toBeVisible(UNBUILT);
  const shown = await fleet(who);
  for (const reading of ['nominal', 'effective']) {
    const cell = panel.getByTestId(`mining-hashrate-${reading}`);
    await expect(cell).toHaveAttribute('data-value', shown[reading], UNBUILT);
    await expect(cell).toContainText(unit);
  }
  const delay = panel.getByTestId('mining-hashrate-delay');
  await expect(delay).toHaveAttribute('data-newest', shown.newestSampleAt, UNBUILT);
  await expect(delay).toHaveText(/^Newest sample \d+ s old$/);
  await expect(panel.getByTestId('mining-hashrate-chart')).toHaveAttribute('data-points', String(shown.series.length));
  for (const [id, code] of [
    ['mining-power', shown.powerReason],
    ['mining-temperature', shown.temperatureReason],
  ]) {
    await expect(panel.getByTestId(id)).toHaveAttribute('data-code', code, UNBUILT);
    await expect(panel.getByTestId(id)).toHaveText('not reported by the pool');
  }
});

test(`${J} #3 opens a worker: hashing and connectivity status; online when a share was recent`, async ({ page }) => {
  const { who } = run.read();
  const { quiet } = quietTiming();
  accepted('Rig-Q', tagged('q3'));
  const [rig] = await roster(who, 'Rig-Q');
  expect(rig, 'Rig-Q is on the roster').toBeTruthy();
  const answer = await worker(who, rig.id);
  expect(answer).toMatchObject({ id: rig.id, name: 'Rig-Q', hashing: 'hashing', connectivity: 'online' });
  // Online because the newest share is inside the published quiet interval.
  expect(Date.parse(answer.asOf) - Date.parse(answer.lastShareAt)).toBeLessThan(quiet);

  // The worker is opened from the roster, at its own address.
  await openMining(page, '/mining/workers');
  await tableIn(page, 'Your workers').getByRole('link', { name: 'Rig-Q', exact: true }).click(UNBUILT);
  await expect(page).toHaveURL(`/mining/workers/${encodeURIComponent(rig.id)}`);
  await expect(page.getByText('No details are shown for this record'), 'BLOCKED customer worker detail room').toHaveCount(0);
  await expect(page.getByTestId('mining-worker-hashing')).toHaveAttribute('data-state', answer.hashing, UNBUILT);
  await expect(page.getByTestId('mining-worker-connectivity')).toHaveAttribute('data-state', answer.connectivity, UNBUILT);
  run.write({ quietWorker: rig.id });
});

test(`${J} #4 a worker stops sending shares: offline after the quiet interval with one state-change row, none on a repeat evaluation; a blank alert limit shows "not set"`, async ({
  page,
}) => {
  const { who, quietWorker } = run.read();
  const { every, wait } = quietTiming();
  test.setTimeout(wait * 2 + 60_000);
  // No share is sent: the pool's own evaluator marks the worker offline once the quiet interval has passed.
  await expect.poll(async () => (await worker(who, quietWorker)).connectivity, { timeout: wait, intervals: [every] }).toBe('offline');
  const offline = (changes) => changes.rows.filter((row) => row.workerId === quietWorker && row.to === 'offline');
  const first = await stateChanges(who, quietWorker);
  expect(offline(first)).toHaveLength(1);
  // A later evaluation of the same quiet worker writes no second row.
  await expect
    .poll(async () => Date.parse((await stateChanges(who, quietWorker)).evaluatedAt), { timeout: wait, intervals: [every] })
    .toBeGreaterThan(Date.parse(offline(first)[0].at));
  expect(offline(await stateChanges(who, quietWorker))).toEqual(offline(first));

  // The stack publishes no alert limit; the pool answers blank by its code, and the room says "not set".
  expect(PUBLISHED.MINING_WORKER_ALERT_LIMIT ?? '').toBe('');
  const answer = await worker(who, quietWorker);
  expect(answer).toMatchObject({ connectivity: 'offline', alertLimit: null, alertLimitReason: 'mining.alert_limit_unset' });

  await openMining(page, `/mining/workers/${encodeURIComponent(quietWorker)}`);
  await expect(page.getByTestId('mining-worker-connectivity')).toHaveAttribute('data-state', 'offline', UNBUILT);
  await expect(bodyRows(tableIn(page, 'State changes'))).toHaveCount(1, UNBUILT);
  const limit = page.getByTestId('mining-worker-alert-limit');
  await expect(limit).toHaveAttribute('data-code', 'mining.alert_limit_unset', UNBUILT);
  await expect(limit).toHaveText('not set');
});

/** Is the quiet-worker subject declared in the built events catalogue? A missing catalogue fails by name too. */
async function offlineDeclared() {
  const { ALL_EVENTS } = await import(new URL('../../../../packages/events/dist/catalog.js', import.meta.url).href);
  return ALL_EVENTS.some(({ subject }) => subject === OFFLINE_SUBJECT);
}

/** svc-notify's inbox rows for a quiet worker of this account. */
async function offlineNotices(who, workerIds) {
  const list = await read(who, 'notify', 'notify.list', { limit: 100 }, 'notify.list');
  return list.items.filter((item) => item.kind === 'mining.worker.offline' && workerIds.includes(item.params?.workerId));
}

test(`${J} #5 turns on notifications with no mail provider: the control shows the email notice and nothing is sent`, async ({ page }) => {
  const { who } = run.read();
  const { every, wait } = quietTiming();
  test.setTimeout(wait + 120_000);
  if (!(await offlineDeclared())) throw new Error(`BLOCKED packages/events: ${OFFLINE_SUBJECT} is not declared`);
  // The stack wires no email or push vendor; svc-notify says so for the mining topic before anything is turned on.
  const prefs = await read(who, 'notify', 'notify.topicPrefs', undefined, 'notify.topicPrefs');
  for (const channel of ['email', 'push']) {
    const row = prefs.find((pref) => pref.topic === 'mining' && pref.channel === channel);
    expect(row, `BLOCKED svc-notify topic "mining" (${channel})`).toBeTruthy();
    expect(row.configured, `the stack now wires a ${channel} vendor; add a knob to restart notify with it blank`).toBe(false);
  }

  accepted('Rig-N', tagged('n1'));
  const [rig] = await roster(who, 'Rig-N');
  await openMining(page, `/mining/workers/${encodeURIComponent(rig.id)}`);
  const toggle = page.getByRole('checkbox', { name: 'Tell me when this worker goes quiet' });
  await toggle.check(UNBUILT);
  const notice = page.getByTestId('mining-alerts-email-notice');
  await expect(notice).toHaveAttribute('data-code', 'vendor.email', UNBUILT);
  await expect(page.getByTestId('mining-alerts-push-notice')).toHaveAttribute('data-code', 'vendor.push');
  const after = await read(who, 'notify', 'notify.topicPrefs', undefined, 'notify.topicPrefs');
  expect(after.find((pref) => pref.topic === 'mining' && pref.channel === 'email')).toMatchObject({ enabled: true, configured: false });

  // Rig-N goes quiet: one inbox row, and each outside channel is refused for its unset vendor; no mail goes out.
  await expect.poll(async () => (await offlineNotices(who, [rig.id])).length, { timeout: wait, intervals: [every] }).toBe(1);
  const [row] = await offlineNotices(who, [rig.id]);
  const deliveries = await read(who, 'notify', 'notify.deliveries', { notificationId: row.id }, 'notify.deliveries');
  for (const channel of ['email', 'push']) {
    expect(deliveries.filter((d) => d.channel === channel).map(({ status, refusalCode }) => ({ status, refusalCode }))).toEqual([
      { status: 'refused', refusalCode: 'channel.not_configured' },
    ]);
  }
  expect(mailedLines(who.email, 'mining-worker-offline')).toEqual([]);
});

test(`${J} #6 puts three workers in maintenance: one idempotent row per worker; no alert is raised and the badge says maintenance`, async ({
  page,
}) => {
  const { who } = run.read();
  const { quiet, every, wait } = quietTiming();
  test.setTimeout(wait * 2 + 120_000);
  const rigs = ['Rig-M1', 'Rig-M2', 'Rig-M3'];
  for (const rig of rigs) accepted(rig, tagged(rig));
  const ids = [];
  for (const rig of rigs) ids.push((await roster(who, rig))[0].id);

  await openMining(page, '/mining/workers');
  const workers = tableIn(page, 'Your workers');
  for (const rig of rigs) await workers.getByRole('checkbox', { name: `Select ${rig}`, exact: true }).check(UNBUILT);
  await page.getByRole('button', { name: 'Put in maintenance' }).click(UNBUILT);
  // The same request again, straight to the pool, keeps one row per worker.
  await write(who, 'mining', 'workers.setMaintenance', { workerIds: ids, on: true }, MAINTENANCE);
  const rows = (await read(who, 'mining', 'workers.maintenance', undefined, MAINTENANCE)).rows.filter((row) => ids.includes(row.workerId));
  expect(rows.map((row) => row.workerId).sort()).toEqual([...ids].sort());

  // The three go quiet in maintenance: once the pool has evaluated them past the quiet interval, each reads maintenance,
  // with no offline row and no notice.
  for (const id of ids) {
    const quietBy = Date.parse((await worker(who, id)).lastShareAt) + quiet;
    await expect
      .poll(async () => Date.parse((await stateChanges(who, id)).evaluatedAt), { timeout: wait, intervals: [every] })
      .toBeGreaterThan(quietBy);
    expect((await worker(who, id)).state).toBe('maintenance');
    expect((await stateChanges(who, id)).rows.filter((row) => row.workerId === id && row.to === 'offline')).toEqual([]);
  }
  if (await offlineDeclared()) expect(await offlineNotices(who, ids)).toEqual([]);

  await page.reload();
  for (const rig of rigs) {
    const row = workers.getByRole('row').filter({ has: page.getByRole('cell', { name: rig, exact: true }) });
    await expect(row.getByTestId('mining-worker-badge')).toHaveAttribute('data-state', 'maintenance', UNBUILT);
    await expect(row.getByTestId('mining-worker-badge')).toHaveText('Maintenance');
  }
});
