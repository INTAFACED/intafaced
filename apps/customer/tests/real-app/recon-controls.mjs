import { expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState, stackUrl, tool, toolAwaited } from './stack.mjs';
import { venueRecord } from './venue.mjs';

/** The TEST venue and TEST partner report stand-in on loopback (`local-test-rail-statements.mjs`), read directly via `venueRecord`. */
export const OWN_REPORTS = stackUrl('rail-statements');

/** Reads one TEST venue's or TEST partner's own report for `place` at `asOf` directly from loopback, never through our app. */
export async function ownReportRecord(reporter, place, asOf = new Date().toISOString()) {
  return (await venueRecord(place, '/report', { reporter, asOf }, OWN_REPORTS)).value;
}

/** One asset's signed amount from a TEST venue or partner report returned by `ownReportRecord`, or null when absent. */
export const reportAmount = (report, asset) => report?.balances?.find((b) => b.assetId === asset)?.amount ?? null;

/**
 * Seeds one of INTAFACED's own TEST obligations: writes the reporter's line first (unless `ledgerOnly` is true, to create
 * a genuine break between our ledger and the outside report), then books our ledger record through its real recipe.
 * Returns `{ out, tx }` where `tx` is the booked ledger transaction id.
 */
export async function seedOwnRecord(reporter, place, asset, amount, ref, { ledgerOnly = false } = {}) {
  const args = ['seed-own-record', reporter, place, asset, amount, '--ref', ref, ...(ledgerOnly ? ['--ledger-only'] : [])];
  const out = await toolAwaited('local-test-stack.mjs', ...args);
  const tx = out.match(/ledger tx ([0-9a-f-]{36})/i)?.[1] ?? null;
  return { out, tx };
}

/**
 * Renew a kept founder session before a step starts once fewer than 6 minutes remain before its 15-minute access token
 * expires, so a long serial journey never crosses the founder console's session expiry mid-step.
 */
export const SESSION_RENEW_BUFFER_MS = 6 * 60_000;

export const runId = (answer) => answer.match(/Run ([0-9a-f-]{36}): /)?.[1] ?? null;

/**
 * Keeps the two founders' console pages ('a' and 'b') signed in across serial steps.
 * The founder console seals each session cookie with identity's 15-minute access token expiry and redirects to /login
 * once it passes. Before each step starts, any session within `renewBeforeMs` of its `expiresAt` is signed in fresh on
 * the same page; a refused or unreadable sign-in fails immediately.
 */
export function createFounderSessionPool({
  openPage,
  signIn,
  readSession,
  now = () => Date.now(),
  renewBeforeMs = SESSION_RENEW_BUFFER_MS,
}) {
  const slots = { a: null, b: null };

  async function readExpiry(page, key) {
    const res = await readSession(page);
    const expiresAt = res?.body?.expiresAt;
    const expiresAtMs = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    if (res?.status !== 200 || !Number.isFinite(expiresAtMs)) {
      const code = res?.body?.upstream ?? res?.body?.code ?? 'no code';
      throw new Error(`founder ${key}'s session expiry could not be read from /api/session (${res?.status ?? 'no status'} ${code})`);
    }
    return expiresAtMs;
  }

  async function ensure(browser, key) {
    if (!slots[key]) {
      const page = await openPage(browser, key);
      await signIn(page, key);
      slots[key] = { page, expiresAtMs: await readExpiry(page, key) };
      return page;
    }
    if (slots[key].expiresAtMs - now() <= renewBeforeMs) {
      await signIn(slots[key].page, key);
      slots[key].expiresAtMs = await readExpiry(slots[key].page, key);
    }
    return slots[key].page;
  }

  return {
    async founders(browser) {
      const a = await ensure(browser, 'a');
      const b = await ensure(browser, 'b');
      return { a, b };
    },
    pages() {
      return { a: slots.a?.page ?? null, b: slots.b?.page ?? null };
    },
  };
}

async function readAdminSession(page) {
  await page.waitForLoadState('load');
  return page.evaluate(async () => {
    const res = await fetch('/api/session', { cache: 'no-store' });
    return { status: res.status, body: await res.json().catch(() => null) };
  });
}

export async function openLedger(page) {
  await page.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
  const section = page.getByTestId('reconciliation-controls');
  await expect(section.getByTestId('rc-table')).toBeVisible({ timeout: 60_000 });
  return section;
}

/** Stops the journey with the console's own words when its treasury doors are parked. */
export async function requireTreasury(section) {
  const parked = section.getByTestId('rc-treasury-parked');
  if (await parked.isVisible())
    throw new Error(`the console's treasury doors are parked: ${(await parked.innerText()).replace(/\s+/g, ' ')}`);
}

export function row(section, id) {
  return section.locator(`[data-testid="rc-row"][data-control-id="${id}"]`);
}

export async function choose(section, id) {
  await row(section, id)
    .getByRole('button', { name: /^Choose|^Chosen/ })
    .click();
  await expect(section.getByTestId('rc-selected').getByRole('heading')).toHaveText(`Control ${id.slice(0, 8)}`);
}

export async function setPolicy(form, { tolerance = '0', activate = true } = {}) {
  await form.getByLabel('Cadence').selectOption('daily');
  await form.getByLabel('Hour (UTC)').fill('6');
  await form.getByLabel('Minute').fill('30');
  await form.getByLabel('Severity').selectOption('warning');
  await form.getByLabel(/^Tolerance \(blank/).fill(tolerance);
  if (activate) await form.getByRole('checkbox').check();
}

/**
 * Sends one approval step for a packet straight to the console's own route, as the signed-in founder on `page`, the way the
 * workbench sends it (an execute carries the packet's operation id), and returns the console's JSON answer. Used where the
 * workbench itself holds the button.
 */
export async function consoleStep(page, endpoint, packetText, step, confirm) {
  const packet = JSON.parse(Buffer.from(packetText.slice('ifa1.'.length), 'base64url').toString('utf8'));
  return page.evaluate(
    async ({ endpoint, request, approvalId, operationId, step, confirm }) => {
      const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
        body: JSON.stringify({ step, request, confirm, approvalId, ...(step === 'execute' ? { operationId } : {}) }),
        cache: 'no-store',
      });
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        return { status: res.status, body: text };
      }
    },
    { endpoint, request: packet.request, approvalId: packet.approvalId, operationId: packet.operationId, step, confirm },
  );
}

/**
 * Proposes one request straight to the console's route as the founder on `page`, the way the desk would, and returns the
 * console's JSON answer (a packet when it was made). Used where the desk itself holds the request button, so consoleStep,
 * which starts from a packet, can take the approve and run steps.
 */
export async function consolePropose(page, endpoint, request, confirm) {
  return page.evaluate(
    async ({ endpoint, request, confirm }) => {
      const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
        body: JSON.stringify({ step: 'propose', request, confirm }),
        cache: 'no-store',
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { endpoint, request, confirm },
  );
}

/** A runs an approved request on their run desk and returns the service's answer as the desk shows it. */
export async function runApproved(desk, phrase) {
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  const reply = desk.getByTestId('step-reply');
  await expect(reply).toContainText(/The service answered|Code: /, { timeout: 60_000 });
  return (await reply.innerText()).replace(/\s+/g, ' ');
}

/**
 * svc-ledger restarted reading its outside side from an address nothing answers, or back on the stack's default (no snapshot
 * published, so unset). "Unreachable" is written to its own state file before the restart, so a run cancelled in between is
 * put back by the next run's first hook.
 */
const outsideSource = journeyState('J-ops-console-07-outside');
export function ledgerOutside(unreachable) {
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

export const putOutsideBack = () => {
  if (outsideSource.read().unreachable) ledgerOutside(false);
};

/** One asset's top-level evidence as the run reply prints it (never a per-reporter sub-line). */
export function evidence(answer, assetId) {
  const num = '(-?\\d+(?:\\.\\d+)?|unset)';
  const all = [
    ...answer.matchAll(new RegExp(`(?:^|\\. )${assetId}: observed ${num}, expected ${num}, difference ${num}, tolerance ${num}\\.`, 'g')),
  ];
  if (all.length !== 1) throw new Error(`the run shows ${all.length} ${assetId} evidence lines, not exactly one: ${answer}`);
  const [m] = all;
  return { observed: m[1], expected: m[2], difference: m[3], tolerance: m[4] };
}

/** The control's stored evaluation for a run, re-read from a fresh /ledger page: its status must be `status`; returns its text. */
export async function storedRun(page, controlId, answer, status) {
  const section = await openLedger(page);
  await choose(section, controlId);
  const stored = section.getByTestId('rc-runs').locator(`[data-testid="rc-run-row"][data-run-id="${runId(answer)}"]`);
  await expect(stored, `the stored evaluation of run ${runId(answer)}`).toHaveAttribute('data-status', status, { timeout: 30_000 });
  return (await stored.innerText()).replace(/\s+/g, ' ');
}

/** A decimal string as a bigint scaled by 10^18, so evidence is compared exactly. */
export function scaled(text) {
  const [whole, frac = ''] = text.replace(/^-/, '').split('.');
  const value = BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
  return text.startsWith('-') ? -value : value;
}

/**
 * The console's alerts room, read fresh. svc-ops reads an evaluation once the ledger has held it for its settle window and its
 * next tick runs, so callers poll. The room must say it read the ledger: a failed read is never taken as "no alert".
 */
export async function openAlerts(page) {
  await page.goto(`${ADMIN}/ledger/alerts`, { waitUntil: 'load' });
  const room = page.getByTestId('recon-alerts');
  await expect(room.getByTestId('alert-source')).toHaveAttribute('data-status', 'ok', { timeout: 30_000 });
  return room;
}

/** The alert rows of one control, as {id, asset, state, occurrences, periodStart, cause, team}, read from a fresh room. */
export async function alertsOf(page, controlId) {
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
export async function awaitAlerts(page, controlId, want, message) {
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
export async function openAlert(page, alertId) {
  await page.goto(`${ADMIN}/ledger/alerts/${alertId}`, { waitUntil: 'load' });
  const detail = page.getByTestId('alert-detail');
  await expect(detail).toBeVisible({ timeout: 30_000 });
  return detail;
}

/**
 * Per-file founder sessions and two-founder reconciliation control actions (define, run, pause/resume/retire), bound to
 * one run `tag` and backed by `createFounderSessionPool` so kept sessions renew before their 15-minute expiry.
 */
export function createReconDesk(tag) {
  const pool = createFounderSessionPool({
    openPage: async (browser) => (await browser.newContext()).newPage(),
    signIn: (page, key) => founderSignIn(page, key),
    readSession: readAdminSession,
  });

  function both() {
    const { a, b } = pool.pages();
    if (!a || !b) throw new Error('call founders(browser) before running a two-founder reconciliation action');
    return { a, b };
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

  /**
   * Founder A asks for a run and founder B approves the packet on their own console. Returns the packet and its phrase, so A
   * can run it now or later.
   */
  async function approvedRun(controlId, { instant = '', margin = '' } = {}) {
    const { a, b } = both();
    const sectionA = await openLedger(a);
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

    const deskB = (await openLedger(b)).getByTestId('rc-run');
    await deskB.getByLabel('Request packet').fill(packetText);
    await expect(deskB.getByTestId('packet-summary')).toContainText(`Run reconciliation control ${controlId}`);
    await deskB.getByLabel(/to approve or run it$/).fill(phrase);
    await deskB.getByRole('button', { name: 'Approve this request' }).click();
    await expect(deskB.getByTestId('step-reply')).toContainText('Approved.', { timeout: 30_000 });
    return { desk, phrase, packetText };
  }

  /** Founder A asks for a run, founder B approves it, and A runs it. Returns the service's answer as shown on A's desk. */
  async function twoFounderRun(controlId, opts) {
    const { desk, phrase } = await approvedRun(controlId, opts);
    return runApproved(desk, phrase);
  }

  /**
   * Pause, resume or retire a control with two founders: A asks on the lifecycle desk, B approves the packet on their own console,
   * and A runs it. Waits until A's desk shows the service's answer naming the new state, then until the list shows it too.
   */
  async function lifecycle(id, move, label) {
    const { a, b } = both();
    const sectionA = await openLedger(a);
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

    const deskB = (await openLedger(b)).getByTestId('rc-lifecycle');
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

  return {
    founders: pool.founders,
    pages: pool.pages,
    define,
    approvedRun,
    twoFounderRun,
    lifecycle,
  };
}
