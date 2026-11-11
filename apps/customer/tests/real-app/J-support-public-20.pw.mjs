// World: book, restart, stack
import { test, expect } from './journey.mjs';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { asDesk, deskPeople, ensureDeskGroup } from './help-centre.mjs';
import { awayBid, fundedTrader } from './desk.mjs';
import { api, ORIGIN, ROOT, stackFile, tool } from './stack.mjs';

// J-support-public-20, in the running app (docs/roadmap/journeys.json): a support agent handles a customer's "my deposit
// or withdrawal is missing" request without moving money, lifting a restriction or reading what they are not entitled to.
// The desk calls go through Edge as the stack's support lead. Tests titled "J-support-public-20 #<n>" prove a step.
const J = 'J-support-public-20';
const RUN = Date.now().toString(36);

// Not serial: a step that is not built yet fails alone and the run goes on.
const shared = {};

async function visitor(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

const query = (procedure, input) => `/api/support/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;

/** A desk call that must succeed, as the lead. */
async function lead(kind, procedure, input) {
  const res = await asDesk('lead', kind, procedure, input);
  const row = res.json?.result?.data;
  if (row === undefined) throw new Error(`${procedure} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
}

/** A desk call that must be refused: its typed code. */
async function refused(kind, procedure, input) {
  const res = await asDesk('lead', kind, procedure, input);
  expect(res.json?.result?.data, `${procedure} was not refused: ${res.text.slice(0, 300)}`).toBeUndefined();
  return res.text;
}

/**
 * The customer and their "my withdrawal is missing" request, claimed by the lead: made once per worker, and again when
 * a failed step restarted the worker, so each step can be proved on its own.
 */
async function request(browser) {
  if (shared.ticket) return shared;
  const page = await visitor(browser);
  const who = await fundedTrader(page, 'j20c', '20');
  await page.context().close();
  const client = await api(who);
  const res = await client.post('/api/support/trpc/create', {
    category: 'deposit_withdraw',
    subject: `TEST ${J} ${RUN} withdrawal missing`,
    body: 'TEST My withdrawal left my account two days ago and never arrived.',
    clientRequestId: `j20:${RUN}:${shared.n ?? 0}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  shared.n = (shared.n ?? 0) + 1;
  await lead('mutation', 'claim', { ticketId: res.body.result.data.id }).catch(() => null);
  Object.assign(shared, { who, userId: client.userId, ticket: res.body.result.data });
  return shared;
}

/**
 * One TEST limit buy at 90% of the best bid, so it rests on the book: an order of `who`'s own. 0.0002 BTC there is above
 * the 5 USDT minimum order value and within the 20 USDT the customer is funded with. Its id.
 */
async function restingOrder(who) {
  const res = await (
    await api(who)
  ).post('/api/v1/orders', {
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    price: await awayBid(90),
    amount: '0.0002',
    clientOrderId: `${J}-${RUN}-${Math.random().toString(36).slice(2, 8)}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
  expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
  return res.body.id;
}

/**
 * One TEST withdrawal of `who`'s, written by the stack's tool as svc-pay's `withdraw` leaves a requested one: a row in
 * svc-pay and nothing posted (local-test-stack.mjs seed-withdrawal). Its id.
 */
function withdrawalOf(who, tag) {
  const out = tool(
    'local-test-stack.mjs',
    'seed-withdrawal',
    who.email,
    'USDT',
    '5',
    '--state',
    'requested',
    '--ref',
    `${J}-${RUN}-${tag}`,
  );
  const id = /^\s*withdrawal\s+([0-9a-f-]{36})$/m.exec(out)?.[1];
  expect(id, out).toMatch(/^[0-9a-f-]{36}$/);
  return id;
}

/**
 * One TEST chain deposit of 20 USDT (above the stack's TEST minimum of 10) to `who`'s own deposit address on TEST
 * Ethereum, delivered to svc-pay's chain webhook (local-test-stack.mjs chain-deposit). Its id, as svc-pay records it
 * and the customer's own deposit list shows it.
 */
async function depositOf(who, tag) {
  const client = await api(who);
  const asked = await client.post('/api/bank/trpc/deposits.address', { assetId: 'USDT', networkId: 'ethereum' });
  const address = asked.body?.result?.data?.address;
  expect(address, `deposits.address: ${asked.status} ${JSON.stringify(asked.body).slice(0, 300)}`).toBeTruthy();
  const out = tool('local-test-stack.mjs', 'chain-deposit', address, 'USDT', '20', '6', '--tx', `${J}-${RUN}-${tag}`);
  expect(out).toContain('"received":true');
  const tx = /^\s*tx\s+(0x[0-9a-f]{64}):\d+/m.exec(out)?.[1];
  expect(tx, out).toBeTruthy();
  let id;
  await expect
    .poll(
      async () => {
        const listed = await client.get(`/api/bank/trpc/deposits.list?input=${encodeURIComponent(JSON.stringify({ txId: tx }))}`);
        id = listed.body?.result?.data?.items?.[0]?.id;
        return id;
      },
      { timeout: 30_000 },
    )
    .toMatch(/^[0-9a-f-]{36}$/);
  return id;
}

test(`${J} #1 only a record that already belongs to the ticket's customer can be linked to it, and a request linked to a recovery-required order ranks above a withdrawal request of the same age`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { ticket, who } = await request(browser);
  const link = (kind, recordId) => asDesk('lead', 'mutation', 'linkRecord', { ticketId: ticket.id, kind, recordId });

  // The customer's own order links, as svc-trade reports it; linking it again is the same link.
  const own = await restingOrder(who);
  const linked = await link('order', own);
  expect(linked.status, `linkRecord: ${linked.text.slice(0, 300)}`).toBe(200);
  expect(linked.json.result.data).toMatchObject({ ticketId: ticket.id, kind: 'order', recordId: own, recoveryRequired: false });
  expect((await link('order', own)).json.result.data).toEqual(linked.json.result.data);

  // The customer's own withdrawal and deposit link too, as svc-pay reports them, never marked recovery-required.
  const mine = [linked.json.result.data];
  for (const [kind, recordId] of [
    ['withdrawal', withdrawalOf(who, 'w')],
    ['deposit', await depositOf(who, 'd')],
  ]) {
    const res = await link(kind, recordId);
    expect(res.status, `linkRecord ${kind}: ${res.text.slice(0, 300)}`).toBe(200);
    expect(res.json.result.data).toMatchObject({ ticketId: ticket.id, kind, recordId, recoveryRequired: false });
    mine.push(res.json.result.data);
  }

  // Another customer's real order, withdrawal and deposit, and records that don't exist, are refused the same way;
  // nothing is linked for them.
  const page = await visitor(browser);
  const stranger = await fundedTrader(page, 'j20o', '20');
  await page.context().close();
  const theirs = await restingOrder(stranger);
  for (const [kind, recordId] of [
    ['order', theirs],
    ['withdrawal', withdrawalOf(stranger, 'ow')],
    ['deposit', await depositOf(stranger, 'od')],
    ['order', '00000000-0000-4000-8000-000000000000'],
    ['withdrawal', '00000000-0000-4000-8000-000000000000'],
    ['deposit', '00000000-0000-4000-8000-000000000001'],
  ]) {
    const res = await link(kind, recordId);
    expect(res.status, `linkRecord ${kind}: ${res.text.slice(0, 300)}`).not.toBe(404);
    expect(res.json?.result?.data, res.text.slice(0, 300)).toBeUndefined();
    expect(res.text).toContain('support.link_record_not_owned');
  }
  const links = await asDesk('lead', 'query', 'ticketLinks', { ticketId: ticket.id });
  expect(links.json?.result?.data, links.text.slice(0, 300)).toHaveLength(mine.length);
  expect(links.json.result.data).toEqual(expect.arrayContaining(mine));
  // The ranking half. Two unclaimed withdrawal requests from the customer, the plain one made first: on age alone it is
  // read first. The later one is linked to an order whose hold has an unknown outcome, made for real: the order rests,
  // the stack's matching engine stops, and the cancel sent then cannot learn whether the engine took the order off, so
  // svc-trade marks it recovery_required and keeps its hold.
  // The customer's own order is cancelled first: its hold frees the funds the next order needs (the link stays, a fact).
  expect((await cancelOrder(who, own)).status).toBeLessThan(300);
  const plain = await openRequest(who, 'plain');
  const flagged = await openRequest(who, 'flagged');
  const stuck = await restingOrder(who);
  let stopped = false;
  try {
    // Marked first, so a stop that times out after its signal still brings the engine back.
    stopped = true;
    stack('stop', 'matching');
    const cancel = await cancelOrder(who, stuck);
    expect(cancel.status, JSON.stringify(cancel.body).slice(0, 300)).toBeGreaterThanOrEqual(400);
  } finally {
    if (stopped) stack('start', '--only', 'matching');
  }
  const flaggedLink = await lead('mutation', 'linkRecord', { ticketId: flagged.id, kind: 'order', recordId: stuck });
  expect(flaggedLink).toMatchObject({ ticketId: flagged.id, kind: 'order', recordId: stuck, recoveryRequired: true });

  // Same category, same age band: the request linked to the recovery-required order is read before the older plain one.
  const ranked = await queueOrder(plain.id, flagged.id);
  expect(ranked.flagged.score, JSON.stringify(ranked)).toBeGreaterThan(ranked.plain.score);
  expect(ranked.flagged.at, JSON.stringify(ranked)).toBeLessThan(ranked.plain.at);

  // Once the hold resolves (the engine is back and the cancel goes through), the queue reads the order's status live and
  // the linked request stops ranking first: the plain one is read first again.
  await expect
    .poll(async () => (await cancelOrder(who, stuck)).status, {
      timeout: 90_000,
      intervals: [3_000],
    })
    .toBeLessThan(300);
  await expect
    .poll(
      async () => {
        const now = await queueOrder(plain.id, flagged.id);
        return now.plain.at < now.flagged.at && now.plain.score === now.flagged.score;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
});

/** Cancel one of `who`'s BTC/USDT orders: the answer as Edge gave it. */
async function cancelOrder(who, id) {
  return (await api(who)).delete(`/api/v1/orders/${id}?symbol=${encodeURIComponent('BTC/USDT')}`);
}

function stack(...args) {
  return tool('local-test-stack.mjs', ...args);
}

/** A new, unclaimed "my withdrawal is missing" request from `who`, so it stays in the desk's shared queue. */
async function openRequest(who, tag) {
  const res = await (
    await api(who)
  ).post('/api/support/trpc/create', {
    category: 'deposit_withdraw',
    subject: `TEST ${J} ${RUN} ${tag} withdrawal missing`,
    body: 'TEST My withdrawal left my account two days ago and never arrived.',
    clientRequestId: `j20:${RUN}:${tag}:${test.info().retry}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** A new "my withdrawal is missing" request from `who`, claimed by the lead: the claim is checked, never assumed. */
async function claimed(who, tag) {
  const made = await openRequest(who, tag);
  await lead('mutation', 'claim', { ticketId: made.id }).catch(() => null);
  expect((await lead('query', 'get', { ticketId: made.id })).assigneeId).toBe((await deskPeople()).lead);
  return made;
}

/** svc-support's own database, as its own role (the role the service writes with), on the journey stack. */
async function supportDb() {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const postgres = createRequire(path.join(ROOT, 'services', 'svc-support', 'package.json'))('postgres');
  const port = ctx.marker.ports.postgres ?? 15460;
  return postgres(`postgres://svc_support:${encodeURIComponent(ctx.secrets.pgService)}@127.0.0.1:${port}/intafaced_local_test`, {
    max: 1,
    onnotice: () => {},
  });
}

/** The guest verification mails svc-notify wrote to the stack's LOCAL TEST outbox for this address, oldest first. */
function guestMail(email) {
  const file = stackFile('status-mail-outbox.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('LOCAL-TEST '))
    .map((line) => JSON.parse(line.slice('LOCAL-TEST '.length)))
    .filter((mail) => mail.purpose === 'guest-verify' && mail.to === email);
}

/**
 * A request from someone with no account, made as a guest makes one: the signed-out form, then the emailed link. The
 * ticket's owner is the guest request's own id, which no account has. Its ticket id.
 */
async function guestRequest(browser) {
  const email = `j20-guest-${RUN}-${test.info().retry}@example.test`;
  const context = await browser.newContext({ baseURL: ORIGIN });
  const page = await context.newPage();
  try {
    await page.goto('/support/new');
    const form = page.getByTestId('support-guest-new');
    await form.getByLabel('Your email address').fill(email);
    await form.getByRole('combobox', { name: 'Topic' }).selectOption({ label: 'Something else' });
    await form.getByLabel('Subject', { exact: true }).fill(`TEST ${J} ${RUN} guest withdrawal missing`);
    await form.getByLabel('What happened').fill(`TEST ${J} ${RUN}: my withdrawal never arrived.`);
    await form.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByTestId('support-guest-check-email')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => guestMail(email).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    const text = guestMail(email).at(-1).text;
    const link = /(http\S+\/support\/guest\/verify#token=\S+)/.exec(text)?.[1];
    expect(link, text).toBeTruthy();
    await page.goto(link);
    await page.getByTestId('support-guest-verify').getByRole('button', { name: 'Open my request' }).click();
    await expect(page).toHaveURL(/\/support\/guest\/request$/);
    const ticket = page.getByTestId('support-guest-ticket');
    await expect(ticket).toBeVisible({ timeout: 15_000 });
    const id = await ticket.getAttribute('data-ticket-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    return id;
  } finally {
    await context.close();
  }
}

/** Where the two requests sit in the desk's queue, and their scores. */
async function queueOrder(plainId, flaggedId) {
  const res = await asDesk('lead', 'query', 'listQueue', { limit: 500 });
  const entries = res.json?.result?.data?.entries;
  expect(Array.isArray(entries), `listQueue: ${res.text.slice(0, 300)}`).toBe(true);
  const at = (id) => {
    const i = entries.findIndex((e) => e.ticketId === id);
    expect(i, `${id} is not in the queue`).toBeGreaterThanOrEqual(0);
    return { at: i, score: entries[i].score };
  };
  return { plain: at(plainId), flagged: at(flaggedId) };
}

test(`${J} #2 reading the customer's balance or withdrawal destination is refused until two checks the customer can confirm are recorded`, async ({
  browser,
}) => {
  const { ticket } = await request(browser);
  const res = await asDesk('lead', 'query', 'customerBalance', { ticketId: ticket.id });
  expect(res.status, `customerBalance: ${res.text.slice(0, 300)}`).not.toBe(404);
  expect(res.text).toContain('support.verification_checks_required');
});

test(`${J} #3 the account state is read for the ticket's owner only, one append-only row records who looked, and no balance is in it`, async ({
  browser,
}) => {
  const { ticket, userId, who } = await request(browser);
  const { lead: leadId } = await deskPeople();
  // The lead works this request: the claim in request() landed.
  expect((await lead('query', 'get', { ticketId: ticket.id })).assigneeId).toBe(leadId);
  const sql = await supportDb();
  try {
    const rows = () =>
      sql`SELECT id, sequence, kind, actor_id, actor_role, from_status, to_status, note, occurred_at
          FROM support.ticket_events WHERE ticket_id = ${ticket.id} AND kind = 'grounding_read' ORDER BY sequence`;
    const before = await rows();

    // The read answers the ticket owner's account state, and nothing about money.
    const state = await lead('query', 'accountState', { ticketId: ticket.id });
    expect(state).toMatchObject({ status: 'read', state: { userId } });
    expect(Object.keys(state.state).sort()).toEqual(expect.arrayContaining(['kycTier', 'status', 'userId']));
    expect(JSON.stringify(state)).not.toMatch(/balance|available|amount|"(asset|total|locked)"/i);

    // Anyone else's account is not readable: the read takes a ticket, never a user, so naming another account is refused as
    // a shape error, and the customer themselves (who is not on the desk) is refused the desk's read.
    expect(await refused('query', 'accountState', { ticketId: ticket.id, userId: '00000000-0000-4000-8000-000000000000' })).toMatch(
      /unrecognized|BAD_REQUEST|invalid/i,
    );
    const self = await (await api(who)).get(query('accountState', { ticketId: ticket.id }));
    expect(self.status, JSON.stringify(self.body).slice(0, 300)).not.toBe(200);
    expect(JSON.stringify(self.body)).not.toContain('"kycTier"');
    // A desk agent who does not own the request is refused too. Once the desk has groups, an agent sees only what is
    // assigned to them or in their groups (the stack marks no role as seeing every group), so the agent, founder B, is
    // answered as if the request did not exist, and reads nothing.
    await ensureDeskGroup(`TEST ${J} desk`);
    const { agent } = await deskPeople();
    expect(agent).not.toBe(leadId);
    const other = await asDesk('agent', 'query', 'accountState', { ticketId: ticket.id });
    expect(other.json?.result?.data, other.text.slice(0, 300)).toBeUndefined();
    expect(other.text).toContain('support.not_found');

    // Exactly one row, from the one answered read: it names the lead as the operator who looked, and holds no balance.
    const after = await rows();
    expect(after).toHaveLength(before.length + 1);
    const row = after.at(-1);
    expect(row).toMatchObject({ kind: 'grounding_read', actor_id: leadId, actor_role: 'operator', from_status: null, to_status: null });
    expect(row.note).toBe(`account_state:${state.state.status}`);
    expect(Object.keys(row).filter((k) => /amount|balance|value|asset/i.test(k))).toEqual([]);
    const columns =
      await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'support' AND table_name = 'ticket_events'`;
    expect(columns.map((c) => c.column_name).filter((c) => /amount|balance|value|asset/i.test(c))).toEqual([]);
    // The desk's own trail shows the same row.
    const trail = (await lead('query', 'events', { ticketId: ticket.id, limit: 500 })).filter((e) => e.kind === 'grounding_read');
    expect(trail.at(-1)).toMatchObject({ id: row.id, actorId: leadId, note: row.note });

    // Append-only: the row can be neither changed nor removed, even by svc-support's own database role, and stays as it was.
    await expect(sql`UPDATE support.ticket_events SET note = ${'TEST rewritten'} WHERE id = ${row.id}`).rejects.toThrow(
      /ticket_events is append-only: UPDATE refused|permission denied/,
    );
    await expect(sql`DELETE FROM support.ticket_events WHERE id = ${row.id}`).rejects.toThrow(
      /ticket_events is append-only: DELETE refused|permission denied/,
    );
    expect(await rows()).toEqual(after);
  } finally {
    await sql.end();
  }
});

test(`${J} #4 a note that says the money moved is refused, and a closed or resolved deposit or withdrawal request never claims a payout`, async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { who } = await request(browser);
  // Its own requests: closing one is final, so the shared request stays open for the other steps.
  const plain = await claimed(who, 'settle');
  const paid = 'TEST The withdrawal has been paid out to the customer.';
  const trail = async (id) => (await lead('query', 'events', { ticketId: id, limit: 500 })).filter((e) => e.kind === 'status_changed');
  const was = (await lead('query', 'get', { ticketId: plain.id })).status;
  const moves = await trail(plain.id);

  // Resolving a deposit or withdrawal request would claim a payout: refused with a note that says the money moved and
  // without one. Closing it with a note that says the money moved is refused too. Nothing changes.
  for (const [status, note] of [
    ['resolved', paid],
    ['resolved', undefined],
    ['closed', paid],
    ['closed', 'TEST Refunded to the customer, credited back.'],
  ]) {
    const text = await refused('mutation', 'setStatus', { ticketId: plain.id, status, ...(note ? { note } : {}) });
    expect(text, `${status} ${note ?? '(no note)'}`).toContain('support.settle.refused');
    expect((await lead('query', 'get', { ticketId: plain.id })).status).toBe(was);
    expect(await trail(plain.id)).toEqual(moves);
  }
  // And the desk has no money act to call instead.
  for (const act of ['complete_withdrawal', 'unfreeze_account', 'move_money'])
    expect(await refused('mutation', 'settle', { act, ticketId: plain.id })).toContain('support.settle.refused');
  expect((await lead('query', 'get', { ticketId: plain.id })).status).toBe(was);

  // Closed with a note that claims nothing, it closes, and the record and the customer's read say nothing of a payout.
  const note = `TEST ${J} #4 the customer's question is answered; the owning module has the request`;
  const closed = await lead('mutation', 'setStatus', { ticketId: plain.id, status: 'closed', note });
  expect(closed.status).toBe('closed');
  expect((await trail(plain.id)).at(-1)).toMatchObject({ toStatus: 'closed', note });
  const mine = await (await api(who)).get(query('get', { ticketId: plain.id }));
  expect(mine.status).toBe(200);
  expect(JSON.stringify(mine.body)).not.toMatch(/paid|payout|refund|credited|money (moved|sent)/i);

  // Once escalated as a money request, even a plain close is refused: the request's close would read as its settlement.
  const money = await claimed(who, 'money');
  await lead('mutation', 'escalate', { ticketId: money.id, reason: 'money_request', summary: `TEST ${J} ${RUN} #4 missing withdrawal` });
  const moneyWas = (await lead('query', 'get', { ticketId: money.id })).status;
  const moneyMoves = await trail(money.id);
  for (const status of ['closed', 'resolved'])
    expect(await refused('mutation', 'setStatus', { ticketId: money.id, status, note })).toContain('support.settle.refused');
  expect((await lead('query', 'get', { ticketId: money.id })).status).toBe(moneyWas);
  expect(await trail(money.id)).toEqual(moneyMoves);
});

test(`${J} #5 a comment holding a card number or a seed phrase is refused and nothing is stored`, async ({ browser }) => {
  const { ticket, who } = await request(browser);
  const card = 'TEST my card is 4111 1111 1111 1111, please check it';
  const seed = 'TEST abandon ability able about above absent absorb abstract absurd abuse access accident';
  const count = async () => (await lead('query', 'listComments', { ticketId: ticket.id, limit: 500 })).length;
  const before = await count();
  // From the desk, as a public reply and as an internal note.
  for (const body of [card, seed]) {
    expect(await refused('mutation', 'comment', { ticketId: ticket.id, body })).toContain('support.comment_secret_refused');
    expect(
      await refused('mutation', 'addInternalNote', { ticketId: ticket.id, body, clientRequestId: `j20:${RUN}:note:${body.length}` }),
    ).toContain('support.comment_secret_refused');
  }
  // From the customer.
  const client = await api(who);
  for (const body of [card, seed]) {
    const res = await client.post('/api/support/trpc/comment', {
      ticketId: ticket.id,
      body,
      clientRequestId: `j20:${RUN}:c:${body.length}`,
    });
    expect(res.status).not.toBe(200);
    expect(JSON.stringify(res.body)).toContain('support.comment_secret_refused');
  }
  expect(await count()).toBe(before);
});

test(`${J} #6 escalated as a money request with citations; with no citations it is refused; the case file has no amount field and no ledger entry is posted`, async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { ticket, who } = await request(browser);
  const client = await api(who);
  const ledger = async () => {
    const res = await client.get('/api/v1/ledger?limit=200');
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return { entries: res.body.entries, balances: await client.balances() };
  };
  const before = await ledger();
  const escalatedBefore = (await lead('query', 'events', { ticketId: ticket.id, limit: 500 })).filter((e) => e.kind === 'escalated');

  const file = await lead('mutation', 'escalate', {
    ticketId: ticket.id,
    reason: 'money_request',
    summary: `TEST ${J} ${RUN} customer reports a missing withdrawal`,
  });
  // Escalated, grounded in what support read: the customer's account state, read from svc-identity.
  expect(file).toMatchObject({ ticketId: ticket.id, reason: 'money_request', grounding: { status: 'read' } });
  expect(file.citations.length).toBeGreaterThan(0);
  expect(file.citations.map((c) => c.kind)).toContain('account_state');
  const read = await lead('query', 'caseFile', { ticketId: ticket.id });
  expect(read).toMatchObject({ ticketId: ticket.id, reason: 'money_request', citations: file.citations });
  const escalated = (await lead('query', 'events', { ticketId: ticket.id, limit: 500 })).filter((e) => e.kind === 'escalated');
  expect(escalated).toHaveLength(escalatedBefore.length + 1);

  // The case file has no amount field: not in what the desk is answered, and not in the table that keeps it.
  const fields = (o) => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => [k, ...fields(v)]) : []);
  expect(fields(file).filter((k) => /^(amount|value|quantity|asset|currency)$/i.test(k))).toEqual([]);
  expect(fields(read).filter((k) => /^(amount|value|quantity|asset|currency)$/i.test(k))).toEqual([]);
  const sql = await supportDb();
  try {
    const columns =
      await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'support' AND table_name = 'case_files'`;
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.map((c) => c.column_name).filter((c) => /amount|value|quantity|asset|currency/i.test(c))).toEqual([]);
  } finally {
    await sql.end();
  }

  // No ledger entry is posted: the customer's ledger lines and balances are exactly as they were.
  expect(await ledger()).toEqual(before);

  // With nothing to cite, the escalation is refused. A request from someone with no account (a guest's emailed request)
  // has no account state to read and, before anyone writes on it, no comment: escalating it cites nothing.
  const guestTicket = await guestRequest(browser);
  const guestEvents = async () => lead('query', 'events', { ticketId: guestTicket, limit: 500 });
  const eventsBefore = await guestEvents();
  expect(
    await refused('mutation', 'escalate', { ticketId: guestTicket, reason: 'money_request', summary: `TEST ${J} ${RUN} nothing read` }),
  ).toContain('support.case_file.ungrounded');
  expect(await guestEvents()).toEqual(eventsBefore);
  // No case file was stored for it.
  const noFile = await asDesk('lead', 'query', 'caseFile', { ticketId: guestTicket });
  expect(noFile.status, noFile.text.slice(0, 300)).toBe(200);
  expect(noFile.json.result.data).toBeNull();
});

test(`${J} #7 a withdrawal freeze asked from the request is recorded by the identity service; no credit is posted and a status change never lifts it`, async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // Its own customer, so the freeze touches no other step's account.
  const page = await visitor(browser);
  const who = await fundedTrader(page, 'j20f', '20');
  await page.context().close();
  const client = await api(who);
  const made = await client.post('/api/support/trpc/create', {
    category: 'deposit_withdraw',
    subject: `TEST ${J} ${RUN} withdrawal missing, freeze`,
    body: 'TEST My withdrawal never arrived and I think someone else is in my account.',
    clientRequestId: `j20f:${RUN}`,
  });
  expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  const ticket = made.body.result.data;
  await lead('mutation', 'claim', { ticketId: ticket.id }).catch(() => null);
  const lockOf = async () => (await client.get('/api/identity/trpc/securityLock.read')).body.result.data;
  const order = await restingOrder(who);
  const orderStatus = async () => (await client.get(`/api/v1/orders/${order}?symbol=BTC%2FUSDT`)).body.status;
  const before = { balances: await client.balances(), order: await orderStatus() };
  expect(before.order).toBe('open');
  expect((await lockOf()).locked).toBe(false);

  // The customer can't ask it for themselves through the desk's door.
  const self = await client.post('/api/support/trpc/requestWithdrawalFreeze', { ticketId: ticket.id, reason: 'TEST' });
  expect(self.status, JSON.stringify(self.body).slice(0, 300)).not.toBe(200);
  expect((await lockOf()).locked).toBe(false);

  // The desk asks; svc-identity records it as the account's security lock, set by support, with its audit row.
  const res = await asDesk('lead', 'mutation', 'requestWithdrawalFreeze', { ticketId: ticket.id, reason: `TEST ${J} #7` });
  expect(res.status, `requestWithdrawalFreeze: ${res.text.slice(0, 300)}`).toBe(200);
  const frozen = res.json.result.data;
  expect(frozen).toMatchObject({
    recordedBy: 'svc-identity',
    changed: true,
    lock: { userId: client.userId, locked: true, setBy: 'support' },
  });
  expect(frozen.auditId).toMatch(/^[0-9a-f-]{36}$/);
  // Asking again from the same request answers the first record.
  const again = (await asDesk('lead', 'mutation', 'requestWithdrawalFreeze', { ticketId: ticket.id, reason: `TEST ${J} #7` })).json.result
    .data;
  expect(again).toMatchObject({ changed: false, auditId: frozen.auditId });
  expect(await lockOf()).toMatchObject({ locked: true, setBy: 'support', unlocksAt: null });

  // The audit row, read back from svc-identity through the desk: one row for this request, the one the freeze answered,
  // naming the request, the agent and the reason, and that this ask set the lock.
  const audit = async () => lead('query', 'withdrawalFreezeRecords', { ticketId: ticket.id });
  expect(await audit()).toEqual({
    recordedBy: 'svc-identity',
    records: [
      {
        id: frozen.auditId,
        ticketId: ticket.id,
        operatorId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        reason: `TEST ${J} #7`,
        lockSet: true,
        recordedAt: frozen.recordedAt,
      },
    ],
  });
  // The customer can't read it through the desk's door.
  const peek = await client.get(query('withdrawalFreezeRecords', { ticketId: ticket.id }));
  expect(peek.status, JSON.stringify(peek.body).slice(0, 300)).not.toBe(200);

  // No credit is posted and the existing hold stays: the balances and the resting order are as they were.
  expect(await client.balances()).toEqual(before.balances);
  expect(await orderStatus()).toBe('open');

  // Moving the request through pending, on hold and closed never lifts it (a deposit or withdrawal request can't be
  // marked resolved: that would claim a payout, #4), and a closed request takes no new freeze.
  // The walk starts from wherever the request stands now (a new request may already be pending), since asking for the
  // status it already has is refused as no change.
  const walk = ['pending', 'on_hold', 'closed'];
  const now = (await lead('query', 'get', { ticketId: ticket.id })).status;
  expect(['open', ...walk.slice(0, -1)]).toContain(now);
  for (const status of walk.slice(walk.indexOf(now) + 1)) {
    const note = status === 'on_hold' ? `TEST ${J} #7 waiting on the customer's identity check` : undefined;
    expect((await lead('mutation', 'setStatus', { ticketId: ticket.id, status, ...(note ? { note } : {}) })).status).toBe(status);
    expect(await lockOf()).toMatchObject({ locked: true, setBy: 'support' });
  }
  expect(await refused('mutation', 'requestWithdrawalFreeze', { ticketId: ticket.id, reason: 'TEST' })).toContain('support.ticket_closed');
  expect(await client.balances()).toEqual(before.balances);
  // The record is unchanged by the walk and the refused ask: still the one row.
  expect((await audit()).records.map((row) => row.id)).toEqual([frozen.auditId]);
});

test(`${J} #8 the customer reads a plain status, no promised time and no staff-only text`, async ({ browser }) => {
  const { ticket, who } = await request(browser);
  const note = `TEST ${J} ${RUN} staff only: ledger looks fine`;
  await lead('mutation', 'addInternalNote', { ticketId: ticket.id, body: note, clientRequestId: `j20:${RUN}:staff` });
  const page = await visitor(browser);
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(`/support/tickets/${ticket.id}`);
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: ticket.subject })).toBeVisible();
  await expect(main.locator('.support-status').first()).toHaveText(/^(Open|Awaiting your reply|Solved)$/);
  await expect(main.getByText(note)).toHaveCount(0);
  await expect(main.getByText(/within \d|by \d{1,2}:\d{2}|due|expected (by|on)|\d+ (hours|days)/i)).toHaveCount(0);
  const client = await api(who);
  const read = await client.get(query('get', { ticketId: ticket.id }));
  expect(JSON.stringify(read.body)).not.toContain(note);
  expect(JSON.stringify(read.body)).not.toMatch(/"(dueAt|due_at|target|promisedAt|slaDue)"/);
  await page.context().close();
});
