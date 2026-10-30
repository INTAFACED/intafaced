import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ORIGIN, ROOT, api, fund, journeyState, signUpInBrowser, tool } from './stack.mjs';

// J-ops-console-07: reconcile the books on the founder console's /ledger page. Steps 1-4 (OPS-reconciliation-01): define a
// control, set its policy and dynamic account set, run it now with two founders, and run it at a past instant. Define, change
// and run travel on the console's treasury transport; a console without ADMIN_TREASURY_TOKEN shows them parked, and this
// journey stops there with that blocker named. Steps 5-6 (OPS-reconciliation-02): a PASS, a FAIL and an ERROR run with
// per-asset evidence, and pause, resume and retire a control. Steps 7-8 (OPS-reconciliation-03): svc-ops raises one alert per
// control, failing asset and period from the ledger's settled evaluations, on the console's /ledger/alerts room. Steps 9-10
// (OPS-reconciliation-04): resolve as fixed with booked ledger transaction ids and accept with two founders; a repeat failure
// reopens, a passing run resolves, an ERROR run is a platform alert, and a run-failed event delivered twice is stored once.
// #9's corrective reversal stays red by name: no reversal can be booked on this stack until J-ops-console-05's desk exists.
// #10's transition event received twice stays red by name: nothing consumes svc-ops' alert transition events yet.

const tag = randomUUID().slice(0, 8);
const state = {
  a: null,
  b: null,
  thresholdId: null,
  outsideId: null,
  outsideRuns: [],
  floorId: null,
  pairId: null,
  // #9 and #10: the customer-USDT floor that is resolved, reopens and passes, its alert and payer; the USDC floor accepted.
  fixId: null,
  fixAlertId: null,
  fixPayer: null,
  acceptId: null,
  acceptAlert: null,
};
const runId = (answer) => answer.match(/Run ([0-9a-f-]{36}): /)?.[1] ?? null;

async function openLedger(page) {
  await page.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
  const section = page.getByTestId('reconciliation-controls');
  await expect(section.getByTestId('rc-table')).toBeVisible({ timeout: 60_000 });
  return section;
}

/** Stops the journey with the console's own words when its treasury doors are parked. */
async function requireTreasury(section) {
  const parked = section.getByTestId('rc-treasury-parked');
  if (await parked.isVisible())
    throw new Error(`the console's treasury doors are parked: ${(await parked.innerText()).replace(/\s+/g, ' ')}`);
}

async function founders(browser) {
  if (!state.a) {
    state.a = await (await browser.newContext()).newPage();
    await founderSignIn(state.a, 'a');
  }
  if (!state.b) {
    state.b = await (await browser.newContext()).newPage();
    await founderSignIn(state.b, 'b');
  }
  return { a: state.a, b: state.b };
}

function row(section, id) {
  return section.locator(`[data-testid="rc-row"][data-control-id="${id}"]`);
}

async function choose(section, id) {
  await row(section, id)
    .getByRole('button', { name: /^Choose|^Chosen/ })
    .click();
  await expect(section.getByTestId('rc-selected').getByRole('heading')).toHaveText(`Control ${id.slice(0, 8)}`);
}

/** Defines a control from the open define form and returns its id, read back from the list by its explanation. */
async function define(section, { template, explanation, fill }) {
  const details = section.getByTestId('rc-define');
  if (!(await details.evaluate((el) => el.open))) await details.locator('summary').click();
  const form = section.getByTestId('rc-form-define');
  await form.getByLabel('Template').selectOption(template);
  await form.getByLabel('Explanation (optional)').fill(explanation);
  await form.getByLabel('Asset', { exact: true }).fill('USDT');
  if (fill) await fill(form);
  await form.getByLabel(/^Why/).fill(`LOCAL TEST J-ops-console-07 define ${tag}`);
  await form.getByRole('button', { name: 'Define control' }).click();
  await expect(form.getByTestId('rc-saved')).toBeVisible({ timeout: 30_000 });
  const defined = section.getByTestId('rc-row').filter({ hasText: explanation });
  await expect(defined).toHaveCount(1);
  return defined.getAttribute('data-control-id');
}

async function setPolicy(form, { tolerance = '0', activate = true } = {}) {
  await form.getByLabel('Cadence').selectOption('daily');
  await form.getByLabel('Hour (UTC)').fill('6');
  await form.getByLabel('Minute').fill('30');
  await form.getByLabel('Severity').selectOption('warning');
  await form.getByLabel(/^Tolerance \(blank/).fill(tolerance);
  if (activate) await form.getByRole('checkbox').check();
}

/**
 * Founder A asks for a run and founder B approves the packet on their own console. Returns the packet and its phrase, so A
 * can run it now or later.
 */
async function approvedRun(controlId, { instant = '', margin = '' } = {}) {
  const sectionA = await openLedger(state.a);
  await choose(sectionA, controlId);
  const desk = sectionA.getByTestId('rc-run');
  await desk.getByLabel(/^At a past instant/).fill(instant);
  if (instant) await desk.getByLabel(/^Margin in seconds/).fill(margin);
  const phrase = `RUN CONTROL ${controlId.slice(0, 8)}`;
  await desk.getByLabel(/^Why \(recorded with the run/).fill(`LOCAL TEST J-ops-console-07 run ${tag}`);
  await desk.getByLabel(/to confirm$/).fill(phrase);
  await desk.getByRole('button', { name: 'Ask a second founder to approve the run' }).click();
  await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  const packetText = (await desk.getByLabel('Request packet').inputValue()).trim();

  const deskB = (await openLedger(state.b)).getByTestId('rc-run');
  await deskB.getByLabel('Request packet').fill(packetText);
  await expect(deskB.getByTestId('packet-summary')).toContainText(`Run reconciliation control ${controlId}`);
  await deskB.getByLabel(/to approve or run it$/).fill(phrase);
  await deskB.getByRole('button', { name: 'Approve this request' }).click();
  await expect(deskB.getByTestId('step-reply')).toContainText('Approved.', { timeout: 30_000 });
  return { desk, phrase, packetText };
}

/**
 * Sends one approval step for a packet straight to the console's own route, as the signed-in founder on `page`, the way the
 * workbench sends it, and returns the console's JSON answer. Used where the workbench itself holds the button.
 */
async function consoleStep(page, endpoint, packetText, step, confirm) {
  const packet = JSON.parse(Buffer.from(packetText.slice('ifa1.'.length), 'base64url').toString('utf8'));
  return page.evaluate(
    async ({ endpoint, request, approvalId, step, confirm }) => {
      const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
        body: JSON.stringify({ step, request, confirm, approvalId }),
        cache: 'no-store',
      });
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        return { status: res.status, body: text };
      }
    },
    { endpoint, request: packet.request, approvalId: packet.approvalId, step, confirm },
  );
}

/** A runs an approved request on their run desk and returns the service's answer as the desk shows it. */
async function runApproved(desk, phrase) {
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  const reply = desk.getByTestId('step-reply');
  await expect(reply).toContainText(/The service answered|Code: /, { timeout: 60_000 });
  return (await reply.innerText()).replace(/\s+/g, ' ');
}

/** The one typed code a desk reply names, or null. */
const codeOf = (reply) => reply.match(/Code: ([a-z0-9_.]+)/)?.[1] ?? null;

/** Founder A asks for a run, founder B approves it, and A runs it. Returns the service's answer as shown on A's desk. */
async function twoFounderRun(controlId, opts) {
  const { desk, phrase } = await approvedRun(controlId, opts);
  return runApproved(desk, phrase);
}

/**
 * svc-ledger restarted reading its outside side from an address nothing answers, or back on the stack's default (no snapshot
 * published, so unset). "Unreachable" is written to its own state file before the restart, so a run cancelled in between is
 * put back by the next run's first hook.
 */
const outsideSource = journeyState('J-ops-console-07-outside');
function ledgerOutside(unreachable) {
  const before = process.env.LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT;
  if (unreachable) {
    process.env.LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT = 'unreachable';
    outsideSource.write({ unreachable: true });
  } else delete process.env.LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT;
  try {
    tool('local-test-stack.mjs', 'restart', 'ledger');
    if (!unreachable) outsideSource.reset({});
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT;
    else process.env.LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT = before;
  }
}
const putOutsideBack = () => {
  if (outsideSource.read().unreachable) ledgerOutside(false);
};
// A step that fails or times out never reaches its own finally, so the hooks put the ledger back before the next step.
test.beforeAll(putOutsideBack);
test.afterEach(putOutsideBack);

const accountsRead = (answer) => Number(/(\d+) accounts? and/.exec(answer)?.[1] ?? NaN);

/** A floor no TEST book reaches, so a min threshold on it must FAIL. */
const HIGH_FLOOR = '1000000000000';

/**
 * Pause, resume or retire a control with two founders: A asks on the lifecycle desk, B approves the packet on their own console,
 * and A runs it. Waits until A's desk shows the service's answer naming the new state, then until the list shows it too.
 */
async function lifecycle(id, move, label) {
  const sectionA = await openLedger(state.a);
  await choose(sectionA, id);
  const desk = sectionA.getByTestId('rc-lifecycle');
  const pick = desk.getByTestId('rc-lifecycle-move');
  if (await pick.isVisible()) await pick.selectOption(move);
  const phrase = `${move.toUpperCase()} CONTROL ${id.slice(0, 8)}`;
  await desk.getByLabel(/^Why \(recorded with the step/).fill(`LOCAL TEST J-ops-console-07 ${move} ${tag}`);
  await desk.getByLabel(/to confirm$/).fill(phrase);
  await desk.getByRole('button', { name: `Ask a second founder to approve: ${move}` }).click();
  await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  const packetText = (await desk.getByLabel('Request packet').inputValue()).trim();

  const deskB = (await openLedger(state.b)).getByTestId('rc-lifecycle');
  await deskB.getByLabel('Request packet').fill(packetText);
  const verb = move[0].toUpperCase() + move.slice(1);
  await expect(deskB.getByTestId('packet-summary')).toContainText(`${verb} reconciliation control ${id}`);
  await deskB.getByLabel(/to approve or run it$/).fill(phrase);
  await deskB.getByRole('button', { name: 'Approve this request' }).click();
  await expect(deskB.getByTestId('step-reply')).toContainText('Approved.', { timeout: 30_000 });

  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  const reply = desk.getByTestId('step-reply');
  await expect(reply).toContainText('The service answered', { timeout: 60_000 });
  await expect(reply).toContainText(new RegExp(`Control ${id} is ${label.toLowerCase()} at version \\d+\\.`));
  await expect(row(sectionA, id).getByTestId('rc-state')).toHaveText(label, { timeout: 30_000 });
  return sectionA;
}

/** One asset's evidence as the run reply prints it. */
function evidence(answer, assetId) {
  const num = '(-?\\d+(?:\\.\\d+)?|unset)';
  const all = [...answer.matchAll(new RegExp(`${assetId}: observed ${num}, expected ${num}, difference ${num}, tolerance ${num}\\.`, 'g'))];
  if (all.length !== 1) throw new Error(`the run shows ${all.length} ${assetId} evidence lines, not exactly one: ${answer}`);
  const [m] = all;
  return { observed: m[1], expected: m[2], difference: m[3], tolerance: m[4] };
}

/** The control's stored evaluation for a run, re-read from a fresh /ledger page: its status must be `status`; returns its text. */
async function storedRun(page, controlId, answer, status) {
  const section = await openLedger(page);
  await choose(section, controlId);
  const stored = section.getByTestId('rc-runs').locator(`[data-testid="rc-run-row"][data-run-id="${runId(answer)}"]`);
  await expect(stored, `the stored evaluation of run ${runId(answer)}`).toHaveAttribute('data-status', status, { timeout: 30_000 });
  return (await stored.innerText()).replace(/\s+/g, ' ');
}

/** A decimal string as a bigint scaled by 10^18, so evidence is compared exactly. */
function scaled(text) {
  const [whole, frac = ''] = text.replace(/^-/, '').split('.');
  const value = BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
  return text.startsWith('-') ? -value : value;
}

/**
 * The console's alerts room, read fresh. svc-ops reads an evaluation once the ledger has held it for its settle window and its
 * next tick runs, so callers poll. The room must say it read the ledger: a failed read is never taken as "no alert".
 */
async function openAlerts(page) {
  await page.goto(`${ADMIN}/ledger/alerts`, { waitUntil: 'load' });
  const room = page.getByTestId('recon-alerts');
  await expect(room.getByTestId('alert-source')).toHaveAttribute('data-status', 'ok', { timeout: 30_000 });
  return room;
}

/** The alert rows of one control, as {id, asset, state, occurrences, periodStart, cause, team}, read from a fresh room. */
async function alertsOf(page, controlId) {
  const room = await openAlerts(page);
  return room.locator(`[data-testid="alert-row"][data-control-id="${controlId}"]`).evaluateAll((rows) =>
    rows.map((r) => ({
      id: r.getAttribute('data-alert-id'),
      asset: r.getAttribute('data-asset'),
      state: r.getAttribute('data-state'),
      occurrences: Number(r.getAttribute('data-occurrences')),
      periodStart: r.getAttribute('data-period-start'),
      cause: r.getAttribute('data-cause'),
      team: r.getAttribute('data-team'),
    })),
  );
}

/** Waits until svc-ops shows `want(rows)` true for a control's alerts, and returns those rows. */
async function awaitAlerts(page, controlId, want, message) {
  let rows = [];
  let lastError = null;
  const poll = expect
    .poll(
      async () => {
        // A ledger restart leaves svc-ops' read unavailable for a tick or two; that is retried, never read as "no alert".
        try {
          rows = await alertsOf(page, controlId);
          lastError = null;
        } catch (error) {
          lastError = error;
          return false;
        }
        return want(rows);
      },
      { message, timeout: 150_000, intervals: [5_000] },
    )
    .toBe(true);
  await poll.catch((error) => {
    if (lastError) error.message += `\nLast read of the alerts room: ${lastError.message}`;
    throw error;
  });
  return rows;
}

/** One alert's detail page, read fresh. */
async function openAlert(page, alertId) {
  await page.goto(`${ADMIN}/ledger/alerts/${alertId}`, { waitUntil: 'load' });
  const detail = page.getByTestId('alert-detail');
  await expect(detail).toBeVisible({ timeout: 30_000 });
  return detail;
}

/** One alert's detail: its resolve form refuses or resolves with these transaction ids; returns the detail page. */
async function resolveWith(page, alertId, txIds, note = '') {
  const detail = await openAlert(page, alertId);
  const form = detail.getByTestId('alert-resolve');
  await form.getByLabel('Corrective transaction ids').fill(txIds.join(', '));
  if (note) await form.getByLabel('Resolution note (optional)').fill(note);
  await form.getByTestId('alert-resolve-submit').click();
  return detail;
}

/** A resolve sent straight to the console's alerts route, as the resolve form sends it, at the version given. */
async function resolveDirect(page, alertId, version, txIds) {
  return page.evaluate(
    async ({ alertId, version, txIds }) => {
      const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
      const res = await fetch('/api/ledger-reconciliation/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
        body: JSON.stringify({ action: 'resolve', alertId, version, txIds }),
        cache: 'no-store',
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { alertId, version, txIds: txIds.join(', ') },
  );
}

/**
 * The accept desk's propose step sent straight to the console's route with the note as given, the way the desk sends it. The
 * desk holds its button for a note under 12 characters, so a blank note can only be shown refused this way.
 */
async function proposeAccept(page, alertId, evidenceHash, reason) {
  return page.evaluate(
    async ({ alertId, evidenceHash, reason, confirm }) => {
      const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
      const res = await fetch('/api/ledger-reconciliation/alerts/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
        body: JSON.stringify({
          step: 'propose',
          request: { kind: 'ops.reconciliation_alert.accept', alertId, evidenceHash, reason },
          confirm,
        }),
        cache: 'no-store',
      });
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        return { status: res.status, body: text };
      }
    },
    { alertId, evidenceHash, reason, confirm: `ACCEPT ALERT ${alertId.slice(0, 8)}` },
  );
}

/**
 * Delivers one `ledger.reconciliation_run.failed` envelope to the stack's bus twice, under two message ids so the stream keeps
 * both, as a redelivery after a lost acknowledgement reaches svc-ops. The stack's ledger raises this only when its platform
 * reconcile run cannot finish, which no TEST step can cause, so the journey sends a LOCAL TEST one (its run id says so).
 * Then it waits until svc-ops' durable consumer has acknowledged both messages, and returns the stream sequences and the
 * consumer's state, so the journey can show the second delivery was read and handled, not still in flight.
 */
function deliverRunFailedTwice(key) {
  const code = `
    import { connect } from 'nats';
    import { buildEnvelope, encodeEnvelope } from './dist/index.js';
    const env = buildEnvelope(
      'ledgerReconciliationRunFailed',
      { errorCode: 'ledger.reconcile_source_unavailable', phase: 'snapshot', consecutiveIncomplete: 1, runId: 'LOCAL TEST ' + process.env.EVENT_KEY },
      'ledger',
      { idempotencyKey: process.env.EVENT_KEY },
    );
    const nc = await connect({ servers: process.env.NATS_URL });
    const js = nc.jetstream();
    const acks = [];
    for (const n of [1, 2]) acks.push(await js.publish(env.subject, encodeEnvelope(env), { msgID: env.idempotencyKey + ':delivery:' + n }));
    const jsm = await nc.jetstreamManager();
    const seqs = acks.map((a) => a.seq);
    let info;
    for (let i = 0; i < 60; i++) {
      info = await jsm.consumers.info(acks[0].stream, 'ops-recon-run-failed');
      if (info.ack_floor.stream_seq >= Math.max(...seqs) && info.num_ack_pending === 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(JSON.stringify({ seqs, duplicate: acks.some((a) => a.duplicate), ackFloor: info.ack_floor.stream_seq, ackPending: info.num_ack_pending }));
    await nc.drain();`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.join(ROOT, 'packages', 'events'),
    env: { ...process.env, NATS_URL: 'nats://127.0.0.1:14232', EVENT_KEY: key },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`delivering the run-failed event twice failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test.describe.serial('J-ops-console-07 reconcile the books', () => {
  test('J-ops-console-07 #1 a control activated with a blank tolerance is refused with ops.control_policy_unset and stays draft', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const { a } = await founders(browser);
    const section = await openLedger(a);
    await expect(section.getByTestId('rc-row').filter({ hasText: 'Built-in' })).toHaveCount(3);
    await requireTreasury(section);

    state.thresholdId = await define(section, {
      template: 'threshold',
      explanation: `LOCAL TEST USDT floor ${tag}`,
      fill: async (form) => {
        await form.getByLabel('Threshold bound').selectOption('min');
        await form.getByLabel(/^Threshold by asset/).fill('USDT=0');
      },
    });
    await expect(row(section, state.thresholdId).getByTestId('rc-state')).toHaveText('Draft');

    // Activate with every policy value but the tolerance: svc-ledger refuses and the control stays a draft.
    await choose(section, state.thresholdId);
    const form = section.getByTestId('rc-form-update');
    await setPolicy(form, { tolerance: '' });
    await form.getByLabel(/^Why/).fill(`LOCAL TEST J-ops-console-07 activate ${tag}`);
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form.getByTestId('rc-save-refused')).toContainText('ops.control_policy_unset');
    await section.getByRole('button', { name: 'Refresh' }).click();
    await expect(row(section, state.thresholdId).getByTestId('rc-state')).toHaveText('Draft');
  });

  test('J-ops-console-07 #2 schedule (UTC), severity, tolerance and a dynamic account set: active, and built-ins cannot change', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    if (!state.thresholdId) throw new Error('step #1 left no control');
    const { a } = await founders(browser);
    const section = await openLedger(a);
    await choose(section, state.thresholdId);
    const form = section.getByTestId('rc-form-update');
    await setPolicy(form, { tolerance: '0' });
    await form.getByLabel(/^Why/).fill(`LOCAL TEST J-ops-console-07 activate ${tag}`);
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form.getByTestId('rc-saved')).toContainText('is active', { timeout: 30_000 });
    const active = row(section, state.thresholdId);
    await expect(active.getByTestId('rc-state')).toHaveText('Active');
    await expect(active).toContainText('Daily at 06:30 UTC');
    await expect(active).toContainText('warning');
    await expect(active).toContainText('Every account with asset USDT, matched at each run');

    // The three built-in controls offer no change form, only a run.
    const builtins = section.getByTestId('rc-row').filter({ hasText: 'Built-in' });
    for (const id of await builtins.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-control-id')))) {
      await choose(section, id);
      await expect(section.getByTestId('rc-builtin')).toBeVisible();
      await expect(section.getByTestId('rc-form-update')).toHaveCount(0);
    }
  });

  test('J-ops-console-07 #2 a new matching account is included on the next run', async ({ browser }) => {
    test.setTimeout(420_000);
    if (!state.thresholdId) throw new Error('step #1 left no control');
    await founders(browser);
    const before = accountsRead(await twoFounderRun(state.thresholdId));
    expect(before, 'the first run names how many accounts it read').toBeGreaterThanOrEqual(0);

    const who = { handle: `ops07${tag}`, email: `ops07-${tag}@local-test.invalid`, password: `Ops07-${tag}-Test!pass` };
    await signUpInBrowser(await (await browser.newContext({ baseURL: ORIGIN })).newPage(), who);
    fund(who.email, 'USDT', '1');

    const after = accountsRead(await twoFounderRun(state.thresholdId));
    expect(after, 'the new TEST customer’s USDT account joins the next run').toBeGreaterThan(before);
  });

  test('J-ops-console-07 #3 a run now stores its row and each source’s as-of; an outside-balance control with no snapshot shows unset', async ({
    browser,
  }) => {
    test.setTimeout(420_000);
    const { a } = await founders(browser);
    const section = await openLedger(a);
    await requireTreasury(section);
    state.outsideId = await define(section, {
      template: 'outside_balance',
      explanation: `LOCAL TEST USDT outside balance ${tag}`,
      fill: (form) => setPolicy(form, { tolerance: '0' }),
    });
    await expect(row(section, state.outsideId).getByTestId('rc-state')).toHaveText('Active');
    const answer = await twoFounderRun(state.outsideId);
    // No outside snapshot is configured for this control, so the run is UNSET, never a PASS or FAIL against nothing.
    expect(answer).toMatch(/Run [0-9a-f-]{36}: UNSET\./);
    expect(answer).toMatch(/Sources: ledger as of \d{4}-\d{2}-\d{2}T/);
    expect(answer).toContain('outside unset');
    expect(answer).toContain('Outside side: unset');
    // The run stored its row: re-read from a fresh page, it carries the same status and the ledger's as-of.
    const asOf = answer.match(/ledger as of (\d{4}-\d{2}-\d{2}T[^ ,;)]+)/)[1];
    const stored = await storedRun(a, state.outsideId, answer, 'UNSET');
    expect(stored).toContain('outside unset');
    expect(stored).toContain(asOf);
    state.outsideRuns.push({ id: runId(answer), status: 'UNSET' });
  });

  test('J-ops-console-07 #4 a past run reads at the instant minus the margin; blank margin, typed 0 and a future instant', async ({
    browser,
  }) => {
    test.setTimeout(420_000);
    if (!state.thresholdId) throw new Error('step #1 left no control');
    const { a } = await founders(browser);
    const section = await openLedger(a);
    await choose(section, state.thresholdId);
    const desk = section.getByTestId('rc-run');
    const past = new Date(Date.now() - 3_600_000);
    past.setUTCSeconds(0, 0);
    const typed = past.toISOString().slice(0, 16);

    // The control has no margin of its own: a blank margin is refused before anything is asked.
    await desk.getByLabel(/^At a past instant/).fill(typed);
    await expect(desk).toContainText('ops.control_margin_unset');
    await expect(desk.getByRole('button', { name: 'Ask a second founder to approve the run' })).toBeDisabled();
    // A future instant is refused the same way.
    await desk.getByLabel(/^At a past instant/).fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16));
    await desk.getByLabel(/^Margin in seconds/).fill('0');
    await expect(desk).toContainText('ledger.reconcile_asof_invalid');
    await expect(desk.getByRole('button', { name: 'Ask a second founder to approve the run' })).toBeDisabled();

    const withMargin = await twoFounderRun(state.thresholdId, { instant: typed, margin: '60' });
    expect(withMargin).toContain(
      `As of ${past.toISOString()}; balances read at ${new Date(past.getTime() - 60_000).toISOString()} (margin 60 s)`,
    );
    const zero = await twoFounderRun(state.thresholdId, { instant: typed, margin: '0' });
    expect(zero).toContain(`balances read at ${past.toISOString()} (margin 0 s)`);
  });

  test('J-ops-console-07 #5 a run evaluates PASS or FAIL with per-asset evidence, and an unreadable source is ERROR, never PASS', async ({
    browser,
  }) => {
    test.setTimeout(420_000);
    if (!state.thresholdId || !state.outsideId) throw new Error('steps #1 and #3 left no controls');
    const { a } = await founders(browser);

    // PASS: the USDT floor of 0 holds, so the difference is 0.
    const pass = await twoFounderRun(state.thresholdId);
    expect(pass).toMatch(/Run [0-9a-f-]{36}: PASS\./);
    const held = evidence(pass, 'USDT');
    expect(held.expected).toBe('0');
    expect(held.difference).toBe('0');
    expect(held.tolerance).toBe('0');
    expect(scaled(held.observed) >= 0n, 'the book holds no negative USDT total under a floor of 0').toBe(true);

    // FAIL: a floor far above the book. The difference is exactly observed minus expected.
    const section = await openLedger(a);
    const floorId = await define(section, {
      template: 'threshold',
      explanation: `LOCAL TEST USDT high floor ${tag}`,
      fill: async (form) => {
        await form.getByLabel('Threshold bound').selectOption('min');
        await form.getByLabel(/^Threshold by asset/).fill(`USDT=${HIGH_FLOOR}`);
        await setPolicy(form, { tolerance: '0' });
      },
    });
    try {
      await expect(row(section, floorId).getByTestId('rc-state')).toHaveText('Active');
      const fail = await twoFounderRun(floorId);
      expect(fail).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      const broken = evidence(fail, 'USDT');
      expect(broken.expected).toBe(HIGH_FLOOR);
      expect(broken.tolerance).toBe('0');
      expect(scaled(broken.difference)).toBe(scaled(broken.observed) - scaled(HIGH_FLOOR));
      expect(scaled(broken.difference) < 0n).toBe(true);
      // The person reads the evaluation: the stored row is FAIL with the same four figures.
      expect(evidence(await storedRun(a, floorId, fail, 'FAIL'), 'USDT'), 'the FAIL evidence is stored as shown').toEqual(broken);
    } finally {
      // Pause the TEST floor even when an assertion fails, so scheduled runs do not keep failing on it. Step #6 reads its alert
      // while paused, then retires it.
      await lifecycle(floorId, 'pause', 'Paused');
      state.floorId = floorId;
    }

    // ERROR: svc-ledger reads the outside side from an address nothing answers. The run is ERROR at the outside phase with
    // the source named unavailable and no evidence, never PASS. The ledger is put back in the finally (and by the hooks).
    try {
      ledgerOutside(true);
      const error = await twoFounderRun(state.outsideId);
      expect(error).toMatch(/Run [0-9a-f-]{36}: ERROR\./);
      expect(error).not.toMatch(/Run [0-9a-f-]{36}: PASS\./);
      expect(error).toContain('Outside side: unavailable.');
      expect(error).toContain('Error: ledger.reconcile_source_unavailable at outside.');
      expect(error).toContain('0 assets read.');
      state.outsideRuns.push({ id: runId(error), status: 'ERROR' });
      // Stored as ERROR, never PASS, with the same code and phase.
      expect(await storedRun(a, state.outsideId, error, 'ERROR')).toContain('ledger.reconcile_source_unavailable');
    } finally {
      ledgerOutside(false);
    }
  });

  test('J-ops-console-07 #5 the evidence is the ledger’s: one customer’s two assets at a past instant and now, stored as shown', async ({
    browser,
  }) => {
    test.setTimeout(600_000);
    const { a } = await founders(browser);
    // A fresh TEST customer is the whole account set, so every observed figure is known from outside the evaluator: the
    // amounts this step funds, and the customer's own balance as the ledger answers their balance read.
    const who = { handle: `ops07e${tag}`, email: `ops07e-${tag}@local-test.invalid`, password: `Ops07e-${tag}-Test!pass` };
    await signUpInBrowser(await (await browser.newContext({ baseURL: ORIGIN })).newPage(), who);
    const session = await api(who);
    expect(fund(who.email, 'USDT', '2.5').tx, 'the USDT credit is a booked ledger transaction').toMatch(/^[0-9a-f-]{36}$/);
    // The past instant is the next whole minute after the USDT credit and before the USDC one.
    const instant = new Date(Math.ceil((Date.now() + 1_000) / 60_000) * 60_000);
    await a.waitForTimeout(Math.max(0, instant.getTime() - Date.now()) + 2_000);
    expect(fund(who.email, 'USDC', '3').tx, 'the USDC credit is a booked ledger transaction').toMatch(/^[0-9a-f-]{36}$/);
    const balances = await session.balances();
    expect(scaled(balances.USDT?.total ?? 'unset'), 'the customer holds the USDT credited').toBe(scaled('2.5'));
    expect(scaled(balances.USDC?.total ?? 'unset'), 'the customer holds the USDC credited').toBe(scaled('3'));

    const section = await openLedger(a);
    await requireTreasury(section);
    const ownId = await define(section, {
      template: 'threshold',
      explanation: `LOCAL TEST one customer two assets ${tag}`,
      fill: async (form) => {
        await form.getByLabel('Asset', { exact: true }).fill('');
        await form.getByLabel('Owner type').selectOption('user');
        await form.getByLabel('Owner id starts with').fill(session.userId);
        await form.getByLabel('Threshold bound').selectOption('min');
        await form.getByLabel(/^Threshold by asset/).fill('USDC=0, USDT=0');
        await setPolicy(form, { tolerance: '0' });
      },
    });
    try {
      // At the past instant (margin 0) the ledger held the USDT credit and not yet the USDC one.
      const past = await twoFounderRun(ownId, { instant: instant.toISOString().slice(0, 16), margin: '0' });
      expect(past).toMatch(/Run [0-9a-f-]{36}: PASS\./);
      expect(past).toContain(`balances read at ${instant.toISOString()} (margin 0 s)`);
      expect(scaled(evidence(past, 'USDT').observed)).toBe(scaled('2.5'));
      expect(scaled(evidence(past, 'USDC').observed)).toBe(0n);

      // Now: both credits, each equal to the customer's balance as the ledger answers it.
      const now = await twoFounderRun(ownId);
      expect(now).toMatch(/Run [0-9a-f-]{36}: PASS\./);
      for (const [asset, total] of [
        ['USDT', '2.5'],
        ['USDC', '3'],
      ]) {
        const shown = evidence(now, asset);
        expect(scaled(shown.observed), `${asset} observed is the customer's ledger balance`).toBe(scaled(balances[asset].total));
        expect(scaled(shown.observed)).toBe(scaled(total));
        expect(shown.expected).toBe('0');
        // A threshold's difference is how far the balance falls past its bound: none, as each holding is over its floor.
        expect(scaled(shown.difference)).toBe(0n);
        expect(shown.tolerance).toBe('0');
      }

      // Both runs are stored as shown: a fresh read of the control's evaluations has each one's status and evidence.
      const again = await openLedger(a);
      await choose(again, ownId);
      const runs = again.getByTestId('rc-runs');
      await expect(runs.getByTestId('rc-runs-count')).toContainText('showing 2 of 2 evaluations', { timeout: 30_000 });
      for (const [answer, assets] of [
        [past, ['USDT', 'USDC']],
        [now, ['USDT', 'USDC']],
      ]) {
        const stored = runs.locator(`[data-testid="rc-run-row"][data-run-id="${runId(answer)}"]`);
        await expect(stored).toHaveAttribute('data-status', 'PASS');
        const text = (await stored.innerText()).replace(/\s+/g, ' ');
        for (const asset of assets)
          expect(evidence(text, asset), `${asset} evidence is stored as the run showed it`).toEqual(evidence(answer, asset));
      }
    } finally {
      await lifecycle(ownId, 'retire', 'Retired');
    }
  });

  /** The selected control's evaluations as its panel reads them back from svc-ledger: the total and the run ids shown. */
  async function evaluationsOf(section) {
    const runs = section.getByTestId('rc-runs');
    await expect(runs.getByTestId('rc-runs-count')).toContainText(/showing \d+ of \d+ evaluation/, { timeout: 30_000 });
    const total = Number((await runs.getByTestId('rc-runs-count').innerText()).match(/showing \d+ of (\d+)/)[1]);
    const ids = await runs.getByTestId('rc-run-row').evaluateAll((els) => els.map((el) => el.getAttribute('data-run-id')));
    return { total, ids };
  }

  test('J-ops-console-07 #6 pause needs two founders, a paused control runs nothing until resumed, and retired is final', async ({
    browser,
  }) => {
    test.setTimeout(420_000);
    if (!state.thresholdId || !state.outsideId) throw new Error('steps #1 and #3 left no controls');
    const { a } = await founders(browser);
    const section = await openLedger(a);
    await requireTreasury(section);

    // One founder alone cannot pause: A asks, then tries to approve their own packet. The approval service refuses with
    // its typed code and the control is still active when read again.
    await choose(section, state.thresholdId);
    const own = section.getByTestId('rc-lifecycle');
    await own.getByTestId('rc-lifecycle-move').selectOption('pause');
    const pausePhrase = `PAUSE CONTROL ${state.thresholdId.slice(0, 8)}`;
    await own.getByLabel(/^Why \(recorded with the step/).fill(`LOCAL TEST J-ops-console-07 pause alone ${tag}`);
    await own.getByLabel(/to confirm$/).fill(pausePhrase);
    await own.getByRole('button', { name: 'Ask a second founder to approve: pause' }).click();
    await expect(own.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
    // The workbench holds the button for the person who asked; the service refuses the same step sent anyway.
    await expect(own.getByRole('button', { name: 'Approve this request' })).toBeDisabled();
    const ownPacket = (await own.getByLabel('Request packet').inputValue()).trim();
    const alone = await consoleStep(a, '/api/ledger-reconciliation/lifecycle', ownPacket, 'approve', pausePhrase);
    expect(alone.body.ok, JSON.stringify(alone)).toBe(false);
    expect(alone.body.refusal?.code, JSON.stringify(alone)).toBe('action_approval.same_person');
    await section.getByRole('button', { name: 'Refresh' }).click();
    await expect(row(section, state.thresholdId).getByTestId('rc-state')).toHaveText('Active');

    // A run approved while active, then the control is paused with two founders: running that approval now is refused by
    // svc-ledger (ops.control_state_illegal), the control is still paused, and the run desk holds new requests.
    const early = await approvedRun(state.thresholdId);
    const paused = await lifecycle(state.thresholdId, 'pause', 'Paused');
    await choose(paused, state.thresholdId);
    const beforeRefused = await evaluationsOf(paused);
    const runDesk = paused.getByTestId('rc-run');
    await runDesk.getByLabel('Request packet').fill(early.packetText);
    await expect(runDesk.getByTestId('packet-summary')).toContainText(`Run reconciliation control ${state.thresholdId}`);
    expect(codeOf(await runApproved(runDesk, early.phrase)), 'the paused control refuses the run').toBe('ops.control_state_illegal');
    await paused.getByRole('button', { name: 'Refresh' }).click();
    await expect(row(paused, state.thresholdId).getByTestId('rc-state')).toHaveText('Paused');
    // The refused run recorded nothing: the control's evaluations, read back from svc-ledger, are the same as before it.
    await choose(paused, state.thresholdId);
    expect(await evaluationsOf(paused), 'a paused control runs nothing').toEqual(beforeRefused);
    const desk = paused.getByTestId('rc-run');
    await expect(desk).toContainText('A paused control runs nothing (ops.control_state_illegal). Resume it first.');
    await expect(desk.getByRole('button', { name: 'Ask a second founder to approve the run' })).toBeDisabled();
    await expect(paused.getByTestId('rc-lifecycle').getByRole('option', { name: 'Pause' })).toHaveCount(0);

    // Resume: active again, and a two-founder run goes through.
    const resumed = await lifecycle(state.thresholdId, 'resume', 'Active');
    const resumedRun = await twoFounderRun(state.thresholdId);
    expect(resumedRun).toMatch(/Run [0-9a-f-]{36}: PASS\./);
    await resumed.getByRole('button', { name: 'Refresh' }).click();
    await choose(resumed, state.thresholdId);
    const afterResume = await evaluationsOf(resumed);
    expect(afterResume.total, 'the resumed control’s run is its one new evaluation').toBe(beforeRefused.total + 1);
    expect(afterResume.ids[0]).toBe(runId(resumedRun));

    // Retire: final. No change form, no lifecycle step, the run desk holds, and the control stays in the list.
    const outsideSection = await openLedger(a);
    await choose(outsideSection, state.outsideId);
    const beforeRetire = await evaluationsOf(outsideSection);
    const again = await lifecycle(state.outsideId, 'retire', 'Retired');
    await expect(again.getByTestId('rc-retired')).toBeVisible();
    await expect(again.getByTestId('rc-form-update')).toHaveCount(0);
    await expect(again.getByTestId('rc-lifecycle-move')).toHaveCount(0);
    await expect(again.getByTestId('rc-lifecycle-why')).toHaveText(
      'A retired control has no pause, resume or retire step (ops.control_state_illegal).',
    );
    await expect(again.getByTestId('rc-run')).toContainText('A retired control runs nothing (ops.control_state_illegal).');
    await again.getByRole('button', { name: 'Refresh' }).click();
    await expect(row(again, state.outsideId).getByTestId('rc-state')).toHaveText('Retired');

    // A retired control keeps every evaluation readable: its evaluations panel lists each run once, newest first, with
    // the total read back, and holds both runs this journey made on it (#3, then the ERROR from #5).
    expect(state.outsideRuns, 'steps #3 and #5 each recorded their run').toHaveLength(2);
    expect(state.outsideRuns.map((r) => r.id).every(Boolean), 'steps #3 and #5 named their runs').toBe(true);
    await choose(again, state.outsideId);
    const runs = again.getByTestId('rc-runs');
    await expect(runs.getByTestId('rc-runs-count')).toContainText(/showing \d+ of \d+ evaluation/, { timeout: 30_000 });
    const [shown, total] = (await runs.getByTestId('rc-runs-count').innerText())
      .match(/showing (\d+) of (\d+)/)
      .slice(1)
      .map(Number);
    const rows = runs.getByTestId('rc-run-row');
    await expect(rows).toHaveCount(shown);
    expect(shown, 'every evaluation of the control is on the first page').toBe(total);
    const ids = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-run-id')));
    expect(new Set(ids).size, 'each evaluation appears exactly once').toBe(ids.length);
    // The hourly scheduler may add its own evaluations while the control is still active, so retiring is shown to keep
    // every evaluation listed before it (none dropped), not to keep the count fixed.
    expect(total, 'retiring dropped no evaluation').toBeGreaterThanOrEqual(beforeRetire.total);
    for (const id of beforeRetire.ids) expect(ids, `evaluation ${id} listed before the retire is still listed`).toContain(id);
    const [first, second] = state.outsideRuns;
    expect(ids.indexOf(second.id), 'the #5 ERROR run is listed').toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(first.id), 'the #3 run is listed').toBeGreaterThan(ids.indexOf(second.id));
    for (const r of state.outsideRuns) {
      const line = runs.locator(`[data-testid="rc-run-row"][data-run-id="${r.id}"]`);
      await expect(line).toHaveAttribute('data-status', r.status);
      await expect(line).toContainText(`Run ${r.id}: ${r.status}.`);
    }
    await expect(runs.locator(`[data-run-id="${second.id}"]`)).toContainText('Error: ledger.reconcile_source_unavailable at outside.');

    // A paused control keeps its alerts, and so does a retired one. A fresh TEST floor fails; its USDT alert and its
    // evaluations are read back from svc-ops and svc-ledger once it is paused, and again after it is retired.
    const keepId = await define(await openLedger(a), {
      template: 'threshold',
      explanation: `LOCAL TEST USDT floor kept ${tag}`,
      fill: async (form) => {
        await form.getByLabel('Threshold bound').selectOption('min');
        await form.getByLabel(/^Threshold by asset/).fill(`USDT=${HIGH_FLOOR}`);
        await setPolicy(form, { tolerance: '0' });
      },
    });
    let keepRetired = false;
    try {
      const fail = await twoFounderRun(keepId);
      expect(fail).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      const failed = evidence(fail, 'USDT');
      const [raised] = await awaitAlerts(
        a,
        keepId,
        (rows) => rows.length === 1 && rows[0].asset === 'USDT',
        'svc-ops raises exactly one USDT alert from the floor’s FAIL',
      );
      expect(raised.state).toBe('open');

      // Paused with two founders: the alert raised before the pause is still there, open, its count never lower, and the
      // FAIL run is still among the control's evaluations. (The hourly scheduler may have run it once more before the pause.)
      const pausedKeep = await lifecycle(keepId, 'pause', 'Paused');
      await choose(pausedKeep, keepId);
      const kept = await evaluationsOf(pausedKeep);
      expect(kept.ids, 'pausing kept the FAIL evaluation').toContain(runId(fail));
      const keptAlerts = await alertsOf(a, keepId);
      const keptAlert = keptAlerts.filter((row) => row.id === raised.id);
      expect(keptAlert, 'a paused control’s alert stays, once').toHaveLength(1);
      expect(keptAlert[0]).toMatchObject({ id: raised.id, asset: 'USDT', state: 'open', periodStart: raised.periodStart });
      expect(keptAlert[0].occurrences).toBeGreaterThanOrEqual(raised.occurrences);
      const detailOf = async () => {
        const detail = await openAlert(a, raised.id);
        return {
          state: await detail.getAttribute('data-state'),
          version: await detail.getAttribute('data-version'),
          occurrences: await detail.getAttribute('data-occurrences'),
          evidence: (await detail.getByTestId('alert-evidence').innerText()).replace(/\s+/g, ' '),
        };
      };
      const whilePaused = await detailOf();
      expect(whilePaused.evidence).toBe(
        `Observed ${failed.observed} · expected ${failed.expected} · difference ${failed.difference} · tolerance ${failed.tolerance}`,
      );

      // Retired: a paused control runs nothing, so its evaluations, its alert and the alert's detail read exactly as while paused.
      const retiredKeep = await lifecycle(keepId, 'retire', 'Retired');
      keepRetired = true;
      await choose(retiredKeep, keepId);
      expect(await evaluationsOf(retiredKeep), 'a retired control keeps every evaluation readable').toEqual(kept);
      expect(await alertsOf(a, keepId), 'a retired control keeps its alert, once and unchanged').toEqual(keptAlerts);
      expect(await detailOf(), 'the alert’s detail still reads, unchanged').toEqual(whilePaused);
    } finally {
      if (!keepRetired) await lifecycle(keepId, 'retire', 'Retired').catch(() => undefined);
    }
    // #5's paused TEST floor is retired too, so no scheduled run keeps failing on it.
    if (state.floorId) await lifecycle(state.floorId, 'retire', 'Retired');
  });

  test('J-ops-console-07 #7 a run that fails two assets opens two alerts; the same failure again raises the count, opens nothing new', async ({
    browser,
  }) => {
    test.setTimeout(600_000);
    const { a } = await founders(browser);
    const section = await openLedger(a);
    await requireTreasury(section);
    // Two floors no TEST book reaches, over the USDT account set: USDT fails on its total, USDC on a total of 0.
    state.pairId = await define(section, {
      template: 'threshold',
      explanation: `LOCAL TEST two-asset floor ${tag}`,
      fill: async (form) => {
        await form.getByLabel('Threshold bound').selectOption('min');
        await form.getByLabel(/^Threshold by asset/).fill(`USDC=${HIGH_FLOOR}, USDT=${HIGH_FLOOR}`);
        await setPolicy(form, { tolerance: '0' });
      },
    });
    try {
      await expect(row(section, state.pairId).getByTestId('rc-state')).toHaveText('Active');

      const first = await twoFounderRun(state.pairId);
      expect(first).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      expect(scaled(evidence(first, 'USDC').difference) < 0n).toBe(true);
      expect(scaled(evidence(first, 'USDT').difference) < 0n).toBe(true);

      // Two alerts, one per asset, in the same period, each counted once.
      const opened = await awaitAlerts(a, state.pairId, (rows) => rows.length >= 2, 'svc-ops opens the two-asset FAIL’s alerts');
      expect(opened.map((r) => r.asset).sort(), 'one alert per failing asset, each exactly once').toEqual(['USDC', 'USDT']);
      expect(new Set(opened.map((r) => r.periodStart)).size, 'both in the run’s one period').toBe(1);
      for (const r of opened) {
        expect(r.state).toBe('open');
        expect(r.occurrences).toBe(1);
      }

      // The same failure again: each alert's count rises to 2 and no third alert opens.
      const again = await twoFounderRun(state.pairId);
      expect(again).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      const repeated = await awaitAlerts(
        a,
        state.pairId,
        (rows) => rows.length > 2 || (rows.length === 2 && rows.every((r) => r.occurrences === 2)),
        'svc-ops counts the repeat on both alerts',
      );
      expect(repeated, 'the repeat opens nothing new').toHaveLength(2);
      expect(repeated.map((r) => r.id).sort()).toEqual(opened.map((r) => r.id).sort());
      expect(repeated.every((r) => r.periodStart === opened[0].periodStart)).toBe(true);
      const detail = await openAlert(a, opened[0].id);
      await expect(detail.getByTestId('timeline-entry')).toHaveCount(2);
      await expect(detail.locator('[data-testid="timeline-entry"][data-kind="opened"]')).toHaveCount(1);
      await expect(detail.locator('[data-testid="timeline-entry"][data-kind="repeated"]')).toHaveCount(1);
    } catch (err) {
      // #8 retires the pair; when this step fails first, retire it here so scheduled runs do not keep failing on it.
      await lifecycle(state.pairId, 'retire', 'Retired').catch(() => undefined);
      state.pairId = undefined;
      throw err;
    }
  });

  test('J-ops-console-07 #8 two founders acknowledge at once: one wins, the other sees it; snoozed notices stop while the count rises', async ({
    browser,
  }) => {
    test.setTimeout(600_000);
    if (!state.pairId || !state.thresholdId) throw new Error('steps #1 and #7 left no controls');
    const { a, b } = await founders(browser);
    try {
      const rows = await alertsOf(a, state.pairId);
      const usdt = rows.find((r) => r.asset === 'USDT');
      if (!usdt || usdt.state !== 'open') throw new Error(`step #7 left no open USDT alert: ${JSON.stringify(rows)}`);

      // Both founders open the alert at the same version and acknowledge with their own notes at once.
      const [detailA, detailB] = await Promise.all([openAlert(a, usdt.id), openAlert(b, usdt.id)]);
      const version = await detailA.getAttribute('data-version');
      await expect(detailB).toHaveAttribute('data-version', version);
      const notes = { a: `LOCAL TEST ack A ${tag}`, b: `LOCAL TEST ack B ${tag}` };
      await detailA.getByLabel('Acknowledgement note').fill(notes.a);
      await detailB.getByLabel('Acknowledgement note').fill(notes.b);
      await Promise.all([detailA.getByTestId('alert-ack').click(), detailB.getByTestId('alert-ack').click()]);
      for (const d of [detailA, detailB]) await expect(d).toHaveAttribute('data-state', 'acknowledged', { timeout: 30_000 });

      // Exactly one is refused with svc-ops's own code, and that founder's page shows the winner's acknowledgement.
      const refusedA = await detailA.getByTestId('alert-refused-code').count();
      const refusedB = await detailB.getByTestId('alert-refused-code').count();
      expect(refusedA + refusedB, 'one founder wins and the other is refused').toBe(1);
      const [winner, loser, winnerNote] = refusedA ? [detailB, detailA, notes.b] : [detailA, detailB, notes.a];
      await expect(loser.getByTestId('alert-refused-code')).toHaveText('ops.alert_state_illegal');
      await expect(winner.getByTestId('alert-acknowledged')).toContainText(winnerNote);
      const shownTo = await winner.getByTestId('alert-acknowledged').innerText();
      await expect(loser.getByTestId('alert-acknowledged')).toHaveText(shownTo);
      // The refusal names who acknowledged first, read back from the winner's record.
      const winnerBy = await winner.getByTestId('alert-acknowledged').getAttribute('data-by');
      expect(winnerBy, 'the acknowledgement names its founder').toBeTruthy();
      await expect(loser.getByTestId('alert-refused-detail')).toContainText(winnerBy);
      // Re-read after the refusal: one acknowledgement in the timeline, the winner's, and the version moved once.
      const reread = await openAlert(a, usdt.id);
      await expect(reread.locator('[data-testid="timeline-entry"][data-kind="acknowledged"]')).toHaveCount(1);
      await expect(reread.locator('[data-testid="timeline-entry"][data-kind="acknowledged"]')).toContainText(winnerNote);
      await expect(reread).toHaveAttribute('data-version', String(Number(version) + 1));

      // The period is still not green while an alert in it is acknowledged; a control whose every run passed is green.
      const room = await openAlerts(a);
      const pairPeriod = room.locator(
        `[data-testid="period-row"][data-control-id="${state.pairId}"][data-period-start="${usdt.periodStart}"]`,
      );
      await expect(pairPeriod).toHaveCount(1);
      await expect(pairPeriod).toHaveAttribute('data-green', 'false');
      const passing = room.locator(`[data-testid="period-row"][data-control-id="${state.thresholdId}"]`);
      expect(await passing.count(), 'the passing control has evaluated periods').toBeGreaterThan(0);
      for (const p of await passing.all()) {
        await expect(p).toHaveAttribute('data-status', 'PASS');
        await expect(p).toHaveAttribute('data-green', 'true');
      }

      // Snooze for an hour, then the same failure again: the alert counts it, its notice is "snoozed" and none is sent.
      const snoozing = await openAlert(a, usdt.id);
      const sentBefore = await snoozing.getByTestId('alert-notices').getAttribute('data-sent');
      const counted = Number(await snoozing.getAttribute('data-occurrences'));
      await snoozing.getByLabel(/^Snooze notices until/).fill(new Date(Date.now() + 3_600_000).toISOString());
      await snoozing.getByTestId('alert-snooze').click();
      await expect(snoozing).toHaveAttribute('data-snoozed', 'true', { timeout: 30_000 });
      await expect(snoozing.getByTestId('alert-refused')).toHaveCount(0);

      expect(await twoFounderRun(state.pairId)).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      await awaitAlerts(
        a,
        state.pairId,
        (now) => now.find((r) => r.id === usdt.id)?.occurrences === counted + 1,
        'svc-ops counts the failure during the snooze',
      );
      const muted = await openAlert(a, usdt.id);
      await expect(muted).toHaveAttribute('data-snoozed', 'true');
      await expect(muted.getByTestId('alert-notices')).toHaveAttribute('data-sent', sentBefore);
      await expect(muted.locator('[data-testid="timeline-entry"][data-kind="repeated"]').last()).toHaveAttribute('data-notice', 'snoozed');
    } finally {
      // Retire the TEST two-asset floor so scheduled runs do not keep failing on it.
      await lifecycle(state.pairId, 'retire', 'Retired');
    }
  });

  test('J-ops-console-07 #9 resolve as fixed names booked ledger transactions; accepting needs a note and two founders and freezes the evidence', async ({
    browser,
  }) => {
    test.setTimeout(900_000);
    const { a, b } = await founders(browser);
    const section = await openLedger(a);
    await requireTreasury(section);

    // A floor over every customer's USDT, set 5 above what the book holds now, so it fails until 5 USDT more is deposited.
    state.fixId = await define(section, {
      template: 'threshold',
      explanation: `LOCAL TEST customer USDT floor ${tag}`,
      fill: async (form) => {
        await form.getByLabel('Owner type').selectOption('user');
        await form.getByLabel('Threshold bound').selectOption('min');
        await form.getByLabel(/^Threshold by asset/).fill('USDT=0');
        await setPolicy(form, { tolerance: '0' });
      },
    });
    try {
      await expect(row(section, state.fixId).getByTestId('rc-state')).toHaveText('Active');
      const probe = await twoFounderRun(state.fixId);
      expect(probe).toMatch(/Run [0-9a-f-]{36}: PASS\./);
      const held = scaled(evidence(probe, 'USDT').observed);
      const floor = held + 5n * 10n ** 18n;
      const floorText = `${floor / 10n ** 18n}.${(floor % 10n ** 18n).toString().padStart(18, '0')}`.replace(/\.?0+$/, '');
      const update = await openLedger(a);
      await choose(update, state.fixId);
      const form = update.getByTestId('rc-form-update');
      await form.getByLabel(/^Threshold by asset/).fill(`USDT=${floorText}`);
      await form.getByLabel(/^Why/).fill(`LOCAL TEST J-ops-console-07 raise floor ${tag}`);
      await form.getByRole('button', { name: 'Save changes' }).click();
      await expect(form.getByTestId('rc-saved')).toBeVisible({ timeout: 30_000 });

      const fail = await twoFounderRun(state.fixId);
      expect(fail).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      expect(scaled(evidence(fail, 'USDT').difference)).toBe(held - floor);
      const [opened] = await awaitAlerts(a, state.fixId, (rows) => rows.length === 1, 'svc-ops opens the customer floor’s alert');
      expect(opened).toMatchObject({ asset: 'USDT', state: 'open', occurrences: 1, cause: 'fail', team: 'finance' });
      state.fixAlertId = opened.id;

      // A transaction id the ledger never booked is refused by name, and the alert stays open.
      const unknown = randomUUID();
      const beforeUnknown = await openAlert(a, opened.id);
      const openedAs = {
        version: await beforeUnknown.getAttribute('data-version'),
        occurrences: await beforeUnknown.getAttribute('data-occurrences'),
        evidence: await beforeUnknown.getByTestId('alert-evidence').innerText(),
      };
      const refused = await resolveWith(a, opened.id, [unknown]);
      await expect(refused.getByTestId('alert-refused-code')).toHaveText('ops.resolve_transaction_not_found', { timeout: 30_000 });
      await expect(refused.getByTestId('alert-refused-detail')).toContainText(unknown);
      const afterUnknown = await openAlert(a, opened.id);
      await expect(afterUnknown).toHaveAttribute('data-state', 'open');
      expect(
        {
          version: await afterUnknown.getAttribute('data-version'),
          occurrences: await afterUnknown.getAttribute('data-occurrences'),
          evidence: await afterUnknown.getByTestId('alert-evidence').innerText(),
        },
        'the refused resolve changed nothing on the alert',
      ).toEqual(openedAs);
      await expect(afterUnknown.getByTestId('alert-resolved')).toHaveCount(0);

      // The corrective booking: a TEST deposit of 2 USDT to a new customer, posted through the ledger's deposit recipe. (The
      // reversal desk that books a true reversal is J-ops-console-05, not on this stack; any booked transaction id is what svc-ops
      // checks.) 2 is short of the 5 the floor wants, so the next run fails again (#10).
      state.fixPayer = { handle: `ops07f${tag}`, email: `ops07f-${tag}@local-test.invalid`, password: `Ops07f-${tag}-Test!pass` };
      await signUpInBrowser(await (await browser.newContext({ baseURL: ORIGIN })).newPage(), state.fixPayer);
      const booked = fund(state.fixPayer.email, 'USDT', '2');
      expect(booked.tx, `the deposit names its ledger transaction: ${booked.out}`).toMatch(/^[0-9a-f-]{36}$/);
      const resolved = await resolveWith(a, opened.id, [booked.tx.toUpperCase()], `LOCAL TEST fixed by deposit ${tag}`);
      await expect(resolved).toHaveAttribute('data-state', 'resolved', { timeout: 30_000 });
      const record = resolved.getByTestId('alert-resolved');
      await expect(record).toHaveAttribute('data-resolution', 'fixed');
      await expect(record.getByTestId('alert-resolved-tx')).toHaveCount(1);
      await expect(record.getByTestId('alert-resolved-tx')).toHaveAttribute('data-tx-id', booked.tx.toLowerCase());
      const resolvedEntry = resolved.locator('[data-testid="timeline-entry"][data-kind="resolved"]');
      await expect(resolvedEntry).toHaveCount(1);
      await expect(resolvedEntry.getByTestId('timeline-tx')).toHaveAttribute('data-tx-id', booked.tx.toLowerCase());
      // A resolved alert offers no second resolution and no acceptance.
      await expect(resolved.getByTestId('alert-resolve-why')).toBeVisible();

      // Accept: a USDC floor over the USDT account set fails on a total of 0 at every run, the same figures each time.
      const desk = await openLedger(a);
      state.acceptId = await define(desk, {
        template: 'threshold',
        explanation: `LOCAL TEST USDC floor to accept ${tag}`,
        fill: async (f) => {
          await f.getByLabel('Threshold bound').selectOption('min');
          await f.getByLabel(/^Threshold by asset/).fill(`USDC=${HIGH_FLOOR}`);
          await setPolicy(f, { tolerance: '0' });
        },
      });
      expect(await twoFounderRun(state.acceptId)).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      const [toAccept] = await awaitAlerts(a, state.acceptId, (rows) => rows.length === 1, 'svc-ops opens the USDC floor’s alert');
      expect(toAccept).toMatchObject({ asset: 'USDC', state: 'open', cause: 'fail', team: 'finance' });
      const before = await openAlert(a, toAccept.id);
      const evidenceHash = (await before.getByTestId('alert-evidence-hash').innerText()).trim();
      expect(evidenceHash).toMatch(/^[0-9a-f]{64}$/);
      const evidenceText = await before.getByTestId('alert-evidence').innerText();

      // A blank note is refused before any approval is made.
      const blank = await proposeAccept(a, toAccept.id, evidenceHash, '');
      expect(blank.status, JSON.stringify(blank)).toBe(400);
      expect(blank.body.refusal?.code, JSON.stringify(blank)).toBe('ops.resolve_note_required');
      const openVersion = await before.getAttribute('data-version');
      const unchanged = async (why) => {
        const look = await openAlert(a, toAccept.id);
        await expect(look, why).toHaveAttribute('data-state', 'open');
        await expect(look, why).toHaveAttribute('data-version', openVersion);
        await expect(look.getByTestId('alert-evidence'), why).toHaveText(evidenceText);
        await expect(look.getByTestId('alert-accepted'), why).toHaveCount(0);
      };
      await unchanged('the blank-note refusal changed nothing on the alert');

      // A asks with a note; A approving their own packet is refused and the alert stays open.
      const phrase = `ACCEPT ALERT ${toAccept.id.slice(0, 8)}`;
      const accept = before.getByTestId('alert-accept');
      const acceptNote = `LOCAL TEST accepted discrepancy ${tag}`;
      await accept.getByLabel(/^Acceptance note/).fill(acceptNote);
      await accept.getByLabel(/to confirm$/).fill(phrase);
      await accept.getByRole('button', { name: 'Ask a second founder to approve the acceptance' }).click();
      await expect(accept.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
      const packetText = (await accept.getByLabel('Request packet').inputValue()).trim();
      const alone = await consoleStep(a, '/api/ledger-reconciliation/alerts/accept', packetText, 'approve', phrase);
      expect(alone.body.ok, JSON.stringify(alone)).toBe(false);
      expect(alone.body.refusal?.code, JSON.stringify(alone)).toBe('action_approval.same_person');
      await unchanged('the same-founder approval changed nothing on the alert');

      // B approves the same packet on their own console, then A runs it: accepted, at the hash both read.
      const approver = (await openAlert(b, toAccept.id)).getByTestId('alert-accept');
      await approver.getByLabel('Request packet').fill(packetText);
      await expect(approver.getByTestId('packet-summary')).toContainText(toAccept.id);
      await approver.getByLabel(/to approve or run it$/).fill(phrase);
      await approver.getByRole('button', { name: 'Approve this request' }).click();
      await expect(approver.getByTestId('step-reply')).toContainText('Approved.', { timeout: 30_000 });
      const runner = (await openAlert(a, toAccept.id)).getByTestId('alert-accept');
      await runner.getByLabel('Request packet').fill(packetText);
      await runner.getByLabel(/to approve or run it$/).fill(phrase);
      await runner.getByRole('button', { name: 'Run the approved request' }).click();
      await expect(runner.getByTestId('step-reply')).toContainText('The service answered', { timeout: 60_000 });

      const accepted = await openAlert(a, toAccept.id);
      await expect(accepted).toHaveAttribute('data-state', 'accepted');
      const stamp = accepted.getByTestId('alert-accepted');
      await expect(stamp).toHaveAttribute('data-evidence-hash', evidenceHash);
      const [by, approvedBy] = [await stamp.getAttribute('data-requested-by'), await stamp.getAttribute('data-approved-by')];
      expect(by && approvedBy && by !== approvedBy, `two different founders: ${by} and ${approvedBy}`).toBe(true);
      await expect(stamp, 'the note is stored with the acceptance').toContainText(`Note: ${acceptNote}`);
      await expect(accepted.getByTestId('alert-evidence')).toHaveText(evidenceText);
      await expect(accepted.locator('[data-testid="timeline-entry"][data-kind="accepted"]')).toHaveCount(1);
      const acceptedVersion = Number(await accepted.getAttribute('data-version'));
      // Frozen: a later resolve, even with a booked transaction id, is refused by its one code and changes nothing.
      const late = await resolveDirect(a, toAccept.id, acceptedVersion, [booked.tx]);
      expect(late.body?.code, JSON.stringify(late)).toBe('ops.alert_state_illegal');
      const reread = await openAlert(a, toAccept.id);
      await expect(reread).toHaveAttribute('data-state', 'accepted');
      await expect(reread).toHaveAttribute('data-version', String(acceptedVersion));
      await expect(reread.getByTestId('alert-accepted')).toHaveAttribute('data-evidence-hash', evidenceHash);
      await expect(reread.getByTestId('alert-evidence')).toHaveText(evidenceText);
      await expect(reread.getByTestId('alert-resolved')).toHaveCount(0);
      state.acceptAlert = {
        id: toAccept.id,
        evidenceHash,
        evidenceText,
        version: acceptedVersion,
        occurrences: Number(await accepted.getAttribute('data-occurrences')),
      };
    } catch (err) {
      // #10 retires these; when this step fails first, retire them here so scheduled runs do not keep failing on them.
      for (const id of [state.fixId, state.acceptId].filter(Boolean)) await lifecycle(id, 'retire', 'Retired').catch(() => undefined);
      state.fixId = state.acceptId = null;
      throw err;
    }
  });

  test('J-ops-console-07 #10 a repeat failure reopens, a passing run resolves, an ERROR run is a platform alert, and a run-failed event received twice is stored once', async ({
    browser,
  }) => {
    test.setTimeout(900_000);
    if (!state.fixId || !state.fixAlertId || !state.acceptId || !state.acceptAlert)
      throw new Error('#10 starts from #9’s resolved and accepted alerts, and #9 did not finish, so #10 cannot run');
    const { a } = await founders(browser);
    let errorId;
    try {
      // The same failure after the fix: the resolved alert reopens (no second alert), its count rises and the acknowledgement
      // and resolution are cleared on the alert while the timeline keeps them.
      expect(await twoFounderRun(state.fixId)).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      const reopened = await awaitAlerts(
        a,
        state.fixId,
        (rows) => rows.length > 1 || rows[0]?.occurrences === 2,
        'svc-ops reopens the resolved alert on the repeat failure',
      );
      expect(reopened, 'the repeat reopens the same alert, opening nothing new').toHaveLength(1);
      expect(reopened[0]).toMatchObject({ id: state.fixAlertId, state: 'open', occurrences: 2 });
      const reread = await openAlert(a, state.fixAlertId);
      await expect(reread.getByTestId('alert-resolved')).toHaveCount(0);
      const kinds = await reread.getByTestId('timeline-entry').evaluateAll((els) => els.map((el) => el.getAttribute('data-kind')));
      expect(kinds.filter((k) => k !== 'acknowledged' && k !== 'snoozed')).toEqual(
        expect.arrayContaining(['opened', 'resolved', 'reopened']),
      );
      expect(kinds.filter((k) => k === 'reopened')).toHaveLength(1);

      // The accepted alert is frozen: the same failure again changes nothing on it and opens no new alert.
      expect(await twoFounderRun(state.acceptId)).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      const fixedRun = await twoFounderRun(state.fixId);
      expect(fixedRun).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      // svc-ops reads evaluations in order: once the later fix-floor run is counted, the accept run before it was read too.
      await awaitAlerts(a, state.fixId, (rows) => rows[0]?.occurrences === 3, 'svc-ops counts the later run');
      const frozen = await alertsOf(a, state.acceptId);
      expect(frozen, 'no new alert beside the accepted one').toHaveLength(1);
      expect(frozen[0]).toMatchObject({ id: state.acceptAlert.id, state: 'accepted', occurrences: state.acceptAlert.occurrences });
      const still = await openAlert(a, state.acceptAlert.id);
      await expect(still.getByTestId('alert-accepted')).toHaveAttribute('data-evidence-hash', state.acceptAlert.evidenceHash);
      await expect(still.getByTestId('alert-evidence')).toHaveText(state.acceptAlert.evidenceText);
      await expect(still).toHaveAttribute('data-version', String(state.acceptAlert.version));

      // Different figures are a new discrepancy: the floor rises by 1, the next FAIL opens a new alert, and the accepted
      // one keeps its frozen evidence, count and version.
      const raise = await openLedger(a);
      await choose(raise, state.acceptId);
      const raiseForm = raise.getByTestId('rc-form-update');
      await raiseForm.getByLabel(/^Threshold by asset/).fill(`USDC=${BigInt(HIGH_FLOOR) + 1n}`);
      await raiseForm.getByLabel(/^Why/).fill(`LOCAL TEST J-ops-console-07 raise accepted floor ${tag}`);
      await raiseForm.getByRole('button', { name: 'Save changes' }).click();
      await expect(raiseForm.getByTestId('rc-saved')).toBeVisible({ timeout: 30_000 });
      const differs = await twoFounderRun(state.acceptId);
      expect(differs).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      const both = await awaitAlerts(a, state.acceptId, (rows) => rows.length === 2, 'svc-ops opens a new alert for different figures');
      const fresh = both.find((r) => r.id !== state.acceptAlert.id);
      const was = both.find((r) => r.id === state.acceptAlert.id);
      expect(fresh, 'the new alert is for the same asset and period, so only the figures differ').toMatchObject({
        asset: 'USDC',
        state: 'open',
        cause: 'fail',
        team: 'finance',
        periodStart: was.periodStart,
      });
      expect(both.find((r) => r.id === state.acceptAlert.id)).toMatchObject({
        state: 'accepted',
        occurrences: state.acceptAlert.occurrences,
      });
      const kept = await openAlert(a, state.acceptAlert.id);
      await expect(kept).toHaveAttribute('data-version', String(state.acceptAlert.version));
      await expect(kept.getByTestId('alert-accepted')).toHaveAttribute('data-evidence-hash', state.acceptAlert.evidenceHash);
      await expect(kept.getByTestId('alert-evidence')).toHaveText(state.acceptAlert.evidenceText);

      // The rest of the 5 USDT arrives: the next run passes and resolves the reopened alert by itself, naming that run.
      expect(fund(state.fixPayer.email, 'USDT', '3').tx, 'the rest is a booked ledger transaction').toMatch(/^[0-9a-f-]{36}$/);
      const pass = await twoFounderRun(state.fixId);
      expect(pass).toMatch(/Run [0-9a-f-]{36}: PASS\./);
      expect(evidence(pass, 'USDT').difference).toBe('0');
      await awaitAlerts(a, state.fixId, (rows) => rows[0]?.state === 'resolved', 'svc-ops resolves the alert on the passing run');
      const auto = (await openAlert(a, state.fixAlertId)).getByTestId('alert-resolved');
      await expect(auto).toHaveAttribute('data-resolution', 'auto');
      await expect(auto).toHaveAttribute('data-by', 'auto');
      await expect(auto).toHaveAttribute('data-passing-run-id', runId(pass));
      await expect(auto.getByTestId('alert-resolved-tx')).toHaveCount(0);

      // A run that cannot finish: an outside-balance control read from an address nothing answers is ERROR. svc-ops raises
      // one platform alert for it, never a finance alert, and it offers no resolve or accept.
      const section = await openLedger(a);
      errorId = await define(section, {
        template: 'outside_balance',
        explanation: `LOCAL TEST outside balance ERROR ${tag}`,
        fill: (f) => setPolicy(f, { tolerance: '0' }),
      });
      try {
        ledgerOutside(true);
        const errorRun = await twoFounderRun(errorId);
        expect(errorRun).toMatch(/Run [0-9a-f-]{36}: ERROR\./);
        expect(await storedRun(a, errorId, errorRun, 'ERROR')).toContain('ledger.reconcile_source_unavailable');
      } finally {
        ledgerOutside(false);
      }
      const [platform] = await awaitAlerts(a, errorId, (rows) => rows.length > 0, 'svc-ops raises the ERROR run’s alert');
      const errorRows = await alertsOf(a, errorId);
      expect(errorRows, 'one alert for the ERROR run, and no finance alert').toHaveLength(1);
      expect(platform).toMatchObject({ state: 'open', cause: 'error', team: 'platform', asset: '' });
      const errorDetail = await openAlert(a, platform.id);
      await expect(errorDetail).toHaveAttribute('data-team', 'platform');
      await expect(errorDetail.getByTestId('alert-team')).toHaveText('Platform team: the run could not finish');
      await expect(errorDetail.getByTestId('alert-error')).toHaveAttribute('data-code', 'ledger.reconcile_source_unavailable');
      await expect(errorDetail.getByTestId('alert-error')).toHaveAttribute('data-phase', 'outside');
      await expect(errorDetail.getByTestId('alert-resolve-submit')).toBeDisabled();
      const noAccept = errorDetail.getByTestId('alert-accept');
      await expect(noAccept.getByRole('button', { name: 'Ask a second founder to approve the acceptance' })).toBeDisabled();
      await expect(noAccept).toContainText('There is no discrepancy to fix or accept');

      // The ledger's own run-failed event, delivered twice: svc-ops, attached to the bus, stores it once.
      const eventKey = `ledger:reconciliation-run-failed:local-test-${tag}`;
      const delivered = deliverRunFailedTwice(eventKey);
      expect(delivered.seqs, 'the stream kept both deliveries').toHaveLength(2);
      expect(delivered.duplicate, 'neither delivery was dropped by the stream as a duplicate').toBe(false);
      // svc-ops' durable consumer acknowledged both: the second delivery was read and handled, not left in flight.
      expect(delivered.ackPending, JSON.stringify(delivered)).toBe(0);
      expect(delivered.ackFloor, JSON.stringify(delivered)).toBeGreaterThanOrEqual(Math.max(...delivered.seqs));
      let incidents;
      await expect
        .poll(
          async () => {
            const room = await openAlerts(a);
            incidents = room.getByTestId('platform-incidents');
            return incidents.locator(`[data-testid="platform-incident"][data-event-key="${eventKey}"]`).count();
          },
          { message: 'svc-ops stores the delivered run-failed event', timeout: 60_000, intervals: [3_000] },
        )
        .toBe(1);
      await expect(incidents).toHaveAttribute('data-bus', 'attached');
      // Both deliveries were handled, and the room shows one incident: the second was applied as the same incident.
      const later = (await openAlerts(a)).locator(`[data-testid="platform-incident"][data-event-key="${eventKey}"]`);
      await expect(later).toHaveCount(1);
      await expect(later).toHaveAttribute('data-error-code', 'ledger.reconcile_source_unavailable');
      await expect(later).toHaveAttribute('data-phase', 'snapshot');
    } finally {
      // Retire every TEST control this step and #9 made, so scheduled runs do not keep failing on them.
      for (const id of [state.fixId, state.acceptId, errorId].filter(Boolean))
        await lifecycle(id, 'retire', 'Retired').catch(() => undefined);
    }
  });
});

// The clause this stack cannot prove: the corrective transaction linked at #9 must be a reversal. A ledger reversal is booked
// only by J-ops-console-05's reversal desk (OPS-ledger-desk-02), which is not built, so #9 links a TEST deposit instead and
// this clause stays red, by name, until that desk books one here. It sits outside the serial journey so its red never
// skips #10.
test('J-ops-console-07 #9 the fix links a corrective reversal booked in the ledger', async () => {
  throw new Error(
    'Blocked: no reversal can be booked on this stack. J-ops-console-05 (OPS-ledger-desk-02) is not built, so #9 resolved with a TEST deposit, not a reversal.',
  );
});

// The other clause this stack cannot prove: svc-ops publishes each alert transition under its business key, but no service
// consumes the core-ops reconciliation_alert subjects yet, so "a transition event received twice applies once" has no
// receiver to show it. #10 shows svc-ops' own consumer of the ledger's run-failed event applying a double delivery once.
test('J-ops-console-07 #10 a transition event received twice applies once', async () => {
  throw new Error(
    'Blocked: no consumer of intafaced.core-ops.reconciliation_alert.* exists on this stack, so no receiver can be shown applying a transition event once.',
  );
});
