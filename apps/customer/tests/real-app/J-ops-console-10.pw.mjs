import { expect, test } from './journey.mjs';
import { randomBytes } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { staffSignIn } from './staff.mjs';

// J-ops-console-10: change a sensitive setting safely and switch a feature on. Independent tests (OWNER 212), written from
// the step's words only, one per step, titled "J-ops-console-10 #<n>". Each test runs on its own (no serial chain), so one
// unbuilt step never hides another.
//
// Founder A and founder B sign in with the stack's TEST founder pair; the break-glass holder is the TEST staff member of
// the `risk` role (staffSignIn), whom founder A names on the change policy page. Every switch name and reason is TEST.
//
// What already exists on main, and is used as it is: the module kill desk's two-founder steps (`/api/kill-switch`:
// propose, approve, execute, with identity binding the approval to the payload hash) and the read-only change policy page
// (`/changes/policy`). Everything else the steps name is addressed by the data-testid it must carry; a surface that is not
// there yet fails at once with its name.

const J = 'J-ops-console-10';
const tag = randomBytes(3).toString('hex');
/** A module on the edge perimeter, so a kill is enforced; resumed after each step that halts it. */
const MODULE = 'blueprint';
const SOON = 5_000;

const decode = (packetText) => JSON.parse(Buffer.from(packetText.trim().slice('ifa1.'.length), 'base64url').toString('utf8'));

/** One step of a two-founder module kill request, as the person signed in on `page` (the console's own CSRF header). */
const killStep = (page, body) =>
  page.evaluate(async (payload) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/kill-switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, body);

const killRequest = (module, disabled, reason) => ({ kind: 'edge.kill', module, disabled, reason });
const killPhrase = (request) => (request.disabled ? `KILL ${request.module}` : `RE-ENABLE ${request.module}`);

/** The edge's killed-module set, read through the console. */
async function killedModules(page) {
  const state = await page.evaluate(async () => (await fetch('/api/kill-switch', { cache: 'no-store' })).json());
  const killed = state?.snapshot?.disabledModules;
  expect(Array.isArray(killed), `the kill-switch read returned no killed set: ${JSON.stringify(state).slice(0, 300)}`).toBe(true);
  return killed;
}

/** A asks, B approves, A runs: module `module` killed (`disabled`) or re-enabled. */
async function twoFounderKill(a, b, module, disabled, reason) {
  const request = killRequest(module, disabled, reason);
  const confirm = killPhrase(request);
  const proposed = await killStep(a, { step: 'propose', request, confirm });
  expect(proposed.body?.ok, JSON.stringify(proposed.body)).toBe(true);
  const packet = decode(proposed.body.packet);
  const approved = await killStep(b, { step: 'approve', request, confirm, approvalId: packet.approvalId });
  expect(approved.body?.ok, JSON.stringify(approved.body)).toBe(true);
  const ran = await killStep(a, { step: 'execute', request, confirm, approvalId: packet.approvalId, operationId: packet.operationId });
  expect(ran.body?.ok, JSON.stringify(ran.body)).toBe(true);
}

async function founders(browser) {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const founderA = await founderSignIn(a, 'a');
  const founderB = await founderSignIn(b, 'b');
  await a.goto(`${ADMIN}/`, { waitUntil: 'load' });
  await b.goto(`${ADMIN}/`, { waitUntil: 'load' });
  return { a, b, founderA, founderB };
}

/** Leave MODULE running for the journeys after this one, whatever a step did. */
async function resume(a, b, module = MODULE) {
  if ((await killedModules(a)).includes(module)) await twoFounderKill(a, b, module, false, `TEST ${J} resume ${module} ${tag}`);
}

/** The /launch switch board row for `key` in environment `env` ('test' or 'production'). */
async function launchBoard(page, env) {
  await page.goto(`${ADMIN}/launch`, { waitUntil: 'load' });
  const board = page.getByTestId('launch-switches');
  await expect(board, 'the /launch page has no switch board with visible and wired states yet (OPS-launch-flags-01)').toBeVisible({
    timeout: SOON,
  });
  await board.getByLabel('Environment').selectOption(env);
  return board;
}

/** The switch editor for one switch (strategies, constraints, parent, lifetime), opened from the board. */
async function switchEditor(page, key, env = 'test') {
  const board = await launchBoard(page, env);
  await board.getByTestId('switch-row').filter({ hasText: key }).getByRole('link', { name: key }).click();
  const editor = page.getByTestId('switch-editor');
  await expect(editor).toBeVisible();
  return editor;
}

/** Evaluates `context` for switch `key` through the console's evaluation read (the same read the edge answers clients with). */
const evaluate = (page, body) =>
  page.evaluate(async (payload) => {
    const res = await fetch('/api/switches/evaluate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, body);

/** A new TEST switch on the board in test, made through the board's own form. Returns its key. */
async function newSwitch(page, name) {
  const board = await launchBoard(page, 'test');
  const key = `test.${name}.${tag}`;
  const form = board.getByTestId('switch-create');
  await form.getByLabel('Switch name').fill(key);
  await form.getByRole('button', { name: 'Add switch' }).click();
  await expect(board.getByTestId('switch-row').filter({ hasText: key })).toBeVisible();
  return key;
}

// ── #1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`${J} #1 two approvals set for a switch and one given: the change is refused; the approval is bound to its payload and a changed payload invalidates it`, async ({
  browser,
}) => {
  const { a, b } = await founders(browser);
  try {
    // The founder SETS the switch's approval count to two.
    await a.goto(`${ADMIN}/changes/policy`, { waitUntil: 'load' });
    const row = a.getByTestId('policy-row').filter({ hasText: 'edge.kill' });
    await expect(row).toBeVisible();
    const set = row.getByTestId('policy-approvals-set');
    await expect(set, "the change policy page has no control to set a switch's approval count yet (OPS-change-control-01)").toBeVisible({
      timeout: SOON,
    });
    await set.getByLabel('Approvals').fill('2');
    await set.getByRole('button', { name: 'Save' }).click();
    await expect(row).toContainText('2 other than the requester');

    // One approval given: the change is refused and the module keeps running.
    const request = killRequest(MODULE, true, `TEST ${J} #1 one approval ${tag}`);
    const confirm = killPhrase(request);
    const proposed = await killStep(a, { step: 'propose', request, confirm });
    expect(proposed.body?.ok, JSON.stringify(proposed.body)).toBe(true);
    const packet = decode(proposed.body.packet);
    const first = await killStep(b, { step: 'approve', request, confirm, approvalId: packet.approvalId });
    expect(first.body?.ok, JSON.stringify(first.body)).toBe(true);
    const oneOnly = await killStep(a, {
      step: 'execute',
      request,
      confirm,
      approvalId: packet.approvalId,
      operationId: packet.operationId,
    });
    expect(oneOnly.body?.ok, `one of two approvals ran the change: ${JSON.stringify(oneOnly.body)}`).toBe(false);
    expect(await killedModules(a)).not.toContain(MODULE);

    // The approval is bound to its payload: approving a changed payload is refused, and running a changed payload is refused.
    const fresh = await killStep(a, { step: 'propose', request: { ...request, reason: `${request.reason} again` }, confirm });
    expect(fresh.body?.ok, JSON.stringify(fresh.body)).toBe(true);
    const freshPacket = decode(fresh.body.packet);
    const changed = { ...request, reason: `TEST ${J} #1 a different reason ${tag}` };
    const approveChanged = await killStep(b, { step: 'approve', request: changed, confirm, approvalId: freshPacket.approvalId });
    expect(approveChanged.body?.ok, JSON.stringify(approveChanged.body)).toBe(false);
    expect(JSON.stringify(approveChanged.body)).toContain('payload_mismatch');
    const runChanged = await killStep(a, {
      step: 'execute',
      request: changed,
      confirm,
      approvalId: packet.approvalId,
      operationId: packet.operationId,
    });
    expect(runChanged.body?.ok, `a changed payload ran on an approval for another: ${JSON.stringify(runChanged.body)}`).toBe(false);
    expect(await killedModules(a)).not.toContain(MODULE);
  } finally {
    await resume(a, b);
  }
});

// ── #2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`${J} #2 a break-glass holder turns a switch off with a reason: it halts, the other founders are notified and audited; the same person enabling is refused; blank break-glass means nobody can use it`, async ({
  browser,
}) => {
  const { a, b } = await founders(browser);
  const holderPage = await (await browser.newContext()).newPage();
  const holder = await staffSignIn(holderPage, browser, 'risk');
  const reason = `TEST ${J} #2 break glass ${tag}`;
  try {
    // Founder A names the holder.
    await a.goto(`${ADMIN}/changes/policy`, { waitUntil: 'load' });
    const glass = a.getByTestId('break-glass');
    await expect(glass, 'the console has no break-glass holder setting yet (OPS-change-control-01)').toBeVisible({ timeout: SOON });
    await glass.getByLabel('Break-glass holder').fill(holder.email);
    await glass.getByRole('button', { name: 'Save' }).click();
    await expect(glass.getByTestId('break-glass-holder')).toContainText(holder.email);

    // The holder turns the switch off alone, with a reason: it halts.
    await holderPage.goto(`${ADMIN}/`, { waitUntil: 'load' });
    const desk = holderPage.getByTestId('break-glass-desk');
    await expect(desk).toBeVisible();
    await desk.getByLabel('Switch').selectOption(MODULE);
    await desk.getByLabel(/^Reason/).fill(reason);
    await desk.getByRole('button', { name: 'Turn off now' }).click();
    await expect(desk.getByTestId('step-reply')).toContainText('Turned off');
    expect(await killedModules(a)).toContain(MODULE);

    // The other founders are notified (both of them) and the audit entry exists with the holder and the reason.
    for (const page of [a, b]) {
      await page.goto(`${ADMIN}/`, { waitUntil: 'load' });
      await expect(page.getByTestId('break-glass-notice').filter({ hasText: MODULE })).toContainText(reason);
    }
    await a.goto(`${ADMIN}/changes/audit`, { waitUntil: 'load' });
    const entry = a.getByTestId('audit-row').filter({ hasText: reason });
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText(holder.email);
    await expect(entry).toContainText(MODULE);

    // The same person enabling a feature is refused.
    await desk.getByLabel('Switch').selectOption(MODULE);
    await desk.getByLabel(/^Reason/).fill(`${reason} back on`);
    const enable = desk.getByRole('button', { name: 'Turn on' });
    if (await enable.count()) await enable.click();
    await expect(desk.getByTestId('step-reply')).toContainText('refused');
    expect(await killedModules(a)).toContain(MODULE);

    // With break-glass blank, nobody can use it: not the former holder, not a founder.
    await glass.getByLabel('Break-glass holder').fill('');
    await glass.getByRole('button', { name: 'Save' }).click();
    await expect(glass.getByTestId('break-glass-holder')).toContainText('not set');
    for (const page of [holderPage, a]) {
      await page.goto(`${ADMIN}/`, { waitUntil: 'load' });
      const blank = page.getByTestId('break-glass-desk');
      await expect(blank.getByRole('button', { name: 'Turn off now' })).toBeDisabled();
      await expect(blank).toContainText('not set');
    }
  } finally {
    await resume(a, b);
  }
});

// ── #3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`${J} #3 the parent kill switch on halts every child; resuming needs a second approver`, async ({ browser }) => {
  const { a, b } = await founders(browser);
  try {
    await a.goto(`${ADMIN}/`, { waitUntil: 'load' });
    const parent = a.getByTestId('parent-kill-switch');
    await expect(parent, 'the console has no parent kill switch over child switches yet (OPS-change-control-01)').toBeVisible({
      timeout: SOON,
    });
    const children = await parent.getByTestId('child-switch').allInnerTexts();
    expect(children.length, 'the parent lists no child switches').toBeGreaterThan(1);

    // Two founders turn the parent on: every child halts.
    await parent.getByLabel(/^Reason/).fill(`TEST ${J} #3 parent ${tag}`);
    await parent.getByRole('button', { name: 'Ask a second founder to approve the parent kill' }).click();
    const packetText = (await parent.getByLabel('Request packet').inputValue()).trim();
    await b.goto(`${ADMIN}/`, { waitUntil: 'load' });
    const parentB = b.getByTestId('parent-kill-switch');
    await parentB.getByLabel('Request packet').fill(packetText);
    await parentB.getByRole('button', { name: 'Approve this request' }).click();
    await expect(parentB.getByTestId('step-reply')).toContainText('Approved.');
    await parent.getByRole('button', { name: 'Run the approved request' }).click();
    await expect(parent.getByTestId('step-reply')).toContainText('Ran');
    const killed = await killedModules(a);
    for (const child of children) expect(killed, `child ${child} did not halt`).toContain(child.trim());

    // Resuming alone is refused; a second approver resumes it.
    await parent.getByLabel(/^Reason/).fill(`TEST ${J} #3 resume alone ${tag}`);
    await parent.getByRole('button', { name: 'Ask a second founder to approve resuming' }).click();
    await parent.getByRole('button', { name: 'Run the approved request' }).click();
    await expect(parent.getByTestId('step-reply')).toContainText('refused');
    const stillKilled = await killedModules(a);
    for (const child of children) expect(stillKilled).toContain(child.trim());
    const resumeText = (await parent.getByLabel('Request packet').inputValue()).trim();
    await parentB.getByLabel('Request packet').fill(resumeText);
    await parentB.getByRole('button', { name: 'Approve this request' }).click();
    await parent.getByRole('button', { name: 'Run the approved request' }).click();
    await expect(parent.getByTestId('step-reply')).toContainText('Ran');
    const after = await killedModules(a);
    for (const child of children) expect(after).not.toContain(child.trim());
  } finally {
    await resume(a, b);
  }
});

// ── #4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`${J} #4 on /launch a switch moved from visible to wired in test is held by the store and returned by the edge read; one approver is refused; a parked module stays visible with its blocker; a NOT_ENFORCED row offers no toggle`, async ({
  browser,
}) => {
  const { a, b } = await founders(browser);
  const board = await launchBoard(a, 'test');
  const row = board
    .getByTestId('switch-row')
    .filter({ has: a.getByTestId('switch-state').filter({ hasText: 'visible' }) })
    .first();
  await expect(row).toBeVisible();
  const key = (await row.getByTestId('switch-key').innerText()).trim();

  // One approver is refused.
  await row.getByRole('button', { name: 'Move to wired' }).click();
  await board.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(board.getByTestId('step-reply')).toContainText('refused');
  await expect(row.getByTestId('switch-state')).toHaveText('visible');

  // With a second founder's approval it moves: the store holds it and the edge read returns it.
  const packetText = (await board.getByLabel('Request packet').inputValue()).trim();
  const boardB = await launchBoard(b, 'test');
  await boardB.getByLabel('Request packet').fill(packetText);
  await boardB.getByRole('button', { name: 'Approve this request' }).click();
  await expect(boardB.getByTestId('step-reply')).toContainText('Approved.');
  await board.getByRole('button', { name: 'Run the approved request' }).click();
  await a.reload({ waitUntil: 'load' });
  await expect((await launchBoard(a, 'test')).getByTestId('switch-row').filter({ hasText: key }).getByTestId('switch-state')).toHaveText(
    'wired',
  );
  const edge = await evaluate(a, { env: 'test', key, context: {} });
  expect(edge.status, JSON.stringify(edge.body)).toBe(200);
  expect(edge.body?.state).toBe('wired');

  // A parked module stays visible, with its blocker.
  const parked = board
    .getByTestId('switch-row')
    .filter({ has: a.getByTestId('switch-state').filter({ hasText: 'parked' }) })
    .first();
  await expect(parked).toBeVisible();
  await expect(parked.getByTestId('switch-blocker')).not.toBeEmpty();

  // A NOT_ENFORCED row says it enforces nothing and offers no toggle.
  const unenforced = board.getByTestId('switch-row').filter({ hasText: 'NOT_ENFORCED' }).first();
  await expect(unenforced).toBeVisible();
  await expect(unenforced).toContainText('enforces nothing');
  await expect(unenforced.getByRole('button')).toHaveCount(0);
  await expect(unenforced.getByRole('checkbox')).toHaveCount(0);
  await expect(unenforced.getByRole('switch')).toHaveCount(0);
});

// ── #5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`${J} #5 the same change in production becomes a change request and applies only when approved; a restart leaves every state unchanged`, async ({
  browser,
}) => {
  const { a, b } = await founders(browser);
  const board = await launchBoard(a, 'production');
  const row = board
    .getByTestId('switch-row')
    .filter({ has: a.getByTestId('switch-state').filter({ hasText: 'visible' }) })
    .first();
  const key = (await row.getByTestId('switch-key').innerText()).trim();
  const statesBefore = await board.getByTestId('switch-row').allInnerTexts();

  await row.getByRole('button', { name: 'Move to wired' }).click();
  const cr = a.getByTestId('change-request');
  await expect(cr).toBeVisible();
  await expect(cr).toContainText(key);
  await expect(cr.getByTestId('change-request-status')).toHaveText('In review');
  await expect(row.getByTestId('switch-state')).toHaveText('visible');
  expect((await evaluate(a, { env: 'production', key, context: {} })).body?.state).toBe('visible');

  // Approved by the second founder, it applies.
  const id = (await cr.getByTestId('change-request-id').innerText()).trim();
  await b.goto(`${ADMIN}/changes/${id}`, { waitUntil: 'load' });
  await b.getByRole('button', { name: 'Approve' }).click();
  await a.goto(`${ADMIN}/changes/${id}`, { waitUntil: 'load' });
  await a.getByRole('button', { name: 'Apply' }).click();
  await expect(a.getByTestId('change-request-status')).toHaveText('Applied');
  expect((await evaluate(a, { env: 'production', key, context: {} })).body?.state).toBe('wired');

  // A restart of the switch store leaves every state as it was.
  const before = await (await launchBoard(a, 'production')).getByTestId('switch-row').allInnerTexts();
  expect(before).not.toEqual(statesBefore);
  const { tool } = await import('./stack.mjs');
  tool('local-test-stack.mjs', 'restart', 'ops');
  await expect
    .poll(async () => (await launchBoard(a, 'production')).getByTestId('switch-row').allInnerTexts(), { timeout: 120_000 })
    .toEqual(before);
});

// ── #6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`${J} #6 a partial rollout with a group id and a schedule: stable per subject, a new group id reshuffles, no subject id is off, on-after-a-time flips, blank percentage gives ops.switch_strategy_unset`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  const key = await newSwitch(page, 'rollout');
  const editor = await switchEditor(page, key);
  const strategy = editor.getByTestId('strategy-partial-rollout');
  await editor.getByRole('button', { name: 'Add strategy' }).click();
  await editor.getByLabel('Strategy').selectOption('partial-rollout');

  // A blank percentage is refused by name.
  await strategy.getByLabel('Group id').fill(`group-a-${tag}`);
  await strategy.getByLabel('Percentage').fill('');
  await strategy.getByRole('button', { name: 'Save strategy' }).click();
  await expect(strategy.getByTestId('strategy-refused')).toContainText('ops.switch_strategy_unset');

  await strategy.getByLabel('Percentage').fill('50');
  await strategy.getByRole('button', { name: 'Save strategy' }).click();
  await expect(strategy.getByTestId('strategy-saved')).toBeVisible();

  // The same subject always gets the same result.
  const subjects = Array.from({ length: 40 }, (_, i) => `subject-${i}-${tag}`);
  const run = async () => {
    const out = [];
    for (const subject of subjects) out.push((await evaluate(page, { env: 'test', key, context: { subjectId: subject } })).body?.enabled);
    return out;
  };
  const first = await run();
  expect(
    first.every((v) => typeof v === 'boolean'),
    JSON.stringify(first),
  ).toBe(true);
  expect(await run()).toEqual(first);
  expect(first.some(Boolean) && first.some((v) => !v), 'a 50% rollout split 40 subjects all one way').toBe(true);

  // A new group id reshuffles.
  await strategy.getByLabel('Group id').fill(`group-b-${tag}`);
  await strategy.getByRole('button', { name: 'Save strategy' }).click();
  expect(await run()).not.toEqual(first);

  // No subject id means off.
  expect((await evaluate(page, { env: 'test', key, context: {} })).body?.enabled).toBe(false);

  // "On after a time" is off before the time and on after it.
  await editor.getByRole('button', { name: 'Add strategy' }).click();
  await editor.getByLabel('Strategy').selectOption('on-after');
  const after = editor.getByTestId('strategy-on-after');
  const at = new Date(Date.now() + 24 * 3600_000).toISOString();
  await after.getByLabel('On after').fill(at);
  await after.getByRole('button', { name: 'Save strategy' }).click();
  const ctx = { subjectId: subjects[0] };
  expect(
    (await evaluate(page, { env: 'test', key, context: { ...ctx, currentTime: new Date(Date.parse(at) - 60_000).toISOString() } })).body
      ?.enabled,
  ).toBe(false);
  expect(
    (await evaluate(page, { env: 'test', key, context: { ...ctx, currentTime: new Date(Date.parse(at) + 60_000).toISOString() } })).body
      ?.enabled,
  ).toBe(true);
});

// ── #7 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`${J} #7 constraints on country, address and hostname and a segment: a missing field is false, a negated constraint inverts, a segment in use cannot retire, blank limits give ops.switch_limit_unset`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  const key = await newSwitch(page, 'constraints');
  const editor = await switchEditor(page, key);
  const constraints = editor.getByTestId('switch-constraints');
  await expect(constraints).toBeVisible();

  const add = async (field, operator, value, negated = false) => {
    await constraints.getByRole('button', { name: 'Add constraint' }).click();
    const row = constraints.getByTestId('constraint-row').last();
    await row.getByLabel('Field').selectOption(field);
    await row.getByLabel('Operator').selectOption(operator);
    await row.getByLabel('Values').fill(value);
    if (negated) await row.getByLabel('Negate').check();
  };
  await add('country', 'in', 'PT');
  await add('address', 'in', '0x0000000000000000000000000000000000000001');
  await add('hostname', 'in', 'test.local');
  await constraints.getByRole('button', { name: 'Save constraints' }).click();

  const full = { subjectId: `s-${tag}`, country: 'PT', address: '0x0000000000000000000000000000000000000001', hostname: 'test.local' };
  expect((await evaluate(page, { env: 'test', key, context: full })).body?.enabled).toBe(true);
  for (const field of ['country', 'address', 'hostname']) {
    const { [field]: _gone, ...missing } = full;
    expect((await evaluate(page, { env: 'test', key, context: missing })).body?.enabled, `missing ${field} was not false`).toBe(false);
  }

  // A negated constraint inverts.
  const country = constraints.getByTestId('constraint-row').first();
  await country.getByLabel('Negate').check();
  await constraints.getByRole('button', { name: 'Save constraints' }).click();
  expect((await evaluate(page, { env: 'test', key, context: full })).body?.enabled).toBe(false);
  expect((await evaluate(page, { env: 'test', key, context: { ...full, country: 'DE' } })).body?.enabled).toBe(true);

  // A segment in use cannot be retired.
  await page.goto(`${ADMIN}/launch/segments`, { waitUntil: 'load' });
  const segments = page.getByTestId('segments');
  const segment = `test-segment-${tag}`;
  await segments.getByLabel('Segment name').fill(segment);
  await segments.getByRole('button', { name: 'Add segment' }).click();
  const editorAgain = await switchEditor(page, key);
  await editorAgain.getByLabel('Segment').selectOption(segment);
  await editorAgain.getByRole('button', { name: 'Save constraints' }).click();
  await page.goto(`${ADMIN}/launch/segments`, { waitUntil: 'load' });
  await page.getByTestId('segment-row').filter({ hasText: segment }).getByRole('button', { name: 'Retire' }).click();
  await expect(page.getByTestId('segment-refused')).toContainText('ops.segment_in_use');
  await expect(page.getByTestId('segment-row').filter({ hasText: segment })).toBeVisible();

  // Blank limits give ops.switch_limit_unset.
  const limits = page.getByTestId('switch-limits');
  await expect(limits).toContainText('ops.switch_limit_unset');
});

// ── #8 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`${J} #8 a child linked to a parent is off whenever the parent is off; a cycle is refused; an unknown name a client asks for appears once with a count; connected applications are listed`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  const parent = await newSwitch(page, 'parent');
  const child = await newSwitch(page, 'child');
  const editor = await switchEditor(page, child);
  await editor.getByLabel('Parent switch').selectOption(parent);
  await editor.getByRole('button', { name: 'Save dependency' }).click();

  const parentEditor = await switchEditor(page, parent);
  await parentEditor.getByLabel('Enabled').uncheck();
  await parentEditor.getByRole('button', { name: 'Save' }).click();
  const childEditor = await switchEditor(page, child);
  await childEditor.getByLabel('Enabled').check();
  await childEditor.getByRole('button', { name: 'Save' }).click();
  expect((await evaluate(page, { env: 'test', key: child, context: { subjectId: `s-${tag}` } })).body?.enabled).toBe(false);

  // A cycle is refused.
  const back = await switchEditor(page, parent);
  await back.getByLabel('Parent switch').selectOption(child);
  await back.getByRole('button', { name: 'Save dependency' }).click();
  await expect(back.getByTestId('dependency-refused')).toContainText('cycle');

  // A client asking for an unknown name appears once, with its count.
  const unknown = `test.unknown.${tag}`;
  for (let i = 0; i < 3; i += 1) await evaluate(page, { env: 'test', key: unknown, context: {}, appName: `test-app-${tag}` });
  await page.goto(`${ADMIN}/launch/unknown`, { waitUntil: 'load' });
  const report = page.getByTestId('unknown-switch-row').filter({ hasText: unknown });
  await expect(report).toHaveCount(1);
  await expect(report.getByTestId('unknown-switch-count')).toHaveText('3');

  // Connected applications are listed.
  await page.goto(`${ADMIN}/launch/applications`, { waitUntil: 'load' });
  await expect(page.getByTestId('connected-application').filter({ hasText: `test-app-${tag}` })).toHaveCount(1);
});

// ── #9 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`${J} #9 the playground across two environments shows each row's reason; a missing field is unknown, not true; nothing is written, also against a pending change`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  const before = await (await launchBoard(page, 'test')).getByTestId('switch-row').allInnerTexts();
  await page.goto(`${ADMIN}/launch/playground`, { waitUntil: 'load' });
  const playground = page.getByTestId('switch-playground');
  await expect(playground, 'the console has no switch playground yet (OPS-launch-flags-05)').toBeVisible({ timeout: SOON });
  await playground.getByLabel('Environments').selectOption(['test', 'production']);
  await playground.getByLabel('Context').fill(JSON.stringify({ subjectId: `s-${tag}` }));
  await playground.getByRole('button', { name: 'Try' }).click();

  const rows = playground.getByTestId('playground-row');
  await expect(rows.first()).toBeVisible();
  const envs = new Set();
  for (const row of await rows.all()) {
    await expect(row.getByTestId('playground-reason')).not.toBeEmpty();
    envs.add((await row.getByTestId('playground-env').innerText()).trim());
  }
  expect([...envs].sort()).toEqual(['production', 'test']);

  // A field the context lacks reads unknown, never true.
  const needsField = rows.filter({ has: page.getByTestId('playground-missing-field') });
  await expect(needsField.first()).toBeVisible();
  for (const row of await needsField.all()) await expect(row.getByTestId('playground-result')).toHaveText('unknown');

  // Against a pending change too, and nothing is written.
  await playground.getByLabel('Against').selectOption({ label: 'Pending change' });
  await playground.getByRole('button', { name: 'Try' }).click();
  await expect(rows.first()).toBeVisible();
  expect(await (await launchBoard(page, 'test')).getByTestId('switch-row').allInnerTexts()).toEqual(before);
  await page.goto(`${ADMIN}/changes/audit`, { waitUntil: 'load' });
  await expect(page.getByTestId('audit-row').filter({ hasText: 'playground' })).toHaveCount(0);
});

// ── #10 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`${J} #10 three changes batched into one scheduled request with multi-stage approval: one request in review with an impact preview; an edit revokes approvals; a changed target suspends it with the reason; stage order holds and one person cannot approve two stages`, async ({
  browser,
}) => {
  const { a, b } = await founders(browser);
  const keys = [await newSwitch(a, 'batch1'), await newSwitch(a, 'batch2'), await newSwitch(a, 'batch3')];
  await a.goto(`${ADMIN}/changes/new`, { waitUntil: 'load' });
  const form = a.getByTestId('change-request-form');
  await expect(form, 'the console has no batched change request yet (OPS-change-control-02)').toBeVisible({ timeout: SOON });
  for (const key of keys) {
    await form.getByRole('button', { name: 'Add change' }).click();
    const change = form.getByTestId('change-item').last();
    await change.getByLabel('Switch').selectOption(key);
    await change.getByLabel('Enabled').check();
  }
  await form.getByLabel('Apply at').fill(new Date(Date.now() + 3600_000).toISOString().slice(0, 16));
  await form.getByLabel('Stages').fill('2');
  await form.getByRole('button', { name: 'Submit for review' }).click();

  const cr = a.getByTestId('change-request');
  await expect(cr.getByTestId('change-request-status')).toHaveText('In review');
  await expect(cr.getByTestId('change-item')).toHaveCount(3);
  await expect(cr.getByTestId('impact-preview')).toBeVisible();
  for (const key of keys) await expect(cr.getByTestId('impact-preview')).toContainText(key);
  const id = (await cr.getByTestId('change-request-id').innerText()).trim();
  await a.goto(`${ADMIN}/changes`, { waitUntil: 'load' });
  await expect(a.getByTestId('change-request-row').filter({ hasText: id })).toHaveCount(1);

  // Stage order is enforced: stage 2 before stage 1 is refused.
  await b.goto(`${ADMIN}/changes/${id}`, { waitUntil: 'load' });
  await b.getByTestId('stage-2').getByRole('button', { name: 'Approve' }).click();
  await expect(b.getByTestId('stage-refused')).toContainText('stage 1');

  // One person cannot approve two stages.
  await b.getByTestId('stage-1').getByRole('button', { name: 'Approve' }).click();
  await expect(b.getByTestId('stage-1')).toContainText('Approved');
  await b.getByTestId('stage-2').getByRole('button', { name: 'Approve' }).click();
  await expect(b.getByTestId('stage-refused')).toContainText('already approved');

  // An edit during review revokes approvals.
  await a.goto(`${ADMIN}/changes/${id}`, { waitUntil: 'load' });
  await a.getByTestId('change-item').first().getByLabel('Enabled').uncheck();
  await a.getByRole('button', { name: 'Save edit' }).click();
  await expect(a.getByTestId('stage-1')).not.toContainText('Approved');
  await expect(a.getByTestId('approvals-revoked')).toBeVisible();

  // A target changed before the scheduled time suspends the request, with the reason.
  const editor = await switchEditor(a, keys[1]);
  await editor.getByLabel('Enabled').check();
  await editor.getByRole('button', { name: 'Save' }).click();
  await a.goto(`${ADMIN}/changes/${id}`, { waitUntil: 'load' });
  await expect(a.getByTestId('change-request-status')).toHaveText('Suspended');
  await expect(a.getByTestId('suspended-reason')).toContainText(keys[1]);
});

// ── #11 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`${J} #11 stale switches: past lifetime is potentially stale, blank lifetime is not set; archive then revive returns it inactive; hard delete with one approver is refused; the debt rating equals the healthy share`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const stale = await newSwitch(a, 'stale');
  const unset = await newSwitch(a, 'unset');

  // A lifetime already past reads potentially stale; a blank one reads not set.
  const editor = await switchEditor(a, stale);
  await editor.getByLabel('Expected lifetime (days)').fill('0');
  await editor.getByRole('button', { name: 'Save' }).click();
  const board = await launchBoard(a, 'test');
  await expect(board.getByTestId('switch-row').filter({ hasText: stale }).getByTestId('switch-health')).toHaveText('potentially stale');
  await expect(board.getByTestId('switch-row').filter({ hasText: unset }).getByTestId('switch-lifetime')).toHaveText('not set');

  // Marked stale, archived, revived: it returns inactive.
  const row = board.getByTestId('switch-row').filter({ hasText: stale });
  await row.getByRole('button', { name: 'Mark stale' }).click();
  await row.getByRole('button', { name: 'Archive' }).click();
  await a.goto(`${ADMIN}/launch/archived`, { waitUntil: 'load' });
  await a.getByTestId('archived-row').filter({ hasText: stale }).getByRole('button', { name: 'Revive' }).click();
  const revived = (await launchBoard(a, 'test')).getByTestId('switch-row').filter({ hasText: stale });
  await expect(revived.getByTestId('switch-active')).toHaveText('inactive');

  // Hard delete with one approver is refused.
  await revived.getByRole('button', { name: 'Hard delete' }).click();
  await a.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(a.getByTestId('step-reply')).toContainText('refused');
  await expect((await launchBoard(a, 'test')).getByTestId('switch-row').filter({ hasText: stale })).toHaveCount(1);

  // The debt rating equals the healthy share of the snapshot.
  const all = await (await launchBoard(a, 'test')).getByTestId('switch-health').allInnerTexts();
  const healthy = all.filter((h) => h.trim() === 'healthy').length;
  const rating = (await a.getByTestId('switch-debt-rating').innerText()).trim();
  expect(rating).toBe(`${Math.round((healthy / all.length) * 100)}%`);
});
