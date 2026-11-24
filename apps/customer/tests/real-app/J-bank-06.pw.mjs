// World: none
import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, STACK_PORTS, api as stackApi, fromUnits, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { venueBalance, venueRecord } from './venue.mjs';
import { ageRecord } from './test-age.mjs';
import { DAY, utcDay } from './clock.mjs';

// J-bank-06, in the running app (docs/roadmap/journeys.json): I schedule payments and standing orders. The person's bank
// money is held at the TEST partner bank (`testPartner.set({ custody: 'off' })`, the launch model, OWNER 226), funded
// there with TEST 100 USDT (`testPartner.fund`, the partner's figure): every run, collection and block is an instruction
// to the partner, and the ledger posts nothing, which each money step checks. Steps 1 to 3 (BK-xfer-10): a one-off on a
// date, a standing order edited with a revision, and what a run does, between the person's own spaces at the partner. The stack has no timer for the standing-order runner:
// this file runs it with the job door's own signed call, as a scheduler would. The edit cutoff is the bank profile's
// TEST value of 60 minutes. Step 4 (BK-xfer-11): direct debits through the stack's TEST scheme stand-in (`dd-sim`),
// whose creditors set up mandates and present collections only by its signed job doors, which this file calls as the
// scheme would; the collection run is its job door too. Step 5 (BK-acct-10): the money calendar over what steps 1 to 4
// left, read only, and a monthly bill the person sets up in Bills once their bank rail at the TEST partner is on
// (`testPartner.set({ bankRail: 'test' })`: the partner pays its own TEST billers); setting it up sends nothing. Step 6 (BK-acct-10): the payment reminder rule saved under its business key, money-moving rules
// refused while their terms are unpublished, the notification choices read from the account's own settings, and the
// notices the bank's notice job owes, run with its signed job door as a scheduler would. Step 8: the person's TEST switch
// (`testPartner.set({ calendarSource })`, svc-bank `partner/test-partner-switches.ts`) fails the direct debits source,
// and the calendar names it while every other kind still shows. Step 7 waits for custody (Later).
const J = 'J-bank-06';
const TRIP = 'Trip TEST';
const EMPTY = 'Empty TEST';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const PARTNER_BANK = 'TEST partner bank';
/** The TEST partner's own reason code for a collection on a mandate the person blocked with it. */
const PARTNER_DD_BLOCKED = 'test_partner.dd_mandate_blocked';
/** The TEST partner bank's own record, on loopback (svc-bank src/partner/test-partner-record.ts): its book, not our doors. */
const PARTNER_RECORD = `http://127.0.0.1:${STACK_PORTS.bank}/test-partner`;

test.describe.configure({ mode: 'default' });

/** The person's own svc-bank (or another service's) API through Edge, with a session of its own (not the browser's). */
async function bank(who, service = 'bank') {
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
    query: (procedure, input) =>
      fetch(`${EDGE}/api/${service}/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, {
        headers,
      }).then(answer),
    mutate: (procedure, input) =>
      fetch(`${EDGE}/api/${service}/trpc/${procedure}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(answer),
  };
}

let jobCtx;
/** One signed call to a bank job door, as the stack's own tooling (or the scheme) makes it. Refusals come back as data. */
async function job(path, body = {}) {
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
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function scheme(path, body) {
  const res = await job(path, body);
  if (res.status !== 200) throw new Error(`${path} refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body;
}
/** One pass of the standing-order runner, signed as the stack's own tooling calls a job door. */
const runOnce = () => scheme('run-due-transfers', {});
/**
 * Runner passes until nothing is due, as a scheduler would call it: the stack's TEST batch is one schedule a pass. Other
 * journeys' orders share this stack, and one that keeps failing stays due, so this stops after 30 passes and the steps
 * check this person's own records, not the stack-wide totals.
 */
async function runDue() {
  const total = { passes: 0, settled: 0, rejected: 0, failures: [] };
  while (total.passes < 30) {
    const pass = await runOnce();
    if (pass.schedulesConsidered === 0) break;
    total.passes += 1;
    total.settled += pass.settled;
    total.rejected += pass.rejected;
    total.failures.push(...(pass.failures ?? []));
  }
  return total;
}

function person() {
  const { who } = run.read();
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}
const main = (rows) => rows.find((s) => s.kind === 'primary' && s.assetId === 'USDT');
/** The person's user id, the owner the partner keeps their book under. */
async function userIdOf(who) {
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then((r) => r.json());
  const owner = login?.result?.data?.userId;
  expect(owner).toBeTruthy();
  return owner;
}
/** Every move on the person's record at the TEST partner, oldest first, as its own book lists it. */
const partnerMoves = async (owner) => (await venueRecord(owner, '/moves', {}, PARTNER_RECORD, null)).value;
/** The person's main USDT balance as the TEST partner's own book holds it. */
const partnerMain = async (owner) => (await venueBalance(owner, 'USDT', PARTNER_RECORD)).total;
/** The partner's own direct debit book: its mandates and the collections it refused, for this person only. */
async function partnerDirectDebits(owner) {
  const { value } = await venueRecord(owner, '/direct-debits', {}, PARTNER_RECORD, null);
  return { mandates: value.mandates.filter((m) => m.owner === owner), failures: value.failures.filter((f) => f.owner === owner) };
}
/**
 * The journey's start at the TEST partner bank: the person's bank money held there (`custody: 'off'`) and TEST 100 USDT
 * paid in there, the partner's figure and no ledger post. The TEST partner keeps its book in memory for one svc-bank
 * process (svc-bank `partner/test-partner.ts`); this file never restarts svc-bank.
 */
async function atPartner(who) {
  const own = await bank(who);
  const held = await own.mutate('testPartner.set', { custody: 'off' });
  expect(held, JSON.stringify(held.body ?? {}).slice(0, 300)).toMatchObject({ ok: true });
  const funded = await own.mutate('testPartner.fund', { fundId: `jb06-${who.email}`.slice(0, 64), assetId: 'USDT', amount: '100' });
  expect(funded, JSON.stringify(funded.body ?? {}).slice(0, 300)).toMatchObject({ ok: true, data: { balance: '100' } });
  expect(main(await spaces(who))).toMatchObject({ balance: '100', ledgerAccount: null, heldAt: { label: PARTNER_BANK } });
}
/** The ledger's USDT figures for `who`, in units: their bank money is the partner's, so these never change. */
async function ledgerUsdt(who) {
  const row = (await (await stackApi(who)).balances()).USDT;
  return row ? { free: toUnits(row.free), used: toUnits(row.used), total: toUnits(row.total) } : null;
}
const named = (rows, name) => rows.find((s) => s.name === name);
async function spaces(who) {
  const res = await (await bank(who)).query('spaces.list', { limit: 50 });
  if (!res.ok) throw new Error(`spaces.list refused: ${res.status}`);
  return res.data;
}
async function schedules(who) {
  const res = await (await bank(who)).query('transfers.listSchedules', { limit: 50 });
  if (!res.ok) throw new Error(`transfers.listSchedules refused: ${res.status}`);
  return res.data;
}
async function executions(who, scheduleId) {
  const res = await (await bank(who)).query('transfers.executions', { scheduleId, limit: 50 });
  if (!res.ok) throw new Error(`transfers.executions refused: ${res.status}`);
  return res.data;
}
/** A `datetime-local` value, in the browser's (and this process's) local time. */
function local(at) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
const inHours = (h) => new Date(Date.now() + h * 3600_000);
const row = (page, id) => page.locator('article[data-testid="money-standing-record"]').filter({ hasText: id });

/** The transfers room's schedule form, from the main balance to the trip space, filled up to the review. */
async function scheduleInApp(page, { cadence, amount, startsAt, endsAt }) {
  const before = await spaces(person());
  await page.goto('/bank/transfers');
  await page.getByLabel('From your space').selectOption(main(before).id);
  await page.getByText('Schedule it for a later date, once or repeating').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('To which of your accounts').selectOption(named(before, TRIP).id);
  await dialog.getByLabel(/Amount/).fill(amount);
  await dialog.getByLabel('Cadence').selectOption({ label: cadence });
  await dialog.getByLabel('First run').fill(local(startsAt));
  if (endsAt) await dialog.getByLabel('Last run by (optional)').fill(local(endsAt));
  await dialog.getByRole('button', { name: 'Review' }).click();
  return dialog;
}

test(`${J} #1 schedules a one-off for tomorrow: on its date the partner is instructed once under a retry-safe key, and the schedule ends`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await signUp(page, 'jb6');
  await verify(page, who);
  await atPartner(who);
  const owner = await userIdOf(who);
  run.reset({ who, owner, ledger: await ledgerUsdt(who) });
  const api = await bank(who);
  expect((await api.mutate('spaces.create', { assetId: 'USDT', name: TRIP })).ok).toBe(true);
  expect((await api.mutate('spaces.create', { assetId: 'USDT', name: EMPTY })).ok).toBe(true);
  await signIn(page, who);

  // A one-off with an end date is refused in the app before anything is sent.
  const sent = [];
  page.on('request', (req) => req.method() === 'POST' && req.url().includes('/api/bank/trpc/transfers.schedule') && sent.push(req.url()));
  const refused = await scheduleInApp(page, { cadence: 'One-off', amount: '5', startsAt: inHours(24), endsAt: inHours(48) });
  await expect(refused).toContainText('A one-off has no end date');
  expect(sent).toEqual([]);
  await refused
    .getByRole('button', { name: /cancel|close/i })
    .first()
    .click();

  // Scheduled in the app for tomorrow: one scheduled item with its date, and nothing sent to the partner yet.
  const tomorrow = inHours(24);
  const start = await spaces(who);
  const dialog = await scheduleInApp(page, { cadence: 'One-off', amount: '5', startsAt: tomorrow });
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByText('Confirmed by the service')).toBeVisible({ timeout: 30_000 });
  const [once] = (await schedules(who)).filter((s) => s.cadence === 'once');
  expect(once).toMatchObject({ amount: '5', status: 'active', endsAt: null, revision: 1 });
  expect(Math.abs(Date.parse(once.nextRunAt) - tomorrow.getTime())).toBeLessThan(60_000);
  await page.goto('/bank/transfers');
  await expect(row(page, once.id)).toContainText('once · active');
  await runDue();
  expect(await executions(who, once.id)).toEqual([]);
  expect(main(await spaces(who)).balance).toBe(main(start).balance);
  // The partner's own book: no instruction for it yet, and its main balance is the one the app shows.
  const sentFor = async (id) => (await partnerMoves(owner)).filter((m) => m.key.startsWith(`bank.transfer.sched:${id}:`));
  expect(await sentFor(once.id)).toEqual([]);
  expect(toUnits(await partnerMain(owner))).toBe(toUnits(main(start).balance));

  // On its date: a second one-off scheduled in the app for tomorrow, then its date comes (the TEST age door moves its
  // start and next run back by the day, as the wait would have). The first stays tomorrow's, for the calendar and the
  // reminder. The partner makes the move and its answer is lost once (the TEST switch), so the runner must send the same
  // key again: the partner answers with the move it made, and the money moves once.
  const second = await scheduleInApp(page, { cadence: 'One-off', amount: '7', startsAt: tomorrow });
  await second.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(second.getByText('Confirmed by the service', { exact: true })).toBeVisible({ timeout: 30_000 });
  const scheduled = (await schedules(who)).find((s) => s.cadence === 'once' && s.amount === '7');
  expect(scheduled).toMatchObject({ status: 'active', endsAt: null, revision: 1 });
  const due = scheduled.id;
  await page.goto('/bank/transfers');
  await expect(row(page, due)).toContainText('once · active');
  expect(await executions(who, due)).toEqual([]);
  expect(await sentFor(due)).toEqual([]);
  const DAY = 86_400_000;
  for (let left = Date.parse(scheduled.nextRunAt) - Date.now() + 1_000; left > 0; left -= DAY)
    await ageRecord('bank', 'scheduled-transfer', due, Math.min(left, DAY));
  expect(Date.parse((await schedules(who)).find((s) => s.id === due).nextRunAt)).toBeLessThanOrEqual(Date.now());
  expect(await api.mutate('testPartner.set', { nextReply: 'lost' })).toMatchObject({ ok: true });
  const passes = await runDue();
  expect(passes.failures.some((f) => f.scheduleId === due && f.code === 'bank.partner_reply_lost')).toBe(true);
  const after = await spaces(who);
  expect(toUnits(main(start).balance) - toUnits(main(after).balance)).toBe(toUnits('7'));
  expect(toUnits(named(after, TRIP).balance) - toUnits(named(start, TRIP).balance)).toBe(toUnits('7'));
  const [instructed] = await executions(who, due);
  expect(instructed).toMatchObject({ occurrence: 0, amount: '7', status: 'settled', rejectionCode: null, ledgerTxId: null });
  expect(instructed.partnerMoveId).toBeTruthy();
  // The partner's own book: one instruction under the occurrence's retry-safe key, although the runner sent it twice,
  // the move the app names, main balance to the trip space, and the partner's main balance the one the app shows.
  const [atPartnerMove, ...extra] = await sentFor(due);
  expect(extra).toEqual([]);
  expect(atPartnerMove).toMatchObject({
    id: instructed.partnerMoveId,
    key: `bank.transfer.sched:${due}:0`,
    from: { owner, assetId: 'USDT', spaceId: null },
    to: { owner, assetId: 'USDT', spaceId: named(start, TRIP).id },
  });
  expect(toUnits(atPartnerMove.amount)).toBe(toUnits('7'));
  expect(toUnits(await partnerMain(owner))).toBe(toUnits(main(after).balance));
  // The schedule ends, and another pass instructs nothing more, at the partner too.
  expect((await schedules(who)).find((s) => s.id === due)).toMatchObject({ status: 'completed' });
  await runDue();
  expect(await executions(who, due)).toHaveLength(1);
  expect(main(await spaces(who)).balance).toBe(main(after).balance);
  expect(await sentFor(due)).toHaveLength(1);
  expect(toUnits(await partnerMain(owner))).toBe(toUnits(main(after).balance));
  // The ledger posted nothing: the money is the partner's.
  expect(await ledgerUsdt(who)).toEqual(run.read().ledger);

  // In the app: the one-off completed, its run sent to the partner bank under the partner's move.
  await page.goto('/bank/transfers');
  await expect(row(page, due)).toContainText('once · completed');
  await row(page, due).getByRole('button', { name: 'Execution history' }).click();
  const history = page.getByTestId('money-selected-instruction').getByTestId('money-execution-history');
  await expect(history).toContainText('settled');
  await expect(history.getByTestId('money-execution-partner')).toContainText(instructed.partnerMoveId);
  run.write({ once: once.id, due });
});

test(`${J} #2 edits a standing order's amount: the revision is shown, a second edit at the same revision is refused, and failed runs list their reason`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = person();
  await signIn(page, who);
  const dialog = await scheduleInApp(page, { cadence: 'Monthly', amount: '10', startsAt: inHours(24), endsAt: inHours(24 * 90) });
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByText('Confirmed by the service')).toBeVisible({ timeout: 30_000 });
  const order = (await schedules(who)).find((s) => s.cadence === 'monthly');
  expect(order).toMatchObject({ amount: '10', revision: 1 });

  await page.goto('/bank/transfers');
  await row(page, order.id).getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog');
  await expect(edit).toContainText('Revision');
  await edit.getByLabel(/Amount/).fill('15');
  await edit.getByLabel('Last run by (optional)').fill('');
  await edit.getByRole('button', { name: 'Review' }).click();
  await edit.getByRole('button', { name: 'Confirm' }).click();
  await expect(edit.getByText('Confirmed by the service')).toBeVisible({ timeout: 30_000 });
  const edited = (await schedules(who)).find((s) => s.id === order.id);
  expect(edited).toMatchObject({ amount: '15', endsAt: null, revision: 2, nextRunAt: order.nextRunAt });

  // The instruction's own view shows the new revision and no end date.
  await page.goto('/bank/transfers');
  await row(page, order.id).getByRole('button', { name: 'Execution history' }).click();
  const facts = page.getByTestId('money-selected-instruction').getByTestId('money-standing-facts');
  await expect(facts).toContainText('15');
  await expect(facts).toContainText('No end date');
  await expect(facts.locator('div').filter({ hasText: 'Revision' }).locator('dd')).toHaveText('2');

  // A second edit sent at the same revision: the review is open on revision 2 when the order changes elsewhere (the
  // person's own API, as another device would). Confirming is refused by name, and the order keeps the other change.
  await page.goto('/bank/transfers');
  await row(page, order.id).getByRole('button', { name: 'Edit' }).click();
  const late = page.getByRole('dialog');
  await late.getByLabel(/Amount/).fill('12');
  await late.getByRole('button', { name: 'Review' }).click();
  const api = await bank(who);
  const elsewhere = await api.mutate('transfers.updateSchedule', { scheduleId: order.id, revision: 2, amount: '14', endsAt: null });
  expect(elsewhere.ok).toBe(true);
  await late.getByRole('button', { name: 'Confirm' }).click();
  await expect(late).toContainText('This standing order changed since you opened it', { timeout: 30_000 });
  expect((await schedules(who)).find((s) => s.id === order.id)).toMatchObject({ amount: '14', revision: 3 });
  // The same stale revision sent straight to the service is refused too, and changes nothing.
  const stale = await api.mutate('transfers.updateSchedule', { scheduleId: order.id, revision: 2, amount: '11', endsAt: null });
  expect(stale.ok).toBe(false);
  expect((await schedules(who)).find((s) => s.id === order.id)).toMatchObject({ amount: '14', revision: 3 });

  // An order whose next run is inside the TEST cutoff of 60 minutes cannot be edited.
  const soon = randomUUID();
  const all = await spaces(who);
  const made = await api.mutate('transfers.schedule', {
    scheduleId: soon,
    fromSpaceId: main(all).id,
    toSpaceId: named(all, TRIP).id,
    amount: '1',
    cadence: 'weekly',
    startsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  expect(made.ok).toBe(true);
  await page.goto('/bank/transfers');
  await row(page, soon).getByRole('button', { name: 'Edit' }).click();
  const close = page.getByRole('dialog');
  await close.getByLabel(/Amount/).fill('2');
  await close.getByRole('button', { name: 'Review' }).click();
  await close.getByRole('button', { name: 'Confirm' }).click();
  await expect(close).toContainText('The next run is too close to change this order now. Nothing was changed.', { timeout: 30_000 });
  expect((await api.mutate('transfers.cancel', { scheduleId: soon })).ok).toBe(true);

  // A failed run lists its reason: a daily order out of the empty space, due a minute ago, refused at the partner.
  const short = randomUUID();
  const empty = await api.mutate('transfers.schedule', {
    scheduleId: short,
    fromSpaceId: named(all, EMPTY).id,
    toSpaceId: main(all).id,
    amount: '3',
    cadence: 'daily',
    startsAt: new Date(Date.now() - 60_000).toISOString(),
  });
  expect(empty.ok).toBe(true);
  await runDue();
  const [failed] = await executions(who, short);
  expect(failed).toMatchObject({ occurrence: 0, status: 'rejected', rejectionCode: 'bank.partner_insufficient_funds', ledgerTxId: null });
  await page.goto('/bank/transfers');
  await row(page, short).getByRole('button', { name: 'Execution history' }).click();
  const history = page.getByTestId('money-selected-instruction').getByTestId('money-execution-history');
  await expect(history).toContainText('rejected');
  await expect(history).toContainText('bank.partner_insufficient_funds');
  expect((await api.mutate('transfers.cancel', { scheduleId: short })).ok).toBe(true);
  run.write({ monthly: order.id, short });
});

test(`${J} #3 a run with too little money: the partner's refusal is recorded as a failed run for insufficient funds, and nothing is sent`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = person();
  const { owner } = run.read();
  const api = await bank(who);
  const before = await spaces(who);
  const partnerBefore = await partnerMoves(owner);
  expect(toUnits(await partnerMain(owner))).toBe(toUnits(main(before).balance));
  // A weekly order for more than the main balance holds, due a minute ago, so the next runner pass finds it due.
  const big = randomUUID();
  const more = fromUnits(toUnits(main(before).balance) + toUnits('1000'));
  const made = await api.mutate('transfers.schedule', {
    scheduleId: big,
    fromSpaceId: main(before).id,
    toSpaceId: named(before, TRIP).id,
    amount: more,
    cadence: 'weekly',
    startsAt: new Date(Date.now() - 60_000).toISOString(),
  });
  expect(made, JSON.stringify(made.body ?? {}).slice(0, 300)).toMatchObject({ ok: true });
  await runDue();

  const [failed] = await executions(who, big);
  expect(failed).toMatchObject({
    occurrence: 0,
    amount: more,
    status: 'rejected',
    rejectionCode: 'bank.partner_insufficient_funds',
    ledgerTxId: null,
    partnerMoveId: null,
  });
  // Nothing sent: every space as it was, and the ledger posted nothing.
  const after = await spaces(who);
  for (const space of before) expect(after.find((s) => s.id === space.id)?.balance).toBe(space.balance);
  expect(await ledgerUsdt(who)).toEqual(run.read().ledger);
  // Nothing sent, in the partner's own book: no move under the order's key, its moves as they were, its main balance
  // unchanged and still the one the app shows.
  const unsent = async () => {
    const moves = await partnerMoves(owner);
    expect(moves.filter((m) => m.key.startsWith(`bank.transfer.sched:${big}:`))).toEqual([]);
    expect(moves).toEqual(partnerBefore);
    expect(toUnits(await partnerMain(owner))).toBe(toUnits(main(before).balance));
  };
  await unsent();
  // A second pass sends nothing for the same occurrence: the failed run is recorded once.
  await runDue();
  expect(await executions(who, big)).toHaveLength(1);
  expect(main(await spaces(who)).balance).toBe(main(before).balance);
  await unsent();

  await signIn(page, who);
  await page.goto('/bank/transfers');
  await row(page, big).getByRole('button', { name: 'Execution history' }).click();
  const history = page.getByTestId('money-selected-instruction').getByTestId('money-execution-history');
  await expect(history).toContainText('rejected');
  await expect(history).toContainText('bank.partner_insufficient_funds');
  await expect(history).toContainText('No ledger reference recorded');
  await expect(history.getByTestId('money-execution-partner')).toHaveCount(0);
  expect((await api.mutate('transfers.cancel', { scheduleId: big })).ok).toBe(true);
  run.write({ big });
});

test(`${J} #4 blocks a direct debit mandate: the block is sent to the partner, new collections are refused with the partner's reason, and 10 against a balance of 4 fails with its reason and a refund path`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = person();
  const api = await bank(who);
  const owner = await userIdOf(who);
  const tag = randomUUID().slice(0, 8);
  const gym = `TEST-GYM-${tag}`,
    power = `TEST-POWER-${tag}`;
  const at = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

  // Two companies set up a mandate through the scheme (as the scheme would: by its signed door), and present collections.
  await scheme('dd-sim/mandate', { mandateId: gym, userId: owner, creditorId: 'TEST-GYM', reference: `GYM ${tag}`, assetId: 'USDT' });
  await scheme('dd-sim/mandate', { mandateId: power, userId: owner, creditorId: 'TEST-POWER', reference: `PWR ${tag}`, assetId: 'USDT' });
  const again = await job('dd-sim/mandate', { mandateId: gym, userId: owner, creditorId: 'TEST-GYM', reference: 'OTHER', assetId: 'USDT' });
  expect(again.body?.code).toBe('bank.dd_mandate_conflict');
  await scheme('dd-sim/collection', { mandateId: gym, collectionId: `${tag}-due`, amount: '5', dueAt: at(-0.01) });
  await scheme('dd-sim/collection', { mandateId: gym, collectionId: `${tag}-next`, amount: '5', dueAt: at(10) });
  await scheme('dd-sim/collection', { mandateId: power, collectionId: `${tag}-bill`, amount: '12.5', dueAt: at(5) });

  // The room: each mandate with what it collects in the next month, and the TEST stand-in named.
  await signIn(page, who);
  await page.goto('/bank/transfers');
  await page
    .getByRole('link', { name: /Direct debits/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/bank\/direct-debits$/);
  await expect(page.getByTestId('dd-scheme')).toContainText('test stand-in');
  const gymRow = page.getByTestId(`dd-mandate-${gym}`);
  const powerRow = page.getByTestId(`dd-mandate-${power}`);
  await expect(gymRow).toContainText('TEST Gym membership');
  await expect(gymRow).toContainText('Active');
  await expect(gymRow).toContainText('5 USDT');
  await expect(powerRow).toContainText('12.5 USDT');

  // Block the power company: the block is sent to the partner bank, its upcoming bill is refused with the partner's
  // reason, and the list shows it blocked.
  await powerRow.getByRole('button', { name: 'Block' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`PWR ${tag}`);
  await dialog.getByRole('button', { name: 'Block mandate' }).click();
  await expect(
    page.getByText('Block sent to TEST partner bank. Blocked TEST Power company. Upcoming collections refused: 1.'),
  ).toBeVisible();
  await expect(powerRow).toContainText('Blocked since');
  await expect(powerRow).toContainText('Nothing due in the next month');
  // A new collection it presents while blocked is rejected with the reason the partner reports.
  const late = await scheme('dd-sim/collection', { mandateId: power, collectionId: `${tag}-late`, amount: '3', dueAt: at(2) });
  expect(late).toMatchObject({ status: 'rejected', failureCode: PARTNER_DD_BLOCKED, ledgerTxId: null, partnerMoveId: null });
  // The partner's own direct debit book: the block is its own, with its time, the gym's mandate untouched, and the late
  // collection is one it refused with the reason the app shows.
  const ddBook = await partnerDirectDebits(owner);
  expect(ddBook.mandates.find((m) => m.mandateId === power)).toMatchObject({ state: 'blocked', blockedAt: expect.any(String) });
  expect(ddBook.mandates.find((m) => m.mandateId === gym)).toMatchObject({ state: 'active', blockedAt: null });
  expect(ddBook.failures.filter((f) => f.mandateId === power)).toEqual([
    { owner, mandateId: power, collectionId: `${tag}-late`, code: PARTNER_DD_BLOCKED },
  ]);

  // The collection run: the gym's due 5 is taken once by the partner, and nothing is posted on the ledger.
  // Other journeys' collections share this stack, so the run is passed until this person's due one is decided.
  const decided = async (...ids) => {
    const { collections } = (await api.query('directDebits.list', {})).data;
    const done = (id) => collections.some((c) => c.collectionId === id && (c.status === 'collected' || c.status === 'failed'));
    return ids.every((id) => done(`${tag}-${id}`));
  };
  const before = main(await spaces(who));
  for (let pass = 0; pass < 20 && !(await decided('due')); pass += 1) await scheme('run-due-direct-debits', { limit: 50 });
  expect(await decided('due')).toBe(true);
  const taken = main(await spaces(who));
  expect(toUnits(before.balance) - toUnits(taken.balance)).toBe(toUnits('5'));
  await scheme('run-due-direct-debits', { limit: 50 });
  expect(main(await spaces(who)).balance).toBe(taken.balance);

  // A collection of 10 against a main balance of 4: the rest moves to the trip space first, then the gym presents 10.
  const rest = toUnits(taken.balance) - toUnits('4');
  const trip = named(await spaces(who), TRIP);
  const moved = await api.mutate('transfers.create', {
    transferId: randomUUID(),
    fromSpaceId: taken.id,
    toSpaceId: trip.id,
    amount: fromUnits(rest),
  });
  expect(moved, JSON.stringify(moved.body ?? {}).slice(0, 300)).toMatchObject({ ok: true, data: { ledgerTxId: null } });
  expect(main(await spaces(who)).balance).toBe('4');
  await scheme('dd-sim/collection', { mandateId: gym, collectionId: `${tag}-ten`, amount: '10', dueAt: at(-0.001) });
  for (let pass = 0; pass < 20 && !(await decided('ten')); pass += 1) await scheme('run-due-direct-debits', { limit: 50 });
  expect(await decided('ten')).toBe(true);
  expect(main(await spaces(who)).balance).toBe('4');
  const listed = (await api.query('directDebits.list', {})).data;
  const byId = (id) => listed.collections.find((c) => c.collectionId === `${tag}-${id}`);
  expect(byId('due')).toMatchObject({ status: 'collected', ledgerTxId: null });
  expect(byId('due').partnerMoveId).toBeTruthy();
  expect(byId('ten')).toMatchObject({
    status: 'failed',
    failureCode: 'bank.partner_insufficient_funds',
    ledgerTxId: null,
    partnerMoveId: null,
    refund: { state: 'none' },
  });
  expect(await ledgerUsdt(who)).toEqual(run.read().ledger);
  // The partner's own book: the collected 5 is its one move under the collection's key, the move the app names, out of
  // the main balance; the refused and failed collections moved nothing there; its main balance is the app's 4.
  const ddMoves = (await partnerMoves(owner)).filter((m) => m.key.startsWith('bank.dd.collection:') && m.key.includes(tag));
  expect(ddMoves.map((m) => m.key)).toEqual([`bank.dd.collection:${gym}:${tag}-due`]);
  expect(ddMoves[0]).toMatchObject({ id: byId('due').partnerMoveId, from: { owner, assetId: 'USDT', spaceId: null } });
  expect(toUnits(ddMoves[0].amount)).toBe(toUnits('5'));
  expect(toUnits(await partnerMain(owner))).toBe(toUnits('4'));

  await page.reload();
  const collected = page.getByTestId(`dd-collection-${tag}-due`);
  await expect(collected).toContainText('Collected');
  await expect(collected).toContainText('5 USDT');
  await expect(collected.getByTestId('dd-partner-move')).toContainText(byId('due').partnerMoveId);
  const failed = page.getByTestId(`dd-collection-${tag}-ten`);
  await expect(failed).toContainText('Failed');
  await expect(failed).toContainText('The partner bank reported too little money in your main balance. Nothing was taken.');
  // A Bank refusal no step names ends in plain words; its code stays on data-code.
  await expect(failed.locator('[data-code="bank.partner_insufficient_funds"]')).toBeAttached();
  await expect(failed).not.toContainText('bank.partner_insufficient_funds');
  await expect(failed).toContainText('Not set. No fee was charged.');
  // Its refund path: nothing was taken, and a debit that was taken is asked back from this list.
  await expect(failed).toContainText('Nothing was taken, so nothing needs refunding.');
  await expect(failed.getByRole('button', { name: 'Request a refund' })).toHaveCount(0);
  const refused = page.getByTestId(`dd-collection-${tag}-bill`);
  await expect(refused).toContainText('The partner bank refused it because you blocked this mandate. Nothing was taken.');
  await expect(refused).toContainText(PARTNER_DD_BLOCKED);
  await expect(page.getByTestId(`dd-collection-${tag}-late`)).toContainText(PARTNER_DD_BLOCKED);

  // Inside the 30-day TEST guarantee period, the collected 5 can be asked back, once.
  await collected.getByRole('button', { name: 'Request a refund' }).click();
  const ask = page.getByRole('dialog');
  await ask.getByLabel('Why should it be refunded?').fill('TEST: I cancelled this membership.');
  await ask.getByRole('button', { name: 'Send refund request' }).click();
  await expect(page.getByText('Refund request sent for 5 USDT. Support will look at it.')).toBeVisible();
  await expect(collected).toContainText('Requested on');
  const refundRow = (await api.query('directDebits.list', {})).data.collections.find((c) => c.collectionId === `${tag}-due`);
  expect(refundRow.refund.state).toBe('requested');
  const twice = await api.mutate('directDebits.requestRefund', { collectionId: refundRow.id, reason: 'TEST again' });
  expect(twice.ok).toBe(true);
  expect(twice.data.created).toBe(false);

  run.write({ dd: { gym, power, tag } });

  // Unblock: the power company may collect again; what was refused while blocked stays refused.
  await powerRow.getByRole('button', { name: 'Unblock' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Unblock mandate' }).click();
  await expect(powerRow).toContainText('Active');
  await expect(refused).toContainText('Refused');
  expect((await partnerDirectDebits(owner)).mandates.find((m) => m.mandateId === power)).toMatchObject({
    state: 'active',
    blockedAt: null,
  });
});

/** The calendar's month, moved with its own buttons until it shows `month` (`YYYY-MM`). */
async function calendarMonth(page, month) {
  const shown = page.getByTestId('cal-month-name');
  for (let i = 0; i < 3; i += 1) {
    const now = await shown.getAttribute('data-month');
    if (now === month) return;
    await page.getByRole('button', { name: now < month ? 'Next month' : 'Previous month' }).click();
    await expect(shown).not.toHaveAttribute('data-month', now);
  }
  await expect(shown).toHaveAttribute('data-month', month);
}

test(`${J} #5 opens the calendar: standing orders, direct debits and a monthly bill on their dates, each opening its room; loans say why they show none, and bills until the partner pays them`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const who = person();
  const { once, monthly, due, short, dd } = run.read();
  if (!due || !short) throw new Error(`${J}: #1 or #2 left no standing orders, so the calendar has nothing of its own to show`);
  if (!dd) throw new Error(`${J}: #4 left no direct debits, so the calendar has nothing of its own to show`);
  const api = await bank(who);
  const before = main(await spaces(who)).balance;
  // The list holds past collections apart from each mandate's upcoming ones.
  const listed = (await api.query('directDebits.list', {})).data;
  const collections = [...listed.collections, ...listed.mandates.flatMap((m) => m.upcoming)];
  const collection = (suffix) => {
    const found = collections.find((c) => c.collectionId === `${dd.tag}-${suffix}`);
    if (!found) throw new Error(`${J}: collection ${suffix} from #4 is missing`);
    return found;
  };
  const collected = collection('due'),
    huge = collection('ten'),
    blocked = collection('bill'),
    next = collection('next');
  const monthOf = (iso) => iso.slice(0, 7);
  const days = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const read = async (month) => {
    const res = await api.query('calendar.window', { from: `${month}-01`, days: days(month), limit: 50 });
    expect(res.ok).toBe(true);
    return res.data;
  };

  // The service's own answer for the month the one-off ran in: the one-off done, the empty order's first day failed by
  // name, and its later days still due; this person's collections by their due dates.
  const ranMonth = (await schedules(who)).find((s) => s.id === due).startsAt.slice(0, 7);
  const ran = await read(ranMonth);
  const byKey = (view, key) => view.items.find((i) => i.key === key);
  expect(byKey(ran, `${due}:0`)).toMatchObject({ source: 'standing_orders', status: 'done', amount: '7' });
  expect(byKey(ran, `${short}:0`)).toMatchObject({ status: 'failed', reasonCode: 'bank.partner_insufficient_funds' });
  // #2 cancelled the empty order after its failed day, so none of its later days are on the calendar.
  expect(ran.items.filter((i) => i.refId === short).map((i) => i.status)).toEqual(['failed']);
  expect(ran.sources.find((s) => s.source === 'loans')).toMatchObject({ state: 'not_set', code: 'bank.loan_schedule_unset' });
  expect(ran.sources.find((s) => s.source === 'bills')).toMatchObject({ state: 'ok', code: 'bank.bills_psp_unset' });
  for (const [row, status, reason] of [
    [collected, 'done', null],
    [huge, 'failed', 'bank.partner_insufficient_funds'],
    [blocked, 'refused', PARTNER_DD_BLOCKED],
    [next, 'upcoming', null],
  ]) {
    const view = monthOf(row.dueAt) === ranMonth ? ran : await read(monthOf(row.dueAt));
    expect(byKey(view, row.id)).toMatchObject({
      source: 'direct_debits',
      refId: dd.gym === row.mandateId ? dd.gym : dd.power,
      status,
      reasonCode: reason,
    });
  }

  // The one-off dated tomorrow (#1) and the edited monthly order (#2) are due on their next run dates.
  for (const schedule of (await schedules(who)).filter((x) => x.id === once || x.id === monthly)) {
    const view = monthOf(schedule.nextRunAt) === ranMonth ? ran : await read(monthOf(schedule.nextRunAt));
    expect(view.items.find((i) => i.refId === schedule.id && i.date === schedule.nextRunAt)).toMatchObject({ status: 'upcoming' });
  }

  // In the app: from Transfers to the calendar, the month the one-off ran in, each kind on its day.
  await signIn(page, who);
  await page.goto('/bank/transfers');
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  await expect(page).toHaveURL(/\/bank\/calendar$/);
  await expect(page.getByRole('note').first()).toContainText('The calendar only reads');
  await calendarMonth(page, ranMonth);
  const day = (iso) => page.getByTestId('cal-month').getByTestId(`cal-day-${Number(iso.slice(8, 10))}`);
  const ranAt = byKey(ran, `${due}:0`).date;
  await expect(day(ranAt).getByTestId(`cal-open-${due}:0`)).toHaveText('Standing order');
  await expect(
    day(byKey(ran, `${short}:0`).date)
      .locator(`[data-status="failed"]`)
      .first(),
  ).toContainText('Failed');
  if (monthOf(huge.dueAt) === ranMonth)
    await expect(day(huge.dueAt).getByTestId(`cal-open-${huge.id}`)).toHaveText('Direct debit: TEST Gym membership');

  // Where the dates come from: loans publish none and bills have no partner, each named; the rest are counted.
  const sources = page.getByTestId('cal-sources');
  await expect(sources.getByTestId('cal-source-loans')).toContainText('repayment dates are not published');
  await expect(sources.getByTestId('cal-source-loans')).toHaveAttribute('data-code', 'bank.loan_schedule_unset');
  // A code is the row's attribute, never words a customer reads.
  await expect(sources).not.toContainText('bank.');
  await expect(sources.getByTestId('cal-source-bills')).toContainText('no bill payment partner is connected');
  await expect(sources.getByTestId('cal-source-standing_orders')).toHaveAttribute('data-state', 'ok');
  await expect(sources.getByTestId('cal-source-direct_debits')).toHaveAttribute('data-state', 'ok');

  // The list: each run with its status, and a failed one with its reason in words, its code on the row.
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const failedRow = page.getByTestId(`cal-row-${short}:0`);
  await expect(failedRow).toContainText('Failed');
  await expect(failedRow).toContainText('There was not enough money. Nothing was taken.');
  await expect(failedRow.locator('[data-status="failed"]')).toHaveAttribute('data-code', 'bank.partner_insufficient_funds');
  await expect(failedRow).not.toContainText('bank.partner_insufficient_funds');
  await expect(page.getByTestId(`cal-row-${due}:0`)).toContainText('Done');

  // Filter by kind: direct debits off leaves the standing orders showing.
  await page.getByRole('button', { name: 'Direct debits', exact: true }).click();
  await expect(page.getByTestId('cal-list').locator('tr[data-source="direct_debits"]')).toHaveCount(0);
  await expect(page.getByTestId(`cal-row-${due}:0`)).toBeVisible();
  await page.getByRole('button', { name: 'Direct debits', exact: true }).click();

  // The blocked company's refused collection and the gym's next one, in their own month.
  await calendarMonth(page, monthOf(blocked.dueAt));
  const refusedRow = page.getByTestId(`cal-row-${blocked.id}`);
  await expect(refusedRow).toContainText('Refused');
  await expect(refusedRow).toContainText('You blocked this direct debit.');
  await calendarMonth(page, monthOf(next.dueAt));
  await expect(page.getByTestId(`cal-row-${next.id}`)).toContainText('Due');

  // Each item opens its own room.
  await page.getByTestId(`cal-row-${next.id}`).getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/bank\/direct-debits$/);
  await page.goto('/bank/calendar');
  await calendarMonth(page, ranMonth);
  await page.getByTestId(`cal-open-${due}:0`).click();
  await expect(page).toHaveURL(/\/bank\/transfers$/);

  // Bills: with the person's bank rail at the TEST partner off, Bills says no biller directory is connected.
  const owner = await userIdOf(who);
  const movesBefore = await partnerMoves(owner);
  const heldBefore = await partnerMain(owner);
  await page.goto('/pay/bills');
  const bills = page.getByTestId('bills-card');
  await bills.getByLabel('Biller', { exact: true }).fill('Water');
  await bills.getByTestId('bills-search').click();
  await expect(bills.getByTestId('pay-reason')).toContainText('Bill pay isn’t connected');
  await expect(bills.getByTestId('bills-review')).toBeDisabled();

  // The TEST partner pays billers once the person's bank rail is on there: its own TEST billers answer the search, and
  // the person sets up a monthly bill from their main balance, first paid on the 1st of next month.
  const railOn = await api.mutate('testPartner.set', { bankRail: 'test' });
  expect(railOn.ok, JSON.stringify(railOn.body ?? '')).toBe(true);
  await page.reload();
  await bills.getByLabel('Biller', { exact: true }).fill('Water');
  await bills.getByTestId('bills-search').click();
  await bills.getByLabel('Choose a biller', { exact: true }).selectOption({ label: 'TEST Water' });
  await expect(bills.getByTestId('pay-reason')).toHaveCount(0);
  const reference = `ACC-${randomUUID().slice(0, 8)}`;
  await bills.getByLabel('Bill reference or account number', { exact: true }).fill(reference);
  await bills.getByLabel('Amount', { exact: true }).fill('3');
  const mainSpace = main(await spaces(who));
  await bills.getByLabel('Pay from', { exact: true }).selectOption(mainSpace.id);
  // The 1st of next month: the last day of this month, then the day after it.
  const thisMonthEnd = new Date(`${utcDay(Date.now()).slice(0, 7)}-28T00:00:00.000Z`);
  const firstOfNext = `${utcDay(thisMonthEnd.getTime() + 4 * DAY).slice(0, 7)}-01`;
  await bills.getByLabel('First payment on', { exact: true }).fill(firstOfNext);
  await bills.getByTestId('bills-review').click();
  await expect(bills.getByTestId('bills-outcome')).toHaveAttribute('data-state', 'ok');
  const recurring = (await api.query('bills.recurring.list', { limit: 20 })).data.filter((b) => b.reference === reference);
  expect(recurring).toHaveLength(1);
  const bill = recurring[0];
  expect(bill).toMatchObject({
    billerId: 'test-biller-water',
    amount: '3',
    assetId: 'USDT',
    fromSpaceId: mainSpace.id,
    cadence: 'monthly',
    status: 'active',
    nextRunAt: `${firstOfNext}T00:00:00.000Z`,
  });
  await expect(bills.getByTestId(`bill-recurring-${bill.id}`)).toContainText(`TEST Water · ${reference}`);
  // Setting a bill up sends nothing: the partner's book and the person's balance there are as they were.
  expect(await partnerMoves(owner)).toEqual(movesBefore);
  expect(await partnerMain(owner)).toBe(heldBefore);

  // The bank's calendar for that month: the bill on its date, its source with no reason against it.
  const billMonth = monthOf(firstOfNext);
  const billView = await read(billMonth);
  expect(byKey(billView, `${bill.id}:0`)).toMatchObject({
    source: 'bills',
    refId: bill.id,
    date: bill.nextRunAt,
    label: reference,
    amount: '3',
    status: 'upcoming',
  });
  expect(billView.sources.find((s) => s.source === 'bills')?.code ?? null).toBeNull();

  // In the app: the bill on its day in that month, and it opens Bills.
  await page.goto('/bank/calendar');
  await calendarMonth(page, billMonth);
  const billItem = day(firstOfNext).getByTestId(`cal-open-${bill.id}:0`);
  await expect(billItem).toHaveText(`Bill: ${reference}`);
  await expect(page.getByTestId('cal-sources').getByTestId('cal-source-bills')).not.toContainText('no bill payment partner');
  await stepPicture();
  await billItem.click();
  await expect(page).toHaveURL(/\/pay\/bills$/);
  await expect(page.getByTestId(`bill-recurring-${bill.id}`)).toContainText(reference);

  // Reading the calendar moved nothing.
  expect(main(await spaces(who)).balance).toBe(before);
});

test(`${J} #6 saves a payment reminder rule under its business key: a replay is the same rule, a stale save is refused, and a rule that moves money is refused with its reason`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = person();
  const api = await bank(who);
  const before = main(await spaces(who)).balance;
  const first = await api.query('rules.get', undefined);
  expect(first.ok).toBe(true);
  expect(first.data).toMatchObject({
    reminder: null,
    leadChoices: [24, 48, 72, 168],
    moneyRules: { state: 'not_set', code: 'bank.rule_terms_unset' },
  });

  // In the app: from Transfers to the rules, two days before each run.
  await signIn(page, who);
  await page.goto('/bank/transfers');
  await page.getByRole('link', { name: 'Rules and notifications', exact: true }).click();
  await expect(page).toHaveURL(/\/bank\/rules$/);
  const reminder = page.getByTestId('rules-reminder');
  await expect(reminder).toContainText('You have no reminder rule. Reminders are off.');
  await reminder.getByLabel('Remind me').selectOption({ label: '2 days before' });
  await reminder.getByRole('button', { name: 'Save' }).click();
  await expect(reminder.getByRole('status')).toContainText(/Saved as rule reminder:[0-9a-f-]{36}, revision 1\./);
  const saved = (await api.query('rules.get', undefined)).data.reminder;
  expect(saved).toMatchObject({ leadHours: 48, revision: 1 });
  expect(saved.ruleKey).toMatch(/^reminder:[0-9a-f-]{36}$/);
  await expect(page.getByTestId('rules-reminder-current')).toHaveAttribute('data-rule-key', saved.ruleKey);
  await expect(page.getByTestId('rules-reminder-current')).toContainText('2 days before');

  // The same request twice is one rule at one revision; a save that read an older revision is refused.
  const write = { leadHours: 48, expectedRevision: 1, clientRequestId: `${J}-replay-${randomUUID()}` };
  const once = await api.mutate('rules.setReminder', write);
  const again = await api.mutate('rules.setReminder', write);
  expect(once.data).toMatchObject({ ruleKey: saved.ruleKey, revision: 2 });
  expect(again.data).toEqual(once.data);
  const stale = await api.mutate('rules.setReminder', {
    leadHours: 24,
    expectedRevision: 1,
    clientRequestId: `${J}-stale-${randomUUID()}`,
  });
  expect(stale).toMatchObject({ ok: false, status: 409 });
  expect(JSON.stringify(stale.body)).toContain('bank.reminder_revision_conflict');
  expect((await api.query('rules.get', undefined)).data.reminder).toMatchObject({ ruleKey: saved.ruleKey, leadHours: 48, revision: 2 });

  // A rule that moves money: every field there, and saving it is refused with the missing terms. Nothing is stored.
  await page.reload();
  const money = page.getByTestId('rules-money');
  await expect(page.getByTestId('rules-money-not-set').locator('[data-code="bank.rule_terms_unset"]')).toBeAttached();
  const rows = await spaces(who);
  await money.getByLabel('Rule name').fill('Sweep TEST');
  await money.getByRole('combobox', { name: /^From/ }).selectOption(main(rows).id);
  await money.getByRole('combobox', { name: /^To\b/ }).selectOption(named(rows, TRIP).id);
  await money.getByRole('combobox', { name: /^When/ }).selectOption({ label: 'When the balance goes over' });
  await money.getByLabel('Balance over').fill('50');
  await money.getByLabel('Amount to move').fill('10');
  await money.getByRole('button', { name: 'Save rule' }).click();
  await expect(money.getByRole('alert')).toContainText('Not saved: rules that move money by themselves are not open');
  await expect(money.getByRole('alert')).not.toContainText('bank.rule_terms_unset');
  const refused = await api.mutate('rules.createMoneyRule', {
    name: 'Sweep TEST',
    fromSpaceId: main(rows).id,
    toSpaceId: named(rows, TRIP).id,
    trigger: { kind: 'date', cadence: 'monthly' },
    amount: '10',
    clientRequestId: `${J}-money-${randomUUID()}`,
  });
  expect(refused).toMatchObject({ ok: false, status: 412 });
  expect(JSON.stringify(refused.body)).toContain('bank.rule_terms_unset');

  // Saving rules moved nothing.
  expect(main(await spaces(who)).balance).toBe(before);
  run.write({ rule: saved.ruleKey });
});

test(`${J} #6 the notification choices on the rules page are the account's own, and follow a change made in notification settings`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = person();
  const notify = await bank(who, 'notify');
  const prefs = async () => {
    const res = await notify.query('notify.categoryPrefs', undefined);
    if (!res.ok) throw new Error(`notify.categoryPrefs refused: ${res.status}`);
    return res.data.filter((row) => row.category === 'orders');
  };
  const sends = (row) => row.enabled && row.configured && !row.notConnected;
  const shown = async (rows) => {
    for (const row of rows) {
      const cell = page.getByTestId(`rules-choice-${row.channel}`);
      await expect(cell).toHaveAttribute('data-enabled', String(sends(row)));
      if (row.notConnected) await expect(cell).toContainText(row.notConnected);
      if (row.locked) await expect(cell).toContainText('Always on');
    }
  };
  const orders = await prefs();
  expect(orders.map((row) => row.channel).sort()).toEqual(['email', 'in_app', 'push', 'sms']);
  expect(orders.find((row) => row.channel === 'in_app')).toMatchObject({ enabled: true, locked: true });

  await signIn(page, who);
  await page.goto('/bank/rules');
  await shown(orders);
  await expect(page.getByRole('link', { name: 'Change them in notification settings' })).toHaveAttribute(
    'href',
    '/notifications?view=settings',
  );

  // A channel switched in the account's settings reads back here as switched. On a stack with no delivery vendor every
  // channel but the inbox is not connected: the switch is still stored, and the page says nothing is sent there.
  const free = orders.find((row) => !row.locked) ?? orders[0];
  const flipped = await notify.mutate('notify.setCategoryPref', {
    category: 'orders',
    channel: free.channel,
    enabled: !free.enabled,
    clientRequestId: `${J}-pref-${randomUUID()}`,
  });
  expect(flipped.ok).toBe(true);
  const after = await prefs();
  expect(after.find((row) => row.channel === free.channel).enabled).toBe(!free.enabled);
  await page.reload();
  await shown(after);
  await notify.mutate('notify.setCategoryPref', {
    category: 'orders',
    channel: free.channel,
    enabled: free.enabled,
    clientRequestId: `${J}-pref-back-${randomUUID()}`,
  });
});

test(`${J} #6 the notice job tells the person once: a reminder before the one-off runs and a notice for the run that failed`, async () => {
  test.setTimeout(120_000);
  const who = person();
  const { once, short } = run.read();
  if (!once || !short) throw new Error(`${J}: #1 or #2 left no order to tell the person about`);
  const notify = await bank(who, 'notify');
  // Two passes, as a scheduler that retried would make them: the outbox owes each notice once.
  for (let pass = 0; pass < 2; pass += 1) await scheme('run-scheduled-notices', { limit: 100 });
  const notices = async () => {
    const res = await notify.query('notify.list', { limit: 100 });
    if (!res.ok) throw new Error(`notify.list refused: ${res.status}`);
    return res.data.items;
  };
  const of = (items, kind, scheduleId) => items.filter((n) => n.kind === kind && n.params?.scheduleId === scheduleId);
  // The inbox notice is svc-notify's half of the step; on a stack without it this fails here, and quickly.
  await expect.poll(async () => of(await notices(), 'bank.scheduled_failed', short).length, { timeout: 20_000 }).toBe(1);
  await expect.poll(async () => of(await notices(), 'bank.scheduled_reminder', once).length, { timeout: 20_000 }).toBe(1);
  await scheme('run-scheduled-notices', { limit: 100 });
  const items = await notices();
  expect(of(items, 'bank.scheduled_failed', short)).toHaveLength(1);
  expect(of(items, 'bank.scheduled_reminder', once)).toHaveLength(1);
});

test(`${J} #8 with one source failing (TEST switch), opens the calendar: the failing source is named, and the other kinds still show`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = person();
  const { due, short, dd } = run.read();
  if (!due || !short || !dd) throw new Error(`${J}: #1, #2 or #4 left nothing on the calendar to show beside the failing source`);
  const api = await bank(who);
  const before = main(await spaces(who)).balance;
  const ranMonth = (await schedules(who)).find((s) => s.id === due).startsAt.slice(0, 7);
  const days = new Date(Date.UTC(Number(ranMonth.slice(0, 4)), Number(ranMonth.slice(5, 7)), 0)).getUTCDate();
  const read = async () => {
    const res = await api.query('calendar.window', { from: `${ranMonth}-01`, days, limit: 50 });
    expect(res.ok).toBe(true);
    return res.data;
  };
  // The direct debits source answers before the switch, so what the switch takes away is known to be there.
  const whole = await read();
  expect(whole.sources.find((s) => s.source === 'direct_debits')).toMatchObject({ state: 'ok' });
  const set = await api.mutate('testPartner.set', { calendarSource: 'direct_debits' });
  expect(set, JSON.stringify(set.body ?? {}).slice(0, 300)).toMatchObject({ ok: true, data: { calendarSource: 'direct_debits' } });
  try {
    // The service's answer: direct debits unavailable, by its code, with none of its items; every other kind as before.
    const broken = await read();
    expect(broken.sources.find((s) => s.source === 'direct_debits')).toEqual({
      source: 'direct_debits',
      state: 'unavailable',
      count: 0,
      code: 'bank.calendar_source_unavailable',
      complete: false,
    });
    expect(broken.items.filter((i) => i.source === 'direct_debits')).toHaveLength(0);
    expect(broken.items).toEqual(whole.items.filter((i) => i.source !== 'direct_debits'));
    for (const source of ['standing_orders', 'bills', 'loans', 'earn'])
      expect(broken.sources.find((s) => s.source === source)).toEqual(whole.sources.find((s) => s.source === source));
    expect(broken.items.find((i) => i.key === `${due}:0`)).toMatchObject({ source: 'standing_orders', status: 'done' });

    // In the app: the failing kind is named in words, its code on the row, and the standing orders still show on their days.
    await signIn(page, who);
    await page.goto('/bank/calendar');
    await calendarMonth(page, ranMonth);
    const sources = page.getByTestId('cal-sources');
    const failing = sources.getByTestId('cal-source-direct_debits');
    await expect(failing).toHaveAttribute('data-state', 'unavailable');
    await expect(failing).toContainText('Direct debits could not be read just now. Everything else is shown.');
    await expect(failing).toHaveAttribute('data-code', 'bank.calendar_source_unavailable');
    await expect(sources).not.toContainText('bank.');
    await expect(sources.getByTestId('cal-source-standing_orders')).toHaveAttribute('data-state', 'ok');
    await expect(sources.getByTestId('cal-source-loans')).toContainText('repayment dates are not published');
    await expect(sources.getByTestId('cal-source-bills')).toContainText('no bill payment partner is connected');
    await expect(page.getByTestId(`cal-open-${due}:0`)).toHaveText('Standing order');
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await expect(page.getByTestId(`cal-row-${due}:0`)).toContainText('Done');
    await expect(page.getByTestId(`cal-row-${short}:0`)).toContainText('Failed');
    await expect(page.getByTestId('cal-list').locator('tr[data-source="direct_debits"]')).toHaveCount(0);
  } finally {
    const off = await api.mutate('testPartner.set', { calendarSource: null });
    expect(off, JSON.stringify(off.body ?? {}).slice(0, 300)).toMatchObject({ ok: true, data: { calendarSource: null } });
  }
  // With the switch off the source answers again with what it held.
  const back = await read();
  expect(back.sources.find((s) => s.source === 'direct_debits')).toEqual(whole.sources.find((s) => s.source === 'direct_debits'));
  expect(back.items.filter((i) => i.source === 'direct_debits')).toEqual(whole.items.filter((i) => i.source === 'direct_debits'));
  // Reading the calendar moved nothing.
  expect(main(await spaces(who)).balance).toBe(before);
});
