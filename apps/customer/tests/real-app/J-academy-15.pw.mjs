// World: restart
import { createHash } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, journeyState, restartWith } from './stack.mjs';
import { signUp } from './desk.mjs';

// J-academy-15 "Enrol people in bulk, run cohorts, and send a course email", in the founder console (docs/roadmap/journeys.json).
// One test per live step, titled "J-academy-15 #<n>", run in order; #4 and #5 (cohorts) are parked until after launch.
// The operator is founder B in the console. The people are fresh TEST accounts signed up in the browser; the addresses
// with no account are TEST addresses under local-test.invalid that nobody holds. The course is Foundations. The stack
// sets TEST owner values (50 addresses an upload, 30 days inactive, exports kept 24 hours, 1000 rows an export); each
// blank branch restarts svc-academy with that value off and puts it back. #2 sets a TEST seat cap on Foundations and
// takes it off again.
const J = 'J-academy-15';
const RUN = `${process.env.JOURNEY_RUN_ID ?? 'local'}${Date.now().toString(36)}`;
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const COURSE = 'foundations';
const ENROLMENT = `${ADMIN}/academy-ops/programmes/enrolment`;

test.describe.configure({ mode: 'serial' });

function state(...keys) {
  const s = run.read();
  for (const k of keys) if (!s[k]) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
  return s;
}

const trpc = (procedure, input) =>
  `/api/academy/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;

/** Staff reads and set-up through Academy's own admin door as founder A, the same door the console uses. */
let staffDoor;
async function staff(kind, procedure, input) {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const sessions = await gates.approverSessions(ctx);
    return { ctx, token: await sessions.a.tradeOpsToken() };
  })();
  const { ctx, token } = await staffDoor;
  const res =
    kind === 'query' ? await ctx.edge.query('academy', procedure, input, token) : await ctx.edge.mutate('academy', procedure, input, token);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return JSON.parse(res.text).result.data;
}

/** A fresh TEST person with an account, signed up in their own browser; returns their address and account id. */
async function person(browser, prefix) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const who = await signUp(page, prefix);
  const userId = (await api(who)).userId;
  await context.close();
  return { ...who, userId };
}

/** The learner's own active enrolments, read from Academy with a session of their own. */
async function enrolledPaths(who) {
  const res = await (await api(who)).get(trpc('myEnrollments'));
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.map((row) => row.pathSlug);
}

test(`${J} #1 uploads 30 addresses to bulk enrol: each is enrolled or listed with its refusal, no mail, the same upload changes nothing, a blank row limit refuses`, async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const people = [];
  for (const prefix of ['ja15a', 'ja15b', 'ja15c']) people.push(await person(browser, prefix));
  // 30 addresses: the three people, 25 TEST addresses nobody holds, one that is not an address, and one repeat.
  const strangers = Array.from({ length: 25 }, (_, i) => `ja15-${RUN}-nobody-${i}@local-test.invalid`);
  const addresses = [...people.map((p) => p.email), ...strangers, 'not an address', people[0].email.toUpperCase()];
  expect(addresses).toHaveLength(30);
  run.reset({ people, strangers });

  const founder = await founderSignIn(page, 'b');
  await page.goto(ENROLMENT);
  const bulk = page.getByTestId('bulk-enrol');
  await expect(bulk.getByRole('heading', { name: 'Enrol people in bulk' })).toBeVisible({ timeout: 60_000 });
  const upload = async () => {
    await bulk.getByLabel('Course', { exact: true }).selectOption(COURSE);
    await bulk.getByLabel('Addresses, one per line').fill(addresses.join('\n'));
    await bulk.getByLabel('Reason for the bulk enrolment').fill(`TEST ${J}: cohort upload`);
    await bulk.getByRole('button', { name: 'Enrol everyone' }).click();
  };
  await upload();
  const result = bulk.getByTestId('bulk-result');
  await expect(result).toHaveAttribute('data-replayed', 'false', { timeout: 60_000 });
  await expect(result).toContainText('3 enrolled in Foundations.');
  await expect(result).toContainText('No mail was sent.');
  const rows = result.locator('tbody tr');
  await expect(rows).toHaveCount(30);
  // Each address answered, in the upload's order: the people enrolled, the rest with their refusal.
  for (const [i, p] of people.entries()) {
    await expect(rows.nth(i)).toHaveAttribute('data-address', p.email.toLowerCase());
    await expect(rows.nth(i)).toHaveAttribute('data-outcome', 'enrolled');
  }
  for (let i = 3; i < 28; i++) {
    await expect(rows.nth(i)).toHaveAttribute('data-outcome', 'refused');
    await expect(rows.nth(i)).toHaveAttribute('data-code', 'academy.learner_not_found');
  }
  await expect(rows.nth(28)).toHaveAttribute('data-code', 'academy.address_invalid');
  await expect(rows.nth(28)).toContainText('Not an email address.');
  await expect(rows.nth(29)).toHaveAttribute('data-code', 'academy.duplicate_address');
  for (const p of people) expect(await enrolledPaths(p)).toContain(COURSE);
  // The service's own record: the people enrolled by bulk upload, by this founder, and no mail.
  const events = (await staff('query', 'admin.staffEnrolments', { path: COURSE })).filter((e) => people.some((p) => p.userId === e.userId));
  expect(events.map((e) => [e.source, e.actorId]).sort()).toEqual(people.map(() => ['bulk', founder.userId]));

  // The same upload again: its stored answers, and nothing changes.
  await page.reload();
  await upload();
  await expect(result).toHaveAttribute('data-replayed', 'true', { timeout: 60_000 });
  await expect(result).toContainText('This upload was already made: these are its stored answers, and nothing was changed.');
  await expect(rows).toHaveCount(30);
  const again = (await staff('query', 'admin.staffEnrolments', { path: COURSE })).filter((e) => people.some((p) => p.userId === e.userId));
  expect(again).toEqual(events);

  // With the owner's row limit blank, an upload is refused with its code and changes nothing.
  restartWith('academy', 'LOCAL_STACK_ACADEMY_BULK_ENROL_ROWS', false);
  try {
    await page.reload();
    await bulk.getByLabel('Course', { exact: true }).selectOption(COURSE);
    await bulk.getByLabel('Addresses, one per line').fill(`ja15-${RUN}-blank@local-test.invalid`);
    await bulk.getByLabel('Reason for the bulk enrolment').fill(`TEST ${J}: blank limit`);
    await bulk.getByRole('button', { name: 'Enrol everyone' }).click();
    const refused = bulk.getByTestId('course-desk-outcome');
    await expect(refused).toHaveAttribute('data-code', 'academy.bulk_limit_unset', { timeout: 60_000 });
    await expect(refused).toContainText('Bulk upload limit not set');
    await expect(bulk.getByTestId('bulk-result')).toHaveCount(0);
  } finally {
    restartWith('academy', 'LOCAL_STACK_ACADEMY_BULK_ENROL_ROWS', true);
  }
});

test(`${J} #2 enrols someone into a full course: the event records the bypass and the reason`, async ({ page, browser }) => {
  test.setTimeout(300_000);
  state('people');
  const late = await person(browser, 'ja15d');
  run.write({ late });
  // Foundations full: a TEST cap of one seat, which its enrolled learners already take.
  await staff('mutation', 'admin.setCourseSeatCap', { slug: COURSE, seatCap: 1, reason: `TEST ${J}: full course` });
  try {
    // The person cannot enrol themselves: the course is full.
    const self = await (await api(late)).post(trpc('enrolCourse'), { slug: COURSE, track: 'audit' });
    expect(self.status, JSON.stringify(self.body).slice(0, 300)).not.toBe(200);
    expect(JSON.stringify(self.body)).toContain('academy.enrolment_closed');

    const founder = await founderSignIn(page, 'b');
    await page.goto(ENROLMENT);
    const one = page.getByTestId('staff-enrol');
    await expect(one.getByRole('heading', { name: 'Enrol one learner' })).toBeVisible({ timeout: 60_000 });
    const reason = `TEST ${J}: a bursary seat in a full course`;
    await one.getByLabel('Learner email or handle').fill(late.email);
    await one.getByLabel('Course', { exact: true }).selectOption(COURSE);
    await one.getByLabel('Reason for the enrolment').fill(reason);
    await one.getByRole('button', { name: 'Enrol learner' }).click();
    const done = one.getByTestId('staff-enrol-result');
    await expect(done).toHaveAttribute('data-outcome', 'enrolled', { timeout: 60_000 });
    await expect(done).toContainText('Went past: the course was full.');
    await expect(done).toContainText(reason);
    // The staff enrolments list shows the event: this learner, the bypass, the reason and who.
    const row = one.getByTestId('staff-enrolments').locator(`tr[data-learner="${late.userId}"]`);
    await expect(row).toHaveCount(1);
    await expect(row.locator('[data-bypassed]')).toHaveAttribute('data-bypassed', 'full');
    await expect(row).toContainText(reason);
    await expect(row).toContainText(founder.userId);
    await expect(row).toContainText('One learner');
    // The service's own record, and the learner is enrolled.
    const [event] = await staff('query', 'admin.staffEnrolments', { path: COURSE, userId: late.userId });
    expect(event).toMatchObject({ source: 'staff', bypassed: ['full'], reason, actorId: founder.userId });
    expect(event.key).toBe(`enrol:${COURSE}:${late.userId}:1`);
    expect(await enrolledPaths(late)).toContain(COURSE);
  } finally {
    await staff('mutation', 'admin.setCourseSeatCap', { slug: COURSE, seatCap: null, reason: `TEST ${J}: cap off again` });
  }
});

test(`${J} #3 invites an address that has no account: the invitation is stored and the mail step shows the email notice`, async ({
  page,
}) => {
  const address = `ja15-${RUN}-invited@local-test.invalid`;
  await founderSignIn(page, 'b');
  // Nobody holds the address: identity's exact lookup finds no account for it.
  await page.goto(`${ADMIN}/academy-ops/programmes/learners?q=${encodeURIComponent(address)}`);
  await expect(page.getByText(`No account has the email or handle “${address}”.`)).toBeVisible({ timeout: 60_000 });

  await page.goto(ENROLMENT);
  const invite = page.getByTestId('invitations');
  await expect(invite.getByRole('heading', { name: 'Invite an address' })).toBeVisible({ timeout: 60_000 });
  await invite.getByLabel('Address to invite').fill(address);
  await invite.getByLabel('Course', { exact: true }).selectOption(COURSE);
  await invite.getByLabel('Reason for the invitation').fill(`TEST ${J}: pre-registration`);
  await invite.getByRole('button', { name: 'Invite', exact: true }).click();
  const made = invite.getByTestId('invite-result');
  await expect(made).toContainText('Invitation stored.', { timeout: 60_000 });
  const mask = `j***@local-test.invalid`;
  await expect(made).toContainText(`${mask} to Foundations.`);
  const notice = made.getByTestId('mail-not-connected');
  await expect(notice).toHaveAttribute('data-not-connected', 'vendor.email');
  await expect(notice).toContainText('The invitation mail needs an email provider. It is switched off in this build.');
  // Stored: the list shows it, masked, with its mail state; the service keeps one invitation for the address.
  const key = await made.getAttribute('data-invitation');
  const row = invite.getByTestId('invitation-list').locator(`tr[data-invitation="${key}"]`);
  await expect(row).toContainText(mask);
  await expect(row.locator('[data-not-connected="vendor.email"]')).toContainText('Needs an email provider');
  const stored = (await staff('query', 'admin.courseInvitations', { path: COURSE })).filter((i) => i.key === key);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ addressMask: mask, mail: 'vendor.email', reason: `TEST ${J}: pre-registration` });
  expect(JSON.stringify(stored)).not.toContain(address);
});

test(`${J} #6 sends a bulk email to participants: a history row refused for the missing provider, nobody marked sent, opted-out learners skipped, a blank inactivity period refuses`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { people } = state('people');
  // The second person opts out of Foundations email, with their own session.
  const off = await (await api(people[1])).post(trpc('setCourseEmails'), { slug: COURSE, on: false });
  expect(off.status, JSON.stringify(off.body).slice(0, 300)).toBe(200);

  await founderSignIn(page, 'b');
  await page.goto(`${ADMIN}/academy-ops/programmes/mail`);
  const desk = page.getByTestId('mail-desk');
  await expect(desk.getByRole('heading', { name: 'Course email' })).toBeVisible({ timeout: 60_000 });
  const subject = `TEST ${J} ${RUN}: this week's lesson`;
  const send = async (title) => {
    await desk.getByLabel('Course', { exact: true }).selectOption(COURSE);
    await desk.getByLabel('Subject', { exact: true }).fill(title);
    await desk.getByLabel('Message', { exact: true }).fill(`TEST ${J}: keep going.`);
    await desk.getByRole('button', { name: 'Send to participants' }).click();
  };
  await send(subject);
  const row = desk.getByTestId('mail-history').locator('tr', { hasText: subject });
  await expect(row).toHaveCount(1, { timeout: 60_000 });
  await expect(row).toHaveAttribute('data-state', 'refused');
  await expect(row).toHaveAttribute('data-refusal', 'vendor.email');
  await expect(row).toContainText('Refused: needs an email provider (vendor.email)');
  await expect(desk.getByTestId('mail-not-connected').first()).toContainText(
    'Sending a course email needs an email provider. It is switched off in this build.',
  );
  const id = await row.getAttribute('data-email');
  const recipients = desk.getByTestId('mail-recipients');
  await expect(recipients).toHaveAttribute('data-email', id, { timeout: 60_000 });
  await expect(recipients.locator(`tr[data-learner="${people[0].userId}"]`)).toHaveAttribute('data-state', 'not_sent');
  await expect(recipients.locator(`tr[data-learner="${people[1].userId}"]`)).toHaveAttribute('data-state', 'skipped_opted_out');
  await expect(recipients.locator(`tr[data-learner="${people[1].userId}"]`)).toContainText('Left out: opted out of this course’s email');
  await expect(recipients.locator('tr[data-state="sent"]')).toHaveCount(0);
  // The service's own record: refused, nobody sent, the opted-out learner skipped.
  const stored = await staff('query', 'admin.bulkEmail', { id });
  expect(stored).toMatchObject({ state: 'refused', refusal: 'vendor.email', subject });
  expect(stored.counts.sent).toBe(0);
  expect(stored.recipients.some((r) => r.state === 'sent')).toBe(false);
  expect(stored.recipients.find((r) => r.userId === people[1].userId)?.state).toBe('skipped_opted_out');
  expect(stored.recipients.find((r) => r.userId === people[0].userId)?.state).toBe('not_sent');

  // With the owner's inactivity period blank, a send is refused with its code and nothing is written.
  const before = (await staff('query', 'admin.bulkEmails', { path: COURSE })).length;
  restartWith('academy', 'LOCAL_STACK_ACADEMY_INACTIVE_DAYS', false);
  try {
    await page.reload();
    await send(`${subject} (blank period)`);
    const refused = desk.getByTestId('course-desk-outcome');
    await expect(refused).toHaveAttribute('data-code', 'academy.inactivity_period_unset', { timeout: 60_000 });
    await expect(refused).toContainText('Inactivity period not set');
  } finally {
    restartWith('academy', 'LOCAL_STACK_ACADEMY_INACTIVE_DAYS', true);
  }
  expect(await staff('query', 'admin.bulkEmails', { path: COURSE })).toHaveLength(before);
});

test(`${J} #7 tags learners in bulk and requests a learner export filtered by tag: the job finishes with only tagged learners, with its time and hash`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { people } = state('people');
  const tag = `ja15-${RUN}`.slice(0, 40);
  const tagged = [people[0], people[2]];
  await founderSignIn(page, 'b');
  await page.goto(ENROLMENT);
  const bulkTag = page.getByTestId('bulk-tag');
  await expect(bulkTag.getByRole('heading', { name: 'Tag learners in bulk' })).toBeVisible({ timeout: 60_000 });
  await bulkTag.getByLabel('Learners to tag, one email or handle per line').fill(tagged.map((p) => p.email).join('\n'));
  await bulkTag.getByLabel('Tag', { exact: true }).fill(tag);
  await bulkTag.getByLabel('Reason for the tag').fill(`TEST ${J}: export group`);
  await bulkTag.getByRole('button', { name: 'Tag learners' }).click();
  await expect(bulkTag.getByTestId('course-desk-outcome')).toContainText(`Done: tag ${tag} added`, { timeout: 60_000 });

  await page.goto(`${ADMIN}/academy-ops/catalogue/reports`);
  const desk = page.getByTestId('reports-desk');
  await expect(desk.getByRole('heading', { name: 'Learner exports' })).toBeVisible({ timeout: 60_000 });
  await desk.getByLabel('Filter by tag').selectOption(tag);
  await desk.getByRole('button', { name: 'Request export' }).click();
  const row = desk.getByTestId('report-tasks').locator(`tr[data-key="report:learners:${tag}:1"]`);
  await expect(row).toHaveCount(1, { timeout: 60_000 });
  // The job runs in the background; the page reads again until it finishes.
  await expect(row).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await expect(row).toContainText('Finished');
  const finished = await row.locator('[data-finished]').getAttribute('data-finished');
  expect(Number.isNaN(Date.parse(finished))).toBe(false);
  const sha256 = await row.locator('[data-sha256]').getAttribute('data-sha256');
  expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  await expect(row.locator('td').nth(3)).toHaveText('2');

  // The file: only the tagged learners, its time in its first line, and its bytes hash to what the page shows.
  const id = await row.getAttribute('data-report');
  const file = await page.request.get(`${ADMIN}/api/academy-reports?id=${id}`);
  expect(file.status()).toBe(200);
  const csv = await file.text();
  expect(createHash('sha256').update(csv, 'utf8').digest('hex')).toBe(sha256);
  expect(file.headers()['x-content-sha256']).toBe(sha256);
  const lines = csv.split('\n');
  expect(lines[0]).toBe(`learner export,tag ${tag},finished at,${finished}`);
  expect(lines[1]).toBe('learner,courses,tags');
  const learners = lines.slice(2).map((line) => line.split(',')[0]);
  expect(learners.sort()).toEqual(tagged.map((p) => p.userId).sort());
  expect(learners).not.toContain(people[1].userId);
});
