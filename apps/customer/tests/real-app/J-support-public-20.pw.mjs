// World: book, restart, stack
import { test, expect } from './journey.mjs';
import { asDesk } from './help-centre.mjs';
import { awayBid, fundedTrader } from './desk.mjs';
import { api, ORIGIN, tool } from './stack.mjs';

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

test(`${J} #3 the account state is read for the ticket's owner only, one row records who looked, and no balance is in it`, async ({
  browser,
}) => {
  const { ticket, userId } = await request(browser);
  const before = (await lead('query', 'events', { ticketId: ticket.id, limit: 500 })).filter((e) => e.kind === 'grounding_read');
  const state = await lead('query', 'accountState', { ticketId: ticket.id });
  expect(JSON.stringify(state)).toContain(userId);
  expect(JSON.stringify(state)).not.toMatch(/balance|available|amount/i);
  // The read takes a ticket, never a user: naming another account is refused as a shape error, not answered.
  expect(await refused('query', 'accountState', { ticketId: ticket.id, userId: '00000000-0000-4000-8000-000000000000' })).toMatch(
    /unrecognized|BAD_REQUEST|invalid/i,
  );
  const after = (await lead('query', 'events', { ticketId: ticket.id, limit: 500 })).filter((e) => e.kind === 'grounding_read');
  expect(after).toHaveLength(before.length + 1);
  expect(after.at(-1).actorId).toBe((await import('./help-centre.mjs').then((m) => m.deskPeople())).lead);
});

test(`${J} #4 resolving a deposit or withdrawal request with a note that says the money moved is refused, and so is any money act`, async ({
  browser,
}) => {
  const { ticket } = await request(browser);
  const text = await refused('mutation', 'setStatus', {
    ticketId: ticket.id,
    status: 'resolved',
    note: 'TEST The withdrawal has been paid out to the customer.',
  });
  expect(text).toContain('support.settle.refused');
  for (const act of ['complete_withdrawal', 'unfreeze_account', 'move_money'])
    expect(await refused('mutation', 'settle', { act, ticketId: ticket.id })).toContain('support.settle.refused');
  expect((await lead('query', 'get', { ticketId: ticket.id })).status).not.toBe('resolved');
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

test(`${J} #6 escalated as a money request, the case file carries its citations, no amount field and no ledger entry`, async ({
  browser,
}) => {
  const { ticket } = await request(browser);
  const file = await lead('mutation', 'escalate', {
    ticketId: ticket.id,
    reason: 'money_request',
    summary: `TEST ${J} ${RUN} customer reports a missing withdrawal`,
  });
  // Grounded in what support read (the account state at least); an escalation with nothing to cite is refused
  // (support.case_file.ungrounded, case-file.test.ts), which the running app cannot reach while identity answers.
  expect(file.citations.length).toBeGreaterThan(0);
  expect(JSON.stringify(file.citations)).toContain('account_state');
  expect(JSON.stringify(file)).not.toMatch(/"(amount|value|quantity|asset)"\s*:/);
  const read = await lead('query', 'caseFile', { ticketId: ticket.id });
  expect(read.reason).toBe('money_request');
  expect(Object.keys(read)).not.toContain('amount');
  const events = await lead('query', 'events', { ticketId: ticket.id, limit: 500 });
  expect(events.filter((e) => e.kind === 'escalated')).toHaveLength(1);
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
