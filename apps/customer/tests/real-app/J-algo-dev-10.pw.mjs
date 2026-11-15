// World: book
// Market: live
import { test, expect } from './journey.mjs';
import { api, journeyState } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { tapeWindow } from './tape.mjs';

// J-algo-dev-10, in the running app (docs/roadmap/journeys.json): moderate shared strategies in the library. One test per
// step, titled "J-algo-dev-10 #<n>", run in order. A founder signed in to the console works the market desk's strategy
// library (/more-ops/market, module quant); a TEST developer has published one open strategy to the library through
// svc-quant's own doors, and a TEST reader is anyone else browsing the library. The queue's page size is an owner value
// (`library.queuePageSize`): blank on the stack, set here to a labelled TEST value through svc-quant's owner-criteria
// door and put back to blank at the end. Every strategy and figure in Algo dev is simulated; nothing here moves money
// (svc-quant imports no ledger client).
const J = 'J-algo-dev-10';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const TITLE = `TEST moderated cross ${Date.now().toString(36)}`;
const CLEAN = 'Buys when the fast average crosses above the slow one on one minute bars. Every figure is a historical simulation.';
const LICENCE = 'TEST open licence';
const PAGE_SIZE = '50'; // TEST owner value
const HIDE_REASON = 'TEST content rule 3: an unlabelled result chart';
const UNHIDE_REASON = 'TEST the owner labelled the chart';
const TICKET = `TEST-SUP-${Date.now().toString(36)}`;
const DISPUTE_REASON = 'TEST another developer says the logic is theirs';
const RESOLVE_REASON = 'TEST the listing predates the other strategy';
const RULES = {
  symbol: 'BTC/USDT',
  barSize: '1m',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '0.01' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};

test.describe.configure({ mode: 'default' });

function state(...keys) {
  const read = run.read();
  for (const key of ['owner', 'reader', 'listingId', 'founderId', ...keys])
    if (!read[key]) throw new Error(`${J}: an earlier step left no ${key}, so this step has nothing to act on`);
  return read;
}

const dataOf = (body) => body?.result?.data?.json ?? body?.result?.data;

/** A signed-in tRPC call of svc-quant through Edge, as the person. */
async function quant(who, procedure, input, method = 'GET') {
  const client = await api(who);
  const res =
    method === 'GET'
      ? await client.get(`/api/quant/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`)
      : await client.post(`/api/quant/trpc/${procedure}`, input);
  return { status: res.status, data: dataOf(res.body), body: res.body };
}
async function ok(who, procedure, input, method) {
  const res = await quant(who, procedure, input, method);
  expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 400)}`).toBe(200);
  return res.data;
}

/** Every listing id the library shows another person, all pages. */
async function libraryIds(who) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 100; i++) {
    const page = await ok(who, 'library.browse', { tag: null, limit: 50, cursor });
    out.push(...page.entries.map((row) => row.listingId));
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
  throw new Error('the library never ended');
}

/** svc-quant's owner-criteria door (AL-lifecycle-01), with the stack's TEST founder's operator token. */
async function criteriaDoor() {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const founders = await gates.approverSessions(ctx);
  const token = await founders.a.tradeOpsToken();
  let n = 0;
  const stamp = `${process.env.JOURNEY_RUN_ID ?? 'local'}:${Date.now()}`;
  return {
    async set(value, toBoot = false) {
      n += 1;
      const res = await ctx.edge.mutate(
        'quant',
        'ops.criteria.set',
        { name: 'library.queuePageSize', value, toBoot, reason: `LOCAL TEST ${J}`, idempotencyKey: `journey:${J}:${stamp}:${n}` },
        token,
      );
      const got = res.json?.result?.data;
      if (!got) throw new Error(`ops.criteria.set refused: ${res.status} ${res.text.slice(0, 300)}`);
      return got;
    },
  };
}

/** The founder console, signed in once per worker in its own browser context (its cookies never meet the customer's). */
let consoleSession = null;
async function desk(browser) {
  if (!consoleSession) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const founder = await founderSignIn(page, 'a');
    consoleSession = { page, founder };
  }
  const { page, founder } = consoleSession;
  await page.goto(`${ADMIN}/more-ops/market`, { waitUntil: 'load' });
  const room = page.getByTestId('quant-library-desk');
  await expect(room).toBeVisible();
  run.write({ founderId: founder.userId });
  return { page, room, founder };
}

/** The listing's row in the review queue, paging forward through the queue as the desk does until it shows. */
async function entryOn(room, listingId) {
  const entry = room.locator(`[data-testid="library-entry"][data-listing="${listingId}"]`);
  for (let i = 0; i < 50; i++) {
    if (await entry.isVisible()) return entry;
    const next = room.getByRole('button', { name: 'Next page' });
    if (!(await next.isVisible())) break;
    const before = await room.getByTestId('library-entry').first().getAttribute('data-listing');
    await next.click();
    await expect(room.getByTestId('library-entry').first()).not.toHaveAttribute('data-listing', before ?? '');
  }
  await expect(entry, `listing ${listingId} is in the review queue`).toBeVisible();
  return entry;
}

/** The console's own call to its library proxy, as the desk sends it (same-origin, with the session's CSRF nonce). */
async function proxyPost(page, body) {
  return page.evaluate(async (payload) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/more-ops/library', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  }, body);
}

/** What the console's library proxy reads for the queue now, every page. */
async function queueThroughProxy(page) {
  return page.evaluate(async () => {
    const entries = [];
    let cursor = null;
    for (let i = 0; i < 100; i++) {
      const res = await fetch(`/api/more-ops/library${cursor ? `?cursor=${cursor}` : ''}`, { cache: 'no-store' });
      const view = await res.json();
      if (view.queue.kind !== 'ok') return { failed: view.queue, entries, raw: JSON.stringify(view) };
      entries.push(...view.queue.data.entries);
      if (!view.queue.data.nextCursor) return { entries, pageSize: view.queue.data.pageSize };
      cursor = view.queue.data.nextCursor;
    }
    throw new Error('the queue never ended');
  });
}

test(`${J} starts: a founder session on the market desk (module quant), and one open strategy published to the library`, async ({
  page,
  browser,
}) => {
  test.setTimeout(15 * 60_000);
  const owner = await signUp(page, 'mo');
  await verify(page, owner);
  const reader = await signUp(page, 'mr');
  await verify(page, reader);
  run.reset({ owner, reader });

  // The owner saves a signal-rules strategy, backtests version 1 with its costs set, and publishes it, through svc-quant.
  const tape = await tapeWindow(60);
  const saved = await ok(
    owner,
    'studio.save',
    {
      name: TITLE,
      blocks: [],
      modules: RULES,
      risk: { maxDrawdown: '100', maxNotional: '500', kill: '50' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: `${J}:${TITLE}`,
      idempotencyKey: `studio.save:${J}:${TITLE}`,
    },
    'POST',
  );
  await ok(
    owner,
    'backtest.start',
    {
      strategyId: saved.id,
      strategyVersion: 1,
      cash: '1000',
      from: `${tape.from}:00.000Z`,
      to: `${tape.to}:00.000Z`,
      fillTiming: 'next_open',
      costs: { feeRole: 'taker', slippageBps: '5', delayBars: '0' },
    },
    'POST',
  );
  const options = await ok(owner, 'library.options', {});
  const listing = await ok(
    owner,
    'library.publish',
    {
      strategyId: saved.id,
      strategyVersion: 1,
      title: TITLE,
      description: CLEAN,
      tags: ['trend'],
      visibility: 'open',
      licence: LICENCE,
      checklistVersion: options.checklist.version,
      checklistAccepted: true,
    },
    'POST',
  );
  const sourcePage = await ok(owner, 'library.get', { listingId: listing.listingId });
  expect(sourcePage.source, 'an open listing has source its owner can read').toBeTruthy();
  run.write({ listingId: listing.listingId, strategyId: saved.id, source: sourcePage.source });
  expect(await libraryIds(reader)).toContain(listing.listingId);

  const { room } = await desk(browser);
  await expect(room.getByRole('heading', { name: 'Market desk: strategy library' })).toBeVisible();
});

test(`${J} #1 opens the library review queue: newly published listings oldest first with facts and no source; a blank page size refuses`, async ({
  browser,
}) => {
  test.setTimeout(5 * 60_000);
  const { listingId, owner, source } = state('source');
  const door = await criteriaDoor();

  // Blank page size: the queue refuses with its typed code and lists nothing.
  await door.set(null, true);
  const blank = await desk(browser);
  const failed = blank.room.getByTestId('library-queue-failed');
  await expect(failed).toBeVisible();
  await expect(failed).toHaveAttribute('data-code', 'quant.library_queue_limit_unset');
  await expect(failed).toContainText('The owner has not set the review queue page size');
  await expect(blank.room.getByTestId('library-entry')).toHaveCount(0);

  // A TEST page size: the queue lists, oldest first.
  await door.set(PAGE_SIZE);
  const { page, room } = await desk(browser);
  await expect(room.getByText(`Oldest first, ${PAGE_SIZE} to a page`)).toBeVisible();
  const entry = await entryOn(room, listingId);
  await expect(entry.getByText(TITLE, { exact: true })).toBeVisible();
  await expect(entry.getByTestId('library-entry-state')).toHaveText('In the library');
  const facts = entry.getByTestId('library-entry-facts');
  await expect(facts).toContainText('Version1');
  await expect(facts).toContainText(`Licence${LICENCE}`);
  await expect(facts).toContainText('Visibilityopen');
  await expect(facts).toContainText('Backtest checked');
  await expect(facts).toContainText('Realism checklist');
  await expect(facts).toContainText(await userIdOfListing(owner, listingId));

  // Oldest first across every page, and no source anywhere: not on the desk, not in what the proxy read.
  const read = await queueThroughProxy(page);
  expect(read.failed, JSON.stringify(read.failed)).toBeUndefined();
  expect(read.pageSize).toBe(Number(PAGE_SIZE));
  const times = read.entries.map((row) => Date.parse(row.listedAt));
  expect(times).toEqual([...times].sort((a, b) => a - b));
  const mine = read.entries.find((row) => row.listingId === listingId);
  expect(mine).toMatchObject({ title: TITLE, state: 'listed', visibility: 'open', strategyVersion: 1, audit: [], disputes: [] });
  expect(mine.facts.runId).toBeTruthy();
  for (const row of read.entries) expect(Object.keys(row)).not.toContain('source');
  expect(JSON.stringify(read.entries)).not.toContain(source.trim().slice(0, 60));
  await expect(room).not.toContainText(source.trim().slice(0, 60));
});

/** The listing owner's account id, as the queue names the owner. */
async function userIdOfListing(owner, listingId) {
  const mine = await ok(owner, 'library.mine', {});
  const found = mine.listings.find((row) => row.listingId === listingId);
  expect(found, 'the owner still holds the listing').toBeTruthy();
  const page = await ok(owner, 'library.get', { listingId });
  return page.ownerId;
}

test(`${J} #2 hides a listing with a reason: it leaves the library, the record stays, an audit row names the actor and reason`, async ({
  browser,
}) => {
  test.setTimeout(5 * 60_000);
  const { listingId, owner, reader, founderId } = state();
  const { room } = await desk(browser);
  const entry = await entryOn(room, listingId);
  await entry.getByLabel('Reason', { exact: true }).fill(HIDE_REASON);
  await entry.getByRole('button', { name: 'Hide' }).click();
  await expect(room.getByTestId('library-desk-outcome')).toContainText('Done: the listing is hidden from the library');
  await expect(entry.getByTestId('library-entry-state')).toHaveText('Hidden');
  const audit = entry.getByTestId('library-entry-audit').locator('li');
  await expect(audit).toHaveCount(1);
  await expect(audit.first()).toHaveAttribute('data-action', 'hide');
  await expect(audit.first()).toHaveAttribute('data-actor', founderId);
  await expect(audit.first()).toContainText(`Reason: ${HIDE_REASON}`);

  // It leaves the library for anyone else, and its page reads as not found.
  expect(await libraryIds(reader)).not.toContain(listingId);
  const other = await quant(reader, 'library.get', { listingId });
  expect(other.status).toBe(404);
  expect(JSON.stringify(other.body)).toContain('quant.listing_not_found');
  // The record stays: the owner still holds it and the queue still lists it.
  expect((await ok(owner, 'library.mine', {})).listings.map((row) => row.listingId)).toContain(listingId);
  await room.getByRole('button', { name: 'Refresh' }).click();
  await expect((await entryOn(room, listingId)).getByTestId('library-entry-state')).toHaveText('Hidden');
});

test(`${J} #3 unhides it: it returns with another audit row`, async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const { listingId, reader, founderId } = state();
  const { room } = await desk(browser);
  const entry = await entryOn(room, listingId);
  await expect(entry.getByTestId('library-entry-state')).toHaveText('Hidden');
  await entry.getByLabel('Reason', { exact: true }).fill(UNHIDE_REASON);
  await entry.getByRole('button', { name: 'Unhide' }).click();
  await expect(room.getByTestId('library-desk-outcome')).toContainText('Done: the listing is back in the library');
  await expect(entry.getByTestId('library-entry-state')).toHaveText('In the library');
  const audit = entry.getByTestId('library-entry-audit').locator('li');
  await expect(audit).toHaveCount(2);
  await expect(audit.nth(0)).toHaveAttribute('data-action', 'hide');
  await expect(audit.nth(1)).toHaveAttribute('data-action', 'unhide');
  await expect(audit.nth(1)).toHaveAttribute('data-actor', founderId);
  await expect(audit.nth(1)).toContainText(`Reason: ${UNHIDE_REASON}`);
  expect(await libraryIds(reader)).toContain(listingId);
  expect((await ok(reader, 'library.get', { listingId })).title).toBe(TITLE);
});

test(`${J} #4 tries to remove a listing without a reason: a typed refusal and nothing changes`, async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const { listingId, reader } = state();
  const { page, room } = await desk(browser);
  const entry = await entryOn(room, listingId);
  await entry.getByLabel('Reason', { exact: true }).fill('');
  await entry.getByRole('button', { name: 'Remove' }).click();
  const outcome = room.getByTestId('library-desk-outcome');
  await expect(outcome).toHaveAttribute('role', 'alert');
  await expect(outcome).toHaveAttribute('data-code', 'quant.moderation_reason_required');
  await expect(outcome).toContainText('Code: quant.moderation_reason_required');
  // Nothing changed: still listed, still two audit rows, still in the library.
  await expect(entry.getByTestId('library-entry-state')).toHaveText('In the library');
  await expect(entry.getByTestId('library-entry-audit').locator('li')).toHaveCount(2);
  const read = await queueThroughProxy(page);
  expect(read.entries.find((row) => row.listingId === listingId)).toMatchObject({ state: 'listed' });
  expect(read.entries.find((row) => row.listingId === listingId).audit.map((row) => row.action)).toEqual(['hide', 'unhide']);
  expect(await libraryIds(reader)).toContain(listingId);
});

test(`${J} #5 opens a dispute and resolves it with a reason: the dispute is stored with its ticket reference and shows resolved`, async ({
  browser,
}) => {
  test.setTimeout(5 * 60_000);
  const { listingId, founderId } = state();
  const { page, room } = await desk(browser);
  const entry = await entryOn(room, listingId);
  await entry.getByLabel('Support ticket reference').fill(TICKET);
  await entry.getByLabel('Dispute reason').fill(DISPUTE_REASON);
  await entry.getByRole('button', { name: 'Open dispute' }).click();
  await expect(room.getByTestId('library-desk-outcome')).toContainText('Done: the dispute is opened');
  const dispute = entry.getByTestId('library-entry-disputes').locator('li');
  await expect(dispute).toHaveCount(1);
  await expect(dispute.first()).toHaveAttribute('data-state', 'open');
  await expect(dispute.first()).toContainText(`Ticket ${TICKET}`);
  await expect(dispute.first()).toContainText(DISPUTE_REASON);
  await expect(dispute.first().getByTestId('dispute-state')).toHaveText('Open');

  await dispute.first().getByLabel('Resolution reason').fill(RESOLVE_REASON);
  await dispute.first().getByRole('button', { name: 'Resolve dispute' }).click();
  await expect(room.getByTestId('library-desk-outcome')).toContainText('Done: the dispute is resolved');
  await expect(dispute.first()).toHaveAttribute('data-state', 'resolved');
  await expect(dispute.first().getByTestId('dispute-state')).toHaveText('Resolved');
  await expect(dispute.first()).toContainText(`Reason: ${RESOLVE_REASON}`);

  // Stored: a fresh read of the desk shows the same dispute with its ticket reference, resolved by this founder.
  const read = await queueThroughProxy(page);
  const disputes = read.entries.find((row) => row.listingId === listingId).disputes;
  expect(disputes).toHaveLength(1);
  expect(disputes[0]).toMatchObject({
    ticketRef: TICKET,
    reason: DISPUTE_REASON,
    openedBy: founderId,
    state: 'resolved',
    resolution: { actor: founderId, reason: RESOLVE_REASON },
  });
  run.write({ disputeId: disputes[0].disputeId });
});

test(`${J} #6 tries an action the proxy does not list: the proxy refuses it`, async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const { listingId, reader } = state();
  const { page } = await desk(browser);
  const before = (await queueThroughProxy(page)).entries.find((row) => row.listingId === listingId);
  for (const op of ['delete', 'purge', 'ops.library.remove']) {
    const res = await proxyPost(page, { op, listingId, reason: 'TEST not a listed action', seq: before.audit.length });
    expect(res.status, `${op}: ${JSON.stringify(res.body)}`).toBe(400);
    expect(res.body).toMatchObject({ ok: false, code: 'admin.action_not_listed', changed: 'no', title: 'That action is not on this desk' });
  }
  // Nothing reached svc-quant: the listing, its audit and its disputes are as they were.
  const after = (await queueThroughProxy(page)).entries.find((row) => row.listingId === listingId);
  expect(after).toEqual(before);
  expect(await libraryIds(reader)).toContain(listingId);
});

test(`${J} ends: a listing hidden with a reason and an audit row, and a dispute resolved with its ticket reference`, async ({
  browser,
}) => {
  test.setTimeout(5 * 60_000);
  const { listingId, founderId } = state('disputeId');
  const { page } = await desk(browser);
  const read = await queueThroughProxy(page);
  const row = read.entries.find((entry) => entry.listingId === listingId);
  expect(row.audit[0]).toMatchObject({ action: 'hide', actor: founderId, reason: HIDE_REASON });
  expect(row.disputes[0]).toMatchObject({ ticketRef: TICKET, state: 'resolved' });
  // The owner value goes back to blank, as the stack has it.
  await (await criteriaDoor()).set(null, true);
});
