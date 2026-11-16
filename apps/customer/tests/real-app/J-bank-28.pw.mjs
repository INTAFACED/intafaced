// World: restart
import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, api as stackApi, tool } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { setPartner, withPartner } from './partner.mjs';
import { STACK_PORTS } from '../../../../tooling/scripts/local-test-facts.mjs';

// J-bank-28, in the running app (docs/roadmap/journeys.json): I watch earn pools, ramps and direct debits (finance), on
// the founder console at /bank-ops/service. Ramps and direct debits are the partner's (OWNER 226); no partner is named,
// so the stack runs its TEST stand-ins: the pay-in partner for add money (`payin-sim`, with the TEST rate stand-in
// `ramp-sim`), the TEST partner bank that holds each person's money (`custody: 'off'`) and answers for their direct
// debits, and the TEST direct debit scheme (`dd-sim`), whose signed job doors this file calls as the scheme would.
//   #3 makes four TEST add-money orders (paid, approved, opened, and one whose quote the TEST ramp says ran out), and the
//      desk's orders by state, partner health and quote expiries match the partner's own report, read on loopback
//      straight from the stand-in (svc-bank src/ramps/ramp-partner-book.ts), never through the app. For one restart the
//      stack runs with no pay-in partner (LOCAL_STACK_BANK_ONRAMP_PARTNER=off) and the desk reads "no data", not zero.
//   #4 sets up three TEST mandates for one person at the TEST partner bank: one collected and then refunded by the
//      partner (credited once, as it reports, a second refund changing nothing), one blocked by the person (a collection
//      on it refused with the partner's reason), and one whose collection the partner refuses for want of money. The desk
//      shows the partner's mandates with state, blocks and refunds, and failures by reason, matching the partner's own
//      book (svc-bank src/partner/test-partner-record.ts); the ledger posts nothing.
// Steps 1 and 2 (pool rates and status under a second person) are Later (OWNER 226).
const J = 'J-bank-28';
const BANK = `http://127.0.0.1:${STACK_PORTS.bank}`;
const PARTNER_BANK = 'TEST partner bank';
const PARTNER_DD_BLOCKED = 'test_partner.dd_mandate_blocked';
const FUNDS = 'bank.partner_insufficient_funds';

test.describe.configure({ mode: 'default' });

/** A loopback read or write of a TEST partner's own record on svc-bank, never through Edge or the app's doors. */
async function partnerRecord(path, body) {
  const res = await fetch(`${BANK}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
/** The TEST ramp partner's own report: its orders by state, its health and its quote expiries. */
async function rampReport() {
  const res = await partnerRecord('/test-ramp-partner/report');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.value;
}
/** The TEST partner bank's own direct debit book: its mandates, refusals and refunds. */
async function ddBook() {
  const res = await partnerRecord('/test-partner/direct-debits', {});
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.value;
}

let jobCtx;
/** One signed call to a bank job door, as the scheme or the pay-in partner makes it. */
async function job(path, body) {
  jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} }));
  const ctx = await jobCtx;
  const raw = JSON.stringify(body);
  const res = await fetch(`${ctx.url('bank')}/internal/jobs/${path}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const answer = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`${path} refused: ${res.status} ${JSON.stringify(answer).slice(0, 300)}`);
  return answer;
}

/** A person's own svc-bank API through Edge, and their user id. */
async function customerBank(who) {
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused`);
  const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
  const answer = async (res) => {
    const body = await res.json();
    if (!res.ok) return { ok: false, status: res.status, code: body?.error?.data?.intafacedCode ?? body?.error?.data?.code, body };
    return { ok: true, data: body.result.data };
  };
  return {
    userId: login.result.data.userId,
    query: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, {
        headers,
      }).then(answer),
    mutate: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(answer),
  };
}

/** A new verified TEST person whose bank money the TEST partner bank holds (the launch model). */
async function partnerHeldPerson(browser, prefix) {
  const page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  const who = await signUp(page, prefix);
  await verify(page, who);
  await page.context().close();
  await setPartner(who, { custody: 'off' });
  return who;
}

async function desk(browser) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, 'a');
  await page.goto('/bank-ops/service');
  await expect(page.getByTestId('bank-service-desk')).toBeVisible({ timeout: 30_000 });
  return page;
}

/** The bank restarted with LOCAL_STACK_ switches set for that restart only (undefined puts the profile's TEST value back). */
function restartBank(switches) {
  const before = Object.fromEntries(Object.keys(switches).map((k) => [k, process.env[k]]));
  const set = (values) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  set(switches);
  try {
    tool('local-test-stack.mjs', 'restart', 'bank');
  } finally {
    set(before);
  }
}

/** One add-money order at the TEST pay-in partner: pay by bank from NL, `amount` USDT. Answers the request it opened. */
async function openOrder(own, method = 'pay_by_bank') {
  const started = await own.mutate('addMoney.start', { requestId: randomUUID(), assetId: 'USDT', amount: '10', method, country: 'NL' });
  return started;
}
/** The payer approves an order on the partner's own page (its approve button's form post). */
async function approve(onrampId) {
  const res = await fetch(`${BANK}/test/payin-sim/pay/${onrampId}/approve`, { method: 'POST', redirect: 'manual' });
  expect(res.status).toBe(303);
}
const counts = (report) => Object.fromEntries(report.orders.map((o) => [o.state, o.count]));

test(`${J} #3 reads ramp metrics: orders by state, partner health and quote expiries as the partner reports; with no partner, "no data"`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const who = await partnerHeldPerson(browser, 'jb28ramp');
  const own = await customerBank(who);
  expect((await own.mutate('currencies.add', { assetId: 'USDT' })).ok).toBe(true);
  const before = counts(await rampReport());

  // Four TEST orders at the partner: one paid, one approved by the payer, one only opened, and one whose quote the TEST
  // ramp says ran out (its own word, `rampQuote: 'expired'`), which the app refuses as expired.
  const paid = await openOrder(own);
  expect(paid, JSON.stringify(paid).slice(0, 300)).toMatchObject({ ok: true, data: { status: 'opened' } });
  await approve(paid.data.onramp.onrampId);
  await job('payin-sim/paid', { requestId: paid.data.requestId, paidAmount: paid.data.onramp.payAmount, payCurrency: 'EUR' });
  const approved = await openOrder(own);
  expect(approved.ok).toBe(true);
  await approve(approved.data.onramp.onrampId);
  const opened = await openOrder(own);
  expect(opened.ok).toBe(true);
  await withPartner(who, { custody: 'off', rampQuote: 'expired' }, async () => {
    const expired = await openOrder(own, 'card');
    expect(expired.ok ? expired.data.refusalCode : expired.code, JSON.stringify(expired).slice(0, 300)).toBe('bank.onramp_quote_expired');
  });
  await setPartner(who, { custody: 'off' });

  const report = await rampReport();
  const after = counts(report);
  // The partner's own book moved by exactly these four orders.
  expect(after.paid - before.paid).toBe(1);
  expect(after.approved - before.approved).toBe(1);
  expect(after.opened - before.opened).toBe(1);
  expect(after.expired - before.expired).toBe(1);
  expect(report.quoteExpiries.count).toBe(after.expired);
  expect(report.label).toMatch(/^TEST\b/);

  // The desk shows the partner's report: every state with its count, its health, and the quote expiries by order.
  const page = await desk(browser);
  const metrics = page.getByTestId('ramp-metrics');
  await expect(metrics.getByTestId('ramp-source')).toContainText(`As ${report.label} reports it`);
  await expect(metrics.getByTestId('ramp-health-state')).toHaveText('Operational');
  for (const { state, count } of report.orders) {
    await expect(metrics.locator(`[data-testid="ramp-order-state"][data-state="${state}"] [data-testid="ramp-order-count"]`)).toHaveText(
      String(count),
    );
  }
  await expect(metrics.getByTestId('ramp-quote-expiries')).toHaveAttribute('data-count', String(report.quoteExpiries.count));
  const shownExpiries = await metrics.getByTestId('ramp-quote-expiry').evaluateAll((els) => els.map((e) => e.getAttribute('data-order')));
  expect(shownExpiries).toEqual(report.quoteExpiries.latest.map((e) => e.orderId));
  // The order the partner opened on the quote it says ran out is in its expiries, and none of the other three is.
  const mine = new Set([paid, approved, opened].map((o) => o.data.onramp.onrampId));
  expect(report.quoteExpiries.latest.some((e) => mine.has(e.orderId))).toBe(false);
  expect(report.quoteExpiries.latest.length).toBeGreaterThan(0);
  await page.context().close();

  // With no pay-in partner at all, the desk says "no data", never zero orders.
  restartBank({ LOCAL_STACK_BANK_ONRAMP_PARTNER: 'off' });
  try {
    expect((await partnerRecord('/test-ramp-partner/report')).status).toBe(404);
    const none = await desk(browser);
    await expect(none.getByTestId('ramps-no-data')).toContainText('No data');
    await expect(none.getByTestId('ramp-metrics')).toHaveCount(0);
    await none.context().close();
  } finally {
    restartBank({ LOCAL_STACK_BANK_ONRAMP_PARTNER: undefined });
  }
});

test(`${J} #4 opens direct debit mandates: the partner's mandates with state, blocks and refunds; failures by reason`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const who = await partnerHeldPerson(browser, 'jb28dd');
  const own = await customerBank(who);
  const owner = own.userId;
  expect(owner).toBeTruthy();
  const funded = await own.mutate('testPartner.fund', { fundId: `jb28-${who.email}`.slice(0, 64), assetId: 'USDT', amount: '20' });
  expect(funded, JSON.stringify(funded).slice(0, 300)).toMatchObject({ ok: true, data: { balance: '20' } });
  const ledgerBefore = (await (await stackApi(who)).balances()).USDT ?? null;
  const partnerUsdt = async () => {
    const res = await own.query('spaces.list', { limit: 50 });
    const main = res.data.find((s) => s.kind === 'primary' && s.assetId === 'USDT');
    expect(main).toMatchObject({ ledgerAccount: null, heldAt: { label: PARTNER_BANK } });
    return main.balance;
  };

  const tag = randomUUID().slice(0, 8);
  const gym = `TEST-GYM-${tag}`,
    power = `TEST-POWER-${tag}`,
    club = `TEST-CLUB-${tag}`;
  const due = new Date(Date.now() - 60_000).toISOString();
  await job('dd-sim/mandate', { mandateId: gym, userId: owner, creditorId: 'TEST-GYM', reference: `GYM ${tag}`, assetId: 'USDT' });
  await job('dd-sim/mandate', { mandateId: power, userId: owner, creditorId: 'TEST-POWER', reference: `PWR ${tag}`, assetId: 'USDT' });
  await job('dd-sim/mandate', { mandateId: club, userId: owner, creditorId: 'TEST-GYM', reference: `CLUB ${tag}`, assetId: 'USDT' });

  // The gym collects 5 and the club asks for 100, more than the partner holds; the run decides both.
  await job('dd-sim/collection', { mandateId: gym, collectionId: `${tag}-due`, amount: '5', dueAt: due });
  await job('dd-sim/collection', { mandateId: club, collectionId: `${tag}-big`, amount: '100', dueAt: due });
  const decided = async () => {
    const { collections } = (await own.query('directDebits.list', {})).data;
    const st = (id) => collections.find((c) => c.collectionId === `${tag}-${id}`)?.status;
    return st('due') === 'collected' && st('big') === 'failed';
  };
  for (let pass = 0; pass < 20 && !(await decided()); pass += 1) await job('run-due-direct-debits', { limit: 50 });
  expect(await decided()).toBe(true);
  expect(await partnerUsdt()).toBe('15');

  // The person blocks the power company with the partner; a collection it presents is refused with the partner's reason.
  const blocked = await own.mutate('directDebits.block', { mandateId: power });
  expect(blocked, JSON.stringify(blocked).slice(0, 300)).toMatchObject({ ok: true });
  const late = await job('dd-sim/collection', { mandateId: power, collectionId: `${tag}-late`, amount: '3', dueAt: due });
  expect(late).toMatchObject({ status: 'rejected', failureCode: PARTNER_DD_BLOCKED });

  // The partner refunds the gym's collection under the scheme's guarantee: credited once, as it reports.
  const refund = await partnerRecord('/test-partner/dd-refund', { owner, mandateId: gym, collectionId: `${tag}-due` });
  expect(refund.status, JSON.stringify(refund.body).slice(0, 300)).toBe(200);
  expect(refund.body.value).toMatchObject({ owner, mandateId: gym, collectionId: `${tag}-due`, assetId: 'USDT', amount: '5' });
  expect(await partnerUsdt()).toBe('20');
  const again = await partnerRecord('/test-partner/dd-refund', { owner, mandateId: gym, collectionId: `${tag}-due` });
  expect(again.body.value.moveId).toBe(refund.body.value.moveId);
  expect(await partnerUsdt()).toBe('20');
  // A collection the partner never moved has nothing to refund, and nothing moves.
  const none = await partnerRecord('/test-partner/dd-refund', { owner, mandateId: club, collectionId: `${tag}-big` });
  expect(none).toMatchObject({ status: 409, body: { code: 'bank.dd_refund_not_collected' } });
  expect(await partnerUsdt()).toBe('20');
  // The money is the partner's: the ledger posted nothing for this person.
  expect((await (await stackApi(who)).balances()).USDT ?? null).toEqual(ledgerBefore);

  // The partner's own book for this person.
  const book = await ddBook();
  const ours = (list) => list.filter((x) => x.owner === owner);
  expect(
    ours(book.mandates)
      .map((m) => [m.mandateId, m.state])
      .sort(),
  ).toEqual(
    [
      [club, 'active'],
      [gym, 'active'],
      [power, 'blocked'],
    ].sort(),
  );
  expect(
    ours(book.failures)
      .map((f) => [f.mandateId, f.collectionId, f.code])
      .sort(),
  ).toEqual(
    [
      [club, `${tag}-big`, FUNDS],
      [power, `${tag}-late`, PARTNER_DD_BLOCKED],
    ].sort(),
  );
  expect(ours(book.refunds)).toHaveLength(1);

  // The desk: the partner's mandates with state, blocks and refunds, and failures by reason, as the partner reports.
  const page = await desk(browser);
  const report = page.getByTestId('dd-report');
  await expect(report.getByTestId('dd-source')).toContainText(`As ${PARTNER_BANK} reports it`);
  const row = (id) => report.locator(`[data-testid="dd-mandate"][data-mandate="${id}"]`);
  await expect(row(gym)).toHaveAttribute('data-state', 'active');
  await expect(row(gym)).toContainText('TEST Gym membership, reference GYM');
  const refundLine = row(gym).getByTestId('dd-refund');
  await expect(refundLine).toHaveAttribute('data-amount', '5');
  await expect(refundLine).toContainText(`Refunded 5 USDT for collection ${tag}-due`);
  await expect(refundLine).toContainText(refund.body.value.moveId);
  await expect(row(power)).toHaveAttribute('data-state', 'blocked');
  await expect(row(power).getByTestId('dd-mandate-state')).toContainText('Blocked since');
  await expect(row(power).getByTestId('dd-failure')).toHaveAttribute('data-code', PARTNER_DD_BLOCKED);
  await expect(row(club)).toHaveAttribute('data-state', 'active');
  await expect(row(club).getByTestId('dd-failure')).toHaveAttribute('data-code', FUNDS);
  await expect(row(club).getByTestId('dd-failure')).toContainText('Not enough money at the partner');
  // Failures by reason are the partner's whole book, counted: each reason the desk shows matches the partner's count.
  const byReason = {};
  for (const f of book.failures) byReason[f.code] = (byReason[f.code] ?? 0) + 1;
  const shown = await report
    .getByTestId('dd-failure-reason')
    .evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-code'), Number(e.getAttribute('data-count'))])));
  expect(shown).toEqual(byReason);
  await page.context().close();
});
