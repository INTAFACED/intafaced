import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { tool } from './stack.mjs';

// J-ops-console-08: check the ledger's integrity and prove a restore. #1-#3 are the ledger integrity panel
// (OPS-ledger-desk-04), which the console does not have yet: they fail at once by name. #4-#7 are the joint restore desk
// (OPS-ledger-desk-05): founder A and founder B, each on their own console, with svc-ops, identity and the four services'
// own watermark doors on the stack. #5-#7 need the stack to serve the ops profile's TEST archive URL and restore target
// (tooling/scripts/local-stack-services/ops.mjs), with `LOCAL_STACK_OPS_RESTORE=off` leaving both blank for #4; until it
// does, #4 sees the blank archive anyway and #5 fails at once by name. Every stamp and the finalize are two-founder requests: A asks,
// B approves the exact request at identity, A runs it, and svc-ops spends the approval once.
// svc-ops compares the stamps with the services' live counts only while svc-ledger's posting freeze is on, so #6's check and
// #7's stamps, checks and finalize hold the freeze (two founders) and lift it after, with a teardown for a timeout.

const J = 'J-ops-console-08';
const tag = randomBytes(3).toString('hex');
const RUN = `R-J08-${tag}`;
const SERVICES = ['ledger', 'identity', 'bank', 'pay'];

test.use({ timezoneId: 'UTC' });

/** svc-ops restarted with the restore archive and target blank, or back on the stack's TEST values. */
function restoreDesk(on) {
  const before = process.env.LOCAL_STACK_OPS_RESTORE;
  if (on) delete process.env.LOCAL_STACK_OPS_RESTORE;
  else process.env.LOCAL_STACK_OPS_RESTORE = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'ops');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_OPS_RESTORE;
    else process.env.LOCAL_STACK_OPS_RESTORE = before;
  }
}

/** One step of a two-founder request posted as the founder signed in on `page` (the console's own CSRF header). */
const approvalStep = (page, body) =>
  page.evaluate(async (payload) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/restore/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  }, body);

const decode = (packetText) => JSON.parse(Buffer.from(packetText.trim().slice('ifa1.'.length), 'base64url').toString('utf8'));

/** One step of a two-founder posting freeze or unfreeze, as the signed-in founder in `page` (as J-ops-console-04 does it). */
const freezeStep = (page, body) =>
  page.evaluate(async (payload) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/ledger-freeze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  }, body);

/** A asks, B approves, A runs: svc-ledger's platform-wide posting freeze on (`frozen`) or off. */
async function setPostingFreeze(a, b, frozen, why) {
  const record = await a.evaluate(async () => (await fetch('/api/ledger-freeze', { cache: 'no-store' })).json());
  expect(record.ok, JSON.stringify(record)).toBe(true);
  if (record.state.frozen === frozen) return;
  const request = frozen
    ? { kind: 'ledger.freeze', reason: why, version: record.state.version }
    : { kind: 'ledger.unfreeze', version: record.state.version };
  const confirm = frozen ? 'FREEZE LEDGER' : 'UNFREEZE LEDGER';
  const proposed = await freezeStep(a, { step: 'propose', request, confirm });
  expect(proposed.body.ok, JSON.stringify(proposed.body)).toBe(true);
  const packet = decode(proposed.body.packet);
  const approved = await freezeStep(b, { step: 'approve', request, confirm, approvalId: packet.approvalId });
  expect(approved.body.ok, JSON.stringify(approved.body)).toBe(true);
  const ran = await freezeStep(a, { step: 'execute', request, confirm, approvalId: packet.approvalId, operationId: packet.operationId });
  expect(ran.body.ok, JSON.stringify(ran.body)).toBe(true);
}

/** Set while #6 or #7 holds the platform-wide posting freeze on, so the teardown below can lift it even after a timeout. */
let freezeOn = false;

// The joint check runs only while the posting freeze is on (svc-ops refuses ops.restore_platform_not_halted otherwise). A
// freeze left on would refuse every later journey's posts on this stack, so it is lifted here on fresh pages when a test
// ends with it on (a timeout closes that test's own pages before its own cleanup can run).
test.afterEach(async ({ browser }) => {
  if (!freezeOn) return;
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  await founderSignIn(b, 'b');
  await a.goto(`${ADMIN}/`, { waitUntil: 'load' });
  await b.goto(`${ADMIN}/`, { waitUntil: 'load' });
  await setPostingFreeze(a, b, false);
  freezeOn = false;
});

/** Runs `body` with the posting freeze on, marked before it is asked for, and lifts it after, whatever `body` did. */
async function frozen(a, b, why, body) {
  await a.goto(`${ADMIN}/`, { waitUntil: 'load' });
  await b.goto(`${ADMIN}/`, { waitUntil: 'load' });
  let failure = null;
  try {
    // Marked on before the call: a freeze that reached the ledger is lifted even if the call's own answer failed.
    freezeOn = true;
    await setPostingFreeze(a, b, true, why);
    await body();
  } catch (error) {
    failure = error;
  }
  // Lift the freeze for the journeys after this one; a failure to lift it never hides the step's own failure.
  try {
    await setPostingFreeze(a, b, false);
    freezeOn = false;
  } catch (unfreeze) {
    failure ??= unfreeze;
  }
  if (failure) throw failure;
}

/**
 * Founder A asks in `section` (already filled), founder B approves the packet on their own console, and A runs it. Answers the
 * packet and A's step reply after the run.
 */
async function twoFounders({ a, b, sectionId, phrase, submit, bUrl }) {
  const section = a.getByTestId(sectionId);
  await section.getByLabel(/to confirm$/).fill(phrase);
  await section.getByRole('button', { name: submit }).click();
  await expect(section.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  const packetText = (await section.getByLabel('Request packet').inputValue()).trim();
  const packet = decode(packetText);

  await b.goto(bUrl, { waitUntil: 'load' });
  const sectionB = b.getByTestId(sectionId);
  await sectionB.getByLabel('Request packet').fill(packetText);
  await sectionB.getByLabel(/to approve or run it$/).fill(phrase);
  await sectionB.getByRole('button', { name: 'Approve this request' }).click();
  await expect(sectionB.getByTestId('step-reply')).toContainText('Approved.', { timeout: 60_000 });

  await section.getByLabel(/to approve or run it$/).fill(phrase);
  await section.getByRole('button', { name: 'Run the approved request' }).click();
  const reply = section.getByTestId('step-reply');
  await expect(reply).toBeVisible({ timeout: 60_000 });
  return { packet, packetText, reply };
}

/** Records one stamp through the desk: A fills the form, B approves, A runs it. */
async function stamp(a, b, service, kind, watermark) {
  const form = a.getByTestId('record-stamp');
  await form.getByLabel('Service').selectOption(service);
  await form.getByLabel(/^What the position counts/).fill(kind);
  await form.getByLabel('Watermark read').fill(watermark);
  return twoFounders({
    a,
    b,
    sectionId: 'record-stamp',
    phrase: `STAMP ${service.toUpperCase()} ${watermark.slice(0, 16)}`,
    submit: 'Ask a second founder to approve this stamp',
    bUrl: `${ADMIN}/restore`,
  });
}

/** The joint table of the run as the room shows it: service label to stamp, live position and verdict. */
async function jointRows(page) {
  const rows = page.getByTestId('joint-row');
  await expect(rows).toHaveCount(4);
  const out = {};
  for (const row of await rows.all()) {
    const cells = await row.locator('td').allInnerTexts();
    out[cells[0].replace(/^svc-/, '')] = { stamp: cells[1], position: cells[2], verdict: cells[3] };
  }
  return out;
}

let founders = null;
let runStarted = false;

async function signedIn(browser) {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const founderA = await founderSignIn(a, 'a');
  const founderB = await founderSignIn(b, 'b');
  founders = { founderA, founderB };
  return { a, b };
}

test(`${J} #1 the integrity check runs with an approval and shows replay parity, hash chain and netting with the as-of time`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
  await expect(
    page.getByTestId('ledger-integrity-check'),
    'the console has no ledger integrity check yet (OPS-ledger-desk-04)',
  ).toBeVisible({
    timeout: 5_000,
  });
});

test(`${J} #2 a write under the posting freeze names the reason, lifting it alone is refused, and the freeze history reads`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
  await expect(page.getByTestId('ledger-freeze-history'), 'the console has no posting freeze history yet (OPS-ledger-desk-04)').toBeVisible(
    {
      timeout: 5_000,
    },
  );
});

test(`${J} #3 a full disk and a clock skew above its bound are named on the panel; a blank bound says not set`, async ({ page }) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
  await expect(page.getByTestId('ledger-write-blocks'), 'the console has no ledger write-block panel yet (OPS-ledger-desk-04)').toBeVisible(
    {
      timeout: 5_000,
    },
  );
});

test(`${J} #4 /restore with no archive configured refuses ops.restore_archive_unconfigured with an empty list and the reason`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  restoreDesk(false);
  try {
    await founderSignIn(page, 'a');
    await page.goto(`${ADMIN}/restore`, { waitUntil: 'load' });
    await expect(page.getByTestId('restore-room')).toBeVisible();
    await expect(page.getByTestId('backups-empty')).toContainText(
      'No backup is listed. No joint-restore archive is configured, so nothing can be started or recorded.',
    );
    // The code is svc-ops' own answer to the backups read, and nothing else in the room claims a backup or a run.
    await expect(page.getByTestId('backups-empty')).toContainText('Code: ops.restore_archive_unconfigured');
    await expect(page.getByTestId('backups-count')).toHaveCount(0);
  } finally {
    restoreDesk(true);
  }
});

test(`${J} #5 a stamp for each service is still listed after a restart; the same key and body returns the first row, a different body conflicts`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const { a, b } = await signedIn(browser);
  await a.goto(`${ADMIN}/restore`, { waitUntil: 'load' });
  // A stamp needs the archive configured; on a stack without the TEST archive, say so at once instead of running the desk.
  await expect(a.getByTestId('restore-room')).toBeVisible();
  await expect(
    a.getByTestId('backups-empty'),
    'the stack serves no TEST restore archive (OPS_RESTORE_ARCHIVE_URL is blank)',
  ).not.toContainText('ops.restore_archive_unconfigured', { timeout: 5_000 });
  const marks = Object.fromEntries(SERVICES.map((s, i) => [s, `${tag}-${i + 1}`]));
  let first = null;
  for (const service of SERVICES) {
    const done = await stamp(a, b, service, `${service}.j08`, marks[service]);
    await expect(done.reply).toContainText(`holds the svc-${service} stamp ${marks[service]}`);
    first ??= done;
  }
  const listed = (page) => page.getByTestId('stamp-row').filter({ hasText: tag });
  await a.reload({ waitUntil: 'load' });
  await expect(listed(a)).toHaveCount(4);

  restoreDesk(true);
  await a.reload({ waitUntil: 'load' });
  await expect(listed(a)).toHaveCount(4);
  for (const service of SERVICES) await expect(listed(a).filter({ hasText: marks[service] })).toHaveCount(1);

  // The same approval and body again: svc-ops returns the stored row, and no second row appears.
  const { packet } = first;
  const phrase = `STAMP LEDGER ${marks.ledger}`;
  const again = await approvalStep(a, { step: 'execute', request: packet.request, confirm: phrase, ...pick(packet) });
  expect(again.body).toMatchObject({ ok: true, step: 'execute' });
  // The same key with a different watermark is a conflict, and nothing is stored.
  const other = { ...packet.request, watermark: `${tag}-other` };
  const conflict = await approvalStep(a, {
    step: 'execute',
    request: other,
    confirm: `STAMP LEDGER ${other.watermark.slice(0, 16)}`,
    ...pick(packet),
  });
  expect(conflict.body).toMatchObject({ ok: false, refusal: { code: 'ops.idempotency_conflict' } });
  await a.reload({ waitUntil: 'load' });
  await expect(listed(a)).toHaveCount(4);
  await expect(listed(a).filter({ hasText: `${tag}-other` })).toHaveCount(0);
});

const pick = (packet) => ({ approvalId: packet.approvalId, operationId: packet.operationId });

test(`${J} #6 a missing or differing stamp refuses ops.restore_watermarks_disagree and nothing restores; a failed validation offers no finalize`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { a, b } = await signedIn(browser);
  await a.goto(`${ADMIN}/restore`, { waitUntil: 'load' });
  // The run's cut-off is a little ahead, so only a stamp that differs, not a write during the drill, can disagree here.
  const start = a.getByTestId('start-run');
  await start.getByLabel('Restore number').fill(RUN);
  await start.getByLabel(/^Cut-off/).fill(new Date(Date.now() + 30 * 60_000).toISOString());
  const started = a.waitForResponse((res) => res.url().endsWith('/api/restore') && res.request().method() === 'POST');
  await start.getByRole('button', { name: 'Start run' }).click();
  const answer = await (await started).json();
  // svc-ops guards restore writes with admin:treasury, which a founder's console session never holds: say so, at once.
  expect(answer, `svc-ops did not start the run: ${answer.code ?? answer.message}`).toMatchObject({ ok: true });
  runStarted = true;
  await a.getByTestId('runs-list').getByRole('link', { name: RUN }).click();
  await expect(a.getByTestId('run-detail')).toBeVisible();
  // #5's stamps are the newest for each service and differ from every live position.
  const joint = await jointRows(a);
  for (const service of SERVICES) {
    expect(joint[service].stamp).toContain(tag);
    expect(joint[service].verdict).toBe('The service reports a different position than its stamp.');
  }
  await expect(a.getByTestId('joint-verdict')).toHaveText('Not compared: the counts prove nothing while the services can still write.');
  await a.getByTestId('step-restore_clean').click();
  await expect(a.getByTestId('step-validate')).toBeVisible();
  // With the posting freeze off the services can still write, so the comparison is refused before it counts.
  await expect(a.getByTestId('joint-halt')).toContainText('The ledger posting freeze is off');
  const unhalted = a.waitForResponse((res) => res.url().endsWith('/api/restore') && res.request().method() === 'POST');
  await a.getByTestId('step-validate').click();
  expect(await (await unhalted).json()).toMatchObject({ ok: false, code: 'ops.restore_platform_not_halted' });
  // Halted, the differing stamps are what refuses.
  const runUrl = `${ADMIN}/restore?run=${encodeURIComponent(RUN)}`;
  await frozen(a, b, `LOCAL TEST J-ops-console-08 #6 joint check ${tag}`, async () => {
    await a.goto(runUrl, { waitUntil: 'load' });
    await expect(a.getByTestId('joint-halt')).toContainText('The ledger posting freeze is on');
    await expect(a.getByTestId('joint-verdict')).toHaveText('The services do not agree, so nothing past clean-area is allowed.');
    const answered = a.waitForResponse((res) => res.url().endsWith('/api/restore') && res.request().method() === 'POST');
    await a.getByTestId('step-validate').click();
    expect(await (await answered).json()).toMatchObject({ ok: false, code: 'ops.restore_watermarks_disagree' });
    await expect(a.getByTestId('step-refused')).toContainText('do not agree, so nothing was restored');
  });
  await a.goto(runUrl, { waitUntil: 'load' });
  await expect(a.getByTestId('restored')).toHaveText('No');
  await expect(a.getByTestId('finalize-form')).toHaveCount(0);
  await expect(a.getByTestId('finalize-parked')).toHaveCount(0);
});

test(`${J} #7 finalize is refused with one approver and records with the second; restored only once every step is a row`, async ({
  browser,
}) => {
  test.setTimeout(900_000);
  // #6 starts the run; without it there is nothing to finalize, so this fails at once rather than waiting on an empty room.
  expect(runStarted, `run ${RUN} was not started in #6, so there is nothing to finalize`).toBe(true);
  const { a, b } = await signedIn(browser);
  const runUrl = `${ADMIN}/restore?run=${encodeURIComponent(RUN)}`;
  await a.goto(runUrl, { waitUntil: 'load' });
  // The stamps, the checks and finalize run with the posting freeze on, as the joint check requires, and only those.
  await frozen(a, b, `LOCAL TEST J-ops-console-08 #7 restore ${tag}`, async () => {
    await a.goto(runUrl, { waitUntil: 'load' });
    // Stamp each service at the position it reports now, as an operator reading the joint table would.
    for (const service of SERVICES) {
      const joint = await jointRows(a);
      expect(joint[service].position, `svc-${service} gave no position`).toMatch(/^\d+$/);
      await stamp(a, b, service, `${service}.position`, joint[service].position);
      await a.goto(runUrl, { waitUntil: 'load' });
    }
    const joint = await jointRows(a);
    for (const service of SERVICES)
      expect(joint[service].verdict, `svc-${service}: stamp ${joint[service].stamp}, live ${joint[service].position}`).toBe('Agrees');
    await a.getByTestId('step-validate').click();
    await expect(a.getByTestId('step-preview')).toBeVisible({ timeout: 30_000 });
    await a.getByTestId('step-preview').click();
    const finalize = a.getByTestId('finalize-form');
    await expect(finalize).toBeVisible({ timeout: 30_000 });
    await expect(a.getByTestId('restored')).toHaveText('No');

    // One approver: A cannot approve their own finalize, and a run before anyone approved restores nothing.
    const phrase = `FINALIZE RESTORE ${RUN}`;
    await finalize.getByLabel(/to confirm$/).fill(phrase);
    await finalize.getByRole('button', { name: 'Ask a second founder to approve finalizing this restore' }).click();
    await expect(finalize.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
    const packetText = (await finalize.getByLabel('Request packet').inputValue()).trim();
    const packet = decode(packetText);
    const self = await approvalStep(a, { step: 'approve', request: packet.request, confirm: phrase, approvalId: packet.approvalId });
    expect(self.body).toMatchObject({ ok: false, refusal: { code: 'action_approval.same_person' } });
    const early = await approvalStep(a, { step: 'execute', request: packet.request, confirm: phrase, ...pick(packet) });
    expect(early.body.ok).toBe(false);
    await a.reload({ waitUntil: 'load' });
    await expect(a.getByTestId('restored')).toHaveText('No');

    // The second founder approves the same run and cut-off; A runs it and the run is restored with all four rows.
    await b.goto(runUrl, { waitUntil: 'load' });
    const deskB = b.getByTestId('finalize-form');
    await deskB.getByLabel('Request packet').fill(packetText);
    await deskB.getByLabel(/to approve or run it$/).fill(phrase);
    await deskB.getByRole('button', { name: 'Approve this request' }).click();
    await expect(deskB.getByTestId('step-reply')).toContainText('Approved.', { timeout: 60_000 });
    const done = await approvalStep(a, { step: 'execute', request: packet.request, confirm: phrase, ...pick(packet) });
    expect(done.body, JSON.stringify(done.body)).toMatchObject({ ok: true, step: 'execute' });
  });
  await a.goto(runUrl, { waitUntil: 'load' });
  await expect(a.getByTestId('restored')).toHaveText('Yes, all four steps are recorded');
  const steps = a.getByTestId('step-row');
  await expect(steps).toHaveCount(4);
  for (const row of await steps.all()) await expect(row).toContainText('recorded by');
  await expect(steps.last()).toContainText(founders.founderA.userId);
});
