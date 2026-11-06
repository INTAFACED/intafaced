import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signUp } from './desk.mjs';
import { asDesk, deskPeople } from './help-centre.mjs';
import { api, tool } from './stack.mjs';

// J-support-public-12, in the running app (docs/roadmap/journeys.json): a support lead decides who sees which requests and
// who gets them. Tests titled "J-support-public-12 #<n>" prove a whole step. The lead (founder A) works in the founder
// console (apps/admin); founder B is an agent who signs in, and three TEST accounts are appointed agents the lead manages.
// TEST customers send the requests through their own support API.
//
// The journey starts on a desk with no groups and no routing, so svc-support runs on the stack's empty-catalogue database
// for this file (LOCAL_STACK_SUPPORT_CATALOGUE=off, made new on that start) and goes back to the stack's own database at
// the end: the shared desk's groups and requests are never touched. The steps run in order on that one desk.
const J = 'J-support-public-12';
const RUN = Date.now().toString(36);

test.describe.configure({ mode: 'serial' });

/** Restart svc-support with these LOCAL TEST switches set for the restart only (undefined leaves one unset). */
function restartSupport(switches) {
  const before = Object.fromEntries(Object.keys(switches).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(switches)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    tool('local-test-stack.mjs', 'restart', 'support');
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
/** This file's desk: the empty-catalogue database, with the heartbeat window given (blank by default). */
const ownDesk = (heartbeatWindow, { fresh = false } = {}) =>
  restartSupport({
    LOCAL_STACK_SUPPORT_CATALOGUE: 'off',
    LOCAL_STACK_SUPPORT_CATALOGUE_KEEP: fresh ? undefined : 'on',
    LOCAL_STACK_SUPPORT_HEARTBEAT_WINDOW: heartbeatWindow,
  });

/** A desk call that must succeed; its data. */
async function desk(who, kind, procedure, input) {
  const res = await asDesk(who, kind, procedure, input);
  if (res.json?.result?.data === undefined) throw new Error(`${procedure} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return res.json.result.data;
}

/** A desk call that must be refused with `code`; the refusal's status. */
async function refused(who, kind, procedure, input, code) {
  const res = await asDesk(who, kind, procedure, input);
  expect(res.json?.result?.data, `${procedure} should be refused`).toBeUndefined();
  expect(res.text).toContain(code);
  return res.status;
}

let people;
let customer;
let customerApi;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  ownDesk(undefined, { fresh: true });
  const { lead, agent } = await deskPeople();
  const page = await browser.newPage();
  // Three TEST accounts the lead appoints as agents (they never sign in to the desk), and one customer.
  const extra = [];
  for (const tag of ['q12c', 'q12d', 'q12e']) extra.push((await api(await signUp(page, tag))).userId);
  customer = await signUp(page, 'q12u');
  await page.close();
  customerApi = await api(customer);
  // A new desk: its first appointment is a lead, then the agents.
  await desk('lead', 'mutation', 'staffAppoint', { userId: lead, role: 'lead', idempotencyKey: `${J}:${RUN}:lead` });
  for (const userId of [agent, ...extra])
    await desk('lead', 'mutation', 'staffAppoint', { userId, role: 'agent', idempotencyKey: `${J}:${RUN}:agent:${userId}` });
  const [c, d, e] = extra;
  people = { lead, b: agent, c, d, e };
});

test.afterAll(() => {
  restartSupport({
    LOCAL_STACK_SUPPORT_CATALOGUE: undefined,
    LOCAL_STACK_SUPPORT_CATALOGUE_KEEP: undefined,
    LOCAL_STACK_SUPPORT_HEARTBEAT_WINDOW: undefined,
  });
});

/** The founder console's support desk, signed in as the lead. */
async function console_(browser) {
  const page = await browser.newPage();
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/support`);
  return page;
}

/** The customer sends one request; its id. */
async function request(subject) {
  const res = await customerApi.post('/api/support/trpc/create', {
    category: 'account',
    subject: `TEST ${J} ${RUN} ${subject}`,
    body: `TEST ${J} request: ${subject}`,
    clientRequestId: `${J}:${RUN}:${subject}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.id;
}

const setAvailability = (who, userId, availability, reason) =>
  desk(who, 'mutation', 'staffSetAvailability', { userId, availability, ...(reason ? { reason } : {}) });
const assignee = async (ticketId) => (await desk('lead', 'query', 'get', { ticketId })).assigneeId;
const assignedRows = async (ticketId) =>
  (await desk('lead', 'query', 'events', { ticketId, limit: 100 })).filter((e) => e.kind === 'assigned');

test(`${J} #1 the agent directory shows availability and groups; an agent goes busy; a set window turns a silent agent offline; blank says not set`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const page = await console_(browser);
  const staff = page.getByTestId('staff-panel');
  // Window blank (as in production): the directory says automatic offline is not set.
  await expect(staff.getByTestId('staff-policy')).toContainText('Automatic offline is not set');
  for (const id of Object.values(people)) await expect(staff.getByTestId(`staff-${id}`)).toBeVisible();
  await expect(staff.getByRole('columnheader', { name: 'Groups (teams)' })).toBeVisible();
  await expect(staff.getByTestId(`staff-groups-${people.b}`)).toHaveText('None');
  // The agent toggles busy on its own session; the directory shows it.
  await setAvailability('agent', people.b, 'busy');
  await page.getByRole('button', { name: 'Refresh staff' }).click();
  await expect(staff.getByTestId(`staff-${people.b}`)).toContainText('busy');
  await setAvailability('agent', people.b, 'online');

  // With a TEST window of 5 seconds, an agent set online who sends no heartbeat reads offline once it passes.
  ownDesk('5');
  await setAvailability('lead', people.c, 'online', `TEST ${J} #1 start a shift`);
  await page.reload();
  await expect(staff.getByTestId('staff-policy')).toContainText('5 seconds');
  await expect(staff.getByTestId(`staff-${people.c}`)).toContainText('online');
  await page.waitForTimeout(6_500);
  await page.getByRole('button', { name: 'Refresh staff' }).click();
  await expect(staff.getByTestId(`staff-${people.c}`)).toContainText('offline');
  ownDesk(undefined);
  await page.reload();
  await expect(staff.getByTestId('staff-policy')).toContainText('Automatic offline is not set');
  await page.close();
});

test(`${J} #2 a lead sets another agent's availability with a logged reason; an agent cannot set someone else's`, async ({ browser }) => {
  const page = await console_(browser);
  const staff = page.getByTestId('staff-panel');
  const reason = `TEST ${J} ${RUN} covering the late shift`;
  await staff.locator('#sd-staff-target').selectOption(people.d);
  await staff.locator('#sd-staff-avail').selectOption('busy');
  await staff.locator('#sd-staff-reason').fill(reason);
  await staff.getByRole('button', { name: 'Review availability' }).click();
  await staff.getByRole('button', { name: 'Yes, set busy' }).click();
  await expect(staff.getByTestId(`staff-${people.d}`)).toContainText('busy');
  // The log has the lead's change with its reason, once.
  const log = page.getByTestId('staff-log');
  await expect(log.getByRole('row').filter({ hasText: reason })).toHaveCount(1);
  await expect(log.getByRole('row').filter({ hasText: reason })).toContainText(people.lead);
  const rows = (await desk('lead', 'query', 'staffAvailabilityLog', { userId: people.d })).filter((r) => r.reason === reason);
  expect(rows).toEqual([expect.objectContaining({ userId: people.d, availability: 'busy', by: people.lead, reason })]);
  // The agent (founder B) cannot set the same person's availability; nothing changes.
  await refused('agent', 'mutation', 'staffSetAvailability', { userId: people.d, availability: 'online' }, 'support.not_lead');
  expect((await desk('lead', 'query', 'staffList')).find((m) => m.userId === people.d).availability).toBe('busy');
  await page.close();
});

test(`${J} #3 visibility settings with no groups say "Visibility is not restricted"`, async ({ browser }) => {
  const page = await console_(browser);
  expect(await desk('lead', 'query', 'groupsList')).toEqual([]);
  await expect(page.getByTestId('groups-panel').getByTestId('groups-scope')).toContainText('Visibility is not restricted');
  await page.close();
});

/** Make a group in the console; its id. */
async function makeGroup(page, name) {
  const panel = page.getByTestId('groups-panel');
  await panel.locator('#sd-group-edit').selectOption({ label: 'A new group' });
  await panel.getByLabel('Name').fill(name);
  await panel.getByRole('button', { name: 'Review group' }).click();
  await panel.getByRole('button', { name: 'Yes, make it' }).click();
  await expect(panel.getByTestId('groups-outcome')).toBeVisible();
  let id;
  await expect.poll(async () => (id = (await desk('lead', 'query', 'groupsList')).find((g) => g.name === name)?.id)).toBeTruthy();
  await expect(panel.getByTestId(`group-${id}`)).toContainText(name);
  return id;
}

/** Add or remove a member in the console. */
async function membership(page, groupName, userId, add) {
  const panel = page.getByTestId('groups-panel');
  await panel.locator('#sd-group-pick').selectOption({ label: groupName });
  await panel.locator('#sd-group-user').selectOption(userId);
  await panel.locator('#sd-group-op').selectOption({ label: add ? 'Add to the group' : 'Remove from the group' });
  await panel.getByRole('button', { name: 'Review membership' }).click();
  await panel.getByRole('button', { name: add ? 'Yes, add them' : 'Yes, remove them' }).click();
  await expect(panel.getByTestId('groups-outcome')).toBeVisible();
  await expect
    .poll(async () => (await desk('lead', 'query', 'groupsList')).find((g) => g.name === groupName)?.memberIds.includes(userId))
    .toBe(add);
}

const groups = {};
const scoped = {};

/** What the agent (founder B) can list, search and count, and whether each ticket opens. */
async function agentSees(word) {
  const list = (await desk('agent', 'query', 'listAll', { limit: 500 })).map((t) => t.id);
  const search = (await desk('agent', 'query', 'listAll', { limit: 500, q: word })).map((t) => t.id);
  const count = (await desk('agent', 'query', 'queueMetrics')).total;
  return { list, search, count };
}

test(`${J} #4 two groups and an agent in one: the agent's list, search and count show its group and its own; a ticket outside is not found`, async ({
  browser,
}) => {
  const page = await console_(browser);
  groups.one = { name: `TEST ${J} ${RUN} payments`, id: await makeGroup(page, `TEST ${J} ${RUN} payments`) };
  groups.two = { name: `TEST ${J} ${RUN} trading`, id: await makeGroup(page, `TEST ${J} ${RUN} trading`) };
  await membership(page, groups.one.name, people.b, true);
  await expect(page.getByTestId('groups-panel').getByTestId('groups-scope')).not.toContainText('Visibility is not restricted');

  const word = `scope${RUN}`;
  scoped.inOne = await request(`${word} in payments`);
  scoped.inTwo = await request(`${word} in trading`);
  scoped.mine = await request(`${word} assigned to the agent`);
  await desk('lead', 'mutation', 'ticketSetGroup', { ticketId: scoped.inOne, groupId: groups.one.id });
  await desk('lead', 'mutation', 'ticketSetGroup', { ticketId: scoped.inTwo, groupId: groups.two.id });
  await desk('lead', 'mutation', 'assign', { ticketId: scoped.mine, assigneeId: people.b, idempotencyKey: `${J}:${RUN}:assign-mine` });

  const seen = await agentSees(word);
  expect(seen.list.sort()).toEqual([scoped.inOne, scoped.mine].sort());
  expect(seen.search.sort()).toEqual([scoped.inOne, scoped.mine].sort());
  expect(seen.count).toBe(2);
  // Outside the agent's scope reads as an id that never existed.
  const outside = await asDesk('agent', 'query', 'get', { ticketId: scoped.inTwo });
  const never = await asDesk('agent', 'query', 'get', { ticketId: '00000000-0000-4000-8000-000000000000' });
  expect(outside.status).toBe(never.status);
  expect(outside.json?.error?.message).toBe(never.json?.error?.message);
  // The lead still sees all three.
  const leadList = (await desk('lead', 'query', 'listAll', { limit: 500, q: word })).map((t) => t.id);
  expect(leadList.sort()).toEqual([scoped.inOne, scoped.inTwo, scoped.mine].sort());
  await page.close();
});

test(`${J} #5 a membership change shows on the next read, and the group log has one row for it`, async ({ browser }) => {
  const page = await console_(browser);
  const before = await desk('lead', 'query', 'groupsLog', { groupId: groups.two.id });
  await membership(page, groups.two.name, people.b, true);
  const after = await desk('lead', 'query', 'groupsLog', { groupId: groups.two.id });
  expect(after.slice(before.length)).toEqual([expect.objectContaining({ action: 'member_added', subject: people.b, by: people.lead })]);
  // The next read: the agent now sees the trading request too.
  const seen = await agentSees(`scope${RUN}`);
  expect(seen.list.sort()).toEqual([scoped.inOne, scoped.inTwo, scoped.mine].sort());
  // The console shows the same one row in the group's log.
  const panel = page.getByTestId('groups-panel');
  await panel.locator('#sd-group-log-pick').selectOption({ label: groups.two.name });
  await expect(page.getByTestId('groups-log').getByRole('row').filter({ hasText: 'Member added' })).toHaveCount(1);
  await page.close();
});

const routed = {};

/** Set an agent's capacity and skills in the console. */
async function routingFor(page, userId, capacity, skills = '') {
  const staff = page.getByTestId('staff-panel');
  await staff.locator('#sd-routing-target').selectOption(userId);
  await staff.locator('#sd-routing-capacity').fill(capacity === null ? '' : String(capacity));
  await staff.locator('#sd-routing-skills').fill(skills);
  await staff.getByRole('button', { name: 'Review routing' }).click();
  await staff.getByRole('button', { name: 'Yes, save routing' }).click();
  await expect(staff.getByTestId('staff-outcome')).toBeVisible();
  await expect(staff.getByTestId(`staff-capacity-${userId}`)).toContainText(capacity === null ? 'Capacity not set' : String(capacity));
}

test(`${J} #6 round robin for three online agents: five new requests go out in turn, the cursor survives a restart, racing passes make one assignment`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const page = await console_(browser);
  // The routed group: B, C and E online with room; D on the desk with a blank capacity.
  routed.group = { name: `TEST ${J} ${RUN} routed`, id: await makeGroup(page, `TEST ${J} ${RUN} routed`) };
  for (const id of [people.b, people.c, people.d, people.e]) await membership(page, routed.group.name, id, true);
  for (const id of [people.b, people.c, people.e]) {
    await setAvailability('lead', id, 'online', `TEST ${J} #6 on shift`);
    await routingFor(page, id, 10);
  }
  await setAvailability('lead', people.d, 'online', `TEST ${J} #6 on shift`);
  await routingFor(page, people.d, null);
  const turn = [people.b, people.c, people.e].sort();

  const panel = page.getByTestId('groups-panel');
  await panel.locator('#sd-group-routing-group').selectOption({ label: routed.group.name });
  await panel.locator('#sd-group-routing-mode').selectOption('round_robin');
  await panel.getByRole('button', { name: 'Review routing' }).click();
  await panel.getByRole('button', { name: 'Yes, set routing' }).click();
  await expect(panel.getByTestId(`group-routing-${routed.group.id}`)).toContainText('In turn');

  routed.tickets = [];
  const place = async (n) => {
    const id = await request(`routed ${n}`);
    await desk('lead', 'mutation', 'ticketSetGroup', { ticketId: id, groupId: routed.group.id });
    routed.tickets.push(id);
    return assignee(id);
  };
  const got = [];
  for (const n of [1, 2, 3]) got.push(await place(n));
  // A restart of svc-support between the third and fourth request: the stored cursor carries on.
  ownDesk(undefined);
  expect((await desk('lead', 'query', 'routingOverview')).groups.find((g) => g.groupId === routed.group.id).cursorUserId).toBe(turn[2]);
  for (const n of [4, 5]) got.push(await place(n));
  expect(got).toEqual([turn[0], turn[1], turn[2], turn[0], turn[1]]);
  for (const id of routed.tickets) {
    const rows = await assignedRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe('support:routing');
  }
  await page.reload();
  await expect(page.getByTestId('groups-panel').getByTestId(`group-routing-${routed.group.id}`)).toContainText(
    `Last assigned to ${turn[1]}`,
  );

  // Two workers racing on one request: it waits (everyone busy), one agent comes back, two passes run at once.
  for (const id of turn) await setAvailability('lead', id, 'busy', `TEST ${J} #6 break`);
  const race = await request('race');
  await desk('lead', 'mutation', 'ticketSetGroup', { ticketId: race, groupId: routed.group.id });
  expect(await assignee(race)).toBeNull();
  await setAvailability('lead', turn[0], 'online', `TEST ${J} #6 back`);
  const passes = await Promise.all([
    asDesk('lead', 'mutation', 'routingRun', { ticketId: race }),
    asDesk('agent', 'mutation', 'routingRun', { ticketId: race }),
  ]);
  const outcomes = passes.map((p) => p.json.result.data.status);
  expect(outcomes.sort()).toEqual(['assigned', 'skipped']);
  expect(await assignee(race)).toBe(turn[0]);
  expect(await assignedRows(race)).toHaveLength(1);
  routed.race = race;
  for (const id of turn.slice(1)) await setAvailability('lead', id, 'online', `TEST ${J} #6 back`);
  await page.close();
});

test(`${J} #7 an agent at capacity, or with a blank capacity, is skipped`, async ({ browser }) => {
  const page = await console_(browser);
  const turn = [people.b, people.c, people.e].sort();
  const load = async (id) =>
    (await desk('lead', 'query', 'listAll', { limit: 500 })).filter((t) => t.assigneeId === id && ['open', 'pending'].includes(t.status))
      .length;
  // The cursor is on the race's winner (turn[0]); next in turn is turn[1]. Fill its capacity to what it holds.
  const held = await load(turn[1]);
  await routingFor(page, turn[1], held);
  await expect(page.getByTestId('staff-panel').getByTestId(`staff-capacity-${turn[1]}`)).toHaveText(String(held));
  await expect(page.getByTestId('staff-panel').getByTestId(`staff-capacity-${people.d}`)).toContainText('Capacity not set');
  const id = await request('capacity');
  await desk('lead', 'mutation', 'ticketSetGroup', { ticketId: id, groupId: routed.group.id });
  expect(await assignee(id)).toBe(turn[2]);
  // D, online in the group with a blank capacity, was never given one.
  expect(await load(people.d)).toBe(0);
  await routingFor(page, turn[1], 10);
  await page.close();
});

test(`${J} #8 a required skill nobody has keeps the request queued, and the queue shows support.no_agent_available`, async ({
  browser,
}) => {
  const page = await console_(browser);
  const id = await request('needs a skill');
  // The lead names the skill on the request, then places it in the routed group.
  await page.goto(`${ADMIN}/support/${id}`);
  const card = page.getByTestId('ticket-routing');
  await expect(card).toContainText('No skill needed');
  await card.locator('#sd-ticket-skill').fill(`test-nobody-${RUN}`);
  await card.getByRole('button', { name: 'Review skill' }).click();
  await card.getByRole('button', { name: 'Yes, set skill' }).click();
  await expect(card.getByTestId('routing-skill')).toContainText(`test-nobody-${RUN}`);
  await desk('lead', 'mutation', 'ticketSetGroup', { ticketId: id, groupId: routed.group.id });
  expect(await assignee(id)).toBeNull();
  expect(await desk('lead', 'query', 'ticketRouting', { ticketId: id })).toMatchObject({
    state: 'no_agent',
    code: 'support.no_agent_available',
  });
  await page.reload();
  await expect(card.getByTestId('routing-state')).toContainText('support.no_agent_available');
  await page.goto(`${ADMIN}/support`);
  await expect(page.getByTestId(`routing-waiting-${id}`)).toContainText('support.no_agent_available');
  await expect(page.getByTestId(`routing-waiting-${id}`)).toContainText('No agent available');
  await page.close();
});

test(`${J} #9 a hand claim racing the worker: exactly one wins and the loser is a no-op`, async () => {
  const turn = [people.b, people.c, people.e].sort();
  for (const id of turn) await setAvailability('lead', id, 'busy', `TEST ${J} #9 break`);
  const id = await request('claim race');
  await desk('lead', 'mutation', 'ticketSetGroup', { ticketId: id, groupId: routed.group.id });
  expect(await assignee(id)).toBeNull();
  await setAvailability('lead', people.c, 'online', `TEST ${J} #9 back`);
  // Founder B claims it by hand while the worker's pass runs.
  const [claim, pass] = await Promise.all([
    asDesk('agent', 'mutation', 'claim', { ticketId: id }),
    asDesk('lead', 'mutation', 'routingRun', { ticketId: id }),
  ]);
  const claimWon = claim.json?.result?.data?.assigneeId === people.b;
  const passWon = pass.json?.result?.data?.status === 'assigned';
  expect([claimWon, passWon].filter(Boolean)).toHaveLength(1);
  if (claimWon) expect(pass.json.result.data).toMatchObject({ status: 'skipped', reason: 'already_assigned' });
  else expect(claim.text).toContain('support.claim.already_claimed');
  expect(await assignee(id)).toBe(claimWon ? people.b : people.c);
  expect(await assignedRows(id)).toHaveLength(1);
});
