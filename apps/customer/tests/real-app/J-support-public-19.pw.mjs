import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { draftNotice, openNotices, publishAs, publishNotice, publishedNotices } from './notices.mjs';
import {
  configureStatusPage,
  incidentTemplates,
  publishedPostmortems,
  setIncidentTemplate,
  statusDefinition,
  statusRead,
} from './status-page.mjs';
import { ORIGIN, statusMail } from './stack.mjs';

// J-support-public-19, in the running app (docs/roadmap/journeys.json): two operators publish an incident, a maintenance
// window and an announcement from the founder console's notify desk, and the public pages, the notice board and the
// subscribers show the same truth. Tests titled "J-support-public-19 #<n>" prove a whole step.
const J = 'J-support-public-19';

test.describe.configure({ mode: 'serial' });

/** The labelled TEST owner values this journey defines. A short staleness window, so a hand reading goes stale in the run. */
const TEST_STALENESS_SECONDS = 20;
const OUTSIDE_SOURCE = 'TEST SMS provider status page';
// Ids of this journey's own: readings are kept per component, and J-support-public-07 reads trading, wallets and card-network.
const COMPONENTS = [
  { id: 'api', name: 'API', group: 'Platform', source: '' },
  { id: 'payments', name: 'Payments', group: 'Platform', source: '' },
  { id: 'sms-gateway', name: 'SMS gateway', group: 'Outside dependencies', source: OUTSIDE_SOURCE },
];

/** Founder A on the console's status page desk, in a context of its own. */
async function statusDesk(browser) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, 'a');
  await page.goto('/notify/status');
  await expect(page.getByRole('heading', { level: 1, name: 'Status page' })).toBeVisible();
  return page;
}

/** Every incident this journey declares starts with this, so a run that stopped half way can be closed by the next. */
const INCIDENT_PREFIX = `TEST journey ${J}:`;
const RUN = Date.now().toString(36);
const TEMPLATE = {
  id: 'j19-payments-slow',
  name: 'Payments slow',
  group: 'Payments',
  title: `${INCIDENT_PREFIX} card payments are slow`,
  body: 'TEST We are looking into slow card payments.',
};

/** Resolves any incident of this journey still open on the page (a run that failed part way leaves one behind). */
async function resolveLeftovers() {
  for (const incident of (await statusRead()).incidents)
    if (incident.resolvedAt === null && incident.title.startsWith(INCIDENT_PREFIX)) {
      const row = await draftNotice({
        kind: 'incident',
        title: incident.title,
        body: 'TEST Closed by the next journey run.',
        minutes: 5,
        key: `j19-leftover:${incident.id}`,
        parentId: incident.id,
        resolves: true,
      });
      await publishNotice(row, `j19-leftover:${incident.id}`);
    }
}

/** The definition and the templates this journey found, put back after it so the stack keeps what others set. */
let found;
let foundTemplates;
test.beforeAll(async () => {
  found = await statusDefinition();
  foundTemplates = await incidentTemplates();
  await resolveLeftovers();
});
test.afterAll(async () => {
  await resolveLeftovers();
  if (foundTemplates) {
    for (const t of await incidentTemplates())
      if (!foundTemplates.some((f) => f.id === t.id)) await setIncidentTemplate(t, { retire: true });
    for (const t of foundTemplates) await setIncidentTemplate(t);
  }
  if (!found) return;
  await configureStatusPage(
    {
      components: found.components,
      componentCap: found.componentCap,
      stalenessSeconds: found.stalenessSeconds,
      uptimeDays: found.uptimeDays,
      challengeBits: found.challengeBits,
      subscribeRatePerHour: found.subscribeRatePerHour,
    },
    `TEST journey ${J}: put back the definition it found`,
  );
});

test(`${J} #1 define components and groups and a manual outside entry: it shows its source and age, then goes stale to No data`, async ({
  browser,
}) => {
  // From an empty page, so every row below is the operator's own.
  await configureStatusPage(
    { components: [], componentCap: 5, stalenessSeconds: TEST_STALENESS_SECONDS },
    `TEST journey ${J}: start empty`,
  );
  const page = await statusDesk(browser);
  await expect(page.getByTestId('status-visible-none')).toContainText('No components are defined');
  await expect(page.getByTestId('status-reading-none')).toBeVisible();

  const define = page.getByTestId('status-define');
  for (const [i, c] of COMPONENTS.entries()) {
    await define.getByRole('button', { name: 'Add component' }).click();
    await define.getByLabel(`Row ${i + 1} id`).fill(c.id);
    await define.getByLabel(`Row ${i + 1} name`).fill(c.name);
    await define.getByLabel(`Row ${i + 1} group`).fill(c.group);
    await define.getByLabel(`Row ${i + 1} outside source`).fill(c.source);
  }
  await define.getByLabel(/^Reason/).fill(`TEST journey ${J} #1: components, groups and one outside dependency`);
  await define.getByRole('button', { name: 'Save the page' }).click();
  await expect(page.getByTestId('status-desk-outcome')).toContainText('Saved');

  // No fresh reading yet (a stack that ran this before keeps its old, stale one): No data, and it says why.
  const outside = page.getByTestId('status-visible-sms-gateway');
  await expect(outside).toContainText(`Outside: ${OUTSIDE_SOURCE}`);
  await expect(outside).toContainText('Outside dependencies');
  await expect(outside).toContainText('No data');
  await expect(outside.getByTestId('status-visible-why')).toHaveText(
    /^(nothing has been read for it yet|its latest reading is older than the staleness window)$/,
  );
  await expect(page.getByTestId('status-visible-api').getByTestId('status-visible-source')).toHaveText('Our own');

  // The operator enters the outside dependency's state by hand: it carries the source and its age.
  const reading = page.getByTestId('status-reading');
  await reading.getByLabel('Component').selectOption('sms-gateway');
  await reading.getByLabel('State').selectOption('operational');
  await reading.getByRole('button', { name: 'Store reading' }).click();
  await expect(page.getByTestId('status-desk-outcome')).toContainText('Reading stored');
  await expect(outside).toContainText('Operational');
  await expect(outside.getByTestId('status-visible-why')).toHaveText('from its latest reading');
  await expect(outside.getByTestId('status-visible-reading')).toContainText(`Operational from ${OUTSIDE_SOURCE}, `);
  await expect(outside.getByTestId('status-visible-reading')).toContainText(/\d+ s ago/);

  // The visitor sees the same component, and the same state, on /status.
  const visitor = await browser.newPage({ baseURL: ORIGIN });
  await visitor.goto('/status');
  await expect(visitor.getByTestId('status-component-sms-gateway')).toContainText('SMS gateway');
  await expect(visitor.getByTestId('status-component-sms-gateway')).toContainText(/operational/i);

  // Past the staleness window the reading no longer counts: No data, with the stale reading and its age still shown.
  await page.waitForTimeout((TEST_STALENESS_SECONDS + 2) * 1000);
  await page.getByRole('button', { name: 'Read again' }).click();
  await expect(outside.getByTestId('status-visible-why')).toHaveText('its latest reading is older than the staleness window');
  await expect(outside).toContainText('No data');
  await expect(outside.getByTestId('status-visible-reading')).toContainText(`Operational from ${OUTSIDE_SOURCE}, `);
  await visitor.reload();
  await expect(visitor.getByTestId('status-component-sms-gateway')).toContainText(/no data/i);
  await visitor.context().close();
  await page.context().close();
});

/** Founder `key` on the console's incident desk, in a context of its own. */
async function incidentDesk(browser, key) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, key);
  await page.goto('/notify/incidents');
  await expect(page.getByRole('heading', { level: 1, name: 'Incidents' })).toBeVisible();
  return page;
}

const outcome = (page) => page.getByTestId('incident-desk-outcome');
const incidentCard = (page, title) => page.getByTestId('incident').filter({ has: page.getByRole('heading', { name: title }) });
const entry = (page, title, body) => incidentCard(page, title).getByTestId('incident-entry').filter({ hasText: body });
const readAgain = (page) => page.getByRole('button', { name: 'Read again' }).click();

/** The incident declared in #2 and carried through #3 and #4. */
const INCIDENT_TITLE = `${TEMPLATE.title} (run ${RUN})`;

/** A asks, B approves, A publishes one entry of the incident, all on the desk. */
async function publishEntry(a, b, body) {
  await entry(a, INCIDENT_TITLE, body).getByRole('button', { name: 'Ask for approval' }).click();
  await expect(outcome(a)).toContainText('Done: requested');
  await readAgain(b);
  await entry(b, INCIDENT_TITLE, body).getByRole('button', { name: 'Approve' }).click();
  await expect(outcome(b)).toContainText('Done: approved');
  await readAgain(a);
  await entry(a, INCIDENT_TITLE, body).getByRole('button', { name: 'Publish' }).click();
  await expect(outcome(a)).toContainText('Done: published');
  await expect(entry(a, INCIDENT_TITLE, body)).toHaveAttribute('data-status', 'published');
}

test(`${J} #2 declare an incident from a template: no template is supplied, the founder defines one and declares from it`, async ({
  browser,
}) => {
  const a = await incidentDesk(browser, 'a');
  // Start from no templates at all, so the picker shows that none is supplied (the ones found come back after the run).
  const templates = a.getByTestId('incident-templates');
  for (const row of await templates.locator('[data-testid^="incident-template-"]').all()) {
    const id = await row.getAttribute('data-testid');
    await row.getByRole('button', { name: 'Retire' }).click();
    await expect(templates.getByTestId(id)).toHaveCount(0);
  }
  await expect(templates.getByRole('button', { name: 'Retire' })).toHaveCount(0);
  const declare = a.getByTestId('incident-declare');
  await expect(declare.getByTestId('incident-templates-none')).toBeVisible();
  await expect(declare.getByLabel('Template').locator('option')).toHaveText(['No templates']);
  await expect(declare.getByLabel('Title')).toHaveValue('');
  await expect(declare.getByLabel('First update')).toHaveValue('');

  // The founder's own wording, naming the component it affects.
  await templates.getByLabel('Template id (lowercase, digits, dashes)').fill(TEMPLATE.id);
  await templates.getByLabel('Name').fill(TEMPLATE.name);
  await templates.getByLabel('Group (optional)').fill(TEMPLATE.group);
  await templates.getByLabel('Incident title').fill(TEMPLATE.title);
  await templates.getByLabel('First update').fill(TEMPLATE.body);
  await templates.getByLabel('Impact').selectOption('minor');
  await templates.getByRole('checkbox', { name: 'Payments' }).check();
  await templates.getByRole('button', { name: 'Save template' }).click();
  await expect(outcome(a)).toContainText('Done: template saved');
  await expect(templates.getByTestId(`incident-template-${TEMPLATE.id}`)).toContainText(`${TEMPLATE.name} (${TEMPLATE.group})`);

  // Declared from the template: it fills the incident, and the founder names this run in the title.
  await declare.getByLabel('Template').selectOption({ label: TEMPLATE.name });
  await expect(declare.getByLabel('Title')).toHaveValue(TEMPLATE.title);
  await expect(declare.getByLabel('First update')).toHaveValue(TEMPLATE.body);
  await expect(declare.getByLabel('Impact')).toHaveValue('minor');
  await expect(declare.getByRole('checkbox', { name: 'Payments' })).toBeChecked();
  await expect(declare.getByRole('checkbox', { name: 'API' })).not.toBeChecked();
  await declare.getByLabel('Title').fill(INCIDENT_TITLE);
  await declare.getByRole('button', { name: 'Save draft' }).click();
  await expect(outcome(a)).toContainText('Done: drafted');
  const card = incidentCard(a, INCIDENT_TITLE);
  await expect(card).toHaveAttribute('data-state', 'draft');
  await expect(card).toContainText('Impact: Minor. Components: Payments.');
  await expect(entry(a, INCIDENT_TITLE, TEMPLATE.body)).toHaveAttribute('data-status', 'draft');
  // A draft is not public.
  expect((await statusRead()).incidents.some((i) => i.title === INCIDENT_TITLE)).toBe(false);
  await a.context().close();
});

test(`${J} #3 a second founder approves, the approver cannot also publish, and the published incident is on /status`, async ({
  browser,
}) => {
  const a = await incidentDesk(browser, 'a');
  const b = await incidentDesk(browser, 'b');
  const first = (page) => entry(page, INCIDENT_TITLE, TEMPLATE.body);

  await first(a).getByRole('button', { name: 'Ask for approval' }).click();
  await expect(outcome(a)).toContainText('Done: requested');
  await expect(first(a).getByTestId('incident-approval')).toHaveAttribute('data-status', 'PENDING');
  await expect(first(a)).toContainText('asked by you');

  // The founder who asked cannot approve: identity refuses.
  await first(a).getByRole('button', { name: 'Approve' }).click();
  await expect(outcome(a)).toHaveAttribute('data-code', 'action_approval.same_person');
  await expect(first(a).getByTestId('incident-approval')).toHaveAttribute('data-status', 'PENDING');

  // B approves. The desk offers B no Publish (the founder who asked publishes), and svc-notify refuses B if B tries
  // anyway with the approval: the approver cannot also publish, and the approval is spent.
  await readAgain(b);
  await expect(first(b)).toContainText('asked by another founder');
  await first(b).getByRole('button', { name: 'Approve' }).click();
  await expect(outcome(b)).toContainText('Done: approved');
  await expect(first(b).getByTestId('incident-approval')).toHaveAttribute('data-status', 'APPROVED');
  await expect(first(b)).toContainText('Approved by you. The founder who asked publishes it');
  await expect(first(b).getByRole('button', { name: 'Publish' })).toHaveCount(0);
  await readAgain(a);
  const approval = first(a).getByTestId('incident-approval');
  await expect(approval).toHaveAttribute('data-status', 'APPROVED');
  const held = {
    id: await incidentCard(a, INCIDENT_TITLE).getAttribute('data-incident-id'),
    approvalId: await approval.getAttribute('data-approval-id'),
    operationId: await approval.getAttribute('data-operation-id'),
  };
  expect(await publishAs('b', held)).toBe('notify.notice_publish_same_operator');
  await readAgain(a);
  await expect(first(a)).toHaveAttribute('data-status', 'draft');
  await expect(first(a)).toContainText('The last approval is consumed.');
  expect((await statusRead()).incidents.some((i) => i.title === INCIDENT_TITLE)).toBe(false);

  // Asked again, approved by B, published by A.
  await publishEntry(a, b, TEMPLATE.body);
  await expect(incidentCard(a, INCIDENT_TITLE)).toHaveAttribute('data-state', 'open');

  // The visitor sees it on /status with its first update, and the component it names follows its impact.
  const page = await statusRead();
  const published = page.incidents.find((i) => i.title === INCIDENT_TITLE);
  expect(published).toMatchObject({ impact: 'minor', components: ['payments'], resolvedAt: null });
  expect(page.components.find((c) => c.id === 'payments')).toMatchObject({ state: 'degraded', incidentId: published.id });
  const visitor = await browser.newPage({ baseURL: ORIGIN });
  await visitor.goto('/status');
  const shown = visitor.getByTestId(`status-incident-${published.id}`);
  await expect(shown).toContainText(INCIDENT_TITLE);
  await expect(shown).toContainText(TEMPLATE.body);
  await expect(visitor.getByTestId('status-component-payments')).toHaveAttribute('data-state', 'degraded');
  await visitor.context().close();
  await a.context().close();
  await b.context().close();
});

test(`${J} #4 post updates, then resolve: the component goes back to its own status, and a resolved incident takes no update`, async ({
  browser,
}) => {
  const a = await incidentDesk(browser, 'a');
  const b = await incidentDesk(browser, 'b');
  const card = incidentCard(a, INCIDENT_TITLE);
  const update = card.getByTestId('incident-update');
  const UPDATE = `TEST A fix is deployed and we are watching (run ${RUN}).`;
  const RESOLVED = `TEST Card payments are back to normal (run ${RUN}).`;

  await update.getByLabel('Update', { exact: true }).fill(UPDATE);
  await update.getByLabel('Impact now').selectOption('minor');
  await update.getByRole('button', { name: 'Save update draft' }).click();
  await expect(outcome(a)).toContainText('Done: drafted');
  await publishEntry(a, b, UPDATE);
  await expect(card).toHaveAttribute('data-state', 'open');

  await update.getByLabel('Update', { exact: true }).fill(RESOLVED);
  await update.getByRole('checkbox', { name: /resolves the incident/ }).check();
  await update.getByRole('button', { name: 'Save update draft' }).click();
  await expect(outcome(a)).toContainText('Done: drafted');
  await expect(entry(a, INCIDENT_TITLE, RESOLVED)).toContainText('resolves the incident');
  await publishEntry(a, b, RESOLVED);
  await expect(card).toHaveAttribute('data-state', 'resolved');
  await expect(card).toContainText('Resolved, and final.');
  await expect(card.getByTestId('incident-update')).toHaveCount(0);

  // On /status: resolved, with its whole timeline, and the component no longer follows it.
  const page = await statusRead();
  const resolved = page.incidents.find((i) => i.title === INCIDENT_TITLE);
  expect(resolved.resolvedAt).not.toBeNull();
  expect(resolved.updates.map((u) => u.body)).toEqual(expect.arrayContaining([TEMPLATE.body, UPDATE, RESOLVED]));
  const payments = page.components.find((c) => c.id === 'payments');
  expect(payments.incidentId).toBeNull();
  expect(payments.basis).not.toBe('incident');
  const visitor = await browser.newPage({ baseURL: ORIGIN });
  await visitor.goto('/status');
  const shown = visitor.getByTestId(`status-incident-${resolved.id}`);
  for (const body of [TEMPLATE.body, UPDATE, RESOLVED]) await expect(shown).toContainText(body);
  await expect(shown).toContainText(/resolved/i);
  await expect(visitor.getByTestId('status-component-payments')).toHaveAttribute('data-state', payments.state);
  await visitor.context().close();

  // An update after resolve is refused by svc-notify, not only hidden by the desk.
  await expect(
    draftNotice({
      kind: 'incident',
      title: INCIDENT_TITLE,
      body: 'TEST One more update',
      minutes: 5,
      key: `j19-after-resolve:${RUN}`,
      parentId: resolved.id,
    }),
  ).rejects.toThrow(/notify\.notice_incident_resolved/);
  await a.context().close();
  await b.context().close();
});

/** TEST subscription safeguards: proof-of-work strength (leading zero bits) and subscribe requests per address per hour. */
const TEST_SAFEGUARDS = { challengeBits: 12, subscribeRatePerHour: 5 };
const SUBSCRIBER = `j19-${RUN}@example.com`;
const IMPORTED = [`j19-a-${RUN}@example.com`, `j19-b-${RUN}@example.com`];

/** Founder A on the console's subscriber desk, in a context of its own. */
async function subscriberDesk(browser) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, 'a');
  await page.goto('/notify/subscribers');
  await expect(page.getByRole('heading', { level: 1, name: 'Status subscribers' })).toBeVisible();
  return page;
}

/** Status mail to `email` once there are `count` messages; fan-out runs just after the publish answers. */
async function statusMailAtLeast(email, count, waitMs = 15_000) {
  const until = Date.now() + waitMs;
  for (;;) {
    const mail = statusMail(email);
    if (mail.length >= count || Date.now() >= until) return mail;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const deskOutcome = (page) => page.getByTestId('subscriber-desk-outcome');

test(`${J} #5 subscriber delivery: one row per subscriber and channel however often it is sent, and the channels with no sender named`, async ({
  browser,
}) => {
  await configureStatusPage(TEST_SAFEGUARDS, `TEST journey ${J} #5: subscription safeguards`);
  // A visitor subscribes on /status to every component and confirms by the emailed link.
  const visitor = await browser.newPage({ baseURL: ORIGIN });
  await visitor.goto('/status');
  const form = visitor.getByTestId('status-subscribe');
  await form.getByLabel('Email address').fill(SUBSCRIBER);
  await form.getByRole('button', { name: 'Subscribe' }).click();
  await expect(form.getByTestId('status-subscribe-sent')).toContainText('Check your inbox');
  const [confirm] = statusMail(SUBSCRIBER);
  await visitor.goto(/(\/status\/confirm\?token=\S+)/.exec(confirm.text)[1]);
  await visitor.getByRole('button', { name: 'Confirm' }).click();
  await expect(visitor.getByTestId('status-subscription-state')).toHaveText('Active');
  await visitor.context().close();

  const key = `j19-delivery:${RUN}`;
  const notice = await publishNotice(
    await draftNotice({
      kind: 'incident',
      title: `${INCIDENT_PREFIX} delivery check (run ${RUN})`,
      body: 'TEST Checking delivery to subscribers.',
      minutes: 15,
      key,
      impact: 'minor',
      components: ['api'],
    }),
    key,
  );
  const updates = () => statusMail(SUBSCRIBER).filter((m) => m.subject === `Status update: ${notice.title}`);
  await statusMailAtLeast(SUBSCRIBER, 2);
  expect(updates()).toHaveLength(1);

  const page = await subscriberDesk(browser);
  const channels = page.getByTestId('subscriber-channels');
  await expect(channels.getByTestId('subscriber-channel-email')).toContainText('LOCAL TEST outbox');
  await expect(channels.getByTestId('subscriber-channel-sms')).toContainText('vendor.sms');
  await expect(channels.getByTestId('subscriber-channel-push')).toContainText('vendor.push');

  const deliveries = page.getByTestId('subscriber-deliveries');
  await deliveries.getByLabel('Published notice').selectOption(notice.id);
  const mine = deliveries.locator(`[data-testid="subscriber-delivery"][data-email="${SUBSCRIBER}"]`);
  await expect(mine).toHaveCount(1);
  await expect(mine).toHaveAttribute('data-channel', 'email');
  await expect(mine).toHaveAttribute('data-status', 'accepted');

  // The fan-out runs twice more: still one row per subscriber and channel, still one message.
  for (let i = 0; i < 2; i += 1) {
    await deliveries.getByRole('button', { name: 'Send again' }).click();
    await expect(deskOutcome(page)).toContainText('Done: sent again');
  }
  await expect(mine).toHaveCount(1);
  await expect(mine).toHaveAttribute('data-status', 'accepted');
  await expect(mine.locator('td').nth(4)).toHaveText('1');
  const pairs = await deliveries
    .getByTestId('subscriber-delivery')
    .evaluateAll((rows) => rows.map((r) => `${r.getAttribute('data-email')}|${r.getAttribute('data-channel')}`));
  expect(new Set(pairs).size).toBe(pairs.length);
  expect(updates()).toHaveLength(1);

  const listed = page.locator(`[data-testid="subscriber-row"][data-email="${SUBSCRIBER}"]`);
  await expect(listed).toHaveAttribute('data-state', 'active');
  await expect(listed).toContainText('The /status form');
  await page.context().close();
  // The subscriber leaves by the link in the update, so later runs do not keep mailing it.
  const leave = await browser.newPage({ baseURL: ORIGIN });
  await leave.goto(/(\/status\/unsubscribe\?token=\S+)/.exec(updates()[0].text)[1]);
  await leave.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(leave.getByTestId('status-subscription-left')).toBeVisible();
  await leave.context().close();
});

test(`${J} #6 subscriber safeguards: a blank rate limit refuses, and an import with a duplicate address makes one record`, async ({
  browser,
}) => {
  const page = await subscriberDesk(browser);
  const safeguards = page.getByTestId('subscriber-safeguards');
  const importer = page.getByTestId('subscriber-import');
  const importList = async (text) => {
    await importer.getByLabel(/^Source/).fill('j19-test');
    await importer.getByLabel(/^Addresses/).fill(text);
    await importer.getByRole('button', { name: 'Import' }).click();
  };
  const list = `${IMPORTED[0]}\n${IMPORTED[0].toUpperCase()}, ${IMPORTED[1]}`;

  // The owner blanks the rate limit: subscribing on /status and imports refuse.
  await safeguards.getByLabel('Subscribe requests per address per hour').fill('');
  await safeguards.getByLabel('Reason').fill(`TEST journey ${J} #6: blank rate limit`);
  await safeguards.getByRole('button', { name: 'Save safeguards' }).click();
  await expect(deskOutcome(page)).toContainText('Done: safeguards saved');
  await expect(safeguards.getByTestId('subscriber-safeguards-now')).toContainText('Subscribe requests per address: blank');
  const visitor = await browser.newPage({ baseURL: ORIGIN });
  await visitor.goto('/status');
  await expect(visitor.getByTestId('status-subscribe')).toContainText('status.rate_limit_unset');
  await visitor.context().close();
  await importList(list);
  await expect(deskOutcome(page)).toHaveAttribute('data-code', 'status.rate_limit_unset');
  await expect(page.locator(`[data-testid="subscriber-row"][data-email="${IMPORTED[0]}"]`)).toHaveCount(0);

  // With the limit set again, the import folds the duplicate into one record, and importing again adds nothing.
  await safeguards.getByLabel('Subscribe requests per address per hour').fill(String(TEST_SAFEGUARDS.subscribeRatePerHour));
  await safeguards.getByLabel('Reason').fill(`TEST journey ${J} #6: rate limit set again`);
  await safeguards.getByRole('button', { name: 'Save safeguards' }).click();
  await expect(deskOutcome(page)).toContainText('Done: safeguards saved');
  // The refused list is still there to import again, previewed before it is sent.
  await expect(importer.getByTestId('subscriber-import-preview')).toContainText('3 lines, 2 distinct');
  await importList(list);
  await expect(deskOutcome(page).getByTestId('subscriber-import-result')).toContainText(
    '3 received, 2 distinct addresses: 2 added, 0 already known',
  );
  await page.getByTestId('subscriber-list').getByLabel('State').selectOption('unconfirmed');
  for (const email of IMPORTED) {
    const row = page.locator(`[data-testid="subscriber-row"][data-email="${email}"]`);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Import: j19-test');
    await expect(row).toHaveAttribute('data-state', 'unconfirmed');
  }
  await importList(list);
  await expect(deskOutcome(page).getByTestId('subscriber-import-result')).toContainText('2 distinct addresses: 0 added, 2 already known');
  await expect(page.locator(`[data-testid="subscriber-row"][data-email="${IMPORTED[0]}"]`)).toHaveCount(1);
  // One confirmation each, and nothing else until it is opened.
  for (const email of IMPORTED) expect(statusMail(email).map((m) => m.subject)).toEqual(['Confirm your status updates']);
  await page.context().close();
});

test(`${J} #7 a postmortem: refused on an incident still open, then written, approved and published on the resolved one`, async ({
  browser,
}) => {
  const a = await incidentDesk(browser, 'a');
  const b = await incidentDesk(browser, 'b');
  const postmortem = (page, title) => incidentCard(page, title).getByTestId('incident-postmortem');
  const POSTMORTEM = `TEST A configuration change slowed card payments; it is rolled back and now checked before release (run ${RUN}).`;

  // An incident still open: the form is there, and svc-notify refuses the postmortem until a published update resolves it.
  const OPEN_TITLE = `${INCIDENT_PREFIX} still open for the postmortem refusal (run ${RUN})`;
  const open = await publishNotice(
    await draftNotice({ kind: 'incident', title: OPEN_TITLE, body: 'TEST Looking into it.', minutes: 5, key: `j19-open:${RUN}` }),
    `j19-open:${RUN}`,
  );
  await readAgain(a);
  await expect(incidentCard(a, OPEN_TITLE)).toHaveAttribute('data-state', 'open');
  await expect(postmortem(a, OPEN_TITLE)).toContainText('once a published update has resolved the incident');
  await postmortem(a, OPEN_TITLE).getByRole('textbox').fill('TEST Written too early.');
  await postmortem(a, OPEN_TITLE).getByRole('button', { name: 'Save postmortem draft' }).click();
  await expect(outcome(a)).toHaveAttribute('data-code', 'status.postmortem_requires_resolved');
  await expect(outcome(a)).toContainText('The incident is not resolved yet');
  await expect(postmortem(a, OPEN_TITLE)).toHaveAttribute('data-status', 'none');
  await expect(postmortem(a, OPEN_TITLE).getByRole('textbox')).toHaveValue('TEST Written too early.');

  // The incident #4 resolved: written by A, asked for by A, approved by B, published by A.
  const section = postmortem(a, INCIDENT_TITLE);
  await expect(section).toHaveAttribute('data-status', 'none');
  await expect(section).toContainText('No postmortem is written yet.');
  await section.getByRole('textbox').fill(POSTMORTEM);
  await section.getByRole('button', { name: 'Save postmortem draft' }).click();
  await expect(outcome(a)).toContainText('Done: postmortem saved');
  await expect(section).toHaveAttribute('data-status', 'draft');
  await expect(section).toContainText('Draft, version 1, last written by you');
  expect((await publishedPostmortems()).some((p) => p.body === POSTMORTEM)).toBe(false);

  await section.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(outcome(a)).toContainText('Done: requested');
  await expect(section.getByTestId('postmortem-approval')).toHaveAttribute('data-status', 'PENDING');
  await readAgain(b);
  await postmortem(b, INCIDENT_TITLE).getByRole('button', { name: 'Approve' }).click();
  await expect(outcome(b)).toContainText('Done: approved');
  await expect(postmortem(b, INCIDENT_TITLE)).toContainText('Approved by you. The founder who asked publishes it');
  await expect(postmortem(b, INCIDENT_TITLE).getByRole('button', { name: 'Publish' })).toHaveCount(0);
  await readAgain(a);
  await expect(section.getByTestId('postmortem-approval')).toHaveAttribute('data-status', 'APPROVED');
  await section.getByRole('button', { name: 'Publish' }).click();
  await expect(outcome(a)).toContainText('Done: postmortem published');
  await expect(section).toHaveAttribute('data-status', 'published');
  await expect(section.getByTestId('postmortem-body')).toHaveText(POSTMORTEM);
  await expect(section.getByRole('textbox')).toHaveCount(0);

  // Published for visitors (the signed-out read), named by the resolved incident, with no author on it.
  const resolved = (await statusRead()).incidents.find((i) => i.title === INCIDENT_TITLE);
  const published = (await publishedPostmortems()).find((p) => p.incidentId === resolved.id);
  expect(published).toMatchObject({ body: POSTMORTEM, version: 1, publishedAt: expect.any(String) });
  expect(published).not.toHaveProperty('writtenBy');
  // A signed-out visitor reads it on /status under its incident; the open incident shows none.
  const visitor = await browser.newPage({ baseURL: ORIGIN });
  await visitor.goto('/status');
  await expect(visitor.getByTestId(`status-postmortem-${resolved.id}`)).toContainText(POSTMORTEM);
  await expect(visitor.getByTestId(`status-postmortem-${resolved.id}`)).toContainText('Postmortem');
  await expect(visitor.getByTestId(`status-incident-${open.id}`)).toBeVisible();
  await expect(visitor.getByTestId(`status-postmortem-${open.id}`)).toHaveCount(0);
  await visitor.context().close();

  // The open one is resolved again here, so the run leaves nothing open.
  await publishNotice(
    await draftNotice({
      kind: 'incident',
      title: OPEN_TITLE,
      body: 'TEST Resolved.',
      minutes: 5,
      key: `j19-open-resolve:${RUN}`,
      parentId: open.id,
      resolves: true,
    }),
    `j19-open-resolve:${RUN}`,
  );
  await a.context().close();
  await b.context().close();
});

/** Founder `key` on the console's maintenance desk, in UTC so the window's times are typed as they are stored. */
async function maintenanceDesk(browser, key) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
  const page = await context.newPage();
  await founderSignIn(page, key);
  await page.goto('/notify/maintenance');
  await expect(page.getByRole('heading', { level: 1, name: 'Maintenance' })).toBeVisible();
  return page;
}

const maintenanceOutcome = (page) => page.getByTestId('maintenance-desk-outcome');
const maintenanceWindow = (page, title) =>
  page.getByTestId('maintenance-window').filter({ has: page.getByRole('heading', { name: title }) });
/** An instant as a `datetime-local` value in UTC, to the minute. */
const localUtc = (ms) => new Date(ms).toISOString().slice(0, 16);

test(`${J} #8 a maintenance window: scheduled, in progress from its start, verified and completed, a reopen refused, one reminder per offset`, async ({
  browser,
}) => {
  test.setTimeout(8 * 60_000);
  // A subscriber who gets the reminders, confirmed by the emailed link, as in #5.
  const READER = `j19-maint-${RUN}@example.com`;
  await configureStatusPage(TEST_SAFEGUARDS, `TEST journey ${J} #8: subscription safeguards`);
  const visitor = await browser.newPage({ baseURL: ORIGIN });
  await visitor.goto('/status');
  const form = visitor.getByTestId('status-subscribe');
  await form.getByLabel('Email address').fill(READER);
  await form.getByRole('button', { name: 'Subscribe' }).click();
  await expect(form.getByTestId('status-subscribe-sent')).toContainText('Check your inbox');
  await visitor.goto(/(\/status\/confirm\?token=\S+)/.exec(statusMail(READER)[0].text)[1]);
  await visitor.getByRole('button', { name: 'Confirm' }).click();
  await expect(visitor.getByTestId('status-subscription-state')).toHaveText('Active');

  const a = await maintenanceDesk(browser, 'a');
  const b = await maintenanceDesk(browser, 'b');
  const schedule = a.getByTestId('maintenance-schedule');
  const TITLE = `TEST journey ${J}: card payments upgrade (run ${RUN})`;
  // Starts three whole minutes from now, so two reminders (2 and 1 minute before) come due while it is scheduled.
  const start = Math.ceil(Date.now() / 60_000) * 60_000 + 3 * 60_000;

  // With no offsets, none: a draft written without them lists no reminder.
  const QUIET = `TEST journey ${J}: no reminders (run ${RUN})`;
  await schedule.getByLabel('Title').fill(QUIET);
  await schedule.getByLabel('What happens').fill('TEST A window with no reminders.');
  await schedule.getByLabel('Starts').fill(localUtc(start + 60 * 60_000));
  await schedule.getByLabel('Planned end').fill(localUtc(start + 90 * 60_000));
  await schedule.getByRole('button', { name: 'Save draft' }).click();
  await expect(maintenanceOutcome(a)).toContainText('Done: drafted');
  await expect(maintenanceWindow(a, QUIET).getByTestId('maintenance-reminders')).toHaveText('No reminders.');

  await schedule.getByLabel('Title').fill(TITLE);
  await schedule.getByLabel('What happens').fill('TEST We upgrade the card payment service.');
  await schedule.getByLabel('Starts').fill(localUtc(start));
  await schedule.getByLabel('Planned end').fill(localUtc(start + 30 * 60_000));
  await schedule.getByRole('checkbox', { name: 'Payments' }).check();
  await schedule.getByLabel('Reminders, minutes before the start').fill('1, 2');
  await schedule.getByRole('button', { name: 'Save draft' }).click();
  await expect(maintenanceOutcome(a)).toContainText('Done: drafted');
  const card = maintenanceWindow(a, TITLE);
  await expect(card).toHaveAttribute('data-state', 'draft');
  await expect(card.getByTestId('maintenance-reminder')).toHaveText([
    '2 minutes before: after it is published',
    '1 minute before: after it is published',
  ]);

  // A asks, B approves, A publishes.
  await card.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(maintenanceOutcome(a)).toContainText('Done: requested');
  await b.getByRole('button', { name: 'Read again' }).click();
  await maintenanceWindow(b, TITLE).getByRole('button', { name: 'Approve' }).click();
  await expect(maintenanceOutcome(b)).toContainText('Done: approved');
  await expect(maintenanceWindow(b, TITLE).getByRole('button', { name: 'Publish' })).toHaveCount(0);
  await a.getByRole('button', { name: 'Read again' }).click();
  await card.getByRole('button', { name: 'Publish' }).click();
  await expect(maintenanceOutcome(a)).toContainText('Done: published');
  await expect(card).toHaveAttribute('data-state', 'scheduled');
  const id = await card.getAttribute('data-window-id');

  // Scheduled: it cannot be verified before it has started.
  await card.getByLabel('Reason for a move').fill('TEST checking early');
  await card.getByRole('button', { name: 'Mark verifying' }).click();
  await expect(maintenanceOutcome(a)).toHaveAttribute('data-code', 'status.maintenance_illegal_move');
  await expect(card).toHaveAttribute('data-state', 'scheduled');

  // Each reminder goes out once, before the start.
  const reminders = () => statusMail(READER).filter((m) => m.subject === `Scheduled maintenance: ${TITLE}`);
  await expect
    .poll(
      async () => {
        await a.getByRole('button', { name: 'Read again' }).click();
        return card.locator('[data-testid="maintenance-reminder"][data-sent="yes"]').count();
      },
      { timeout: 4 * 60_000, intervals: [10_000] },
    )
    .toBe(2);
  expect(reminders()).toHaveLength(2);
  expect(reminders().every((m) => m.text.includes(new Date(start).toISOString()))).toBe(true);

  // In progress from its start, and the component it touches shows maintenance on /status.
  await expect
    .poll(
      async () => {
        await a.getByRole('button', { name: 'Read again' }).click();
        return card.getAttribute('data-state');
      },
      { timeout: 3 * 60_000, intervals: [10_000] },
    )
    .toBe('in_progress');
  expect((await statusRead()).components.find((c) => c.id === 'payments')).toMatchObject({ state: 'maintenance' });
  expect(reminders()).toHaveLength(2);

  // Verified, then completed; a reopen is refused; it leaves the open maintenance at once.
  await card.getByLabel('Reason for a move').fill('TEST upgrade applied, checking payments');
  await card.getByRole('button', { name: 'Mark verifying' }).click();
  await expect(maintenanceOutcome(a)).toContainText('Done: moved to verifying');
  await expect(card).toHaveAttribute('data-state', 'verifying');
  await card.getByLabel('Reason for a move').fill('TEST payments checked');
  await card.getByRole('button', { name: 'Mark completed' }).click();
  await expect(maintenanceOutcome(a)).toContainText('Done: moved to completed');
  await expect(card).toHaveAttribute('data-state', 'completed');
  await expect(card.getByTestId('maintenance-moves')).toContainText('TEST payments checked');
  await card.getByLabel('Reason for a move').fill('TEST reopen');
  await card.getByRole('button', { name: 'Reopen' }).click();
  await expect(maintenanceOutcome(a)).toHaveAttribute('data-code', 'status.maintenance_reopen_refused');
  await expect(card).toHaveAttribute('data-state', 'completed');
  const page = await statusRead();
  expect(page.components.find((c) => c.id === 'payments').state).not.toBe('maintenance');
  expect((await openNotices()).maintenance.some((m) => m.id === id)).toBe(false);
  expect(reminders()).toHaveLength(2);

  // The reader leaves by the link in a reminder.
  await visitor.goto(/(\/status\/unsubscribe\?token=\S+)/.exec(reminders()[0].text)[1]);
  await visitor.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(visitor.getByTestId('status-subscription-left')).toBeVisible();
  await visitor.context().close();
  await a.context().close();
  await b.context().close();
});

/** Founder `key` on the console's announcement desk. */
async function noticesDesk(browser, key) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, key);
  await page.goto('/notify/notices');
  await expect(page.getByRole('heading', { level: 1, name: 'Announcements' })).toBeVisible();
  return page;
}

const noticesOutcome = (page) => page.getByTestId('notices-desk-outcome');
const noticeCard = (page, title) => page.getByTestId('notice-card').filter({ has: page.getByRole('heading', { name: title }) });

test(`${J} #9 an announcement with a kind and a category: off the list refused, then published once with both`, async ({ browser }) => {
  const before = (await statusDefinition()).noticeCategories ?? null;
  const a = await noticesDesk(browser, 'a');
  const b = await noticesDesk(browser, 'b');
  try {
    // The founders' category list, an owner value: labelled TEST here and put back as it was at the end.
    const categories = a.getByTestId('notice-categories');
    await categories
      .getByLabel('One per line, as id: Name (blank clears the list)')
      .fill('j19-listings: TEST new listings\nj19-risk: TEST risk notices');
    await categories.getByLabel('Reason for the change').fill(`TEST journey ${J} #9 categories`);
    await categories.getByRole('button', { name: 'Save categories' }).click();
    await expect(noticesOutcome(a)).toContainText('Done: categories saved');
    await expect(a.getByTestId('notice-categories-list')).toContainText('TEST new listings');

    // A category off the list is refused by svc-notify, whoever sends it.
    await expect(
      draftNotice({
        kind: 'announcement',
        title: 'TEST off the list',
        body: 'TEST',
        minutes: 5,
        key: `j19-cat-off:${RUN}`,
        category: 'j19-delistings',
      }),
    ).rejects.toThrow(/status\.category_unknown/);

    const TITLE = `TEST journey ${J}: a new market opens (run ${RUN})`;
    const draft = a.getByTestId('notice-draft');
    await draft.getByLabel('Title').fill(TITLE);
    await draft.getByLabel('Message').fill('TEST The TEST/USDT market opens on Monday.');
    await draft.getByLabel('Category').selectOption({ label: 'TEST new listings' });
    await draft.getByRole('button', { name: 'Save draft' }).click();
    await expect(noticesOutcome(a)).toContainText('Done: drafted');
    const card = noticeCard(a, TITLE);
    await expect(card).toHaveAttribute('data-status', 'draft');
    await expect(card.getByTestId('notice-filing')).toContainText('Kind: announcement. Category: TEST new listings.');
    expect((await publishedNotices()).some((n) => n.title === TITLE)).toBe(false);

    await card.getByRole('button', { name: 'Ask for approval' }).click();
    await expect(noticesOutcome(a)).toContainText('Done: requested');
    await b.getByRole('button', { name: 'Read again' }).click();
    await noticeCard(b, TITLE).getByRole('button', { name: 'Approve' }).click();
    await expect(noticesOutcome(b)).toContainText('Done: approved');
    await expect(noticeCard(b, TITLE).getByRole('button', { name: 'Publish' })).toHaveCount(0);
    await a.getByRole('button', { name: 'Read again' }).click();
    await card.getByRole('button', { name: 'Publish' }).click();
    await expect(noticesOutcome(a)).toContainText('Done: published');
    await expect(card).toHaveAttribute('data-status', 'published');

    // On the public board once, with its kind and the category as filed.
    const shown = (await publishedNotices()).filter((n) => n.title === TITLE);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ kind: 'announcement', category: { id: 'j19-listings', name: 'TEST new listings' } });

    // A signed-out visitor reads it on /notice, /announcement and its own page, filed under its category.
    const visitor = await browser.newPage({ baseURL: ORIGIN });
    try {
      for (const path of ['/notice', '/announcement', `/notice/${shown[0].id}`]) {
        await visitor.goto(path);
        const entry = visitor.getByTestId(`notice-${shown[0].id}`);
        await expect(entry).toContainText(TITLE);
        await expect(entry.getByTestId('notice-category')).toHaveText('TEST new listings');
      }
    } finally {
      await visitor.context().close();
    }
  } finally {
    const now = await statusDefinition();
    if (JSON.stringify(now.noticeCategories ?? null) !== JSON.stringify(before))
      await configureStatusPage({ noticeCategories: before }, `TEST journey ${J} #9: categories put back`);
    await a.context().close();
    await b.context().close();
  }
});

test(`${J} #10 the badge page: an image link, HTML and Markdown snippet per component, on the public site`, async ({ browser }) => {
  const page = await statusDesk(browser);
  const badges = page.getByTestId('status-badges');
  await expect(badges.getByRole('heading', { name: 'Badges' })).toBeVisible();
  await expect(badges.getByTestId('status-badges-no-origin')).toHaveCount(0);
  const defined = (await statusDefinition()).components;
  expect(defined.map((c) => c.id)).toEqual(COMPONENTS.map((c) => c.id));
  for (const c of [{ id: null, name: 'Whole page' }, ...defined]) {
    const block = badges.getByTestId(`status-badge-${c.id ?? 'page'}`);
    const image = `${ORIGIN}/api/notify/status/badge.svg${c.id ? `?component=${c.id}` : ''}`;
    await expect(block.getByTestId('status-badge-image')).toHaveValue(image);
    await expect(block.getByTestId('status-badge-html')).toHaveValue(
      `<a href="${ORIGIN}/status"><img src="${image}" alt="${c.id ? c.name : 'Platform'} status"></a>`,
    );
    await expect(block.getByTestId('status-badge-markdown')).toHaveValue(
      `[![${c.id ? c.name : 'Platform'} status](${image})](${ORIGIN}/status)`,
    );
    // The link serves the badge the service draws, for exactly this component.
    const res = await fetch(image);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    if (c.id) expect(await res.text()).toContain(`<title>${c.name}: `);
  }
  // The desk opens the image on the public site (the console loads no image from another site).
  await expect(badges.getByTestId('status-badge-sms-gateway').getByRole('link', { name: 'Open the badge image' })).toHaveAttribute(
    'href',
    `${ORIGIN}/api/notify/status/badge.svg?component=sms-gateway`,
  );
  await page.context().close();
});
