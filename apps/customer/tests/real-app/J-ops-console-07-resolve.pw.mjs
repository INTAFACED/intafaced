// World: stack, restart
import { expect, test } from './journey.mjs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ROOT, STACK_PORTS } from './stack.mjs';
import { MINUTE, clearOfDayTurn, dayTurnWait } from './clock.mjs';
import { openTx, reverseWithTwoFounders } from './ledger-reversal-desk.mjs';
import {
  alertsOf,
  awaitAlerts,
  consoleStep,
  createReconDesk,
  evidence,
  ledgerOutside,
  openAlert,
  openAlerts,
  openLedger,
  ownReportRecord,
  putOutsideBack,
  reportAmount,
  requireTreasury,
  row,
  runId,
  seedOwnRecord,
  setPolicy,
  storedRun,
} from './recon-controls.mjs';

// J-ops-console-07 part 2 (OPS-reconciliation-04): steps #9 and #10 run in their own part file with their own founder
// sign-in so the journey stays well inside the founder console's 15-minute session window and balanced across CI shards.
// Step #9 resolves as fixed with a corrective reversal booked on J-ops-console-05's reversal desk and accepts a discrepancy
// with two founders; step #10 verifies repeat failure reopens, a passing run resolves, an ERROR run raises a platform alert,
// a run-failed event delivered twice is stored once, and svc-notify applies an alert transition received twice once.

const tag = randomUUID().slice(0, 8);
// #9 opens the fix control's alert and #10's repeat run must reopen that same alert. A daily control's alerts are one per
// asset and UTC day, so #9 and #10 (about 6 minutes on CI) start only when the UTC day has this long left.
const RESOLVE_WINDOW = 20 * MINUTE;
const { founders, define, twoFounderRun, lifecycle } = createReconDesk(tag);
const state = {
  // #9 and #10: a TEST venue report control (resolved with a real reversal, reopened, then auto-resolved when the venue
  // reports the remaining leg) and a TEST partner report control (accepted with frozen evidence, then split by a new break).
  fixId: null,
  fixVenue: null,
  fixRef3: null,
  fixAlertId: null,
  acceptId: null,
  acceptPartner: null,
  acceptAlert: null,
};

// A step that fails or times out never reaches its own finally, so the hooks put the ledger back before the next step.
test.beforeAll(putOutsideBack);
test.afterEach(putOutsideBack);

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
    env: { ...process.env, NATS_URL: `nats://127.0.0.1:${STACK_PORTS.nats}`, EVENT_KEY: key },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`delivering the run-failed event twice failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/**
 * Delivers one reconciliation alert transition to the bus twice, under the business key svc-ops published it with and two
 * distinct stream message ids, so the stream keeps both, and waits until svc-notify's durable consumer has acknowledged both.
 */
function deliverTransitionTwice(entry) {
  const code = `
    import { connect } from 'nats';
    import { buildEnvelope, encodeEnvelope } from './dist/index.js';
    const e = JSON.parse(process.env.ENTRY);
    const env = buildEnvelope(
      'coreOpsReconciliationAlertUpdated',
      { alertId: e.alertId, sequence: e.sequence, transition: e.kind, state: e.state, actor: e.actor, changedAt: e.occurredAt },
      'ops',
      { idempotencyKey: e.eventKey },
    );
    const nc = await connect({ servers: process.env.NATS_URL });
    const js = nc.jetstream();
    const acks = [];
    for (const n of [1, 2]) acks.push(await js.publish(env.subject, encodeEnvelope(env), { msgID: env.idempotencyKey + ':redelivery:' + process.env.TAG + ':' + n }));
    const jsm = await nc.jetstreamManager();
    const seqs = acks.map((a) => a.seq);
    let info;
    for (let i = 0; i < 60; i++) {
      info = await jsm.consumers.info(acks[0].stream, 'notify-recon-alert-updated');
      if (info.ack_floor.stream_seq >= Math.max(...seqs) && info.num_ack_pending === 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(JSON.stringify({ seqs, duplicate: acks.some((a) => a.duplicate), ackFloor: info.ack_floor.stream_seq, ackPending: info.num_ack_pending }));
    await nc.drain();`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.join(ROOT, 'packages', 'events'),
    env: { ...process.env, NATS_URL: `nats://127.0.0.1:${STACK_PORTS.nats}`, ENTRY: JSON.stringify(entry), TAG: tag },
    encoding: 'utf8',
    timeout: 90_000,
  });
  if (r.status !== 0) throw new Error(`delivering the alert transition twice failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/** svc-notify's record of one alert's transitions, as the alert page shows it: [{eventKey, kind, sequence}]. */
async function feedOf(page, alertId) {
  await openAlert(page, alertId);
  const feed = page.getByTestId('alert-feed');
  await expect(feed).toBeVisible({ timeout: 30_000 });
  return feed.getByTestId('alert-feed-entry').evaluateAll((els) =>
    els.map((el) => ({
      eventKey: el.getAttribute('data-event-key'),
      kind: el.getAttribute('data-kind'),
      sequence: Number(el.getAttribute('data-sequence')),
      state: el.getAttribute('data-state'),
      actor: el.getAttribute('data-actor'),
    })),
  );
}

test.describe.serial('J-ops-console-07 resolve and lifecycle transitions', () => {
  test('J-ops-console-07 #9 resolve as fixed with a corrective reversal id; accepting needs a note and two founders and freezes the evidence', async ({
    browser,
    stepPicture,
  }) => {
    test.setTimeout(900_000 + dayTurnWait(Date.now(), RESOLVE_WINDOW));
    await clearOfDayTurn((await founders(browser)).a, RESOLVE_WINDOW);
    const { a, b } = await founders(browser);
    const section = await openLedger(a);
    await requireTreasury(section);

    // A TEST venue with one matched obligation (5 USDT) and two unmatched --ledger-only bookings (2 USDT and 3 USDT):
    // our ledger holds -10 while the TEST venue's own loopback report holds -5, so the break is -5 USDT. Reversing the
    // 2 USDT booking in #9 leaves a -3 USDT break so #10's next run fails again and reopens the alert, then the TEST venue
    // reports the remaining 3 USDT and #10's passing run auto-resolves it.
    state.fixVenue = `ltv9f-${tag}`;
    state.fixRef3 = `ops07-fix2-${tag}`;
    await seedOwnRecord('venue', state.fixVenue, 'USDT', '5', `ops07-fix0-${tag}`);
    const unmatched2 = await seedOwnRecord('venue', state.fixVenue, 'USDT', '2', `ops07-fix1-${tag}`, { ledgerOnly: true });
    expect(unmatched2.tx, `the unmatched 2 USDT booking names its ledger transaction: ${unmatched2.out}`).toMatch(/^[0-9a-f-]{36}$/);
    const unmatched3 = await seedOwnRecord('venue', state.fixVenue, 'USDT', '3', state.fixRef3, { ledgerOnly: true });
    expect(unmatched3.tx, `the unmatched 3 USDT booking names its ledger transaction: ${unmatched3.out}`).toMatch(/^[0-9a-f-]{36}$/);

    const fixReported = await ownReportRecord('venue', state.fixVenue, new Date().toISOString());
    const expectedFix = reportAmount(fixReported, 'USDT');
    expect(expectedFix, 'the TEST venue report holds only the matched 5 USDT obligation').toBe('-5');

    state.fixId = await define(section, {
      template: 'outside_balance',
      explanation: `LOCAL TEST venue USDT break ${tag}`,
      fill: async (form) => {
        await form.getByLabel('Asset', { exact: true }).fill('USDT');
        await form.getByLabel('Venue report (venue id)', { exact: true }).fill(state.fixVenue);
        await setPolicy(form, { tolerance: '0' });
      },
    });
    try {
      await expect(row(section, state.fixId).getByTestId('rc-state')).toHaveText('Active');
      const fail = await twoFounderRun(state.fixId);
      expect(fail).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      expect(evidence(fail, 'USDT')).toEqual({ observed: '-10', expected: expectedFix, difference: '-5', tolerance: '0' });
      const [opened] = await awaitAlerts(a, state.fixId, (rows) => rows.length === 1, 'svc-ops opens the venue break’s alert');
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
      expect(openedAs.evidence.replace(/\s+/g, ' ')).toBe(`Observed -10 · expected ${expectedFix} · difference -5 · tolerance 0`);
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

      // Reverse the unmatched 2 USDT builder-fee booking on J-ops-console-05's reversal desk with two founders, then link
      // that booked reversal id to resolve the alert as fixed. Our ledger moves from -10 to -8 while the venue still
      // reports -5 (leaving the -3 break for #10's reopen).
      const reversal = await reverseWithTwoFounders(a, b, unmatched2.tx, {
        reason: `LOCAL TEST J-ops-console-07 corrective reversal ${tag}`,
        caseRef: `LOCAL-TEST-OPS07-${tag}`,
      });
      const reversing = await openTx(a, reversal);
      await expect(reversing.getByTestId('tx-reverses')).toHaveAttribute('data-tx-id', unmatched2.tx.toLowerCase());
      await expect(reversing.getByTestId('ledger-lookup-business-key')).toHaveText(`ops:reversal:${unmatched2.tx.toLowerCase()}:1`);

      const resolved = await resolveWith(a, opened.id, [reversal.toUpperCase()], `LOCAL TEST fixed by reversal ${tag}`);
      await expect(resolved).toHaveAttribute('data-state', 'resolved', { timeout: 30_000 });
      const record = resolved.getByTestId('alert-resolved');
      await expect(record).toHaveAttribute('data-resolution', 'fixed');
      await expect(record.getByTestId('alert-resolved-tx')).toHaveCount(1);
      await expect(record.getByTestId('alert-resolved-tx')).toHaveAttribute('data-tx-id', reversal);
      const resolvedEntry = resolved.locator('[data-testid="timeline-entry"][data-kind="resolved"]');
      await expect(resolvedEntry).toHaveCount(1);
      await expect(resolvedEntry.getByTestId('timeline-tx')).toHaveAttribute('data-tx-id', reversal);
      // A resolved alert offers no second resolution and no acceptance.
      await expect(resolved.getByTestId('alert-resolve-why')).toBeVisible();

      // Accept: a TEST partner USDC report control with a real -1 USDC break (ledger -5 vs partner report -4).
      state.acceptPartner = `ltp9a-${tag}`;
      await seedOwnRecord('partner', state.acceptPartner, 'USDC', '4', `ops07-acc0-${tag}`);
      await seedOwnRecord('partner', state.acceptPartner, 'USDC', '1', `ops07-acc1-${tag}`, { ledgerOnly: true });
      const accReported = await ownReportRecord('partner', state.acceptPartner, new Date().toISOString());
      const expectedAcc = reportAmount(accReported, 'USDC');
      expect(expectedAcc, 'the TEST partner report holds the matched 4 USDC obligation').toBe('-4');

      const desk = await openLedger(a);
      state.acceptId = await define(desk, {
        template: 'outside_balance',
        explanation: `LOCAL TEST partner USDC break to accept ${tag}`,
        fill: async (f) => {
          await f.getByLabel('Asset', { exact: true }).fill('USDC');
          await f.getByLabel('Partner report (partner id)', { exact: true }).fill(state.acceptPartner);
          await setPolicy(f, { tolerance: '0' });
        },
      });
      const accFail = await twoFounderRun(state.acceptId);
      expect(accFail).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      expect(evidence(accFail, 'USDC')).toEqual({ observed: '-5', expected: expectedAcc, difference: '-1', tolerance: '0' });
      const [toAccept] = await awaitAlerts(a, state.acceptId, (rows) => rows.length === 1, 'svc-ops opens the partner USDC alert');
      expect(toAccept).toMatchObject({ asset: 'USDC', state: 'open', cause: 'fail', team: 'finance' });
      const before = await openAlert(a, toAccept.id);
      const evidenceHash = (await before.getByTestId('alert-evidence-hash').innerText()).trim();
      expect(evidenceHash).toMatch(/^[0-9a-f]{64}$/);
      const evidenceText = await before.getByTestId('alert-evidence').innerText();
      expect(evidenceText.replace(/\s+/g, ' ')).toBe(`Observed -5 · expected ${expectedAcc} · difference -1 · tolerance 0`);

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
      // Frozen: a later resolve, even with a booked reversal's id, is refused by its one code and changes nothing.
      const late = await resolveDirect(a, toAccept.id, acceptedVersion, [reversal]);
      expect(late.body?.code, JSON.stringify(late)).toBe('ops.alert_state_illegal');
      const reread = await openAlert(a, toAccept.id);
      await expect(reread).toHaveAttribute('data-state', 'accepted');
      await expect(reread).toHaveAttribute('data-version', String(acceptedVersion));
      await expect(reread.getByTestId('alert-accepted')).toHaveAttribute('data-evidence-hash', evidenceHash);
      await expect(reread.getByTestId('alert-evidence')).toHaveText(evidenceText);
      await expect(reread.getByTestId('alert-resolved')).toHaveCount(0);
      await stepPicture(a);
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
    stepPicture,
  }) => {
    test.setTimeout(900_000);
    if (
      !state.fixId ||
      !state.fixVenue ||
      !state.fixRef3 ||
      !state.fixAlertId ||
      !state.acceptId ||
      !state.acceptPartner ||
      !state.acceptAlert
    )
      throw new Error('#10 starts from #9’s resolved and accepted alerts, and #9 did not finish, so #10 cannot run');
    const { a } = await founders(browser);
    let errorId;
    try {
      // The same venue break remains after #9's 2 USDT reversal (ledger -8 vs TEST venue report -5): the resolved alert
      // reopens (no second alert), its count rises and the resolution is cleared on the alert while the timeline keeps it.
      const fixBefore = await ownReportRecord('venue', state.fixVenue, new Date().toISOString());
      const expectedFixBefore = reportAmount(fixBefore, 'USDT');
      expect(expectedFixBefore, 'the TEST venue still reports -5 before the remaining 3 USDT is reported').toBe('-5');
      const reopenRun = await twoFounderRun(state.fixId);
      expect(reopenRun).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      expect(evidence(reopenRun, 'USDT')).toEqual({ observed: '-8', expected: expectedFixBefore, difference: '-3', tolerance: '0' });
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

      // The accepted alert is frozen: the same partner break again (-5 vs -4) changes nothing on it and opens no new alert.
      const accReport = await ownReportRecord('partner', state.acceptPartner, new Date().toISOString());
      const expectedAcc = reportAmount(accReport, 'USDC');
      expect(expectedAcc, 'the TEST partner report still holds -4').toBe('-4');
      const sameAccRun = await twoFounderRun(state.acceptId);
      expect(sameAccRun).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      expect(evidence(sameAccRun, 'USDC')).toEqual({ observed: '-5', expected: expectedAcc, difference: '-1', tolerance: '0' });
      const fixedRun = await twoFounderRun(state.fixId);
      expect(fixedRun).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      // svc-ops reads evaluations in order: once the later fix-venue run is counted, the accept run before it was read too.
      await awaitAlerts(a, state.fixId, (rows) => rows[0]?.occurrences === 3, 'svc-ops counts the later run');
      const frozen = await alertsOf(a, state.acceptId);
      expect(frozen, 'no new alert beside the accepted one').toHaveLength(1);
      expect(frozen[0]).toMatchObject({ id: state.acceptAlert.id, state: 'accepted', occurrences: state.acceptAlert.occurrences });
      const still = await openAlert(a, state.acceptAlert.id);
      await expect(still.getByTestId('alert-accepted')).toHaveAttribute('data-evidence-hash', state.acceptAlert.evidenceHash);
      await expect(still.getByTestId('alert-evidence')).toHaveText(state.acceptAlert.evidenceText);
      await expect(still).toHaveAttribute('data-version', String(state.acceptAlert.version));

      // Different figures are a new discrepancy: another unmatched 2 USDC ledger booking moves observed from -5 to -7
      // against the partner's -4 report (difference -3). The next FAIL opens a new alert, and the accepted one keeps its
      // frozen evidence, count and version.
      await seedOwnRecord('partner', state.acceptPartner, 'USDC', '2', `ops07-acc2-${tag}`, { ledgerOnly: true });
      const differs = await twoFounderRun(state.acceptId);
      expect(differs).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
      expect(evidence(differs, 'USDC')).toEqual({ observed: '-7', expected: expectedAcc, difference: '-3', tolerance: '0' });
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

      // The TEST venue reports the remaining 3 USDT (same business key, so our ledger stays at -8 idempotently while the
      // venue's own loopback report catches up to -8): the next run passes and resolves the reopened alert automatically.
      await seedOwnRecord('venue', state.fixVenue, 'USDT', '3', state.fixRef3);
      const fixAfter = await ownReportRecord('venue', state.fixVenue, new Date().toISOString());
      const expectedFixAfter = reportAmount(fixAfter, 'USDT');
      expect(expectedFixAfter, 'the TEST venue report now agrees with our ledger at -8').toBe('-8');
      const pass = await twoFounderRun(state.fixId);
      expect(pass).toMatch(/Run [0-9a-f-]{36}: PASS\./);
      expect(evidence(pass, 'USDT')).toEqual({
        observed: expectedFixAfter,
        expected: expectedFixAfter,
        difference: '0',
        tolerance: '0',
      });
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
      await stepPicture(a);
    } finally {
      // Retire every TEST control this step and #9 made, so scheduled runs do not keep failing on them.
      for (const id of [state.fixId, state.acceptId, errorId].filter(Boolean))
        await lifecycle(id, 'retire', 'Retired').catch(() => undefined);
    }
  });

  // The receiver of svc-ops' alert transitions is svc-notify: it keeps one feed row per business key. The fixed alert's real
  // transitions (#9 to #10) arrived there in order; its reopen, delivered twice more, changes nothing.
  test('J-ops-console-07 #10 a transition event received twice applies once', async ({ browser, stepPicture }) => {
    test.setTimeout(300_000);
    if (!state.fixAlertId || !state.fixVenue)
      throw new Error('#10’s transition check reads the alert #9 resolved and #10 reopened, and #9 did not finish');
    const { a } = await founders(browser);
    const venueFinal = await ownReportRecord('venue', state.fixVenue, new Date().toISOString());
    expect(reportAmount(venueFinal, 'USDT'), 'the TEST venue report holds the reconciled -8 balance').toBe('-8');
    let before;
    await expect
      .poll(
        async () => {
          before = await feedOf(a, state.fixAlertId);
          return before.map((e) => e.kind);
        },
        { message: 'svc-notify receives the alert’s transitions from svc-ops', timeout: 90_000, intervals: [3_000] },
      )
      .toEqual(expect.arrayContaining(['opened', 'resolved', 'reopened']));
    await expect(a.getByTestId('alert-detail')).toHaveAttribute('data-state', 'resolved');
    await expect(a.getByTestId('alert-resolved')).toHaveAttribute('data-resolution', 'auto');
    await expect(a.getByTestId('alert-feed')).toHaveAttribute('data-bus', 'attached');
    const keys = before.map((e) => e.eventKey);
    expect(new Set(keys).size, 'one row per business key').toBe(keys.length);
    for (const e of before) expect(e.eventKey).toBe(`ops:reconciliation-alert:${state.fixAlertId}:${e.sequence}`);
    expect(
      before.map((e) => e.sequence),
      'in sequence order',
    ).toEqual(before.map((e) => e.sequence).sort((x, y) => x - y));

    const reopen = before.find((e) => e.kind === 'reopened');
    const row = a.locator(`[data-testid="alert-feed-entry"][data-event-key="${reopen.eventKey}"]`);
    const shown = (await row.textContent()) ?? '';
    const delivered = deliverTransitionTwice({
      alertId: state.fixAlertId,
      sequence: reopen.sequence,
      eventKey: reopen.eventKey,
      kind: 'reopened',
      state: reopen.state,
      actor: reopen.actor,
      occurredAt: new Date().toISOString(),
    });
    expect(delivered.seqs, 'the stream kept both deliveries').toHaveLength(2);
    expect(delivered.duplicate, 'neither delivery was dropped by the stream as a duplicate').toBe(false);
    // svc-notify's durable consumer acknowledged both: each was read and handled, not left in flight.
    expect(delivered.ackPending, JSON.stringify(delivered)).toBe(0);
    expect(delivered.ackFloor, JSON.stringify(delivered)).toBeGreaterThanOrEqual(Math.max(...delivered.seqs));

    const after = await feedOf(a, state.fixAlertId);
    expect(after, 'both deliveries applied as the one reopen already there').toEqual(before);
    await expect(a.locator(`[data-testid="alert-feed-entry"][data-event-key="${reopen.eventKey}"]`)).toHaveCount(1);
    await expect(a.locator(`[data-testid="alert-feed-entry"][data-event-key="${reopen.eventKey}"]`)).toHaveText(shown);
    await stepPicture(a);
  });
});
