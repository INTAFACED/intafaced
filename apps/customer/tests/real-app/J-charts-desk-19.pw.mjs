// World: market, stack
// Market: live
import { readFile } from 'node:fs/promises';
import { test, expect } from './journey.mjs';
import { ADMIN } from './admin.mjs';
import { signUp } from './desk.mjs';
import { asDesk, deskPeople } from './help-centre.mjs';
import { EDGE, api, bestPrices, marketIdOf, signOutBrowser } from './stack.mjs';
import { twoPerson } from '../../../../tooling/scripts/local-test-gates.mjs';

// J-charts-desk-19 "I look up a customer's alerts and layouts, control a feed source, and export the audit", in the
// founder console (apps/admin) against the running stack. One test per step, titled "J-charts-desk-19 #<n>".
// The operator who proposes and applies is founder A; the second person who approves is founder B. Each step's effect is
// checked against a source read on its own: svc-trade's public candle read for what a chart feed state really does,
// identity's approval for who approved, and the trade operator audit for the record.
//
// #2 and #3 change one market's chart feed (IFC/USDT, the market the fewest journeys chart). Each starts from, and in a
// `finally` puts the market back on, its primary source and `on`, through svc-trade's own two-person door, so no other
// journey's chart reads a changed feed for longer than the step runs.
const J = 'J-charts-desk-19';
const RUN = Date.now().toString(36);
const SYMBOL = 'IFC/USDT';
const FEEDS = `${ADMIN}/trade-ops/feeds`;
const REASON = (what) => `LOCAL TEST ${J} ${RUN}: ${what}`;

/** The approvals this file applied, in order: #4's file must hold each of them. */
const applied = [];

const trpcData = (res) => res.json?.result?.data?.json ?? res.json?.result?.data;

/** svc-trade's own list of every market's chart feed, read as operator A of `pair` (founders.ops()). */
async function controls({ ctx, sessions }) {
  const res = await ctx.edge.query('trade', 'admin.chartFeedControls.list', {}, await sessions.a.tradeOpsToken());
  const view = trpcData(res);
  expect(view?.markets, res.text?.slice(0, 300)).toBeTruthy();
  return view;
}
const settingOf = async (pair, symbol) => (await controls(pair)).markets.find((m) => m.symbol === symbol);

/** The public candle read a chart makes, as anyone: its status and the refusal code, if any. */
async function candleRead(symbol) {
  const res = await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent(symbol)}?timeframe=1m&limit=10`);
  const body = await res.json().catch(() => null);
  return { status: res.status, code: body?.intafacedCode ?? null, message: body?.message ?? '' };
}

/** Put the market back on primary and on, through svc-trade's two-person door, whatever the step left. */
async function restore(pair, symbol) {
  const { ctx, sessions } = pair;
  for (let i = 0; i < 2; i++) {
    const now = await settingOf(pair, symbol);
    const action = now.state !== 'on' ? { kind: 'enable' } : now.source !== 'primary' ? { kind: 'switch_source', to: 'primary' } : null;
    if (action === null) return;
    const change = { symbol, action, expectedVersion: now.version, reason: REASON(`put ${symbol} back on its primary feed`) };
    const token = await sessions.a.tradeOpsToken();
    const prepared = trpcData(await ctx.edge.query('trade', 'admin.chartFeedControls.prepare', change, token));
    expect(prepared?.payloadHash).toMatch(/^sha256:/);
    const ids = await twoPerson(ctx, sessions, {
      actionType: 'trade.chart_feed_control',
      targetService: 'svc-trade',
      targetId: symbol,
      expectedVersion: now.version,
      payloadHash: prepared.payloadHash,
      policyVersion: 'trade-chart-feed-control-v1',
    });
    const res = await ctx.edge.mutate('trade', 'admin.chartFeedControls.run', { ...change, ...ids }, await sessions.a.tradeOpsToken());
    expect(trpcData(res)?.control?.approvalId, res.text?.slice(0, 300)).toBe(ids.approvalId);
    applied.push(ids.approvalId);
  }
  const back = await settingOf(pair, symbol);
  expect([back.source, back.state]).toEqual(['primary', 'on']);
}

/** The control section of the feed desk, signed in as `page`'s founder. */
async function openControl(page) {
  await page.goto(FEEDS);
  const region = page.getByRole('region', { name: 'Feed source and symbol control', exact: true });
  await expect(region).toBeVisible({ timeout: 30_000 });
  return region;
}
const marketRow = (region, symbol) =>
  region.getByRole('table', { name: 'Chart feed per market', exact: true }).locator(`tr[data-symbol="${symbol}"]`);

/** The change form, filled with one change on SYMBOL. */
async function fillChange(region, { kind, to, reason }) {
  const form = region.getByRole('form', { name: 'Change a chart feed', exact: true });
  await form.getByLabel('Market', { exact: true }).selectOption(SYMBOL);
  await form.getByLabel('Change', { exact: true }).selectOption(kind);
  if (to) await form.getByLabel('New source', { exact: true }).selectOption(to);
  await form.getByLabel('Reason', { exact: true }).fill(reason);
  return form;
}

/** Founder A files one change from the form; returns the approval id and the payload hash the page shows. */
async function propose(region, change) {
  const form = await fillChange(region, change);
  await form.getByRole('button', { name: 'Ask a second operator to approve', exact: true }).click();
  const filed = form.locator('[data-filed]');
  await expect(filed).toBeVisible({ timeout: 30_000 });
  const approvalId = (await filed.locator('[data-field="Approval id"]').textContent()).trim();
  const payloadHash = (await filed.locator('[data-field="Payload hash"]').textContent()).trim();
  expect(payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  return { form, approvalId, payloadHash, change: (await filed.locator('[data-field="Change"]').textContent()).trim() };
}

/** Freezes & approvals, as whoever is signed in on `page`: approve exactly `payloadHash`; returns the dialog. */
async function actOnApproval(page, approvalId, payloadHash) {
  await page.goto(`${ADMIN}/trade-ops/approvals`);
  // The pending list lands above the form and moves the button: act once it is in (J-cex-spot-17's approveAsB).
  await expect(page.getByRole('grid', { name: 'Approvals waiting for this operator', exact: true })).toBeVisible();
  await page.getByLabel('Approval id', { exact: true }).fill(approvalId);
  await page.getByLabel('Payload hash you reviewed', { exact: true }).fill(payloadHash);
  await page.getByRole('button', { name: 'Approve request', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(dialog.locator('[data-outcome]')).toBeVisible({ timeout: 15_000 });
  return dialog;
}

/** Founder B, in the console context of their own, approves; returns B's user id. */
async function approveAsB(founders, approvalId, payloadHash) {
  const { page: b, founder: founderB } = await founders.console('b');
  const dialog = await actOnApproval(b, approvalId, payloadHash);
  await expect(dialog.locator('[data-outcome=ok]')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  return founderB.userId;
}

/** Founder A applies the approved change from the same form (the same change and reason are still on it). */
async function applyChange(page, form, approvalId) {
  await form.getByLabel('Approved request id', { exact: true }).fill(approvalId);
  await form.getByRole('button', { name: 'Apply the approved change', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Apply change', exact: true }).click();
  await expect(dialog.locator('[data-outcome]')).toBeVisible({ timeout: 30_000 });
  return dialog;
}

/**
 * One CSV line's cells (RFC 4180: a quoted cell may hold commas and doubled quotes; the console writes no line breaks in
 * a cell for these columns). A leading apostrophe the console adds against formula injection is taken off.
 */
function csvCells(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => (/^'[=+\-@]/.test(c) ? c.slice(1) : c));
}

const closeDialog = async (page) => {
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
};

// ── #1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// J-charts-desk-19 #1 "Opens a customer's alerts and layouts from /support": a support agent (the stack's founder A, the
// support lead, in the founder console) opens a customer's request on /support and looks up that customer's price alerts
// with their firing history and saved desk layouts. Read-only; one audit row with the agent, the customer and the time.
// The customer is made here: a TEST price alert set below the market (so the next evaluation pass fires it, and its firing
// is in the trigger log) and one saved desk layout, written through the customer's own identity preferences door.
const BTC = 'BTC/USDT';
const LAYOUT_ID = `j19-${RUN}`;
const LAYOUT_NAME = `TEST J19 ${RUN}`;

/** The desk's answer to one svc-support call as the lead; throws on a refusal. */
async function desk(kind, procedure, input) {
  const res = await asDesk('lead', kind, procedure, input);
  if (res.json?.result?.data === undefined) throw new Error(`${procedure} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return res.json.result.data;
}

/** The customer's own alerts and trigger log, read as the customer. */
async function ownAlerts(client) {
  const res = await client.get(`/api/notify/trpc/notify.alerts?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.items;
}
async function ownTriggers(client, alertId) {
  const res = await client.get(`/api/notify/trpc/notify.alertTriggers?input=${encodeURIComponent(JSON.stringify({ alertId, limit: 10 }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.items;
}
async function ownLayouts(client) {
  const input = encodeURIComponent(JSON.stringify({ namespace: 'trade.desk.layouts' }));
  const res = await client.get(`/api/identity/trpc/preferences.get?input=${input}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

const chartsRows = (ticketId) =>
  desk('query', 'events', { ticketId, limit: 500 }).then((rows) => rows.filter((e) => e.kind === 'charts_lookup'));

test(`${J} #1 opens a customer's alerts and layouts from /support: alerts with history and layouts, read-only; one audit row with the agent, the customer and the time`, async ({
  page,
  founders,
}) => {
  test.setTimeout(300_000);

  // The customer: one price alert that fires (above half the best bid crosses at once), one saved desk layout, one request.
  const who = await signUp(page, `cd19${RUN}`);
  await signOutBrowser(page.context());
  const client = await api(who);
  const { bid } = await bestPrices(BTC);
  const target = String(Math.max(1, Math.floor(Number(bid) / 2)));
  const created = await client.post('/api/notify/trpc/notify.createAlert', {
    marketId: await marketIdOf(BTC),
    direction: 'above',
    targetPrice: target,
  });
  expect(created.status, JSON.stringify(created.body).slice(0, 300)).toBe(200);
  const alert = created.body.result.data;
  // The sweep runs every minute: the firing is in the customer's own trigger log within two passes.
  await expect.poll(async () => (await ownTriggers(client, alert.id)).length, { timeout: 150_000, intervals: [5_000] }).toBeGreaterThan(0);
  const [fired] = await ownTriggers(client, alert.id);

  const savedAt = new Date().toISOString();
  const stored = await ownLayouts(client);
  const wrote = await client.post('/api/identity/trpc/preferences.set', {
    namespace: 'trade.desk.layouts',
    ifVersion: stored.version,
    clientRequestId: `${J}:${RUN}:layout`,
    value: {
      layouts: [
        {
          id: LAYOUT_ID,
          name: LAYOUT_NAME,
          symbol: BTC,
          interval: '15m',
          desk: { v: 1, preset: 'classic', order: ['markets', 'chart', 'book', 'trades'], widths: {} },
          savedAt,
        },
      ],
      active: LAYOUT_ID,
      deleted: [],
    },
  });
  expect(wrote.status, JSON.stringify(wrote.body).slice(0, 300)).toBe(200);

  const ticketRes = await client.post('/api/support/trpc/create', {
    category: 'other',
    subject: `TEST ${J} ${RUN} my alert fired`,
    body: 'TEST My BTC alert fired and my saved layout looks wrong.',
    clientRequestId: `${J}:${RUN}:ticket`,
  });
  expect(ticketRes.status, JSON.stringify(ticketRes.body).slice(0, 300)).toBe(200);
  const ticket = ticketRes.body.result.data;

  const alertsBefore = await ownAlerts(client);
  const layoutsBefore = await ownLayouts(client);
  const rowsBefore = await chartsRows(ticket.id);

  // The agent opens the request on /support and asks for the lookup.
  const { page: console_, founder: agent } = await founders.console('a');
  expect(agent.userId).toBe((await deskPeople()).lead);
  await console_.goto(`${ADMIN}/support/${ticket.id}`);
  const workspace = console_.getByRole('region', { name: 'Ticket', exact: true });
  await expect(workspace).toBeVisible();
  const panel = workspace.getByRole('region', { name: 'Charts: alerts and layouts', exact: true });
  await expect(panel).toBeVisible();
  // Nothing is read until the agent asks: no lookup row yet.
  expect(await chartsRows(ticket.id)).toHaveLength(rowsBefore.length);

  const asked = Date.now();
  const answer = console_.waitForResponse((res) => res.url().includes('view=charts'));
  await panel.getByRole('button', { name: 'Look up alerts and layouts', exact: true }).click();
  expect((await answer).ok()).toBe(true);
  const result = panel.getByTestId('charts-lookup-result');
  await expect(result).toBeVisible();
  const done = Date.now();

  // Alerts: the customer's alert, as the customer's own list has it.
  await expect(panel.getByTestId('charts-alerts-state')).toHaveAttribute('data-state', 'read');
  const alertRow = panel.getByRole('table', { name: 'Price alerts', exact: true }).locator(`tr[data-alert-id="${alert.id}"]`);
  await expect(alertRow).toBeVisible();
  await expect(alertRow).toContainText(`above ${target}`);
  await expect(alertRow).toContainText(alertsBefore.find((a) => a.id === alert.id).status);
  // History: the firing, with the mark that fired it.
  await expect(panel.getByTestId('charts-history-state')).toHaveAttribute('data-state', 'read');
  const historyRow = panel.getByRole('table', { name: 'Alert history', exact: true }).locator(`tr[data-alert-id="${alert.id}"]`).first();
  await expect(historyRow).toBeVisible();
  await expect(historyRow).toContainText(fired.markPrice);
  // Layouts: the saved layout, with its market and interval, marked in use.
  await expect(panel.getByTestId('charts-layouts-state')).toHaveAttribute('data-state', 'read');
  const layoutRow = panel.getByRole('table', { name: 'Saved layouts', exact: true }).locator(`tr[data-layout-id="${LAYOUT_ID}"]`);
  await expect(layoutRow).toContainText(LAYOUT_NAME);
  await expect(layoutRow).toContainText(BTC);
  await expect(layoutRow).toContainText('15m');
  await expect(layoutRow.locator('td').last()).toHaveText('yes');

  // Read-only: the panel offers no control but the lookup itself, and the customer's alert and layouts are as they were.
  await expect(panel.locator('input, select, textarea')).toHaveCount(0);
  await expect(panel.getByRole('button')).toHaveCount(1);
  await expect(panel.getByRole('button')).toHaveText('Look up again');
  expect(await ownAlerts(client)).toEqual(alertsBefore);
  expect(await ownLayouts(client)).toEqual(layoutsBefore);

  // One audit row: the agent, the customer and the time, the same row the panel shows.
  const rowsAfter = await chartsRows(ticket.id);
  expect(rowsAfter).toHaveLength(rowsBefore.length + 1);
  const row = rowsAfter.at(-1);
  expect(row).toMatchObject({ actorId: agent.userId, actorRole: 'operator', note: `customer:${client.userId}` });
  expect(ticket.userId).toBe(client.userId);
  const at = Date.parse(row.occurredAt);
  expect(at).toBeGreaterThanOrEqual(asked - 5_000);
  expect(at).toBeLessThanOrEqual(done + 5_000);
  await expect(panel.getByTestId('charts-audit-agent')).toHaveText(agent.userId);
  await expect(panel.getByTestId('charts-audit-customer')).toHaveText(client.userId);
  await expect.poll(async () => Date.parse(await panel.getByTestId('charts-audit-time').getAttribute('data-at'))).toBe(at);
  await expect(panel.getByTestId('charts-lookup-audit')).toContainText(`#${row.sequence}`);
});
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test.describe(`${J} #2 #3 #4 chart feed control and its audit`, () => {
  test.describe.configure({ mode: 'serial' });

  test(`${J} #2 opens feed source and symbol control: the source per market and a way to disable a symbol with approval`, async ({
    founders,
  }) => {
    test.setTimeout(300_000);
    const { page, founder: founderA } = await founders.console('a');
    const pair = await founders.ops();
    await restore(pair, SYMBOL);
    try {
      let region = await openControl(page);

      // The source per market: every spot market svc-trade lists has its row, naming its source and chart state.
      const view = await controls(pair);
      expect(view.markets.length).toBeGreaterThan(0);
      for (const m of view.markets) {
        const row = marketRow(region, m.symbol);
        await expect(row).toHaveAttribute('data-source', m.source);
        await expect(row).toHaveAttribute('data-state', m.state);
        await expect(row.locator('[data-field=source]')).toHaveText(m.source === 'primary' ? 'primary (INTAFACED trade tape)' : m.source);
      }
      await expect(marketRow(region, SYMBOL).locator('[data-field=state]')).toHaveText('On');
      expect((await candleRead(SYMBOL)).status).toBe(200);

      // A way to disable it with approval: founder A files the request, and it waits for a second person.
      const filed = await propose(region, { kind: 'disable', reason: REASON(`disable the ${SYMBOL} chart feed`) });
      expect(filed.change).toBe('primary, On → primary, Disabled');
      let dialog = await applyChange(page, filed.form, filed.approvalId);
      await expect(dialog.locator('[data-outcome=refused]')).toContainText('action_approval.pending');
      await closeDialog(page);
      expect(await settingOf(pair, SYMBOL)).toMatchObject({ state: 'on' });
      expect((await candleRead(SYMBOL)).status).toBe(200);

      // A second founder approves; founder A applies: the chart feed is disabled, and the candle read really refuses.
      const approverId = await approveAsB(founders, filed.approvalId, filed.payloadHash);
      expect(approverId).not.toBe(founderA.userId);
      region = await openControl(page);
      const form = await fillChange(region, { kind: 'disable', reason: REASON(`disable the ${SYMBOL} chart feed`) });
      dialog = await applyChange(page, form, filed.approvalId);
      await expect(dialog.locator('[data-outcome=ok]')).toBeVisible();
      await closeDialog(page);
      applied.push(filed.approvalId);
      await expect(marketRow(region, SYMBOL)).toHaveAttribute('data-state', 'disabled');
      await expect(marketRow(region, SYMBOL).locator('[data-field=state]')).toHaveText('Disabled');
      expect(await candleRead(SYMBOL)).toMatchObject({ status: 503, code: 'trade.chart_feed.disabled' });

      await restore(pair, SYMBOL);
      expect((await candleRead(SYMBOL)).status).toBe(200);
    } finally {
      await restore(pair, SYMBOL);
    }
  });

  test(`${J} #3 changes a feed source: the change proposed, approved by a second person and recorded`, async ({ founders }) => {
    test.setTimeout(300_000);
    const { page, founder: founderA } = await founders.console('a');
    const pair = await founders.ops();
    await restore(pair, SYMBOL);
    try {
      const region = await openControl(page);
      const sources = (await region.getByTestId('fallback-sources').getAttribute('data-sources')).split(',').filter(Boolean);
      expect(sources.length, "the stack's TEST fallback source list is set").toBeGreaterThan(0);
      const to = sources[0];
      const reason = REASON(`switch the ${SYMBOL} chart to ${to}`);

      // Proposed: filed by founder A, bound to this change; nothing changed yet.
      const filed = await propose(region, { kind: 'switch_source', to, reason });
      expect(filed.change).toBe(`primary, On → ${to}, On`);
      expect(await settingOf(pair, SYMBOL)).toMatchObject({ source: 'primary' });

      // Approved by a second person: founder A's own approval is refused by identity; founder B's is accepted.
      const self = await actOnApproval(page, filed.approvalId, filed.payloadHash);
      await expect(self.locator('[data-outcome=refused]')).toContainText('action_approval.same_person');
      const approverId = await approveAsB(founders, filed.approvalId, filed.payloadHash);
      expect(approverId).not.toBe(founderA.userId);

      const back = await openControl(page);
      const form = await fillChange(back, { kind: 'switch_source', to, reason });
      const dialog = await applyChange(page, form, filed.approvalId);
      await expect(dialog.locator('[data-outcome=ok]')).toBeVisible();
      await closeDialog(page);
      applied.push(filed.approvalId);
      await expect(marketRow(back, SYMBOL)).toHaveAttribute('data-source', to);

      // Recorded: the journal row names the change, the reason, who proposed, who approved, who applied, and when.
      const entry = back
        .getByRole('table', { name: 'Chart control journal', exact: true })
        .locator(`tr[data-approval="${filed.approvalId}"]`);
      await expect(entry).toHaveAttribute('data-action', 'switch_source');
      await expect(entry.locator('[data-field=change]')).toHaveText(`primary, On → ${to}, On`);
      await expect(entry.locator('[data-field=reason]')).toHaveText(reason);
      await expect(entry.locator('[data-field=proposer]')).toHaveText(founderA.userId);
      await expect(entry.locator('[data-field=approver]')).toHaveText(approverId);
      await expect(entry.locator('[data-field=executor]')).toHaveText(founderA.userId);
      const at = Date.parse(await entry.locator('[data-field=at]').getAttribute('data-at'));
      expect(Math.abs(Date.now() - at)).toBeLessThan(5 * 60_000);
      // The same record in the trade operator audit room, with the second operator and the reason.
      await page.goto(`${ADMIN}/trade-ops/audit?kind=chart_feed.control`);
      const auditRow = page
        .getByRole('table', { name: 'Audit rows', exact: true })
        .locator('tr[data-audit-id]')
        .filter({ hasText: reason });
      await expect(auditRow).toHaveCount(1);
      await expect(auditRow).toContainText(approverId);
      await expect(auditRow.getByTestId('audit-operator')).toHaveText(founderA.userId);

      // What the switch really does: no adapter connects the fallback here, so the chart's candle read refuses by name
      // rather than serve INTAFACED trades labelled as another source.
      const read = await candleRead(SYMBOL);
      expect(read).toMatchObject({ status: 503, code: 'trade.chart_feed.source_not_connected' });
      expect(read.message).toContain(to);
    } finally {
      await restore(pair, SYMBOL);
    }
  });

  test(`${J} #4 exports the audit of chart controls: a file of every control change with who and when`, async ({ founders }) => {
    test.setTimeout(180_000);
    expect(applied.length, '#2 and #3 applied their changes').toBeGreaterThan(0);
    const { page } = await founders.console('a');
    await page.goto(`${ADMIN}/trade-ops/exports`);
    await page.getByRole('button', { name: 'Chart controls audit', exact: true }).click();
    await page.getByRole('button', { name: 'Read the data', exact: true }).click();
    const save = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
    const download = await save;
    const text = await readFile(await download.path(), 'utf8');
    const [header, ...lines] = text.trim().split('\r\n');
    const cols = csvCells(header);
    expect(cols).toEqual([
      'time',
      'symbol',
      'action',
      'from_source',
      'to_source',
      'from_state',
      'to_state',
      'reason',
      'proposed_by',
      'approved_by',
      'applied_by',
      'approval_id',
      'version',
    ]);
    const rows = lines.map((l) => Object.fromEntries(csvCells(l).map((v, i) => [cols[i], v])));

    // Every control change: the file holds exactly the changes svc-trade's journal holds, row for row.
    const { ctx, sessions } = await founders.ops();
    const res = await ctx.edge.mutate('trade', 'admin.chartFeedControls.export', {}, await sessions.a.tradeOpsToken());
    const journal = trpcData(res)?.rows;
    expect(journal, res.text?.slice(0, 300)).toBeTruthy();
    expect(rows.map((r) => r.approval_id)).toEqual(journal.map((r) => r.approvalId));
    for (const id of applied)
      expect(
        rows.some((r) => r.approval_id === id),
        `the file holds ${id}`,
      ).toBe(true);

    // With who and when: each row names who proposed, approved and applied it (two different people), and its time.
    for (const r of rows) {
      const j = journal.find((x) => x.approvalId === r.approval_id);
      expect(r).toMatchObject({ proposed_by: j.proposerId, approved_by: j.approverId, applied_by: j.executorId, time: j.at });
      expect(r.proposed_by).not.toBe(r.approved_by);
      expect(Number.isNaN(Date.parse(r.time))).toBe(false);
    }
    const mine = rows.filter((r) => applied.includes(r.approval_id));
    expect(mine.every((r) => r.symbol === SYMBOL && r.reason.startsWith(`LOCAL TEST ${J} ${RUN}`))).toBe(true);
  });
});
