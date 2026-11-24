// World: stack, restart
import { expect, test } from './journey.mjs';
import { randomUUID } from 'node:crypto';
import { stackUrl, toolAwaited } from './stack.mjs';
import { venueRecord } from './venue.mjs';
import { closedMinute, MINUTE, utcMinuteOf } from './clock.mjs';
import {
  alertsOf,
  awaitAlerts,
  choose,
  consolePropose,
  consoleStep,
  createReconDesk,
  evidence,
  HIGH_FLOOR,
  ledgerOutside,
  openAlert,
  openAlerts,
  openLedger,
  putOutsideBack,
  requireTreasury,
  row,
  runApproved,
  runId,
  scaled,
  setPolicy,
  storedRun,
} from './recon-controls.mjs';

// J-ops-console-07: reconcile the books on the founder console's /ledger page. Steps 1-4 (OPS-reconciliation-01): define a
// control, set its policy and dynamic account set, run it now with two founders, and run it at a past instant. Define, change
// and run travel on the console's treasury transport; a console without ADMIN_TREASURY_TOKEN shows them parked, and this
// journey stops there with that blocker named. Steps 5-6 (OPS-reconciliation-02): a PASS, a FAIL and an ERROR run with
// per-asset evidence, and pause, resume and retire a control. Steps 7-8 (OPS-reconciliation-03): svc-ops raises one alert per
// control, failing asset and period from the ledger's settled evaluations, on the console's /ledger/alerts room. Steps 9-10
// (OPS-reconciliation-04) run in J-ops-console-07-resolve.pw.mjs with their own founder sign-in.

const tag = randomUUID().slice(0, 8);
const { founders, pages, define, approvedRun, twoFounderRun, lifecycle } = createReconDesk(tag);
const state = {
  thresholdId: null,
  outsideId: null,
  outsideRuns: [],
  floorId: null,
  pairId: null,
};
/** The TEST venue and TEST partner report stand-in on loopback (`local-test-rail-statements.mjs`), read directly via `venueRecord`. */
const OWN_REPORTS = stackUrl('rail-statements');

/** Reads one TEST venue's or TEST partner's own report for `place` at `asOf` directly from loopback, never through our app. */
async function ownReportRecord(reporter, place, asOf) {
  return (await venueRecord(place, '/report', { reporter, asOf }, OWN_REPORTS)).value;
}

/** Seeds one of INTAFACED's own TEST obligations: writes the reporter's line first, then books our ledger record through its recipe. */
function seedOwnRecord(reporter, place, asset, amount, ref) {
  return toolAwaited('local-test-stack.mjs', 'seed-own-record', reporter, place, asset, amount, '--ref', ref);
}

/** Arms a one-shot loopback hold on `GET /report` for one reporter and place, so a test can observe the `started` run row mid-read. */
async function holdReport(reporter, place) {
  const res = await fetch(`${OWN_REPORTS}/test/hold-report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reporter, place }),
  });
  expect(res.status, `arming report hold for ${reporter}:${place}`).toBe(200);
}

/** Reads whether svc-ledger's `GET /report` has reached the loopback hold yet. */
async function readReportHold(reporter, place) {
  const res = await fetch(`${OWN_REPORTS}/test/hold-report?reporter=${encodeURIComponent(reporter)}&place=${encodeURIComponent(place)}`);
  expect(res.status, `reading report hold for ${reporter}:${place}`).toBe(200);
  return res.json();
}

/** Releases a loopback hold on `GET /report` so svc-ledger's in-flight read answers normally. */
async function releaseReport(reporter, place) {
  const res = await fetch(`${OWN_REPORTS}/test/release-report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reporter, place }),
  });
  expect(res.status, `releasing report hold for ${reporter}:${place}`).toBe(200);
}

/**
 * A past run asked of svc-ledger through the console's own run route with the desk's hold left out: founder A proposes the
 * exact control, instant, margin (`unset` for blank) and reason, founder B approves it, and A runs it. Returns the console's
 * answer to the run step, or to the first step that refused.
 */
async function serviceRun(controlId, asOf, margin) {
  const { a, b } = pages();
  const endpoint = '/api/ledger-reconciliation/run';
  const version = String((await controlsOf(a)).find((c) => c.id === controlId)?.version);
  const request = {
    kind: 'ledger.reconciliation_control.run',
    controlId,
    version,
    asOf,
    margin,
    reason: `LOCAL TEST J-ops-console-07 run ${tag}`,
  };
  const phrase = `RUN CONTROL ${controlId.slice(0, 8)}`;
  const proposed = (await consolePropose(a, endpoint, request, phrase)).body;
  if (!proposed?.ok) return proposed;
  const approved = (await consoleStep(b, endpoint, proposed.packet, 'approve', phrase)).body;
  if (!approved?.ok) return approved;
  return (await consoleStep(a, endpoint, proposed.packet, 'execute', phrase)).body;
}

/** The console's control list, as { status, body }; a refusal keeps its code in the body. */
const readControls = (page) =>
  page.evaluate(async () => {
    const res = await fetch('/api/ledger-reconciliation', { cache: 'no-store' });
    return { status: res.status, body: await res.json().catch(() => null) };
  });

/** The control list, or a failure naming the console's status and code when it refuses. */
async function controlsOf(page) {
  const read = await readControls(page);
  const code = read.body?.upstream ?? read.body?.code ?? null;
  expect(read.status, `the console's control list refused: ${read.status} ${code}`).toBe(200);
  expect(Array.isArray(read.body?.controls), `the control list answered no controls array (${code})`).toBe(true);
  return read.body.controls;
}

/** The one typed code a desk reply names, or null. */
const codeOf = (reply) => reply.match(/Code: ([a-z0-9_.]+)/)?.[1] ?? null;

// A step that fails or times out never reaches its own finally, so the hooks put the ledger back before the next step.
test.beforeAll(putOutsideBack);
test.afterEach(putOutsideBack);

const accountsRead = (answer) => Number(/(\d+) accounts? and/.exec(answer)?.[1] ?? NaN);

/**
 * Waits until the minute now falls in has closed, and returns its end: a whole past instant the run desk can type, after
 * everything done so far and before anything done next.
 */
async function nextMinute(page) {
  return new Date((await closedMinute(page, new Date())) + MINUTE);
}

/** An instant as the desk's "At a past instant" field takes it (minutes, UTC). */
const minuteText = (instant) => utcMinuteOf(instant);

test.describe.serial('J-ops-console-07 reconcile the books', () => {
  test('J-ops-console-07 #1 a control activated with a blank tolerance is refused with ops.control_policy_unset and stays draft', async ({
    browser,
    stepPicture,
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
    await expect(form.getByTestId('rc-save-refused')).toContainText('ops.control_policy_unset');
    await stepPicture(a);
  });

  test('J-ops-console-07 #2 schedule (UTC), severity, tolerance and a dynamic account set: active, and built-ins cannot change', async ({
    browser,
    stepPicture,
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

    // The three built-in controls offer no change form and cannot be removed: no pause or retire step is offered, the
    // lifecycle desk names the ledger's code and its request button stays off; only a run is left.
    const builtins = section.getByTestId('rc-row').filter({ hasText: 'Built-in' });
    await expect(builtins).toHaveCount(3);
    const builtinIds = await builtins.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-control-id')));
    for (const id of builtinIds) {
      await choose(section, id);
      await expect(section.getByTestId('rc-builtin')).toContainText('cannot be changed or removed');
      await expect(section.getByTestId('rc-form-update')).toHaveCount(0);
      const desk = section.getByTestId('rc-lifecycle');
      await expect(desk.getByTestId('rc-lifecycle-move')).toHaveCount(0);
      await expect(desk.getByTestId('rc-lifecycle-why')).toHaveText(
        'A built-in control cannot be paused or retired (ledger.reconcile_builtin_immutable).',
      );
      const live = await desk
        .locator('button')
        .evaluateAll((all) =>
          all.filter((b) => !b.disabled && /ask a second founder|retire|pause/i.test(b.textContent)).map((b) => b.textContent.trim()),
        );
      expect(live, `built-in ${id}: no retire or pause request can be sent from the desk`).toEqual([]);
    }

    // A retire sent anyway, with two founders, is refused by the ledger with its code, and the control stays as it was.
    await requireTreasury(section);
    const { b } = await founders(browser);
    const target = builtinIds[0];
    const control = (await controlsOf(a)).find((c) => c.id === target);
    expect(control, `built-in ${target} is in the console's list`).toMatchObject({ builtin: true });
    const retire = {
      kind: 'ledger.reconciliation_control.lifecycle',
      controlId: target,
      version: String(control.version),
      lifecycle: 'retire',
      reason: `LOCAL TEST J-ops-console-07 retire a built-in ${tag}`,
    };
    const endpoint = '/api/ledger-reconciliation/lifecycle';
    const retirePhrase = `RETIRE CONTROL ${target.slice(0, 8)}`;
    // Whichever step the guard stops it at, the answer is the ledger's code; nothing moves.
    let refused = (await consolePropose(a, endpoint, retire, retirePhrase)).body;
    if (refused?.ok) {
      const packetText = refused.packet;
      refused = (await consoleStep(b, endpoint, packetText, 'approve', retirePhrase)).body;
      if (refused?.ok) refused = (await consoleStep(a, endpoint, packetText, 'execute', retirePhrase)).body;
    }
    expect(refused, JSON.stringify(refused).slice(0, 400)).toMatchObject({
      ok: false,
      refusal: { code: 'ledger.reconcile_builtin_immutable' },
    });
    expect((await controlsOf(a)).find((c) => c.id === target)).toMatchObject({
      builtin: true,
      state: control.state,
      version: control.version,
    });
    await stepPicture(a);
  });

  test('J-ops-console-07 #2 a new matching account is included on the next run', async ({ browser, stepPicture }) => {
    test.setTimeout(420_000);
    if (!state.thresholdId) throw new Error('step #1 left no control');
    const { a } = await founders(browser);
    const before = accountsRead(await twoFounderRun(state.thresholdId));
    expect(before, 'the first run names how many accounts it read').toBeGreaterThanOrEqual(0);

    // A new TEST venue builder-fee obligation creates a new matching USDT account on INTAFACED's own books (no customer account).
    const venue = `ltv2-${tag}`;
    await seedOwnRecord('venue', venue, 'USDT', '1', `ops07s2-${tag}`);
    const reported = await ownReportRecord('venue', venue, new Date().toISOString());
    expect(reported.balances).toEqual([{ assetId: 'USDT', amount: '-1' }]);

    const after = accountsRead(await twoFounderRun(state.thresholdId));
    expect(after, 'the new TEST venue receivable USDT account joins the next run').toBeGreaterThan(before);
    await stepPicture(a);
  });

  test('J-ops-console-07 #3 a run now commits its result row before reads begin, stores each source’s as-of, and an outside-balance control with no snapshot shows unset', async ({
    browser,
    stepPicture,
  }) => {
    test.setTimeout(540_000);
    const { a, b } = await founders(browser);
    const section = await openLedger(a);
    await requireTreasury(section);

    // 1. A result row exists before reads finish and stores every source's as-of time: hold the TEST venue's report reply on
    //    loopback, observe the committed `started` row on /ledger while svc-ledger is mid-read, then release and verify the
    //    exact same run id finishes PASS with both the ledger's as-of and the venue report's as-of stored.
    const s3Venue = `ltv3-${tag}`;
    await seedOwnRecord('venue', s3Venue, 'USDT', '4', `ops07s3-${tag}`);
    const venueReport = await ownReportRecord('venue', s3Venue, new Date().toISOString());
    expect(venueReport.asOf, 'the TEST venue report carries its own as-of').toBeTruthy();
    expect(venueReport.balances).toEqual([{ assetId: 'USDT', amount: '-4' }]);

    const reportsId = await define(section, {
      template: 'outside_balance',
      explanation: `LOCAL TEST venue run now ${tag}`,
      fill: async (form) => {
        await form.getByLabel('Venue report (venue id)', { exact: true }).fill(s3Venue);
        await setPolicy(form, { tolerance: '0' });
      },
    });
    try {
      const { desk, phrase } = await approvedRun(reportsId);
      const sectionB = await openLedger(b);
      await choose(sectionB, reportsId);

      let running = null;
      let startedId = null;
      await holdReport('venue', s3Venue);
      try {
        running = runApproved(desk, phrase);
        await expect
          .poll(async () => (await readReportHold('venue', s3Venue)).arrived, {
            message: 'svc-ledger calls the TEST venue report while the run is in flight',
            timeout: 20_000,
            intervals: [100],
          })
          .toBe(true);

        const runsB = sectionB.getByTestId('rc-runs');
        await runsB.getByRole('button', { name: 'Reload evaluations', exact: true }).click();
        const startedRow = runsB.locator('[data-testid="rc-run-row"][data-status="started"]');
        await expect(startedRow, 'the started result row is already stored while the outside read is held').toHaveCount(1, {
          timeout: 4_000,
        });
        startedId = await startedRow.getAttribute('data-run-id');
        expect(startedId, 'the started row carries a run id').toMatch(/^[0-9a-f-]{36}$/);
      } finally {
        await releaseReport('venue', s3Venue).catch(() => undefined);
      }

      const reportsAnswer = await running;
      expect(runId(reportsAnswer), 'the finished run is the same row committed as started').toBe(startedId);
      expect(reportsAnswer).toContain(`Run ${startedId}: PASS.`);
      expect(reportsAnswer).toMatch(/Sources: ledger as of \d{4}-\d{2}-\d{2}T[0-9:.]+Z;/);
      expect(reportsAnswer).toContain(`Venue ${s3Venue} report: as of ${venueReport.asOf}.`);
      expect(reportsAnswer).toContain(`venue ${s3Venue} USDT: observed -4, expected -4, difference 0, tolerance 0.`);
      const storedPass = await storedRun(a, reportsId, reportsAnswer, 'PASS');
      expect(storedPass).toMatch(/Sources: ledger as of \d{4}-\d{2}-\d{2}T[0-9:.]+Z;/);
      expect(storedPass).toContain(`Venue ${s3Venue} report: as of ${venueReport.asOf}.`);
    } finally {
      await lifecycle(reportsId, 'retire', 'Retired').catch(() => undefined);
    }

    // 2. An outside-balance control with no snapshot (no reports, no rail, no outside snapshot URL) shows its outside side unset.
    const freshSection = await openLedger(a);
    state.outsideId = await define(freshSection, {
      template: 'outside_balance',
      explanation: `LOCAL TEST USDT outside balance ${tag}`,
      fill: (form) => setPolicy(form, { tolerance: '0' }),
    });
    await expect(row(freshSection, state.outsideId).getByTestId('rc-state')).toHaveText('Active');
    const answer = await twoFounderRun(state.outsideId);
    // The stack's ledger serves no outside snapshot for this control, so the run is UNSET, never a PASS or FAIL against nothing.
    expect(answer).toMatch(/Run [0-9a-f-]{36}: UNSET\./);
    const sources = answer.match(
      /Sources: ledger as of (\d{4}-\d{2}-\d{2}T[0-9:.]+Z); outside unset; parity unset\. Outside side: unset\./,
    );
    expect(sources, 'the run names the ledger as-of, and the outside and parity sources as unset').not.toBeNull();
    state.outsideRuns.push({ id: runId(answer), status: 'UNSET' });
    // The run stored its row: re-read from a fresh page, it carries the same status and the same sources line.
    const stored = await storedRun(a, state.outsideId, answer, 'UNSET');
    expect(stored).toContain(sources[0]);
    await stepPicture(a);
  });

  test('J-ops-console-07 #4 a past run reads our records at the instant minus the margin against the venue and partner reports for that instant; not reported is never a match; blank margin, typed 0 and a future instant', async ({
    browser,
    stepPicture,
  }) => {
    test.setTimeout(720_000);
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

    // The same two asked of svc-ledger itself through the console's run route, past the desk's own hold: A proposes, B
    // approves, A runs, and svc-ledger answers each refusal with its code.
    const blank = await serviceRun(state.thresholdId, past.toISOString(), 'unset');
    expect(blank, JSON.stringify(blank).slice(0, 400)).toMatchObject({ ok: false, refusal: { code: 'ops.control_margin_unset' } });
    const ahead = new Date(Date.now() + 86_400_000);
    ahead.setUTCSeconds(0, 0);
    const future = await serviceRun(state.thresholdId, ahead.toISOString(), '0');
    expect(future, JSON.stringify(future).slice(0, 400)).toMatchObject({ ok: false, refusal: { code: 'ledger.reconcile_asof_invalid' } });

    const withMargin = await twoFounderRun(state.thresholdId, { instant: typed, margin: '60' });
    expect(withMargin).toContain(
      `As of ${past.toISOString()}; balances read at ${new Date(past.getTime() - 60_000).toISOString()} (margin 60 s)`,
    );
    const zero = await twoFounderRun(state.thresholdId, { instant: typed, margin: '0' });
    expect(zero).toContain(`balances read at ${past.toISOString()} (margin 0 s)`);

    // The ledger's own TEST records with a TEST venue and a TEST partner, each also written in that party's own report
    // (`seed-own-record`: the reporter's line first, then our record through its real recipe). The venue's lands a
    // minute before the partner's, so one past instant falls between them. Every expected figure and as-of below is
    // read directly from the TEST venue's and TEST partner's loopback records (`venueRecord`), never through our app.
    const venue = `ltv-${tag}`;
    const partner = `ltp-${tag}`;
    await seedOwnRecord('venue', venue, 'USDT', '5', `ops07v-${tag}`);
    const between = await nextMinute(a);
    await seedOwnRecord('partner', partner, 'USDT', '3', `ops07p-${tag}`);
    const after = await nextMinute(a);
    const readAt = new Date(after.getTime() - 60_000).toISOString();

    const venueAtBetween = await ownReportRecord('venue', venue, between.toISOString());
    const partnerAtBetween = await ownReportRecord('partner', partner, between.toISOString());
    const partnerAtReadAt = await ownReportRecord('partner', partner, readAt);
    const venueAtAfter = await ownReportRecord('venue', venue, after.toISOString());
    const partnerAtAfter = await ownReportRecord('partner', partner, after.toISOString());
    expect(venueAtBetween.asOf, 'the TEST venue had reported by `between`').toBeTruthy();
    expect(venueAtBetween.balances).toEqual([{ assetId: 'USDT', amount: '-5' }]);
    expect(partnerAtBetween).toMatchObject({ reporter: 'partner', place: partner, reported: false });
    expect(partnerAtReadAt).toMatchObject({ reporter: 'partner', place: partner, reported: false });
    expect(venueAtAfter.asOf).toBe(venueAtBetween.asOf);
    expect(venueAtAfter.balances).toEqual([{ assetId: 'USDT', amount: '-5' }]);
    expect(partnerAtAfter.asOf, 'the TEST partner had reported by `after`').toBeTruthy();
    expect(partnerAtAfter.balances).toEqual([{ assetId: 'USDT', amount: '-3' }]);

    const reportsId = await define(await openLedger(a), {
      template: 'outside_balance',
      explanation: `LOCAL TEST venue and partner reports ${tag}`,
      fill: async (form) => {
        await form.getByLabel('Venue report (venue id)', { exact: true }).fill(venue);
        await form.getByLabel('Partner report (partner id)', { exact: true }).fill(partner);
        await setPolicy(form, { tolerance: '0' });
      },
    });

    // Between the two: the venue had reported, the partner had not. The partner's side reads "not reported" and the run is
    // UNSET, never a match; the venue's side carries its own report's as-of against our records as of the instant.
    const early = await twoFounderRun(reportsId, { instant: minuteText(between), margin: '0' });
    expect(early).toMatch(/Run [0-9a-f-]{36}: UNSET\./);
    expect(early).toContain(`As of ${between.toISOString()}; balances read at ${between.toISOString()} (margin 0 s).`);
    expect(early).toContain(`Sources: ledger as of ${between.toISOString()};`);
    expect(early).toContain('Error: ledger.reconcile_not_reported at outside.');
    expect(early).toContain(`Venue ${venue} report: as of ${venueAtBetween.asOf}.`);
    expect(early).toContain(
      `venue ${venue} USDT: observed ${venueAtBetween.balances[0].amount}, expected ${venueAtBetween.balances[0].amount}, difference 0, tolerance 0.`,
    );
    expect(early).toContain(`Partner ${partner} report: not reported for this instant, never a match.`);
    expect(early).not.toMatch(/: PASS\./);

    // After both, with a margin of 60 s: our records as of the instant minus the margin, and each report for that same
    // read instant with its own as-of. The partner's line is after the read instant, so it still reads "not reported".
    const margined = await twoFounderRun(reportsId, { instant: minuteText(after), margin: '60' });
    expect(margined).toContain(`As of ${after.toISOString()}; balances read at ${readAt} (margin 60 s).`);
    expect(margined).toContain(`Sources: ledger as of ${readAt};`);
    expect(margined).toContain(`Venue ${venue} report: as of ${venueAtBetween.asOf}.`);
    expect(margined).toContain(`Partner ${partner} report: not reported for this instant, never a match.`);

    // With a margin of 0 both had reported: each side compared with its own report, and the sums agree. PASS.
    const both = await twoFounderRun(reportsId, { instant: minuteText(after), margin: '0' });
    expect(both).toMatch(/Run [0-9a-f-]{36}: PASS\./);
    expect(both).toContain(`balances read at ${after.toISOString()} (margin 0 s).`);
    expect(both).toContain(`Venue ${venue} report: as of ${venueAtAfter.asOf}.`);
    expect(both).toContain(`Partner ${partner} report: as of ${partnerAtAfter.asOf}.`);
    expect(both).toContain(
      `venue ${venue} USDT: observed ${venueAtAfter.balances[0].amount}, expected ${venueAtAfter.balances[0].amount}, difference 0, tolerance 0.`,
    );
    expect(both).toContain(
      `partner ${partner} USDT: observed ${partnerAtAfter.balances[0].amount}, expected ${partnerAtAfter.balances[0].amount}, difference 0, tolerance 0.`,
    );
    // The run's own row: our records at both places against both reports together.
    expect(both).toContain('2 accounts and 1 asset read. 1 record compared,');
    expect(both).toMatch(/ compared, read through [0-9TZ:.-]+\. USDT: observed -8, expected -8, difference 0, tolerance 0\./);
    await stepPicture(a);
  });

  test('J-ops-console-07 #5 a run evaluates PASS or FAIL with per-asset evidence, and an unreadable source is ERROR, never PASS', async ({
    browser,
    stepPicture,
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
      await stepPicture(a);
    } finally {
      ledgerOutside(false);
    }
  });

  test('J-ops-console-07 #5 the evidence is the ledger’s: two assets of our own records at a past instant and now, stored as shown', async ({
    browser,
    stepPicture,
  }) => {
    test.setTimeout(600_000);
    const { a } = await founders(browser);
    // A fresh TEST venue place is the whole account set (no customer balances), so every observed and expected figure is
    // known from the TEST venue's own loopback report (`venueRecord`) at the past instant and now.
    const venue = `ltv5-${tag}`;
    await seedOwnRecord('venue', venue, 'USDT', '2.5', `ops07e1-${tag}`);
    await seedOwnRecord('venue', venue, 'USDC', '1', `ops07e2-${tag}`);
    // The past instant is the next whole minute after the USDT and first USDC records, and before the second USDC one.
    const instant = await nextMinute(a);
    await seedOwnRecord('venue', venue, 'USDC', '2', `ops07e3-${tag}`);
    const reportAtPast = await ownReportRecord('venue', venue, instant.toISOString());
    const reportNow = await ownReportRecord('venue', venue, new Date().toISOString());
    const amountOf = (report, asset) => report.balances.find((b) => b.assetId === asset)?.amount;
    expect(scaled(amountOf(reportAtPast, 'USDT') ?? '0')).toBe(scaled('-2.5'));
    expect(scaled(amountOf(reportAtPast, 'USDC') ?? '0')).toBe(scaled('-1'));
    expect(scaled(amountOf(reportNow, 'USDT') ?? '0')).toBe(scaled('-2.5'));
    expect(scaled(amountOf(reportNow, 'USDC') ?? '0')).toBe(scaled('-3'));

    const section = await openLedger(a);
    await requireTreasury(section);
    const ownId = await define(section, {
      template: 'outside_balance',
      explanation: `LOCAL TEST own venue two assets ${tag}`,
      fill: async (form) => {
        await form.getByLabel('Asset', { exact: true }).fill('');
        await form.getByLabel('Venue report (venue id)', { exact: true }).fill(venue);
        await setPolicy(form, { tolerance: '0' });
      },
    });
    try {
      // At the past instant (margin 0) the ledger and TEST venue held the USDT record and the first USDC record, not yet
      // the second: both assets are compared from decimal figures, and USDC is its balance then, not now.
      const past = await twoFounderRun(ownId, { instant: minuteText(instant), margin: '0' });
      expect(past).toMatch(/Run [0-9a-f-]{36}: PASS\./);
      expect(past).toContain(`balances read at ${instant.toISOString()} (margin 0 s)`);
      expect(past).toContain('2 records compared');
      expect(past).not.toContain('missing on the');
      for (const asset of ['USDT', 'USDC']) {
        const expected = amountOf(reportAtPast, asset);
        const shown = evidence(past, asset);
        expect(scaled(shown.observed), `${asset} observed is our ledger record at the instant`).toBe(scaled(expected));
        expect(scaled(shown.expected), `${asset} expected is the TEST venue report at the instant`).toBe(scaled(expected));
        expect(scaled(shown.difference)).toBe(0n);
        expect(shown.tolerance).toBe('0');
      }

      // Now: both USDC records are in, each matching the TEST venue's own loopback report.
      const now = await twoFounderRun(ownId);
      expect(now).toMatch(/Run [0-9a-f-]{36}: PASS\./);
      expect(now).toContain('2 records compared');
      for (const asset of ['USDT', 'USDC']) {
        const expected = amountOf(reportNow, asset);
        const shown = evidence(now, asset);
        expect(scaled(shown.observed), `${asset} observed is our ledger record now`).toBe(scaled(expected));
        expect(scaled(shown.expected), `${asset} expected is the TEST venue report now`).toBe(scaled(expected));
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
        for (const asset of assets) {
          const kept = evidence(text, asset);
          expect(kept, `${asset} evidence is stored as the run showed it`).toEqual(evidence(answer, asset));
          // Stored as decimal figures, never an unset one: a stored row that lost its figures is not the run shown.
          for (const field of ['observed', 'expected', 'difference', 'tolerance'])
            expect(kept[field], `${asset} stored ${field} is a decimal figure`).toMatch(/^-?\d+(?:\.\d+)?$/);
        }
      }
      await stepPicture(a);
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
    stepPicture,
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
      await stepPicture(a);
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
    stepPicture,
  }) => {
    test.setTimeout(600_000);
    const { a } = await founders(browser);
    const section = await openLedger(a);
    await requireTreasury(section);
    // Two floors no TEST book reaches, over the USDT account set: USDT fails on its total; the set holds no USDC account, so
    // USDC fails as a missing ledger side, never as a total of 0 (OWNER 288).
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

      // Alerts count per UTC day, so a repeat after midnight rightly opens the new day's alerts. Both runs take about a
      // minute and a half; with under five minutes left in the day, wait until the new day has begun.
      const leftToday = 86_400_000 - (Date.now() % 86_400_000);
      if (leftToday < 300_000) await a.waitForTimeout(leftToday + 5_000);
      const first = await twoFounderRun(state.pairId);
      expect(first).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      expect(evidence(first, 'USDC')).toEqual({ observed: 'unset', expected: HIGH_FLOOR, difference: 'unset', tolerance: '0' });
      expect(first).toContain('USDC is missing on the ledger side: a break, never read as a zero.');
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
      await openAlerts(a);
      await stepPicture(a);
    } catch (err) {
      // #8 retires the pair; when this step fails first, retire it here so scheduled runs do not keep failing on it.
      await lifecycle(state.pairId, 'retire', 'Retired').catch(() => undefined);
      state.pairId = undefined;
      throw err;
    }
  });

  test('J-ops-console-07 #8 two founders acknowledge at once: one wins, the other sees it; snoozed notices stop while the count rises', async ({
    browser,
    stepPicture,
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

      // The period is still not green while an alert in it is acknowledged; a period with no open alert shows green.
      const room = await openAlerts(a);
      const pairPeriod = room.locator(
        `[data-testid="period-row"][data-control-id="${state.pairId}"][data-period-start="${usdt.periodStart}"]`,
      );
      await expect(pairPeriod).toHaveCount(1);
      await expect(pairPeriod).toHaveAttribute('data-green', 'false');
      // The threshold control's newest period was last run by step #5's passing run. Step #4's run at an hour ago can land in
      // the day before (in the first hour after midnight UTC) and read a stack that held no USDT account yet: an honest FAIL
      // with its own open alert, so not every period of this control passed. Each period is judged on what it holds.
      const passing = room.locator(`[data-testid="period-row"][data-control-id="${state.thresholdId}"]`);
      expect(await passing.count(), 'the passing control has evaluated periods').toBeGreaterThan(0);
      await expect(passing.first()).toHaveAttribute('data-status', 'PASS');
      let quiet = 0;
      for (const p of await passing.all()) {
        const cells = p.locator('td');
        const [open, acknowledged] = [(await cells.nth(3).innerText()).trim(), (await cells.nth(4).innerText()).trim()];
        if (open !== '0' || acknowledged !== '0') {
          await expect(p).toHaveAttribute('data-green', 'false');
          continue;
        }
        quiet += 1;
        await expect(p).toHaveAttribute('data-green', 'true');
        await expect(cells.nth(5)).toHaveText('Green');
      }
      expect(quiet, 'the newest period, with no open alert, is among them').toBeGreaterThan(0);
      await expect(passing.first().locator('td').nth(5)).toHaveText('Green');

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
      await stepPicture(a);
    } finally {
      // Retire the TEST two-asset floor so scheduled runs do not keep failing on it.
      await lifecycle(state.pairId, 'retire', 'Retired');
    }
  });
});
