import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ORIGIN, fund, journeyState, signUpInBrowser, tool } from './stack.mjs';

// J-ops-console-07: reconcile the books on the founder console's /ledger page. Steps 1-4 (OPS-reconciliation-01): define a
// control, set its policy and dynamic account set, run it now with two founders, and run it at a past instant. Define, change
// and run travel on the console's treasury transport; a console without ADMIN_TREASURY_TOKEN shows them parked, and this
// journey stops there with that blocker named. Steps 5-6 (OPS-reconciliation-02): a PASS, a FAIL and an ERROR run with
// per-asset evidence, and pause, resume and retire a control. Steps 7-8 (OPS-reconciliation-03): svc-ops raises one alert per
// control, failing asset and period from the ledger's settled evaluations, on the console's /ledger/alerts room. Steps 9-10
// wait for OPS-reconciliation-04 and refuse at once.

const tag = randomUUID().slice(0, 8);
const state = { a: null, b: null, thresholdId: null, outsideId: null, outsideRuns: [], floorId: null, pairId: null };
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
  const m = new RegExp(`${assetId}: observed ${num}, expected ${num}, difference ${num}, tolerance ${num}\\.`).exec(answer);
  if (!m) throw new Error(`the run shows no ${assetId} evidence: ${answer}`);
  return { observed: m[1], expected: m[2], difference: m[3], tolerance: m[4] };
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

/** The alert rows of one control, as {id, asset, state, occurrences, periodStart}, read from a fresh room. */
async function alertsOf(page, controlId) {
  const room = await openAlerts(page);
  return room.locator(`[data-testid="alert-row"][data-control-id="${controlId}"]`).evaluateAll((rows) =>
    rows.map((r) => ({
      id: r.getAttribute('data-alert-id'),
      asset: r.getAttribute('data-asset'),
      state: r.getAttribute('data-state'),
      occurrences: Number(r.getAttribute('data-occurrences')),
      periodStart: r.getAttribute('data-period-start'),
    })),
  );
}

/** Waits until svc-ops shows `want(rows)` true for a control's alerts, and returns those rows. */
async function awaitAlerts(page, controlId, want, message) {
  let rows = [];
  await expect
    .poll(
      async () => {
        rows = await alertsOf(page, controlId);
        return want(rows);
      },
      { message, timeout: 150_000, intervals: [5_000] },
    )
    .toBe(true);
  return rows;
}

/** One alert's detail page, read fresh. */
async function openAlert(page, alertId) {
  await page.goto(`${ADMIN}/ledger/alerts/${alertId}`, { waitUntil: 'load' });
  const detail = page.getByTestId('alert-detail');
  await expect(detail).toBeVisible({ timeout: 30_000 });
  return detail;
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
    expect(answer).toMatch(/Run [0-9a-f-]{36}: (PASS|FAIL|ERROR|UNSET)\./);
    expect(answer).toMatch(/Sources: ledger as of \d{4}-\d{2}-\d{2}T/);
    expect(answer).toContain('outside unset');
    expect(answer).toContain('Outside side: unset');
    state.outsideRuns.push({ id: runId(answer), status: answer.match(/Run [0-9a-f-]{36}: (\w+)\./)[1] });
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
    } finally {
      ledgerOutside(false);
    }
  });

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
    const runDesk = paused.getByTestId('rc-run');
    await runDesk.getByLabel('Request packet').fill(early.packetText);
    await expect(runDesk.getByTestId('packet-summary')).toContainText(`Run reconciliation control ${state.thresholdId}`);
    expect(await runApproved(runDesk, early.phrase)).toContain('Code: ops.control_state_illegal');
    await paused.getByRole('button', { name: 'Refresh' }).click();
    await expect(row(paused, state.thresholdId).getByTestId('rc-state')).toHaveText('Paused');
    const desk = paused.getByTestId('rc-run');
    await expect(desk).toContainText('A paused control runs nothing (ops.control_state_illegal). Resume it first.');
    await expect(desk.getByRole('button', { name: 'Ask a second founder to approve the run' })).toBeDisabled();
    await expect(paused.getByTestId('rc-lifecycle').getByRole('option', { name: 'Pause' })).toHaveCount(0);

    // Resume: active again, and a two-founder run goes through.
    await lifecycle(state.thresholdId, 'resume', 'Active');
    expect(await twoFounderRun(state.thresholdId)).toMatch(/Run [0-9a-f-]{36}: PASS\./);

    // Retire: final. No change form, no lifecycle step, the run desk holds, and the control stays in the list.
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
    const [first, second] = state.outsideRuns;
    expect(ids.indexOf(second.id), 'the #5 ERROR run is listed').toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(first.id), 'the #3 run is listed').toBeGreaterThan(ids.indexOf(second.id));
    for (const r of state.outsideRuns) {
      const line = runs.locator(`[data-testid="rc-run-row"][data-run-id="${r.id}"]`);
      await expect(line).toHaveAttribute('data-status', r.status);
      await expect(line).toContainText(`Run ${r.id}: ${r.status}.`);
    }
    await expect(runs.locator(`[data-run-id="${second.id}"]`)).toContainText('Error: ledger.reconcile_source_unavailable at outside.');

    // A paused control keeps its alerts, and so does a retired one: #5's FAIL raised one USDT alert on the floor control,
    // which #5 paused. It is listed once while paused, then the floor is retired with two founders and the same alert is
    // still listed and its detail still reads, with the same count and evidence.
    if (!state.floorId) throw new Error('step #5 left no paused floor control');
    const [raised] = await awaitAlerts(
      a,
      state.floorId,
      (rows) => rows.length === 1 && rows[0].asset === 'USDT',
      'svc-ops raises exactly one USDT alert from the floor control’s FAIL',
    );
    const floorPaused = await openLedger(a);
    await expect(row(floorPaused, state.floorId).getByTestId('rc-state')).toHaveText('Paused');
    const pausedDetail = await openAlert(a, raised.id);
    await expect(pausedDetail).toHaveAttribute('data-occurrences', String(raised.occurrences));
    await expect(pausedDetail.getByTestId('alert-evidence')).toContainText(`expected ${HIGH_FLOOR}`);
    const evidenceText = await pausedDetail.getByTestId('alert-evidence').innerText();

    await lifecycle(state.floorId, 'retire', 'Retired');
    const kept = await alertsOf(a, state.floorId);
    expect(kept, 'the retired control still lists its alert, once and unchanged').toEqual([raised]);
    const retiredDetail = await openAlert(a, raised.id);
    await expect(retiredDetail).toHaveAttribute('data-occurrences', String(raised.occurrences));
    await expect(retiredDetail.getByTestId('alert-evidence')).toHaveText(evidenceText);
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

  for (const [n, slice] of [
    [9, 'OPS-reconciliation-04'],
    [10, 'OPS-reconciliation-04'],
  ])
    test(`J-ops-console-07 #${n} waits for ${slice}`, () => {
      throw new Error(`step #${n} is not built yet: ${slice}`);
    });
});
