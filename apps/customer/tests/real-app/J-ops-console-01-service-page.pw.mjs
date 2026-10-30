import { expect, test } from '@playwright/test';
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

    // Every panel with a source, each on its own: the record's three and the alerts read. On call, incidents, objectives and
    // dashboards have no source in the product; they are asserted at the end, where each fails by name.
    await expect(page.getByTestId('service-owner-team')).toHaveText(RUN);
    await expect(page.getByTestId('service-dependencies').getByRole('link', { name: 'Identity' })).toHaveAttribute(
      'href',
      '/health/identity',
    );
    await expect(page.getByTestId('service-dependencies').getByRole('link', { name: 'Edge' })).toHaveAttribute('href', '/health/edge');
    await expect(page.getByTestId('service-runbook-path')).toHaveText(RUNBOOK);
    await expect(page.getByTestId('service-alerts')).toHaveAttribute('data-state', 'read');
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

    // The row asks for who is on call, open incidents, objectives and dashboards on the page, and for the on-call panel alone
    // to refuse when its source is down. The product has no source for any of the four (apps/admin/src/lib/service-page/
    // model.ts UNWIRED_PANELS), so each panel's content is asserted here and fails by name; every other clause above ran.
    await a.goto(`${ADMIN}/health/ledger`, { waitUntil: 'load' });
    const missing = {
      'on-call':
        'who is on call: no on-call source exists (the on-call desk, its rota and who holds the pager, is not built), so the panel cannot show anyone, and with no source to go down "only the on-call panel refuses" cannot be shown (OPS-service-health-01)',
      incidents: 'open incidents: no incident desk source exists for a module, so none can be listed (OPS-service-health-01)',
      objectives: 'objectives: no service level objective source exists (the objectives desk is not built) (OPS-service-health-01)',
      dashboards: 'dashboards: no dashboard source is linked to a module (the dashboards desk is not built) (OPS-service-health-01)',
    };
    for (const [id, what] of Object.entries(missing))
      await expect
        .soft(a.locator(`[data-testid="service-${id}"][data-state="read"]`), `service page panel shows its content: ${what}`)
        .toBeVisible({ timeout: 5_000 });
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
