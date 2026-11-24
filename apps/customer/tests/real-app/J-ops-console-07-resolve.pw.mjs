// World: restart
import { expect, test } from './journey.mjs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fund, ROOT, STACK_PORTS } from './stack.mjs';
import { openTx, reverseWithTwoFounders } from './ledger-reversal-desk.mjs';
import {
  alertsOf,
  awaitAlerts,
  choose,
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
  runId,
  scaled,
  setPolicy,
  storedRun,
} from './recon-controls.mjs';

// J-ops-console-07 part 2 (OPS-reconciliation-04): steps #9 and #10 run in their own part file with their own founder
// sign-in so the journey stays well inside the founder console's 15-minute session window and balanced across CI shards.
// Step #9 resolves as fixed with a corrective reversal booked on J-ops-console-05's reversal desk and accepts a discrepancy
// with two founders; step #10 verifies repeat failure reopens, a passing run resolves, an ERROR run raises a platform alert,
// a run-failed event delivered twice is stored once, and svc-notify applies an alert transition received twice once.

const tag = randomUUID().slice(0, 8);
const { founders, define, twoFounderRun, lifecycle } = createReconDesk(tag);
const state = {
  // #9 and #10: our own house USDT floor that is resolved, reopens and passes, and its alert; the USDC floor accepted.
  fixId: null,
  fixAlertId: null,
  acceptId: null,
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
    test.setTimeout(900_000);
    const { a, b } = await founders(browser);
    const section = await openLedger(a);
    await requireTreasury(section);

    // Ensure INTAFACED's own house market-maker USDT account holds a positive balance (no customer accounts).
    expect(fund('house', 'USDT', '1', `ops07-fix0-${tag}`).tx, 'the house USDT seed is a booked ledger transaction').toMatch(
      /^[0-9a-f-]{36}$/,
    );
    // A floor over INTAFACED's own house market-maker USDT, set 5 above what the book holds now, so it fails until 5 USDT more arrives.
    state.fixId = await define(section, {
      template: 'threshold',
      explanation: `LOCAL TEST house USDT floor ${tag}`,
      fill: async (form) => {
        await form.getByLabel('Owner type', { exact: true }).selectOption('house');
        await form.getByLabel('Owner id starts with', { exact: true }).fill('market-maker');
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

      // Two real postings on INTAFACED's own books, kept apart (zero customer accounts):
      // - #10's figures: a TEST house seed of 2 USDT (`marketMakerSeedFund`). 2 is short of the 5 the floor wants, so
      //   #10's next run fails again and reopens the alert; #10 seeds the other 3 and the run passes.
      // - #9's fix: the corrective reversal the alert is resolved with, made on J-ops-console-05's reversal desk and only
      //   linked here. Its original is INTAFACED's own TEST entry (a house market-maker seed in an asset no other journey
      //   reads); founder a asks and runs, founder b approves.
      const deposit = fund('house', 'USDT', '2', `ops07-fix1-${tag}`);
      expect(deposit.tx, `the house seed names its ledger transaction: ${deposit.out}`).toMatch(/^[0-9a-f-]{36}$/);
      const own = fund('house', 'AUD', '0.5', `ops07-fix-${tag}`);
      expect(own.tx, `our own entry names its ledger transaction: ${own.out}`).toMatch(/^[0-9a-f-]{36}$/);
      const reversal = await reverseWithTwoFounders(a, b, own.tx, {
        reason: `LOCAL TEST J-ops-console-07 corrective reversal ${tag}`,
        caseRef: `LOCAL-TEST-OPS07-${tag}`,
      });
      // The id linked below is a booked reversal: the ledger's own record of it names the entry it reverses.
      const reversing = await openTx(a, reversal);
      await expect(reversing.getByTestId('tx-reverses')).toHaveAttribute('data-tx-id', own.tx.toLowerCase());
      await expect(reversing.getByTestId('ledger-lookup-business-key')).toHaveText(`ops:reversal:${own.tx.toLowerCase()}:1`);

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

      // Accept: a USDC floor over the USDT account set fails at every run on a missing USDC side (no account holds it), the
      // same figures each time.
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

      // The rest of the 5 USDT arrives on INTAFACED's own house account: the next run passes and resolves the reopened alert by itself, naming that run.
      expect(fund('house', 'USDT', '3', `ops07-fix2-${tag}`).tx, 'the rest is a booked ledger transaction').toMatch(/^[0-9a-f-]{36}$/);
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
      await stepPicture(a);
    } finally {
      // Retire every TEST control this step and #9 made, so scheduled runs do not keep failing on them.
      for (const id of [state.fixId, state.acceptId, errorId].filter(Boolean))
        await lifecycle(id, 'retire', 'Retired').catch(() => undefined);
    }
  });

  // The receiver of svc-ops' alert transitions is svc-notify: it keeps one feed row per business key. The fixed alert's real
  // transitions (#7 to #10) arrived there in order; its reopen, delivered twice more, changes nothing.
  test('J-ops-console-07 #10 a transition event received twice applies once', async ({ browser, stepPicture }) => {
    test.setTimeout(300_000);
    if (!state.fixAlertId) throw new Error('#10’s transition check reads the alert #9 resolved and #10 reopened, and #9 did not finish');
    const { a } = await founders(browser);
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
