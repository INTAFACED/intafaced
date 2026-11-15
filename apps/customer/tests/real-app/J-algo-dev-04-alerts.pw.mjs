// World: book
// Market: live
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './journey.mjs';
import { api, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import {
  NAME,
  announcedFills,
  dataOf,
  fillNotices,
  openStrategy,
  read,
  saveSignalStrategy,
  savedStrategyId,
  startForm,
} from './paper-strategy.mjs';

// J-algo-dev-04 #5 to #8, in the running app (docs/roadmap/journeys.json): get notified of a paper run's fills, then stop
// it. Run in order on one TEST developer of this file's own, who starts signed in with a saved signal-rules strategy
// version and one paper run started on the exchange's own prices (as #2 starts one in J-algo-dev-04-start.pw.mjs; #1 is
// in J-algo-dev-04.pw.mjs). #7 reads a fill notice with the email #5 chose and the alert #6 added, and #8 stops the run
// #6 and #7 watched, so the four stay together here, in order. The paper run trades on the local TEST market maker's own
// 1 minute bars of BTC/USDT; every figure is paper and nothing here moves money (svc-quant imports no ledger client). No
// email sender is set on the stack, so email is the honest vendor notice and the notice still appears in the app.
const J = 'J-algo-dev-04';
const run = journeyState(`${J}-alerts-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const TEMPLATE = '{strategy} v{version} paper {side} {qty} {symbol} at {price} ({time})';

test.describe.configure({ mode: 'default' });

function state() {
  const read = run.read();
  if (!read.account || !read.strategyId || !read.runId) {
    throw new Error(`${J} starts (alerts) made no developer, strategy and paper run, so this step has no one to act as`);
  }
  return read;
}

test(`${J} starts (alerts): a TEST developer signed in with a saved signal-rules strategy version and one paper run on our exchange's own prices`, async ({
  page,
}) => {
  const who = await signUp(page, 'jp');
  await verify(page, who);
  run.reset({ account: who });
  await signIn(page, who);
  await saveSignalStrategy(page);
  const strategyId = await savedStrategyId(page);
  const paper = await openStrategy(page, strategyId);
  const form = await startForm(paper);
  const reply = page.waitForResponse((res) => res.url().includes('/api/quant/trpc/paper.start') && res.request().method() === 'POST');
  await form.getByRole('button', { name: 'Start', exact: true }).click();
  const { runId } = dataOf(await (await reply).json());
  expect(runId).toBeTruthy();
  await expect(paper.getByTestId('quant-paper-note')).toHaveText('Version 1 is running on paper.');
  await expect(paper.getByTestId('quant-paper-view')).toHaveAttribute('data-run-id', runId);
  run.write({ strategyId, runId });
});

test(`${J} #5 sets notification channels for the strategy, in-app, email and webhook: in-app on; email shows the vendor notice while the notice still appears in the app; webhook is refused as unavailable and is not saved`, async ({
  page,
}) => {
  const { account: who, strategyId } = state();
  await signIn(page, who);
  await openStrategy(page, strategyId);
  const section = page.getByTestId('quant-notify');
  await expect(section.getByTestId('quant-notify-current')).toHaveAttribute('data-channels', 'inapp');
  // In-app is on and stays on.
  const inapp = section.getByRole('checkbox', { name: 'In the app (always on)' });
  await expect(inapp).toBeChecked();
  await expect(inapp).toBeDisabled();

  // Email: the vendor notice, saying the notice still appears in the app; saved.
  await section.getByRole('checkbox', { name: 'Email', exact: true }).check();
  const vendor = section.locator('[data-testid="quant-notify-vendor"][data-channel="email"]');
  await expect(vendor).toHaveAttribute('data-code', 'vendor.email');
  await expect(vendor).toHaveText(
    'Email needs a delivery provider, which is not connected in this build. The notice still appears in the app, and the Email attempt is recorded as not sent.',
  );
  await section.getByRole('button', { name: 'Save notification channels' }).click();
  await expect(section.getByTestId('quant-notify-note')).toHaveText('Saved. Notices go to: In the app, Email.');
  await expect(section.getByTestId('quant-notify-current')).toHaveAttribute('data-channels', 'inapp,email');
  // With email chosen, the notice still goes to the app: in-app stays on, on the page and in what svc-quant stored, and
  // nothing has been sent anywhere yet (no alert exists until #6). #7 reads a real fill notice in the inbox with email on,
  // and its email row recorded as not sent.
  await expect(inapp).toBeChecked();
  await expect(inapp).toBeDisabled();
  expect((await read(who, 'quant', 'notify.get', { strategyId })).channels).toEqual(['inapp', 'email']);
  expect(await fillNotices(who)).toEqual([]);

  // Webhook: refused as unavailable, and nothing is saved.
  await section.getByRole('checkbox', { name: 'My own webhook' }).check();
  await section.getByRole('button', { name: 'Save notification channels' }).click();
  const refusal = section.getByTestId('quant-notify-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'quant.notify_channel_unavailable');
  await expect(refusal).toHaveText('My own webhook has no sender in this build, so it cannot be chosen. Nothing was saved.');
  await page.reload();
  await expect(section.getByTestId('quant-notify-current')).toHaveAttribute('data-channels', 'inapp,email');
  await expect(section.getByRole('checkbox', { name: 'My own webhook' })).not.toBeChecked();
  expect((await read(who, 'quant', 'notify.get', { strategyId })).channels).toEqual(['inapp', 'email']);
});

test(`${J} #6 adds a fill alert with a message template, then changes a strategy parameter: a fill produces one notice with the fields filled; the existing alert is unchanged by the parameter change; an unknown template field is refused`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const { account: who, strategyId, runId } = state();
  await signIn(page, who);
  await openStrategy(page, strategyId);
  const alerts = page.getByTestId('quant-alerts');
  await expect(alerts.getByText('This strategy has no fill alert yet.')).toBeVisible();

  // An unknown field is refused by name, and nothing is added.
  await alerts.getByRole('button', { name: 'Add a fill alert' }).click();
  const form = alerts.getByTestId('quant-alert-form');
  await form.getByLabel('Message').fill('{strategy} made {profit}');
  await form.getByRole('button', { name: 'Save alert' }).click();
  const refusal = form.getByTestId('quant-alert-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'alert.template_invalid');
  await expect(refusal).toContainText('{profit} is not a field');
  await expect(alerts.getByTestId('quant-alert')).toHaveCount(0);

  // The template with allowed fields, previewed with TEST values, then saved for version 1.
  await form.getByLabel('Message').fill(TEMPLATE);
  await expect(form.getByTestId('quant-alert-preview')).toHaveText(
    'Preview with TEST values: TEST strategy v1 paper buy 0.01 TEST/USD at 100 (2026-01-01T00:00:00.000Z)',
  );
  await form.getByRole('button', { name: 'Save alert' }).click();
  await expect(alerts.getByTestId('quant-alerts-note')).toHaveText('The fill alert is saved for version 1.');
  const row = alerts.getByTestId('quant-alert');
  await expect(row).toHaveCount(1);
  const before = (await read(who, 'quant', 'alert.list', { strategyId })).alerts;
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ strategyVersion: 1, event: 'fill', template: TEMPLATE });
  run.write({ alert: before[0] });

  // A parameter change in Studio: a new version; the alert stays as it was, on version 1.
  await page.goto('/quant/studio');
  // Studio keeps the strategy it last saved open on this device; otherwise open it from the library once it has read it.
  const open = page.getByRole('button', { name: `Open ${NAME}` });
  await expect(open.or(page.getByText('Open in the form')).first()).toBeVisible();
  if (await open.isVisible()) await open.click();
  await expect(page.getByLabel('Strategy name')).toHaveValue(NAME);
  await page.getByTestId('quant-signal-builder').getByLabel('Slow average (bars)').fill('3');
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText('Saved as version 2.');
  expect((await read(who, 'quant', 'alert.list', { strategyId })).alerts).toEqual(before);
  await openStrategy(page, strategyId);
  await expect(row).toHaveAttribute('data-version', '1');
  await expect(row).toHaveAttribute('data-alert-id', before[0].alertId);
  await expect(row.getByTestId('quant-alert-template')).toHaveText(TEMPLATE);

  // A fill of the run (started by this file's setup) after the alert: one notice, with the template's fields filled from that fill.
  await expect
    .poll(async () => (await announcedFills(who, runId, before[0].createdAt)).length, {
      timeout: 12 * 60_000,
      intervals: [15_000],
      message: 'the paper run made no fill since the alert; is the TEST market maker running (pnpm local:market)?',
    })
    .toBeGreaterThan(0);
  const [fill] = await announcedFills(who, runId, before[0].createdAt);
  const matching = async () => (await fillNotices(who)).filter((n) => n.params.runId === runId && n.params.filledAt === fill.ts);
  await expect.poll(async () => (await matching()).length, { timeout: 90_000, intervals: [5_000] }).toBe(1);
  const [notice] = await matching();
  expect(notice.params).toMatchObject({
    message: `${NAME} v1 paper ${fill.side} ${fill.qty} BTC/USDT at ${fill.price} (${fill.ts})`,
    mode: 'paper',
    alertId: before[0].alertId,
    strategyId,
    side: fill.side,
    qty: fill.qty,
    price: fill.price,
  });
});

/**
 * The newest `intafaced.quant.order.filled` of this developer, published again twice on the stack's bus with its payload
 * unchanged (same event id) under new envelope keys, so the bus does not drop it as its own duplicate and svc-notify's
 * consumer is what must hold. Returns the payload.
 */
function redeliverFill(userId) {
  const code = `
    import { connect } from 'nats';
    import { EVENT_CATALOG, JetStreamEventBus, decodeEnvelope, streamName } from '@intafaced/events';
    const { NATS_URL: servers, NATS_STREAM_PREFIX: prefix, USER_ID: userId } = process.env;
    const subject = EVENT_CATALOG.quantOrderFilled.subject;
    const nc = await connect({ servers });
    const jsm = await nc.jetstreamManager();
    const stream = streamName(EVENT_CATALOG.quantOrderFilled.service, prefix);
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
    const bus = await JetStreamEventBus.connect({ servers, producer: 'svc-quant', streamPrefix: prefix });
    for (const n of [1, 2]) {
      await bus.publish('quantOrderFilled', payload, { idempotencyKey: payload.eventId + ':again:' + n + ':' + Date.now() });
    }
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

/** Until svc-notify's paper fill consumer has taken and acknowledged every message on the bus. */
async function notifyConsumerCaughtUp() {
  await expect(async () => {
    const info = await fetch('http://127.0.0.1:18232/jsz?consumers=true').then((r) => r.json());
    const consumer = info.account_details
      ?.flatMap((a) => a.stream_detail ?? [])
      .filter((st) => st.name === 'LOCAL_TEST_QUANT')
      .flatMap((st) => st.consumer_detail ?? [])
      .find((c) => c.name === 'notify-quant-order-filled');
    expect(consumer?.num_pending ?? -1).toBe(0);
    expect(consumer?.num_ack_pending ?? -1).toBe(0);
  }).toPass({ timeout: 30_000 });
}

test(`${J} #7 lets the run fill, then closes the browser: the notice is still created server-side, once per fill even if the event is delivered twice`, async ({
  browser,
}) => {
  test.setTimeout(15 * 60_000);
  const { account: who, strategyId, runId, alert } = state();
  if (!alert) throw new Error(`${J} #6 added no alert, so nothing announces a fill`);
  // The developer looks at the run, then closes the browser.
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, who);
  await openStrategy(page, strategyId);
  const seen = (await announcedFills(who, runId, alert.createdAt)).length;
  await context.close();

  // With no browser open, the run fills again and the server writes the notice.
  await expect
    .poll(async () => (await announcedFills(who, runId, alert.createdAt)).length, {
      timeout: 12 * 60_000,
      intervals: [15_000],
      message: 'the paper run made no new fill with the browser closed; is the TEST market maker running (pnpm local:market)?',
    })
    .toBeGreaterThan(seen);
  const onePerFill = async () => {
    const fills = await announcedFills(who, runId, alert.createdAt);
    const notices = (await fillNotices(who)).filter((n) => n.params.runId === runId);
    return fills.every((fill) => notices.filter((n) => n.params.filledAt === fill.ts && n.params.side === fill.side).length === 1);
  };
  await expect.poll(onePerFill, { timeout: 90_000, intervals: [5_000] }).toBe(true);

  // The same fill event delivered twice more: still one notice for that fill.
  const userId = (await api(who)).userId;
  const again = redeliverFill(userId);
  expect(again.mode).toBe('paper');
  await notifyConsumerCaughtUp();
  const same = (await fillNotices(who)).filter((n) => n.params.runId === again.runId && n.params.filledAt === again.filledAt);
  expect(same).toHaveLength(1);
  expect(await onePerFill()).toBe(true);

  // Email was chosen with no email sender: the notice is in the app, and its email row says it was not sent.
  const deliveries = await read(who, 'notify', 'notify.deliveries', { notificationId: same[0].id });
  const email = deliveries.find((row) => row.channel === 'email');
  expect(email, JSON.stringify(deliveries)).toBeTruthy();
  expect(email.acceptedAt).toBeNull();
  expect(email.refusalCode).toBe('channel.not_configured');

  // Opened again, the app shows the notice, labelled paper.
  const later = await browser.newContext();
  const reopened = await later.newPage();
  await signIn(reopened, who);
  await reopened.getByRole('button', { name: /^Notifications/ }).click();
  await expect(
    reopened
      .getByRole('dialog', { name: /Notifications/ })
      .getByText('Paper strategy fill (not a real order)')
      .first(),
  ).toBeVisible({ timeout: 20_000 });
  await later.close();
});

test(`${J} #8 stops the paper run: no new orders; the record stays`, async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const { account: who, strategyId, runId } = state();
  await signIn(page, who);
  const paper = await openStrategy(page, strategyId);
  const row = paper.locator(`[data-testid="quant-paper-run"][data-run-id="${runId}"]`);
  await row.getByRole('button', { name: /^Stop the paper run/ }).click();
  await expect(paper.getByTestId('quant-paper-note')).toHaveText('The paper run is stopped. It places no new order, and its record stays.');
  await expect(row).toHaveAttribute('data-state', 'stopped');
  const stopped = await read(who, 'quant', 'paper.get', { runId });
  expect(stopped.state).toBe('stopped');
  expect(stopped.stoppedAt).toBeTruthy();

  // Three more closed bars later, nothing new has filled, and nothing filled after the stop.
  await page.waitForTimeout(3 * 60_000);
  const later = await read(who, 'quant', 'paper.get', { runId });
  expect(later.trades).toEqual(stopped.trades);
  for (const trade of later.trades) expect(Date.parse(trade.ts)).toBeLessThan(Date.parse(stopped.stoppedAt));
  await page.reload();
  await expect(row).toHaveAttribute('data-state', 'stopped');
  await row.getByRole('button', { name: /^Show run/ }).click();
  await expect(paper.getByTestId('quant-paper-view')).toHaveAttribute('data-state', 'stopped');
  await expect(paper.getByTestId('quant-paper-fill')).toHaveCount(stopped.trades.length);
  // The record stays: the run is still listed, with its fills.
  expect((await read(who, 'quant', 'paper.list', { strategyId, limit: 50 })).runs.map((r) => r.runId)).toContain(runId);
});
