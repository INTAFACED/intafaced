import { expect, test } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-01 #4: one module's service page at /health/:module. Founder A opens the ledger from the module health
// board, names its owner team, dependencies and runbook, and sees them on the page with who is on call, open incidents,
// alerts, objectives and dashboards each in its own panel. Panels with no source in this build (on call among them) refuse
// on their own with the blocker while the rest show. A module nobody has set reads "owner not set". The record is svc-ops'
// own (OPS-service-health-01), so the test clears what it set, even when a step fails.

const RUN = `TEST platform ${Date.now().toString(36)}`;
const RUNBOOK = 'docs/runbooks/INCIDENT-MONEY-PATH-RUNBOOK.md';

/** One console change from this page, with its CSRF token: the BFF's answer as { status, body }. */
async function post(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { path, body },
  );
}

test('J-ops-console-01 #4 a module service page: owner, on call, dependencies, runbook, incidents, alerts, objectives, dashboards', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  await founderSignIn(b, 'b');
  /** What the ledger's record held before this run, put back at the end. */
  let before = null;

  try {
    // From the board to the ledger's service page.
    await a.goto(`${ADMIN}/health`, { waitUntil: 'load' });
    const boardState = await a.getByTestId('health-ledger').getAttribute('data-state');
    await a.getByTestId('health-ledger').getByRole('link', { name: 'Ledger', exact: true }).click();
    await a.waitForURL((url) => url.pathname === '/health/ledger', { timeout: 60_000 });
    const page = a.getByTestId('service-page');
    await expect(page.getByRole('heading', { level: 1, name: 'Ledger: service page' })).toBeVisible();
    const form = a.getByTestId('service-record-form');
    before = {
      owner: await form.getByLabel('Owner team').inputValue(),
      runbook: await form.getByLabel(/^Runbook/).inputValue(),
      deps: await form.getByRole('checkbox', { checked: true }).evaluateAll((boxes) => boxes.map((b) => b.value)),
    };

    // A runbook outside docs/runbooks/ is refused by name, and nothing changes.
    await form.getByLabel('Owner team').fill(RUN);
    await form.getByLabel(/^Runbook/).fill('https://evil.example/runbook.md');
    await form.getByRole('button', { name: 'Save the service record' }).click();
    await expect(form.getByTestId('service-record-outcome')).toHaveAttribute('data-code', 'ops.service_record_invalid');

    await form.getByLabel(/^Runbook/).fill(RUNBOOK);
    for (const dep of ['identity', 'edge']) await form.getByRole('checkbox', { name: dep, exact: true }).check();
    await form.getByRole('button', { name: 'Save the service record' }).click();
    await expect(form.getByTestId('service-record-outcome')).toContainText('service record saved');

    // Every panel, each on its own: the record's three, the alerts read, and the four with no source naming their blocker.
    await expect(page.getByTestId('service-owner-team')).toHaveText(RUN);
    await expect(page.getByTestId('service-dependencies').getByRole('link', { name: 'Identity' })).toHaveAttribute(
      'href',
      '/health/identity',
    );
    await expect(page.getByTestId('service-dependencies').getByRole('link', { name: 'Edge' })).toHaveAttribute('href', '/health/edge');
    await expect(page.getByTestId('service-runbook-path')).toHaveText(RUNBOOK);
    await expect(page.getByTestId('service-alerts')).toHaveAttribute('data-state', 'read');
    for (const id of ['on-call', 'incidents', 'objectives', 'dashboards']) {
      const panel = page.getByTestId(`service-${id}`);
      await expect(panel).toHaveAttribute('data-state', 'unwired');
      await expect(panel).toContainText('no source');
      await expect(panel).toContainText('ops.health_source_unwired');
    }
    await expect(page.getByTestId('service-on-call')).toContainText('nobody is shown as on call');
    for (const id of ['owner', 'dependencies', 'runbook'])
      await expect(page.getByTestId(`service-${id}`)).toHaveAttribute('data-state', 'read');
    // The module state is the board's own row for this module, read the same way.
    await expect(page.getByTestId('service-state')).toHaveAttribute('data-state', boardState);
    await expect(page.getByRole('button', { name: 'Escalate' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Declare an incident' })).toBeDisabled();
    await expect(page).toContainText('Needs the incident desk');

    // B saving from a read before A's save is refused, and A's record stays.
    const stale = await post(b, '/api/service-records', {
      module: 'ledger',
      expectedRevision: 0,
      ownerTeam: 'Someone else',
      dependencies: [],
      runbook: null,
    });
    expect(stale).toMatchObject({ status: 409, body: { ok: false, code: 'ops.service_record_stale' } });
    await b.goto(`${ADMIN}/health/ledger`, { waitUntil: 'load' });
    await expect(b.getByTestId('service-owner-team')).toHaveText(RUN);

    // A dependency opens its own service page; a module nobody has set reads "owner not set".
    await page.getByTestId('service-dependencies').getByRole('link', { name: 'Identity' }).click();
    await a.waitForURL((url) => url.pathname === '/health/identity', { timeout: 60_000 });
    await expect(a.getByRole('heading', { level: 1, name: 'Identity: service page' })).toBeVisible();
    await b.goto(`${ADMIN}/health/blueprint`, { waitUntil: 'load' });
    await expect(b.getByTestId('service-owner-unset')).toContainText('Owner not set.');
    await expect(b.getByTestId('service-owner-unset')).toContainText('ops.service_owner_unset');

    // A name that is not a module is a typed refusal.
    await b.goto(`${ADMIN}/health/mars`, { waitUntil: 'load' });
    await expect(b.getByTestId('service-not-found')).toContainText('ops.service_not_found');
  } finally {
    if (before) {
      // Put the ledger's record back as it was, from the revision stored now.
      await a.goto(`${ADMIN}/health/ledger`, { waitUntil: 'load' });
      const form = a.getByTestId('service-record-form');
      await form.getByLabel('Owner team').fill(before.owner);
      await form.getByLabel(/^Runbook/).fill(before.runbook);
      for (const box of await form.getByRole('checkbox').all()) await box.setChecked(before.deps.includes(await box.getAttribute('value')));
      await form.getByRole('button', { name: 'Save the service record' }).click();
      await expect(form.getByTestId('service-record-outcome')).toContainText('service record saved');
      if (before.owner === '') await expect(a.getByTestId('service-owner-unset')).toContainText('Owner not set.');
      else await expect(a.getByTestId('service-owner-team')).toHaveText(before.owner);
    }
    await a.context().close();
    await b.context().close();
  }
});
