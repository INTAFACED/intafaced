// World: book
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './journey.mjs';
import { OWN_AGENT, UNBUILT, agentsRun, createOwnAgent, openOwnAgent, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';
import { api } from './stack.mjs';

// J-agents-07, in the running app (docs/roadmap/journeys.json): schedule an agent, trigger it from an event and hand
// work to a specialist. One test per step, titled "J-agents-07 #<n>", run in order on one verified TEST account with a
// published agent of its own and a specialist agent. Every scheduled and triggered run is metered against the person's
// caps; a blank cap skips the occurrence with the reason shown.
// #1 to #4 are built (AG-sessions-02): the agent's Schedules and Triggers pages. svc-agents' due-run workers (two on the
// stack, waking together every TEST tick) claim each due occurrence under its business key, so one occurrence is one
// run; a trigger runs on the person's own fill (trade.fill.settled), once per fill id, however often it is delivered.
// Every answer is read back from svc-agents.
// #5 to #7 are not built yet: there are no hand-offs to a specialist (AG-sessions-03), so each fails at its first missing
// part, quickly (UNBUILT).
const J = 'J-agents-07';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const pages = (page) => page.getByRole('group', { name: 'Agent pages' });
const schedule = (page) => main(page).getByRole('form', { name: 'New schedule' });
const schedules = (page) => tableIn(main(page), 'Schedules');
const occurrences = (page) => tableIn(main(page), 'Occurrences');

/** The specialist agent the journey starts with, beside its own published agent. */
const SPECIALIST = 'Market scanner';
/** What every schedule and trigger of the journey asks the agent. */
const ASK = 'TEST: summarise my open orders';
/** One TEST market buy on the real book: it fills against the stack's TEST market maker. */
const SYMBOL = 'BTC/USDT';
const TRADE = '0.001';

/** One of svc-agents' reads of the journey's own agent through Edge, as the journey's person: the answer's data. */
async function ownRead(procedure, input) {
  const query = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await (await api(agents.account())).get(`/api/agents/trpc/own.${procedure}${query}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}
/** The journey's own agent (or the specialist), as svc-agents holds it. */
async function ownAgent(name = OWN_AGENT) {
  const [agent] = (await ownRead('list', { limit: 50 })).filter((row) => row.name === name);
  expect(agent, `the journey made its own agent ${name}`).toBeTruthy();
  return agent;
}
const schedulesHeld = async () => (await ownRead('schedules.list', { id: (await ownAgent()).id })).schedules;
const triggersHeld = async () => ownRead('triggers.list', { id: (await ownAgent()).id });

test(`${J} starts: a verified TEST account with a published agent of its own and a specialist agent`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag07', '500');
  await signIn(page, agents.account());
  await createOwnAgent(page);
  // The person's spending limits for it, which every scheduled and triggered run is held against.
  await openOwnAgent(page, agents, 'Limits');
  const limits = main(page).getByRole('form', { name: 'Spending limits' });
  await limits.getByRole('textbox', { name: /^Per call/ }).fill('0.012');
  await limits.getByRole('textbox', { name: /^Per session/ }).fill('0.02');
  await limits.getByRole('textbox', { name: /^Per month/ }).fill('5');
  await limits.getByRole('button', { name: 'Save limits' }).click();
  await expect(limits.getByRole('status')).toHaveText('Limits saved.');
  // Published to the person's own agents.
  await pages(page).getByRole('button', { name: 'Build', exact: true }).click();
  await main(page).getByRole('button', { name: 'Publish' }).click();
  const publish = page.getByRole('dialog', { name: 'Publish' });
  await publish.getByRole('checkbox', { name: 'My agents' }).check();
  await publish.getByRole('button', { name: 'Publish version 1' }).click();
  await expect(main(page).getByTestId('agent-version')).toHaveText('Version 1 · published');
  // And a specialist agent of the person's own.
  await createOwnAgent(page, { name: SPECIALIST });
  expect(await ownAgent()).toMatchObject({ state: 'published' });
  expect(await ownAgent(SPECIALIST)).toBeTruthy();
});

test(`${J} #1 creates a repeating schedule with the minimum interval left blank: a refusal naming the interval and no schedule`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Schedules');
  await schedule(page).getByRole('combobox', { name: 'Repeat' }).selectOption({ label: 'Repeating' });
  await expect(schedule(page).getByRole('textbox', { name: /^Minimum interval/ })).toHaveValue('');
  await schedule(page)
    .getByRole('textbox', { name: /^Cap per run/ })
    .fill('0.1');
  await schedule(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill(ASK);
  await schedule(page).getByRole('button', { name: 'Create schedule' }).click();
  const refusal = schedule(page).getByRole('alert');
  await expect(refusal).toContainText('Set the minimum interval between runs first.');
  await expect(refusal.locator('code')).toHaveText('agents.schedule.min_interval_unset');
  // No schedule: none on the page, and none in svc-agents.
  await expect(schedules(page).getByRole('row')).toHaveCount(1);
  expect(await schedulesHeld()).toEqual([]);
});

test(`${J} #2 sets a cadence and a per-run cap: the schedule list with status and recent runs; two workers waking together make one run; a blank cap skips with the reason`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openOwnAgent(page, agents, 'Schedules');
  // A schedule with its cap per run left blank: it is kept blank, and its occurrence is skipped with the reason.
  await schedule(page).getByRole('combobox', { name: 'Repeat' }).selectOption({ label: 'Once' });
  await schedule(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill(ASK);
  await schedule(page).getByRole('button', { name: 'Create schedule' }).click();
  await expect(schedules(page).getByRole('row')).toHaveCount(2);
  // The cadence and the cap per run set.
  await schedule(page).getByRole('combobox', { name: 'Repeat' }).selectOption({ label: 'Repeating' });
  await schedule(page)
    .getByRole('textbox', { name: /^Minimum interval/ })
    .fill('1');
  await schedule(page)
    .getByRole('textbox', { name: /^Cap per run/ })
    .fill('0.1');
  await schedule(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill(ASK);
  await schedule(page).getByRole('button', { name: 'Create schedule' }).click();
  await expect(schedules(page).getByRole('row')).toHaveCount(3);

  // svc-agents' workers wake together for the first occurrence: both woke, one wrote it, and it is one run.
  let held;
  await expect
    .poll(
      async () => {
        held = await schedulesHeld();
        return held.find((s) => s.repeat === 'repeat')?.recent.find((r) => r.ordinal === 1)?.state ?? 'none';
      },
      { timeout: 60_000 },
    )
    .toBe('ran');
  const capped = held.find((s) => s.repeat === 'repeat');
  expect(capped).toMatchObject({ state: 'active', intervalMinutes: 1, perRunCap: '0.1', ask: ASK });
  expect(capped.nextDueAt).not.toBeNull();
  const first = capped.recent.find((r) => r.ordinal === 1);
  expect(first).toMatchObject({ state: 'ran', runs: 1, wakes: 2, code: null, runKey: `agents:schedule:${capped.id}:1` });
  // Metered against the person's caps: its cost is within the cap per run, on the agent's own usage window for the run.
  expect(Number(first.cost)).toBeGreaterThan(0);
  expect(Number(first.cost)).toBeLessThanOrEqual(0.1);
  const agent = await ownAgent();
  const windows = await ownRead('usage', { id: agent.id, limit: 50 });
  expect(windows.filter((w) => w.sessionId === first.sessionId)).toHaveLength(1);
  // The run is the agent's own live run, once.
  const live = await ownRead('runs', { id: agent.id, limit: 50 });
  expect(live.filter((row) => row.sessionId === first.sessionId && row.status === 'executed')).toHaveLength(1);
  // The blank cap: kept blank, and its occurrence skipped with the reason; nothing ran.
  const blank = held.find((s) => s.repeat === 'once');
  expect(blank.perRunCap).toBeNull();
  await expect
    .poll(async () => (await schedulesHeld()).find((s) => s.id === blank.id)?.recent[0]?.state ?? 'none', { timeout: 30_000 })
    .toBe('skipped');
  const [skipped] = (await schedulesHeld()).find((s) => s.id === blank.id).recent;
  expect(skipped).toMatchObject({
    code: 'agents.schedule_blocked',
    reasonCode: 'agents.schedule.cap_per_run_unset',
    runs: 0,
    cost: null,
    sessionId: null,
  });

  // The page: the list with each schedule's status, and its recent runs.
  const row = schedules(page).getByRole('row').filter({ hasText: 'Every 1 min' });
  await expect(row).toContainText('Active');
  await row.getByRole('button', { name: 'Recent runs' }).click();
  const ran = occurrences(page)
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: '1', exact: true }) });
  await expect(ran.getByTestId('occurrence-outcome')).toHaveText('Ran');
  await expect(ran.getByTestId('runs-for-occurrence')).toHaveText('1 run');
  await expect(ran.getByTestId('wakes')).toHaveText('2 woke');
  const once = schedules(page).getByRole('row').filter({ hasText: 'Once' });
  await expect(once).toContainText('Completed');
  await once.getByRole('button', { name: 'Recent runs' }).click();
  await expect(occurrences(page).getByTestId('occurrence-outcome')).toHaveText(['Skipped: no cap per run agents.schedule_blocked']);
  await expect(occurrences(page).getByTestId('runs-for-occurrence')).toHaveText(['0 runs']);
});

/**
 * The person's newest fill delivered to svc-agents once more: their newest trade.fill.settled on the stack's bus,
 * published again with its payload unchanged (the same fill id) under a new envelope key, so the bus does not drop it as
 * its own duplicate and the trigger is what must hold. Returns the payload.
 */
function redeliverFill(userId) {
  const code = `
    import { connect } from 'nats';
    import { EVENT_CATALOG, JetStreamEventBus, decodeEnvelope, streamName } from '@intafaced/events';
    const { NATS_URL: servers, NATS_STREAM_PREFIX: prefix, USER_ID: userId } = process.env;
    const subject = EVENT_CATALOG.fillSettled.subject;
    const nc = await connect({ servers });
    const jsm = await nc.jetstreamManager();
    const stream = streamName(EVENT_CATALOG.fillSettled.service, prefix);
    const { state } = await jsm.streams.info(stream);
    let payload;
    for (let seq = state.last_seq; seq >= state.first_seq && !payload; seq -= 1) {
      const m = await jsm.streams.getMessage(stream, { seq }).catch(() => null);
      if (m?.subject !== subject) continue;
      const env = decodeEnvelope(m.data);
      if (env.payload.userId === userId) payload = env.payload;
    }
    await nc.close();
    if (!payload) throw new Error('no ' + subject + ' for ' + userId + ' in ' + stream);
    const bus = await JetStreamEventBus.connect({ servers, producer: 'svc-trade', streamPrefix: prefix });
    await bus.publish('fillSettled', payload, { idempotencyKey: payload.fillId + ':again:' + Date.now() });
    await bus.close();
    console.log(JSON.stringify(payload));`;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.join(root, 'packages', 'events'),
    env: { ...process.env, NATS_URL: 'nats://127.0.0.1:14232', NATS_STREAM_PREFIX: 'LOCAL_TEST', USER_ID: userId },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`delivering the fill event again failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

test(`${J} #3 adds an event trigger and the same event id arrives twice: one run`, async ({ page }) => {
  test.setTimeout(120_000);
  await openOwnAgent(page, agents, 'Triggers');
  const triggers = main(page).getByRole('form', { name: 'New trigger' });
  await triggers.getByRole('combobox', { name: 'When' }).selectOption({ label: 'An order of mine fills' });
  await triggers.getByRole('textbox', { name: /^Cap per run/ }).fill('0.1');
  await triggers.getByRole('textbox', { name: /^Ask the agent/ }).fill(ASK);
  await triggers.getByRole('button', { name: 'Add trigger' }).click();
  await expect(tableIn(main(page), 'Triggers').getByRole('row')).toHaveCount(2);
  expect(await triggersHeld()).toEqual([expect.objectContaining({ subject: 'trade.fill.settled', state: 'active', perRunCap: '0.1' })]);

  // An order of the person's fills: the event arrives once on the bus, and the trigger runs the agent.
  const me = await api(agents.account());
  const order = await me.post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'market',
    side: 'buy',
    amount: TRADE,
    clientOrderId: `${J}-${Date.now()}`,
  });
  expect(order.status, JSON.stringify(order.body).slice(0, 300)).toBeLessThan(300);
  await expect
    .poll(async () => (await triggersHeld())[0].runs.filter((r) => r.state === 'ran').length, { timeout: 60_000 })
    .toBeGreaterThan(0);
  // The same event id arrives again.
  const fill = redeliverFill(me.userId);
  const ofFill = (trigger) => ({
    deliveries: trigger.deliveries.filter((d) => d.eventId === fill.fillId),
    runs: trigger.runs.filter((r) => r.eventId === fill.fillId),
  });
  await expect.poll(async () => ofFill((await triggersHeld())[0]).deliveries.length, { timeout: 60_000 }).toBe(2);
  const { deliveries, runs } = ofFill((await triggersHeld())[0]);
  // Two deliveries of one event id, and one run.
  expect(deliveries.map((d) => d.redelivered).sort()).toEqual([false, true]);
  expect(runs).toEqual([expect.objectContaining({ state: 'ran', runs: 1, runKey: expect.stringMatching(new RegExp(`:${fill.fillId}$`)) })]);

  // The page, re-read: the event's first delivery ran, its redelivery was ignored.
  await openOwnAgent(page, agents, 'Triggers');
  const fired = tableIn(main(page), 'Trigger runs').getByRole('row').filter({ hasText: fill.fillId });
  await expect(fired).toHaveCount(2);
  await expect(fired.filter({ hasText: 'Redelivered event ignored' })).toHaveCount(1);
  await expect(fired.getByTestId('delivery-outcome')).toContainText(['Redelivered event ignored', 'Ran']);
  await expect(fired.filter({ hasText: 'Ran' }).getByTestId('runs-for-event')).toHaveText('1 run');
});

test(`${J} #4 cancels the schedule: no further occurrences`, async ({ page }) => {
  test.setTimeout(150_000);
  await openOwnAgent(page, agents, 'Schedules');
  const row = schedules(page).getByRole('row').filter({ hasText: 'Every 1 min' });
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(row).toContainText('Cancelled');
  await expect(row.getByTestId('next-occurrence')).toHaveText('None');
  const cancelled = (await schedulesHeld()).find((s) => s.repeat === 'repeat');
  expect(cancelled).toMatchObject({ state: 'cancelled', nextDueAt: null });
  const count = cancelled.recent.length;
  // Wait past when its next occurrence would have been due (one interval after the last, plus the workers' tick).
  const last = Math.max(...cancelled.recent.map((r) => Date.parse(r.dueAt)));
  await page.waitForTimeout(Math.max(0, last + 60_000 + 10_000 - Date.now()));
  const after = (await schedulesHeld()).find((s) => s.id === cancelled.id);
  expect(after).toMatchObject({ state: 'cancelled', nextDueAt: null });
  expect(after.recent).toHaveLength(count);
  expect(after.recent.every((r) => r.state !== 'claimed')).toBe(true);
});

test(`${J} #5 lets a primary agent hand a task to a specialist: the specialist's run is a child with its own audit row; its cost counts on the caller's caps`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Runs');
  const parent = tableIn(main(page), 'Live runs').getByRole('row').filter({ hasText: 'Handed to' }).first();
  await parent.getByRole('button', { name: 'Open' }).click(UNBUILT);
  const child = tableIn(main(page), 'Child runs').getByRole('row').nth(1);
  await expect(child).toContainText('Market scanner');
  await expect(child.getByRole('link', { name: 'Audit row' })).toBeVisible();
  await expect(main(page).getByTestId('caps-used')).toContainText('including child runs');
});

test(`${J} #6 hands off in a loop and with the hop limit blank: a route-loop refusal and a hop-limit-unset refusal`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Runs');
  const refused = tableIn(main(page), 'Live runs').getByRole('row').filter({ hasText: 'Refused' });
  await expect(refused.filter({ hasText: 'agents.handoff.loop' })).toHaveCount(1, UNBUILT);
  await expect(refused.filter({ hasText: 'agents.handoff.hop_limit_unset' })).toHaveCount(1);
});

test(`${J} #7 stops the parent: the child stops at its next boundary`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Runs');
  const parent = tableIn(main(page), 'Live runs').getByRole('row').filter({ hasText: 'Handed to' }).first();
  await parent.getByRole('button', { name: 'Stop' }).click(UNBUILT);
  await parent.getByRole('button', { name: 'Open' }).click();
  await expect(tableIn(main(page), 'Child runs').getByRole('row').nth(1)).toContainText('Stopped at its next step');
});
