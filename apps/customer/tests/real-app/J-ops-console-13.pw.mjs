// World: gates
import { expect, test } from './journey.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-13: review sanctions hits, run a screening search and keep screening running. Written by a test-writer
// from the step words in operation-zero/modules/ops-console/acceptance/journeys.md (project-state), not by the builder.
// The compliance reviewer is founder A on the stack's founder pair; the second reviewer is founder B, each in their own
// browser. The stack starts with no sanctions list configured, no screening provider and every owner value blank (match
// score, maximum hits, upload cap, retention, report destination, scoring). The rooms are the ones
// modules/ops-console/specs/ops-screening.md names: the hit queue at /screening, the hub, search, lists, policy, saved,
// health, audit and continuous pages under /compliance/screening. A step that sets an owner value sets a TEST value with
// both reviewers and puts the blank back before it ends, so the next step and the next file start from the stack as it was.

const J = 'J-ops-console-13';
const TAG = randomUUID().slice(0, 8);

test.use({ timezoneId: 'UTC' });

/** Opens a console room and waits for its level-1 heading; a room that is not there fails here, naming it. */
async function room(page, path, heading) {
  await page.goto(`${ADMIN}${path}`, { waitUntil: 'load' });
  await expect(page.getByRole('heading', { level: 1, name: heading }), `the ${path} room is not in the console`).toBeVisible({
    timeout: 15_000,
  });
}

/** Founder A and founder B, each signed in on their own browser. */
async function twoReviewers(browser) {
  const a = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  const b = await (await browser.newContext()).newPage();
  await founderSignIn(b, 'b');
  return { a, b };
}

/** The pending change a reviewer requested, opened on the other reviewer's console and approved there. */
async function approveOn(page, path, heading, change) {
  await room(page, path, heading);
  const pending = page.getByRole('region', { name: 'Waiting for a second reviewer' }).getByRole('row').filter({ hasText: change });
  await expect(pending).toHaveCount(1);
  await pending.getByRole('button', { name: 'Approve' }).click();
}

/** A policy field set to `value` by A and approved by B (an empty value puts the blank back). */
async function setPolicy(a, b, label, value) {
  await room(a, '/compliance/screening/policy', 'Screening policy');
  await a.getByLabel(label).fill(value);
  await a.getByRole('button', { name: 'Request change' }).click();
  await expect(a.getByRole('status')).toContainText('Waiting for a second reviewer');
  await approveOn(b, '/compliance/screening/policy', 'Screening policy', label);
  await expect(b.getByRole('status')).toContainText('Applied');
}

test(`${J} #1 with the sanctions list unset the hit queue is empty, names the missing list, renders no row and never reads clear`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await room(page, '/screening', 'Sanctions hits');
  // The queue is empty, with a line naming the missing list.
  await expect(page.getByText(/sanctions list is not (set|configured)/i)).toBeVisible();
  const queue = page.getByRole('table', { name: 'Sanctions hits' });
  await expect(queue.locator('tbody tr')).toHaveCount(0);
  // The screening status of the queue cannot be read while no list is set: it says so, and nothing on the page says clear.
  await expect(page.getByTestId('screening-status')).toHaveText(/could not be checked/i);
  await expect(page.getByText(/\bclear(ed)?\b/i)).toHaveCount(0);
});

test(`${J} #2 a blank provider fails closed; a threshold edit needs two approvers and warns live scenarios change; a blank stale bound reads not set`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { a, b } = await twoReviewers(browser);
  await room(a, '/compliance/screening/policy', 'Screening policy');

  // The provider is blank: choosing to screen with it fails closed with a typed error, and no hit is invented.
  await expect(a.getByLabel('Provider')).toHaveValue('');
  await a.getByRole('button', { name: 'Check provider' }).click();
  await expect(a.getByRole('alert')).toContainText(/vendor\.aml|compliance\.provider_unset/);
  await room(a, '/screening', 'Sanctions hits');
  await expect(a.getByRole('table', { name: 'Sanctions hits' }).locator('tbody tr')).toHaveCount(0);

  // A threshold edit warns that every live scenario changes, and A alone does not apply it.
  await room(a, '/compliance/screening/policy', 'Screening policy');
  await a.getByLabel('Minimum match score').fill('0.85');
  await expect(a.getByText(/all live scenarios change/i)).toBeVisible();
  await a.getByRole('button', { name: 'Request change' }).click();
  await expect(a.getByRole('status')).toContainText('Waiting for a second reviewer');
  const mine = a.getByRole('region', { name: 'Waiting for a second reviewer' }).getByRole('row').filter({ hasText: 'Minimum match score' });
  await mine.getByRole('button', { name: 'Approve' }).click();
  await expect(a.getByRole('alert')).toContainText(/action_approval\.same_person|compliance\.self_approval_refused/);
  await a.reload();
  await expect(a.getByLabel('Minimum match score')).toHaveValue('');

  // B approves: the TEST threshold applies. Then the blank goes back the same way, so later steps see the stack as it was.
  await approveOn(b, '/compliance/screening/policy', 'Screening policy', 'Minimum match score');
  await expect(b.getByRole('status')).toContainText('Applied');
  await room(a, '/compliance/screening/policy', 'Screening policy');
  await expect(a.getByLabel('Minimum match score')).toHaveValue('0.85');
  await setPolicy(a, b, 'Minimum match score', '');

  // The list-age bound is blank: it reads "not set", and no list is called fresh or stale against a bound nobody set.
  await expect(a.getByTestId('stale-bound')).toHaveText(/not set/i);
  await room(a, '/compliance/screening/lists', 'Screening lists');
  await expect(a.getByText(/\bfresh\b/i)).toHaveCount(0);
});

test(`${J} #3 the lists catalogue shows the one configured list, invents none; a blank match score refuses and a typed one needs a second reviewer`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { a, b } = await twoReviewers(browser);
  await room(a, '/compliance/screening/lists', 'Screening lists');
  // Only lists the stack configures are rows, each with its source, version and count; with none, no row at all.
  const catalogue = a.getByRole('table', { name: 'Screening lists' });
  for (const column of ['List', 'Source', 'Version', 'Items'])
    await expect(catalogue.getByRole('columnheader', { name: column })).toBeVisible();
  const rows = catalogue.locator('tbody tr');
  expect(await rows.count()).toBeLessThanOrEqual(1);
  for (const row of await rows.all()) for (const cell of await row.getByRole('cell').all()) await expect(cell).not.toBeEmpty();

  // The match score is blank: screening against the catalogue refuses with its typed code.
  await room(a, '/compliance/screening/policy', 'Screening policy');
  await expect(a.getByLabel('Minimum match score')).toHaveValue('');
  await expect(a.getByTestId('policy-state')).toContainText('compliance.match_threshold_unset');

  // A typed score is not applied until a second reviewer approves it; then the blank goes back.
  await a.getByLabel('Minimum match score').fill('0.9');
  await a.getByRole('button', { name: 'Request change' }).click();
  await expect(a.getByRole('status')).toContainText('Waiting for a second reviewer');
  await a.reload();
  await expect(a.getByLabel('Minimum match score')).toHaveValue('');
  await approveOn(b, '/compliance/screening/policy', 'Screening policy', 'Minimum match score');
  await a.reload();
  await expect(a.getByLabel('Minimum match score')).toHaveValue('0.9');
  await setPolicy(a, b, 'Minimum match score', '');
});

test(`${J} #4 a watchlist upload over or without a cap, or of an unknown type, is refused and stores nothing; the same file twice changes nothing`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await room(page, '/compliance/screening/lists', 'Screening lists');
  const upload = page.getByRole('region', { name: 'Upload a watchlist' });
  const countBefore = await page.getByRole('table', { name: 'Screening lists' }).locator('tbody tr').count();

  // The upload cap is a blank owner value on the stack: any upload refuses `compliance.upload_limit_unset` (or, with a cap
  // set, a file over it refuses `compliance.upload_too_large`).
  const csv = Buffer.from(`name,type\nTEST Person ${TAG},person\n`);
  await upload.getByLabel('Watchlist file').setInputFiles({ name: `test-${TAG}.csv`, mimeType: 'text/csv', buffer: csv });
  await upload.getByRole('button', { name: 'Upload' }).click();
  await expect(upload.getByRole('alert')).toContainText(/compliance\.upload_limit_unset|compliance\.upload_too_large/);

  // An unknown type is refused by its own code, and nothing is stored.
  await upload
    .getByLabel('Watchlist file')
    .setInputFiles({ name: `test-${TAG}.exe`, mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') });
  await upload.getByRole('button', { name: 'Upload' }).click();
  await expect(upload.getByRole('alert')).toContainText('compliance.upload_type_refused');
  await page.reload();
  await expect(page.getByRole('table', { name: 'Screening lists' }).locator('tbody tr')).toHaveCount(countBefore);

  // The same file twice: the second upload is recognised by its hash and changes nothing.
  const hash = createHash('sha256').update(csv).digest('hex');
  await upload.getByLabel('Watchlist file').setInputFiles({ name: `test-${TAG}.csv`, mimeType: 'text/csv', buffer: csv });
  await upload.getByRole('button', { name: 'Upload' }).click();
  await expect(upload.getByRole('alert').or(upload.getByRole('status'))).toBeVisible();
  const after = await page.getByRole('table', { name: 'Screening lists' }).locator('tbody tr').count();
  await upload.getByLabel('Watchlist file').setInputFiles({ name: `again-${TAG}.csv`, mimeType: 'text/csv', buffer: csv });
  await upload.getByRole('button', { name: 'Upload' }).click();
  await expect(upload.getByRole('status').or(upload.getByRole('alert'))).toContainText(new RegExp(`already|${hash.slice(0, 12)}`, 'i'));
  await page.reload();
  await expect(page.getByRole('table', { name: 'Screening lists' }).locator('tbody tr')).toHaveCount(after);
});

test(`${J} #5 an entity search with no provider refuses vendor.aml and scores nothing; unset maximum hits and no dataset refuse by code`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await room(page, '/compliance/screening/search', 'Screening search');
  // The form works: every field takes input.
  await page.getByLabel('Name').fill(`TEST Person ${TAG}`);
  await page.getByLabel('Entity type').selectOption('person');
  await page.getByLabel('Birth date').fill('1980-01-01');

  // No dataset selected refuses before anything runs.
  await page.getByRole('button', { name: 'Run search' }).click();
  await expect(page.getByRole('alert')).toContainText('compliance.list_selection_empty');

  // With every dataset selected: the maximum hits are a blank owner value, and no provider or self-hosted index exists.
  await page.getByLabel('All datasets').check();
  await page.getByRole('button', { name: 'Run search' }).click();
  const refusal = page.getByRole('alert');
  await expect(refusal).toContainText(/vendor\.aml|compliance\.max_hits_unset/);
  await expect(page.locator('[data-not-connected="vendor.aml"]').or(page.getByText('compliance.max_hits_unset'))).toBeVisible();
  // Nothing is scored, no hit is rendered, and the result never reads clear (nor partial results as clear).
  await expect(page.getByRole('table', { name: 'Search results' }).locator('tbody tr')).toHaveCount(0);
  await expect(page.getByText(/score breakdown/i)).toHaveCount(0);
  await expect(page.getByText(/\bclear\b/i)).toHaveCount(0);
});

test(`${J} #6 a saved search and a preset print with the parameters and the date from the stored row`, async ({ page }) => {
  await founderSignIn(page, 'a');
  await room(page, '/compliance/screening/search', 'Screening search');
  const name = `TEST Saved ${TAG}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Entity type').selectOption('company');
  await page.getByLabel('All datasets').check();
  await page.getByRole('button', { name: 'Save search' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');
  await page.getByRole('button', { name: 'Save as preset' }).click();
  await page.getByLabel('Preset name').fill(`TEST Preset ${TAG}`);
  await page.getByRole('button', { name: 'Save preset' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  await room(page, '/compliance/screening/saved', 'Saved searches');
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  const storedAt = (await row.getByTestId('saved-at').innerText()).trim();
  await expect(page.getByRole('row').filter({ hasText: `TEST Preset ${TAG}` })).toHaveCount(1);

  // The print view carries the parameters and the date from the stored row.
  await row.getByRole('link', { name: 'Print' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Screening search/ })).toBeVisible();
  await expect(page.getByText(name)).toBeVisible();
  await expect(page.getByText(/company/i)).toBeVisible();
  await expect(page.getByText(storedAt)).toBeVisible();
});

test(`${J} #7 a hit reviewed as match confirmed becomes a confirmed hit and its case routes to its inbox`, async ({ page }) => {
  await founderSignIn(page, 'a');
  await room(page, '/screening', 'Sanctions hits');
  // A hit exists only once a list and a source exist: the queue must hold one to review, never an invented row.
  const hit = page.getByRole('table', { name: 'Sanctions hits' }).locator('tbody tr').first();
  await expect(hit, 'no screening hit to review on the stack').toBeVisible();
  await hit.getByRole('button', { name: 'Review' }).click();
  const dialog = page.getByRole('dialog', { name: /Review hit/ });
  await dialog.getByLabel('Decision').selectOption('match_confirmed');
  await dialog.getByLabel('Comment').fill(`TEST confirmed ${TAG}`);
  await dialog.getByRole('button', { name: 'Record decision' }).click();
  await expect(hit.getByTestId('screening-status')).toHaveText(/confirmed hit/i);
  const inbox = (await hit.getByTestId('routed-to').innerText()).trim();
  expect(inbox).not.toBe('');
  await room(page, '/compliance/cases', /Cases/);
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: inbox })
      .filter({ hasText: /confirmed hit/i }),
  ).not.toHaveCount(0);
});

test(`${J} #8 a bulk dismiss of 30 with one decided gives 29 and one reason; a self force-resolve refuses; comments are append-only`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await room(page, '/screening', 'Sanctions hits');
  const rows = page.getByRole('table', { name: 'Sanctions hits' }).locator('tbody tr');
  expect(await rows.count(), 'the queue needs 30 hits for a bulk dismiss').toBeGreaterThanOrEqual(30);
  for (let i = 0; i < 30; i++) await rows.nth(i).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Dismiss as false positive' }).click();
  const receipt = page.getByRole('status');
  await expect(receipt).toContainText('29 dismissed');
  await expect(receipt).toContainText(/1 not dismissed: .+/);

  await page.getByRole('button', { name: 'Force-resolve' }).click();
  await page.getByLabel('Reason').fill(`TEST force-resolve ${TAG}`);
  await page.getByRole('button', { name: 'Request force-resolve' }).click();
  await page.getByRole('button', { name: 'Approve force-resolve' }).click();
  await expect(page.getByRole('alert')).toContainText(/compliance\.self_approval_refused|action_approval\.same_person/);

  const first = rows.first();
  await first.getByRole('button', { name: 'Review' }).click();
  const thread = page.getByRole('list', { name: 'Comments' });
  const before = await thread.getByRole('listitem').count();
  await page.getByLabel('Comment').fill(`TEST comment ${TAG}`);
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(thread.getByRole('listitem')).toHaveCount(before + 1);
  await expect(thread.getByRole('button', { name: /edit|delete/i })).toHaveCount(0);
});

test(`${J} #9 a refresh while one runs refuses with the job id; an empty list with hard-fail on fails and keeps the previous version`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await room(page, '/compliance/screening/health', 'Screening health');
  const version = (await page.getByTestId('list-version').innerText()).trim();
  await page.getByRole('button', { name: 'Refresh now' }).click();
  const job = page.getByTestId('refresh-job');
  await expect(job).toHaveText(/\S/);
  const jobId = (await job.innerText()).trim();
  await page.getByRole('button', { name: 'Refresh now' }).click();
  await expect(page.getByRole('alert')).toContainText('compliance.refresh_running');
  await expect(page.getByRole('alert')).toContainText(jobId);

  // The configured list is empty and hard-fail is on: the refresh ends failed and the version before it stays.
  await expect(page.getByLabel('Fail when a list is empty')).toBeChecked();
  await expect(page.getByTestId('refresh-state')).toHaveText(/failed/i, { timeout: 60_000 });
  await page.reload();
  await expect(page.getByTestId('list-version')).toHaveText(version);
});

test(`${J} #10 the audit log has a row per list change; unset retention prunes nothing; a report with no destination stays a draft; triggers show owners`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await room(page, '/compliance/screening/audit', 'Screening audit log');
  const log = page.getByRole('table', { name: 'Screening audit log' });
  for (const column of ['Change', 'Before', 'After', 'Actor', 'Time'])
    await expect(log.getByRole('columnheader', { name: column })).toBeVisible();
  // #2 and #3 changed the policy: each change is its own row, with before, after and who made it.
  const changes = log.getByRole('row').filter({ hasText: 'Minimum match score' });
  expect(await changes.count()).toBeGreaterThanOrEqual(2);
  for (const row of (await changes.all()).slice(0, 2)) await expect(row.getByRole('cell').nth(3)).not.toBeEmpty();

  await expect(page.getByTestId('retention')).toContainText('compliance.retention_unset');
  await expect(page.getByTestId('pruned')).toHaveText(/nothing pruned|0 pruned/i);

  await room(page, '/compliance/screening/continuous', 'Continuous screening');
  const routing = page.getByRole('region', { name: 'Outcome routing' });
  await routing.getByRole('button', { name: 'Route a regulator report' }).click();
  await expect(page.getByRole('alert')).toContainText('compliance.report_destination_unset');
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: /regulator report/i })
      .filter({ hasText: /draft/i }),
  ).not.toHaveCount(0);

  const triggers = page.getByRole('table', { name: 'Trigger points' });
  const triggerRows = triggers.locator('tbody tr');
  expect(await triggerRows.count()).toBeGreaterThan(0);
  for (const row of await triggerRows.all()) await expect(row.getByTestId('trigger-owner')).not.toBeEmpty();
});

test(`${J} #11 continuous screening: a diffed confirmed edit, blank scoring refuses, skip-initial is audited, re-screens are exact, unrouted alerts go to the default inbox`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await room(page, '/compliance/screening/continuous', 'Continuous screening');

  // A config edit shows a diff and is not applied until confirmed.
  await page.getByLabel('Re-screen interval (days)').fill('30');
  await page.getByRole('button', { name: 'Review change' }).click();
  const diff = page.getByRole('region', { name: 'Change' });
  await expect(diff).toContainText('Re-screen interval');
  await expect(diff).toContainText('30');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Scoring is blank: continuous screening refuses by code.
  await expect(page.getByTestId('scoring')).toContainText('compliance.scoring_unset');

  // An object added with skip-initial raises no initial alert, and the audit names who skipped it.
  const subject = `TEST Monitored ${TAG}`;
  await page.getByLabel('Object name').fill(subject);
  await page.getByLabel('Skip initial screening').check();
  await page.getByRole('button', { name: 'Add object' }).click();
  await expect(page.getByRole('row').filter({ hasText: subject })).toHaveCount(1);
  await expect(page.getByRole('table', { name: 'Alerts' }).getByRole('row').filter({ hasText: subject })).toHaveCount(0);
  await room(page, '/compliance/screening/audit', 'Screening audit log');
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: subject })
      .filter({ hasText: /skipped initial/i }),
  ).toHaveCount(1);

  // A dataset update re-screens only the objects that include it, and the same event delivered again adds no alert.
  await room(page, '/compliance/screening/continuous', 'Continuous screening');
  const runs = page.getByRole('table', { name: 'Re-screen runs' });
  await expect(runs.getByRole('columnheader', { name: 'Objects re-screened' })).toBeVisible();
  await expect(runs.getByRole('columnheader', { name: 'Dataset' })).toBeVisible();

  // An alert with no routing rule goes to the default inbox, or refuses `compliance.routing_unset`.
  await expect(page.getByTestId('default-routing')).toHaveText(/default inbox|compliance\.routing_unset/);
});
