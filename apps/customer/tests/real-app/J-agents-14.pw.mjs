// World: restart
import { readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { OWN_AGENT, UNBUILT, agentsRun, createOwnAgent, openAgents, openFounderDesk, openOwnAgent, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';
import { api, tool } from './stack.mjs';

// J-agents-14, in the founder console (docs/roadmap/journeys.json): see and quarantine every agent on the platform. One
// test per step, titled "J-agents-14 #<n>", run in order. The operators are the stack's two LOCAL TEST founders on
// /more-ops/agents; the agent quarantined is a TEST customer's own agent that the start makes, so no shared agent of
// the stack is touched. #5 kills a whole kind and restores it (two founders) in the same step, in a finally, for the same
// reason; its "a restart does not re-enable it" restarts svc-agents (a plain restart, no setting switched) while the kind
// is off and reads the kill again from the restarted service.
// Built: the console's Agent fleet desk (AG-registry-01, AG-control-02) over svc-agents' fleet.* procedures, with the
// fleet's audit log under the registry (fleet.audit), and on the customer's side the agent's status, its background test
// run (Test, then Runs) and its row in the catalogue's "Agents you made" (AG-catalogue-01). What the service does is read
// from the service itself: the customer's own.status and own.session.open through Edge, and a founder's restore through
// the console's own route. A part a step needs that is missing still fails fast (UNBUILT). Steps #3, #4, #5 and #7 each
// sign in two or three people (founders with a TOTP code, the customer), so each has its own time budget, as the start
// does; no check is loosened.
const J = 'J-agents-14';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const fleet = (page) => tableIn(page.getByRole('main'), 'Agents on the platform');
/** The registry's body rows: every row that holds cells (the header row holds column headers). */
const fleetRows = (page) =>
  fleet(page)
    .getByRole('row')
    .filter({ has: page.getByRole('cell') });
const ownRow = (page) => fleet(page).getByRole('row').filter({ hasText: OWN_AGENT }).filter({ hasText: agents.account().handle });
const statusOf = (row) => row.getByTestId('fleet-status');
const openFleet = (page, key) => openFounderDesk(page, '/more-ops/agents', 'Agent fleet', key);
const auditLog = (page) => tableIn(page.getByRole('main'), 'Fleet audit log');
/** The audit log's rows for one request id, which the page sent with the action. */
const auditRows = (page, requestId) => auditLog(page).getByRole('row').filter({ hasText: requestId });

/** The request id the desk sends with its next `action`, read from the request itself. */
const nextRequestId = (page, action) =>
  page
    .waitForRequest((r) => r.url().endsWith('/api/agents-fleet') && r.method() === 'POST' && r.postDataJSON()?.action === action)
    .then((r) => r.postDataJSON().requestId);

/** One action through the console's own fleet route, as the founder signed in to `page` (its CSRF from /api/session). */
const fleetCall = (page, body) =>
  page.evaluate(async (payload) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/agents-fleet', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, body);

/** A call of svc-agents' own.* procedures through Edge, as the customer on a sign-in of its own: status and refusal code. */
async function ownCall(method, procedure, input) {
  const customer = await api(agents.account());
  const res =
    method === 'GET'
      ? await customer.get(`/api/agents/trpc/own.${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`)
      : await customer.post(`/api/agents/trpc/own.${procedure}`, input);
  return { status: res.status, data: res.body?.result?.data, code: res.body?.error?.message ?? null };
}
/** The id of the customer's own TEST agent, as svc-agents lists it for them. */
async function ownAgentId() {
  const listed = await ownCall('GET', 'list', { limit: 50 });
  expect(listed.status, JSON.stringify(listed)).toBe(200);
  const mine = listed.data.filter((row) => row.name === OWN_AGENT);
  expect(mine, 'the start made exactly one agent of the customer’s own').toHaveLength(1);
  return mine[0].id;
}
/** Whether svc-agents lets the agent start new work: active, quarantined or disabled_by_kind. */
async function serviceStatus(id) {
  const read = await ownCall('GET', 'status', { id });
  expect(read.status, JSON.stringify(read)).toBe(200);
  return read.data.status;
}
/** A new session of the agent, asked of svc-agents itself: refused as disabled while a switch is on. */
async function expectNewSessionRefused(id) {
  const opened = await ownCall('POST', 'session.open', { id });
  expect(opened.status, JSON.stringify(opened)).toBe(403);
  expect(opened.code).toBe('agents.agent.disabled');
}

/** One CSV line into its cells, quoted cells ("a,b", "say ""x""") included. */
function csvCells(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      cells.push(cell);
      cell = '';
    } else cell += c;
  }
  cells.push(cell);
  return cells;
}

test(`${J} starts: a TEST customer with an agent of its own, and the founder console`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag14', '10');
  await signIn(page, agents.account());
  await createOwnAgent(page);
});

test(`${J} #1 opens the registry: total, ownerless and unmanaged counts and a row per agent with owner, publisher, channels and risk signals`, async ({
  page,
}) => {
  await openFleet(page);
  for (const column of ['Agent', 'Kind', 'Owner', 'Publisher', 'Channels', 'Risk signals', 'Status'])
    await expect(fleet(page).getByRole('columnheader', { name: column, exact: true })).toBeVisible();
  // The whole fleet is on the page (one read shows up to the owner's page size), so each count is held to the rows.
  await expect(page.getByText(/^More agents match than one read shows/)).toHaveCount(0);
  const rows = fleetRows(page);
  const count = async (id) => {
    await expect(page.getByTestId(id)).toHaveText(/^\d+$/);
    return Number(await page.getByTestId(id).innerText());
  };
  const total = await count('fleet-total');
  expect(total, 'at least the agent the start made').toBeGreaterThanOrEqual(1);
  await expect(rows, 'a row per agent').toHaveCount(total);
  // Ownerless: a row whose owner reads "No owner". Unmanaged: ownerless and not a product agent.
  const ownerless = rows.filter({ has: page.getByTestId('fleet-owner').getByText('No owner', { exact: true }) });
  await expect(ownerless).toHaveCount(await count('fleet-ownerless'));
  await expect(ownerless.filter({ has: page.getByRole('cell', { name: 'Customer-built', exact: true }) })).toHaveCount(
    await count('fleet-unmanaged'),
  );
  // A field with no stored value reads "not set", never a blank or an invented value.
  await expect(rows.getByRole('cell').filter({ hasNotText: /\S/ })).toHaveCount(0);

  // The TEST agent the start made: its own row, owned by the customer, a draft no one has published, on no channel yet,
  // and never run.
  const own = ownRow(page);
  await expect(own).toHaveCount(1);
  const cells = own.getByRole('cell');
  await expect(cells.nth(0)).toHaveText(OWN_AGENT);
  await expect(cells.nth(1)).toHaveText('Customer-built');
  await expect(cells.nth(2)).toHaveText(agents.account().handle);
  await expect(cells.nth(3), 'publisher').toHaveText('not set');
  await expect(cells.nth(4), 'channels').toHaveText('not set');
  await expect(cells.nth(5), 'risk signals').toContainText('Never run');
  await expect(statusOf(own)).toHaveText('Active');
});

test(`${J} #2 filters by risk signal and exports: a CSV of the filtered rows over the full range and one audit row`, async ({ page }) => {
  const founder = await openFleet(page);
  await page.getByRole('combobox', { name: 'Risk signal' }).selectOption({ label: 'Enabled with no owner' }, UNBUILT);
  const shown = Number(await page.getByTestId('fleet-filtered').innerText());
  expect(shown, 'the stack has ownerless product agents').toBeGreaterThan(0);
  // Every row the filter leaves carries the chosen risk signal.
  await expect(fleetRows(page)).toHaveCount(shown);
  await expect(fleetRows(page).filter({ hasNotText: 'Enabled with no owner' })).toHaveCount(0);

  const sent = nextRequestId(page, 'export');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /^Export CSV/ }).click();
  const requestId = await sent;
  const [header, ...lines] = readFileSync(await (await download).path(), 'utf8')
    .trim()
    .split('\n');
  const columns = csvCells(header);
  expect(columns).toContain('risk_signals');
  expect(lines, 'one line per matching agent, over the full range').toHaveLength(shown);
  for (const line of lines) {
    const cells = csvCells(line);
    expect(cells).toHaveLength(columns.length);
    expect(cells[columns.indexOf('risk_signals')].split(' '), line).toContain('no_owner');
  }
  await expect(page.getByRole('status')).toContainText('Export recorded in the audit log');

  // svc-agents' audit log holds exactly one row for this export, naming the operator, the filter and the count.
  const row = auditRows(page, requestId);
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('audit-row-operator')).toHaveText(founder.handle);
  await expect(row).toContainText('Export');
  await expect(row).toContainText('Risk signal: Enabled with no owner');
  await expect(row.getByTestId('audit-row-count')).toHaveText(String(shown));
});

test(`${J} #3 quarantines one agent with a reason: new sessions refuse as disabled, a running run stops at its next boundary, an audit row names the operator`, async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  const id = await ownAgentId();
  expect(await serviceStatus(id)).toBe('active');
  // The customer, in a browser of their own, has a background run of the agent going before the quarantine.
  const customer = await browser.newContext();
  try {
    const own = await customer.newPage();
    await openOwnAgent(own, agents, 'Test');
    const panel = own.getByRole('main').getByRole('region', { name: 'Test' });
    await panel.getByRole('textbox', { name: /^Ask the agent/ }).fill('TEST: check every market one by one', UNBUILT);
    await panel.getByRole('checkbox', { name: 'Run in the background' }).check();
    await panel.getByRole('button', { name: 'Run a test' }).click();

    const founder = await openFleet(page);
    await ownRow(page).getByRole('button', { name: 'Quarantine' }).click(UNBUILT);
    const sheet = page.getByRole('dialog', { name: 'Quarantine agent' });
    await sheet.getByRole('textbox', { name: /^Reason/ }).fill('LOCAL TEST quarantine');
    const sent = nextRequestId(page, 'quarantine');
    await sheet.getByRole('button', { name: 'Quarantine' }).click();
    const requestId = await sent;
    await expect(statusOf(ownRow(page))).toHaveText(/^Quarantined/);
    await expect(ownRow(page).getByTestId('audit-operator')).toHaveText(founder.handle);
    // svc-agents' audit log: exactly one row for this quarantine, naming the operator, the agent and the reason.
    const audit = auditRows(page, requestId);
    await expect(audit).toHaveCount(1);
    await expect(audit.getByTestId('audit-row-operator')).toHaveText(founder.handle);
    await expect(audit).toContainText('Quarantine');
    await expect(audit).toContainText(`own:${id}`);
    await expect(audit).toContainText('LOCAL TEST quarantine');

    // A new session is asked of svc-agents itself and refused as disabled.
    expect(await serviceStatus(id)).toBe('quarantined');
    await expectNewSessionRefused(id);

    // The run in flight stops at its next step. The Runs panel reads the runs once when it opens, and the next step
    // boundary (one AGENTS_BACKGROUND_STEP_MS tick) can come just after that read (#7517's run 42455921357: still Running
    // on a read made after the quarantine). So the panel is read again until the run reads stopped, and the stop is held
    // to steps, not time: read after the quarantine committed, the run may take at most the one step a tick that read the
    // switch before the commit could still take.
    const runsRead = () => own.waitForResponse((r) => r.url().includes('/api/agents/trpc/own.backgroundRuns'));
    const newestRun = async (response) => {
      const body = await response.json();
      return (body?.result?.data?.json ?? body?.result?.data)?.[0];
    };
    const firstRead = runsRead();
    await openOwnAgent(own, agents, 'Runs');
    const atQuarantine = await newestRun(await firstRead);
    expect(atQuarantine?.stepsDone, 'the run in flight, read after the quarantine').toEqual(expect.any(Number));
    let latest = atQuarantine;
    await expect(async () => {
      if (latest.state !== 'stopped') {
        const read = runsRead();
        await own.reload();
        await own.getByRole('group', { name: 'Agent pages' }).getByRole('button', { name: 'Runs', exact: true }).click(UNBUILT);
        latest = await newestRun(await read);
      }
      expect(latest.state).toBe('stopped');
    }).toPass({ timeout: 10_000 });
    expect(latest.id, 'the same run').toBe(atQuarantine.id);
    expect(latest.stopCode).toBe('agents.agent.quarantined');
    expect(latest.stepsDone, 'it stopped at its next step, not later').toBeLessThanOrEqual(atQuarantine.stepsDone + 1);
    await expect(tableIn(own.getByRole('main'), 'Live runs').getByRole('row').nth(1)).toContainText('Stopped: agent quarantined');
  } finally {
    await customer.close();
  }
});

test(`${J} #4 restores it as one founder: refused until two distinct founders restore it`, async ({ browser, page }) => {
  test.setTimeout(180_000);
  const id = await ownAgentId();
  await openFleet(page, 'a');
  await ownRow(page).getByRole('button', { name: 'Restore' }).click(UNBUILT);
  await expect(ownRow(page)).toContainText('Restore waiting for a second founder');
  // One founder's restore lifts nothing: the agent is still quarantined, in the registry and in svc-agents.
  await page.reload();
  await expect(statusOf(ownRow(page))).toHaveText(/^Quarantined/);
  await expect(ownRow(page).getByRole('button', { name: /^(Restore|Confirm restore)$/ })).toHaveCount(0);
  expect(await serviceStatus(id)).toBe('quarantined');
  await expectNewSessionRefused(id);

  // The same founder confirming, sent to the service through the console's route as a new request, is not the second
  // founder: it still waits, and the agent stays quarantined.
  const again = await fleetCall(page, {
    action: 'restore',
    ref: `own:${id}`,
    requestId: `agents-fleet:restore:${J}-same-founder-${Date.now()}`,
  });
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  expect(again.body.outcome).toBe('waiting_second_founder');
  await page.reload();
  await expect(statusOf(ownRow(page))).toHaveText(/^Quarantined/);
  expect(await serviceStatus(id)).toBe('quarantined');

  // A second, distinct founder confirms, and the agent is active again.
  const other = await browser.newContext();
  try {
    const b = await other.newPage();
    const second = await openFleet(b, 'b');
    const sent = nextRequestId(b, 'restore');
    await tableIn(b.getByRole('main'), 'Agents on the platform')
      .getByRole('row')
      .filter({ hasText: OWN_AGENT })
      .filter({ hasText: agents.account().handle })
      .getByRole('button', { name: 'Confirm restore' })
      .click();
    const requestId = await sent;
    const audit = auditRows(b, requestId);
    await expect(audit).toHaveCount(1);
    await expect(audit.getByTestId('audit-row-operator')).toHaveText(second.handle);
    await expect(audit).toContainText('Restore');
  } finally {
    await other.close();
  }
  await page.reload();
  await expect(statusOf(ownRow(page))).toHaveText('Active');
  expect(await serviceStatus(id)).toBe('active');
});

test(`${J} #5 kills a whole kind: every agent of the kind disabled in one audited action; a restart does not re-enable it`, async ({
  browser,
  page,
}) => {
  test.setTimeout(300_000);
  const id = await ownAgentId();
  const founder = await openFleet(page, 'a');
  await page.getByRole('button', { name: 'Kill a kind' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'Kill a kind' });
  await sheet.getByRole('combobox', { name: 'Kind' }).selectOption({ label: 'Customer-built' });
  await sheet.getByRole('textbox', { name: /^Reason/ }).fill('LOCAL TEST kind kill');
  const kindRows = () => fleetRows(page).filter({ has: page.getByRole('cell', { name: 'Customer-built', exact: true }) });
  try {
    const sent = nextRequestId(page, 'killKind');
    await sheet.getByRole('button', { name: 'Kill every agent of this kind' }).click();
    const requestId = await sent;
    await expect(page.getByRole('status')).toContainText(/^Customer-built: \d+ agents? switched off in 1 audited action\.$/);
    const killed = Number((await page.getByRole('status').innerText()).match(/: (\d+) agent/)[1]);
    // Every agent of the kind is off: as many customer-built rows as the action switched off, none of them active.
    await expect(page.getByText(/^More agents match than one read shows/)).toHaveCount(0);
    await expect(kindRows()).toHaveCount(killed);
    await expect(kindRows().filter({ hasNot: page.getByTestId('fleet-status').getByText(/^(Disabled by kind|Quarantined)/) })).toHaveCount(
      0,
    );
    await expect(statusOf(ownRow(page))).toHaveText(/^Disabled by kind/);
    expect(await serviceStatus(id)).toBe('disabled_by_kind');
    await expectNewSessionRefused(id);
    // One audited action: exactly one audit row, naming the operator, the kind, the reason and how many agents.
    const audit = auditRows(page, requestId);
    await expect(audit).toHaveCount(1);
    await expect(audit.getByTestId('audit-row-operator')).toHaveText(founder.handle);
    await expect(audit).toContainText('Kill a kind');
    await expect(audit).toContainText('Customer-built');
    await expect(audit).toContainText('LOCAL TEST kind kill');
    await expect(audit.getByTestId('audit-row-count')).toHaveText(String(killed));

    // svc-agents restarts (nothing switched), and the restarted service still holds the kind off.
    tool('local-test-stack.mjs', 'restart', 'agents');
    expect(await serviceStatus(id)).toBe('disabled_by_kind');
    await expectNewSessionRefused(id);
    await page.reload();
    await expect(statusOf(ownRow(page))).toHaveText(/^Disabled by kind/);
    await expect(kindRows().filter({ hasNot: page.getByTestId('fleet-status').getByText(/^(Disabled by kind|Quarantined)/) })).toHaveCount(
      0,
    );
  } finally {
    // Put the kind back with both founders, so the stack's other journeys meet it as before. Each click is followed by the
    // desk's own answer, so the request has landed before the next founder reads it or the browser closes (run
    // 42933547963: the second founder's browser closed before its confirm reached the service, and the kind stayed off).
    await page.getByRole('button', { name: 'Restore a kind' }).click();
    await expect(page.getByRole('status')).toHaveText('Restore of Customer-built waiting for a second founder.');
    const other = await browser.newContext();
    try {
      const b = await other.newPage();
      await openFleet(b, 'b');
      await b.getByRole('button', { name: 'Confirm restore of Customer-built' }).click();
      await expect(b.getByRole('status')).toHaveText('Customer-built agents restored.');
    } finally {
      await other.close();
    }
  }
  await page.reload();
  await expect(statusOf(ownRow(page))).toHaveText('Active');
  expect(await serviceStatus(id)).toBe('active');
});

test(`${J} #6 reassigns an ownerless agent: the owner column and counts update`, async ({ page }) => {
  await openFleet(page);
  const before = Number(await page.getByTestId('fleet-ownerless').innerText());
  const unmanaged = await page.getByTestId('fleet-unmanaged').innerText();
  const ownerless = fleetRows(page)
    .filter({ has: page.getByRole('button', { name: 'Reassign' }) })
    .first();
  await expect(ownerless.getByTestId('fleet-owner')).toHaveText('No owner', UNBUILT);
  // The row is pinned by the agent's reference as svc-agents stores it: a product agent's name may read "not set" on
  // many rows (run 42608487532: 11 rows), so the name cannot tell them apart.
  const ref = await ownerless.getAttribute('data-agent-ref');
  expect(ref, 'the row carries its agent reference').toMatch(/\S/);
  const row = fleetRows(page).and(page.locator(`tr[data-agent-ref="${ref}"]`));
  await expect(row, 'the agent is named by one row').toHaveCount(1);
  await ownerless.getByRole('button', { name: 'Reassign' }).click();
  await page
    .getByRole('dialog', { name: 'Reassign agent' })
    .getByRole('textbox', { name: /^New owner/ })
    .fill(agents.account().handle);
  await page.getByRole('dialog', { name: 'Reassign agent' }).getByRole('button', { name: 'Reassign' }).click();
  // The reassigned row's owner column names the new owner, and it is no longer offered for reassignment.
  await expect(row.getByTestId('fleet-owner')).toHaveText(agents.account().handle);
  await expect(row.getByRole('button', { name: 'Reassign' })).toHaveCount(0);
  await expect(page.getByTestId('fleet-ownerless')).toHaveText(String(before - 1));
  // A product agent is never unmanaged, so that count stays.
  await expect(page.getByTestId('fleet-unmanaged')).toHaveText(unmanaged);
  // Read again from svc-agents, not the page's memory.
  await page.reload();
  await expect(row.getByTestId('fleet-owner')).toHaveText(agents.account().handle);
  await expect(page.getByTestId('fleet-ownerless')).toHaveText(String(before - 1));
});

test(`${J} #7 checks as the customer: the quarantined agent shows its disabled status and the open button off`, async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  const id = await ownAgentId();
  // The customer's catalogue, in a browser of their own: the agent of their own, under "Agents you made".
  const customer = await browser.newContext();
  try {
    const own = await customer.newPage();
    const made = () =>
      tableIn(own.getByRole('main'), 'Agents you made')
        .getByRole('row')
        .filter({ has: own.getByRole('link', { name: OWN_AGENT, exact: true }) });
    await openAgents(own, agents);
    // #4 restored it: before the quarantine it reads Active with its open button on.
    await expect(made().getByTestId('agent-status')).toHaveText('Active', UNBUILT);
    await expect(made().getByRole('button', { name: 'Open a session' })).toBeEnabled();

    await openFleet(page);
    await ownRow(page).getByRole('button', { name: 'Quarantine' }).click(UNBUILT);
    await page
      .getByRole('dialog', { name: 'Quarantine agent' })
      .getByRole('textbox', { name: /^Reason/ })
      .fill('LOCAL TEST quarantine');
    await page.getByRole('dialog', { name: 'Quarantine agent' }).getByRole('button', { name: 'Quarantine' }).click();
    await expect(statusOf(ownRow(page))).toHaveText(/^Quarantined/);
    expect(await serviceStatus(id)).toBe('quarantined');

    // The catalogue read again: the quarantined agent reads Disabled and its open button is off.
    await own.reload();
    await expect(own.getByRole('main').getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
    await expect(made().getByTestId('agent-status')).toHaveText('Disabled');
    await expect(made().getByRole('button', { name: 'Open a session' })).toBeDisabled();
  } finally {
    await customer.close();
  }
});
