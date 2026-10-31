import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, fund, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-06, in the running app (docs/roadmap/journeys.json): I schedule payments and standing orders. Steps 1 to 3
// (BK-xfer-10): a one-off on a date, a standing order edited with a revision, and what a run does. One TEST account
// funded with TEST 100 USDT moves money between its own spaces. The stack has no timer for the standing-order runner:
// this file runs it with the job door's own signed call, as a scheduler would. The edit cutoff is the bank profile's
// TEST value of 60 minutes. Step 4 (BK-xfer-11): direct debits through the stack's TEST scheme stand-in (`dd-sim`),
// whose creditors set up mandates and present collections only by its signed job doors, which this file calls as the
// scheme would; the collection run is its job door too. Step 5 (BK-acct-10): the money calendar over what steps 3 and 4
// left, read only. Step 6 (BK-acct-10): the payment reminder rule saved under its business key, money-moving rules
// refused while their terms are unpublished, the notification choices read from the account's own settings, and the
// notices the bank's notice job owes, run with its signed job door as a scheduler would.
const J = 'J-bank-06';
const TRIP = 'Trip TEST';
const EMPTY = 'Empty TEST';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

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
  const total = { passes: 0, settled: 0, rejected: 0 };
  while (total.passes < 30) {
    const pass = await runOnce();
    if (pass.schedulesConsidered === 0) break;
    total.passes += 1;
    total.settled += pass.settled;
    total.rejected += pass.rejected;
  }
  return total;
}

function person() {
  const { who } = run.read();
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}
const main = (rows) => rows.find((s) => s.kind === 'primary' && s.assetId === 'USDT');
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

test(`${J} #1 schedules a one-off for tomorrow: it is listed once with its date, and a one-off with an end date is refused`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await signUp(page, 'jb6');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  run.reset({ who });
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

  const tomorrow = inHours(24);
  const dialog = await scheduleInApp(page, { cadence: 'One-off', amount: '5', startsAt: tomorrow });
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByText('Confirmed by the service')).toBeVisible({ timeout: 30_000 });

  const [once] = (await schedules(who)).filter((s) => s.cadence === 'once');
  expect(once).toMatchObject({ amount: '5', status: 'active', endsAt: null, revision: 1 });
  expect(Math.abs(Date.parse(once.nextRunAt) - tomorrow.getTime())).toBeLessThan(60_000);
  await page.goto('/bank/transfers');
  await expect(row(page, once.id)).toContainText('once · active');
  run.write({ once: once.id });
});

test(`${J} #2 edits a standing order's amount and end date: revision 2 is shown, and a stale second edit is refused`, async ({ page }) => {
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

  // A stale edit: the review is open on revision 2 when the order changes elsewhere (the person's own API, as another
  // device would). Confirming is refused by name, and the order keeps the other change.
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
  run.write({ monthly: order.id });
});

test(`${J} #3 a due one-off posts once and completes, and a run with too little money fails by name and posts nothing`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = person();
  const api = await bank(who);
  const before = await spaces(who);
  const due = randomUUID(),
    short = randomUUID();
  const past = new Date(Date.now() - 60_000).toISOString();
  // Made through the person's own API with a first run a minute ago, so the next runner pass finds them due.
  const once = await api.mutate('transfers.schedule', {
    scheduleId: due,
    fromSpaceId: main(before).id,
    toSpaceId: named(before, TRIP).id,
    amount: '7',
    cadence: 'once',
    startsAt: past,
  });
  expect(once.ok).toBe(true);
  const empty = await api.mutate('transfers.schedule', {
    scheduleId: short,
    fromSpaceId: named(before, EMPTY).id,
    toSpaceId: main(before).id,
    amount: '3',
    cadence: 'daily',
    startsAt: past,
  });
  expect(empty.ok).toBe(true);

  // Other journeys' orders on this stack may be due too, so this counts at least these two.
  const first = await runDue();
  expect(first.settled).toBeGreaterThanOrEqual(1);
  expect(first.rejected).toBeGreaterThanOrEqual(1);
  const after = await spaces(who);
  expect(toUnits(main(before).balance) - toUnits(main(after).balance)).toBe(toUnits('7'));
  expect(toUnits(named(after, TRIP).balance) - toUnits(named(before, TRIP).balance)).toBe(toUnits('7'));
  expect(toUnits(named(after, EMPTY).balance)).toBe(0n);

  const [posted] = await executions(who, due);
  expect(posted).toMatchObject({ occurrence: 0, amount: '7', status: 'settled', rejectionCode: null });
  expect(posted.ledgerTxId).toBeTruthy();
  expect((await schedules(who)).find((s) => s.id === due)).toMatchObject({ status: 'completed' });
  const [failed] = await executions(who, short);
  expect(failed).toMatchObject({ occurrence: 0, status: 'rejected', rejectionCode: 'ledger.insufficient_funds', ledgerTxId: null });

  // A second pass posts nothing more: the one-off is done and the failed day is recorded.
  await runDue();
  const again = await spaces(who);
  expect(main(again).balance).toBe(main(after).balance);
  expect(await executions(who, due)).toHaveLength(1);
  expect(await executions(who, short)).toHaveLength(1);
  run.write({ due, short });

  // Both outcomes in the app, from the instructions' own history.
  await signIn(page, who);
  await page.goto('/bank/transfers');
  await expect(row(page, due)).toContainText('once · completed');
  await row(page, short).getByRole('button', { name: 'Execution history' }).click();
  const history = page.getByTestId('money-selected-instruction').getByTestId('money-execution-history');
  await expect(history).toContainText('rejected');
  await expect(history).toContainText('ledger.insufficient_funds');
  await expect(history).toContainText('No ledger reference recorded');
  expect((await api.mutate('transfers.cancel', { scheduleId: short })).ok).toBe(true);
});

test(`${J} #4 sees each direct debit with what it collects next, blocks one, and a collection that fails costs no fee and a collected one can be refunded`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = person();
  const api = await bank(who);
  const before = main(await spaces(who));
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then((r) => r.json());
  const owner = login?.result?.data?.userId;
  expect(owner).toBeTruthy();
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
  await scheme('dd-sim/collection', { mandateId: gym, collectionId: `${tag}-huge`, amount: '100000', dueAt: at(-0.01) });
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

  // Block the power company: its upcoming bill is refused now, and nothing is taken.
  await powerRow.getByRole('button', { name: 'Block' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`PWR ${tag}`);
  await dialog.getByRole('button', { name: 'Block mandate' }).click();
  await expect(page.getByText('Blocked TEST Power company. Upcoming collections refused: 1.')).toBeVisible();
  await expect(powerRow).toContainText('Blocked since');
  await expect(powerRow).toContainText('Nothing due in the next month');
  // A collection it presents while blocked is refused too.
  const late = await scheme('dd-sim/collection', { mandateId: power, collectionId: `${tag}-late`, amount: '3', dueAt: at(2) });
  expect(late).toMatchObject({ status: 'rejected', failureCode: 'bank.dd_mandate_blocked', ledgerTxId: null });

  // The collection run: the due 5 is collected once; the 100000 fails on too little money, posts nothing, costs no fee.
  // Other journeys' collections share this stack, so the run is passed until this person's two due ones are decided.
  const decided = async () => {
    const { collections } = (await api.query('directDebits.list', {})).data;
    const done = (id) => collections.some((c) => c.collectionId === id && (c.status === 'collected' || c.status === 'failed'));
    return done(`${tag}-due`) && done(`${tag}-huge`);
  };
  for (let pass = 0; pass < 20 && !(await decided()); pass += 1) await scheme('run-due-direct-debits', { limit: 50 });
  expect(await decided()).toBe(true);
  const after = main(await spaces(who));
  expect(toUnits(before.balance) - toUnits(after.balance)).toBe(toUnits('5'));
  await scheme('run-due-direct-debits', { limit: 50 });
  expect(main(await spaces(who)).balance).toBe(after.balance);

  await page.reload();
  const collected = page.getByTestId(`dd-collection-${tag}-due`);
  await expect(collected).toContainText('Collected');
  await expect(collected).toContainText('5 USDT');
  const failed = page.getByTestId(`dd-collection-${tag}-huge`);
  await expect(failed).toContainText('Failed');
  await expect(failed).toContainText('Your main balance did not have enough money. Nothing was taken.');
  await expect(failed).toContainText('Not set. No fee was charged.');
  await expect(failed).toContainText('bank.dd_failure_fee_unset');
  const refused = page.getByTestId(`dd-collection-${tag}-bill`);
  await expect(refused).toContainText('Refused because you blocked this mandate. Nothing was taken.');
  await expect(failed.getByRole('button', { name: 'Request a refund' })).toHaveCount(0);

  // Inside the 30-day TEST guarantee period, the collected 5 can be asked back, once.
  await collected.getByRole('button', { name: 'Request a refund' }).click();
  const ask = page.getByRole('dialog');
  await ask.getByLabel('Why should it be refunded?').fill('TEST: I cancelled this membership.');
  await ask.getByRole('button', { name: 'Send refund request' }).click();
  await expect(page.getByText('Refund request sent for 5 USDT. Support will look at it.')).toBeVisible();
  await expect(collected).toContainText('Requested on');
  const listed = (await api.query('directDebits.list', {})).data;
  const row = listed.collections.find((c) => c.collectionId === `${tag}-due`);
  expect(row.refund.state).toBe('requested');
  const twice = await api.mutate('directDebits.requestRefund', { collectionId: row.id, reason: 'TEST again' });
  expect(twice.ok).toBe(true);
  expect(twice.data.created).toBe(false);

  run.write({ dd: { gym, power, tag } });

  // Unblock: the power company may collect again; what was refused while blocked stays refused.
  await powerRow.getByRole('button', { name: 'Unblock' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Unblock mandate' }).click();
  await expect(powerRow).toContainText('Active');
  await expect(refused).toContainText('Refused');
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

test(`${J} #5 opens the calendar: standing orders and direct debits on their dates, each opening its room, and loans and bills say why they show none`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = person();
  const { once, monthly, due, short, dd } = run.read();
  if (!due || !short) throw new Error(`${J}: #3 left no standing orders, so the calendar has nothing of its own to show`);
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
    huge = collection('huge'),
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
  expect(byKey(ran, `${short}:0`)).toMatchObject({ status: 'failed', reasonCode: 'ledger.insufficient_funds' });
  // #3 cancelled the empty order after its failed day, so none of its later days are on the calendar.
  expect(ran.items.filter((i) => i.refId === short).map((i) => i.status)).toEqual(['failed']);
  expect(ran.sources.find((s) => s.source === 'loans')).toMatchObject({ state: 'not_set', code: 'bank.loan_schedule_unset' });
  expect(ran.sources.find((s) => s.source === 'bills')).toMatchObject({ state: 'ok', code: 'bank.bills_psp_unset' });
  for (const [row, status, reason] of [
    [collected, 'done', null],
    [huge, 'failed', 'bank.insufficient_funds'],
    [blocked, 'refused', 'bank.dd_mandate_blocked'],
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
  await expect(sources.getByTestId('cal-source-loans')).toContainText('bank.loan_schedule_unset');
  await expect(sources.getByTestId('cal-source-bills')).toContainText('no bill payment partner is connected');
  await expect(sources.getByTestId('cal-source-standing_orders')).toHaveAttribute('data-state', 'ok');
  await expect(sources.getByTestId('cal-source-direct_debits')).toHaveAttribute('data-state', 'ok');

  // The list: each run with its status, and a failed one with its reason in words and by code.
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const failedRow = page.getByTestId(`cal-row-${short}:0`);
  await expect(failedRow).toContainText('Failed');
  await expect(failedRow).toContainText('There was not enough money. Nothing was taken.');
  await expect(failedRow).toContainText('ledger.insufficient_funds');
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
  await expect(page.getByTestId('rules-money-not-set')).toContainText('bank.rule_terms_unset');
  const rows = await spaces(who);
  await money.getByLabel('Rule name').fill('Sweep TEST');
  await money.getByRole('combobox', { name: /^From/ }).selectOption(main(rows).id);
  await money.getByRole('combobox', { name: /^To\b/ }).selectOption(named(rows, TRIP).id);
  await money.getByRole('combobox', { name: /^When/ }).selectOption({ label: 'When the balance goes over' });
  await money.getByLabel('Balance over').fill('50');
  await money.getByLabel('Amount to move').fill('10');
  await money.getByRole('button', { name: 'Save rule' }).click();
  await expect(money.getByRole('alert')).toContainText('Not saved: rules that move money by themselves are not open');
  await expect(money.getByRole('alert')).toContainText('bank.rule_terms_unset');
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
  if (!once || !short) throw new Error(`${J}: #1 or #3 left no order to tell the person about`);
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
