import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ORIGIN, fund, signUpInBrowser } from './stack.mjs';

// J-ops-console-07: reconcile the books on the founder console's /ledger page. Steps 1-4 (OPS-reconciliation-01): define a
// control, set its policy and dynamic account set, run it now with two founders, and run it at a past instant. Define, change
// and run travel on the console's treasury transport; a console without ADMIN_TREASURY_TOKEN shows them parked, and this
// journey stops there with that blocker named. Steps 5-6 (OPS-reconciliation-02): pause, resume and retire a control, and a
// PASS and a FAIL run with per-asset evidence. Steps 7-10 wait for OPS-reconciliation-03 and -04 and refuse at once.

const tag = randomUUID().slice(0, 8);
const state = { a: null, b: null, thresholdId: null, outsideId: null };

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
 * Founder A asks for a run, founder B approves the packet on their own console, and A runs it. Returns the service's answer
 * as shown on A's desk.
 */
async function twoFounderRun(controlId, { instant = '', margin = '' } = {}) {
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

  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  const reply = desk.getByTestId('step-reply');
  await expect(reply).toContainText('The service answered', { timeout: 60_000 });
  return (await reply.innerText()).replace(/\s+/g, ' ');
}

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

  test('J-ops-console-07 #5 pause, resume and retire: a paused control runs nothing until resumed; retired is final', async ({
    browser,
  }) => {
    test.setTimeout(420_000);
    if (!state.thresholdId || !state.outsideId) throw new Error('steps #1 and #3 left no controls');
    const { a } = await founders(browser);
    const section = await openLedger(a);
    await requireTreasury(section);

    // Pause, approved by a second founder: the state reads Paused and the run desk holds, naming the service's refusal code.
    const paused = await lifecycle(state.thresholdId, 'pause', 'Paused');
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
  });

  test('J-ops-console-07 #6 a run evaluates PASS or FAIL with per-asset evidence: observed, expected, difference and tolerance', async ({
    browser,
  }) => {
    test.setTimeout(420_000);
    if (!state.thresholdId) throw new Error('step #1 left no control');
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
      // Retire the TEST floor even when an assertion fails, so scheduled runs do not keep failing on it.
      await lifecycle(floorId, 'retire', 'Retired');
    }
  });

  for (const [n, slice] of [
    [7, 'OPS-reconciliation-03'],
    [8, 'OPS-reconciliation-03'],
    [9, 'OPS-reconciliation-04'],
    [10, 'OPS-reconciliation-04'],
  ])
    test(`J-ops-console-07 #${n} waits for ${slice}`, () => {
      throw new Error(`step #${n} is not built yet: ${slice}`);
    });
});
