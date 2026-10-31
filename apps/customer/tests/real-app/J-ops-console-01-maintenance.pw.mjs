import { expect, test } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-01 #9: founder A turns on maintenance mode and founder B approves the same packet on their own console. The
// banner shows, a console write refuses `ops.console_read_only`, reads still work and the posting freeze is as it was. Turning
// it off with one founder alone is refused; with B's approval it goes off again. The mode is svc-ops' own record
// (OPS-admin-access-08), so the test always leaves it off, even when a step fails.

const REASON = 'TEST journey J-ops-console-01 #9 maintenance window';
const ON_PHRASE = 'CONSOLE READ ONLY';
const OFF_PHRASE = 'CONSOLE WRITABLE';

/** svc-ops' mode, read through the console as the signed-in founder. */
async function modeOf(page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/console-mode', { cache: 'no-store' });
    return res.ok ? (await res.json()).view : null;
  });
}

/** A console write from this page, with its CSRF token: the BFF's answer as { status, body }. */
async function tryWrite(page) {
  return page.evaluate(async () => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/crm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify({
        action: 'addNote',
        input: { opportunityId: crypto.randomUUID(), note: 'TEST note', requestId: crypto.randomUUID() },
      }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  });
}

/** One founder asks for the change; returns the packet text once the console has made it. */
async function ask(page, phrase, reason) {
  await page.goto(`${ADMIN}/tools/console-mode`, { waitUntil: 'load' });
  const desk = page.getByTestId('control-desk');
  if (reason) await desk.getByLabel(/^Why the console goes read-only/).fill(reason);
  await desk.getByLabel(/to confirm$/).fill(phrase);
  await desk.getByRole('button', { name: /^Ask a second founder to approve turning it/ }).click();
  await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  return (await desk.getByLabel('Request packet').inputValue()).trim();
}

/** The other founder approves that exact packet on their own console. */
async function approve(page, packetText, phrase, summary) {
  await page.goto(`${ADMIN}/tools/console-mode`, { waitUntil: 'load' });
  const desk = page.getByTestId('control-desk');
  await desk.getByLabel('Request packet').fill(packetText);
  await expect(desk.getByTestId('packet-summary')).toContainText(summary);
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Approve this request' }).click();
  await expect(desk.getByTestId('step-reply')).toContainText('Approved.', { timeout: 60_000 });
}

async function run(page, phrase) {
  const desk = page.getByTestId('control-desk');
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  return desk.getByTestId('step-reply');
}

test('J-ops-console-01 #9 maintenance mode with a second approver: banner, writes refuse, reads work, the posting freeze is untouched', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  await founderSignIn(b, 'b');

  // Found from the command palette like any page.
  await a.goto(`${ADMIN}/crm`, { waitUntil: 'load' });
  await expect(a.getByRole('button', { name: /^Search/ })).toBeEnabled();
  await a.keyboard.press('Control+k');
  await a.keyboard.type('maintenance mode');
  await a.keyboard.press('Enter');
  await a.waitForURL((url) => url.pathname === '/tools/console-mode', { timeout: 60_000 });
  await expect(a.getByRole('heading', { level: 1, name: 'Maintenance mode' })).toBeVisible();

  const before = await modeOf(a);
  expect(before?.kind, 'svc-ops keeps the console mode on this stack').toBe('read');
  expect(before.mode.readOnly, 'a previous run left maintenance mode on').toBe(false);
  await expect(a.getByTestId('console-mode-state')).toHaveAttribute('data-state', 'off');
  await expect(a.getByTestId('console-mode-banner')).toHaveCount(0);
  const freezeBefore = await a.evaluate(async () => (await fetch('/api/ledger-freeze', { cache: 'no-store' })).json());
  expect(freezeBefore.ok, 'the console reads the posting record on this stack').toBe(true);

  try {
    // A asks, B approves the same packet, A runs it.
    const onPacket = await ask(a, ON_PHRASE, REASON);
    await expect(a.getByTestId('control-desk').getByRole('button', { name: 'Approve this request' })).toBeDisabled();
    await approve(b, onPacket, ON_PHRASE, 'maintenance mode');
    await expect(await run(a, ON_PHRASE)).toContainText('maintenance mode is on', { timeout: 60_000 });

    // The banner shows on every page, with the reason.
    await a.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
    const banner = a.getByTestId('console-mode-banner');
    await expect(banner).toHaveAttribute('data-state', 'on');
    await expect(banner).toContainText('this console is read-only');
    await expect(banner).toContainText(REASON);
    // Reads still work: the ledger page renders its posting record.
    await expect(a.getByTestId('ledger-lookup')).toBeVisible();

    // A console write refuses before it reaches any service.
    const write = await tryWrite(a);
    expect(write).toEqual({ status: 423, body: { code: 'ops.console_read_only' } });

    // The posting freeze is unchanged: maintenance mode never touches the ledger.
    const freezeDuring = await a.evaluate(async () => (await fetch('/api/ledger-freeze', { cache: 'no-store' })).json());
    expect(freezeDuring).toEqual(freezeBefore);

    // Turning it off with one founder alone is refused, and the mode stays on.
    await ask(a, OFF_PHRASE, null);
    await expect(a.getByTestId('control-desk').getByRole('button', { name: 'Approve this request' })).toBeDisabled();
    const alone = await run(a, OFF_PHRASE);
    await expect(alone).toContainText('has not approved this yet', { timeout: 60_000 });
    expect((await modeOf(a)).mode.readOnly).toBe(true);
  } finally {
    // B approves turning it off and A runs it: the console takes writes again, whatever happened above.
    if ((await modeOf(a))?.mode?.readOnly) {
      const offPacket = await ask(a, OFF_PHRASE, null);
      await approve(b, offPacket, OFF_PHRASE, 'maintenance mode');
      await expect(await run(a, OFF_PHRASE)).toContainText('maintenance mode is off', { timeout: 60_000 });
    }
  }
  expect((await modeOf(a)).mode.readOnly).toBe(false);
  await a.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
  await expect(a.getByTestId('console-mode-banner')).toHaveCount(0);
  expect((await tryWrite(a)).body?.code).not.toBe('ops.console_read_only');
});
