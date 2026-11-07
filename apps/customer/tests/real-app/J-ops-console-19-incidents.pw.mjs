// World: none
import { expect, test } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-19 #10: a founder declares an incident (OPS-oncall-02). With no severity it is pending; a private incident
// opened by someone who does not take part is not found; a timeline note sent twice under one key is one; a task for someone
// not taking part refuses ops.assignee_not_participant; resolving stores the end time and the time-to-resolve metric comes from
// the stored times; and with no incidents the metrics are empty. Founder A runs the incident; founder B declares the private one.

/** One console change from this page, with its CSRF token: the console's answer as { status, body }. */
async function post(page, body) {
  return page.evaluate(async (body) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/incidents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, body);
}

/** The console's own duration words (apps/admin ops-desk model formatDuration): the two largest units. */
function duration(seconds) {
  const s = Math.max(0, Math.trunc(seconds));
  const d = Math.trunc(s / 86_400);
  const h = Math.trunc((s % 86_400) / 3_600);
  const m = Math.trunc((s % 3_600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s % 60} s`;
  return `${s} s`;
}

test('J-ops-console-19 #10 declare an incident: pending, private, one note, tasks, resolve and metrics from stored times', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  const founderB = await founderSignIn(b, 'b');
  const tag = Date.now().toString(36);
  try {
    // With no incidents the metrics are empty: no zero chart, no sample figure.
    await a.goto(`${ADMIN}/incidents`, { waitUntil: 'load' });
    await expect(
      a.getByTestId('incident-list').locator('[data-state="empty"]'),
      'this clause needs a stack where no incident was declared yet',
    ).toBeVisible({ timeout: 60_000 });
    await expect(a.getByTestId('incident-metrics').locator('[data-state="empty"]')).toContainText('No incidents yet');

    // Declared with no severity: pending.
    const declare = a.getByTestId('incident-declare');
    await declare.getByLabel('Title').fill(`TEST ledger replica lag ${tag}`);
    await declare.getByLabel('Module affected').selectOption('ledger');
    await declare.getByRole('button', { name: 'Declare the incident' }).click();
    await a.waitForURL((url) => /^\/incidents\/[0-9a-f-]{36}$/.test(url.pathname), { timeout: 60_000 });
    const incidentId = a.url().split('/').pop();
    await expect(a.getByTestId('incident-severity')).toHaveText('pending');
    await expect(a.getByTestId('incident-status')).toHaveText('active');

    // An unknown severity is refused by name, and nothing is declared.
    const unknown = await post(a, {
      action: 'declare',
      requestKey: `console:incident:declare:bad-${tag}`,
      title: 'TEST',
      severity: 'apocalyptic',
    });
    expect(unknown.status).not.toBe(200);
    expect(unknown.body).toMatchObject({ ok: false, code: 'ops.severity_unknown' });

    // A timeline note sent twice under one key is one note.
    const note = { action: 'note', incidentId, requestKey: `console:incident:note:${tag}`, body: `TEST replica 40 s behind ${tag}` };
    expect((await post(a, note)).status).toBe(200);
    expect((await post(a, note)).status).toBe(200);
    await a.reload({ waitUntil: 'load' });
    await expect(a.getByTestId('incident-timeline').locator('li[data-kind="note"]')).toHaveCount(1);
    await expect(a.getByTestId('incident-timeline')).toContainText(`TEST replica 40 s behind ${tag}`);

    // A task for someone who does not take part refuses; invited, they can be given it, and the timeline shows both.
    const task = a.getByTestId('incident-task');
    await task.getByLabel('Task').fill('TEST check the replica');
    await task.getByLabel('Assignee user id').fill(founderB.userId);
    await task.getByRole('button', { name: 'Add the task' }).click();
    await expect(task.getByTestId('incident-outcome')).toHaveAttribute('data-code', 'ops.assignee_not_participant');
    await expect(a.getByTestId('incident-tasks')).toContainText('No tasks.');
    const invite = a.getByTestId('incident-invite');
    await invite.getByLabel('User id to invite').fill(founderB.userId);
    await invite.getByRole('button', { name: 'Invite' }).click();
    await expect(a.getByTestId('incident-participants').locator(`li[data-user="${founderB.userId}"]`)).toBeVisible();
    await task.getByLabel('Task').fill('TEST check the replica');
    await task.getByLabel('Assignee user id').fill(founderB.userId);
    await task.getByRole('button', { name: 'Add the task' }).click();
    await expect(a.getByTestId('incident-tasks').locator(`li[data-assignee="${founderB.userId}"]`)).toContainText('open');

    // Resolving stores the end time; resolving again refuses.
    await a.getByTestId('incident-resolve').getByRole('button', { name: 'Resolve the incident' }).click();
    await expect(a.getByTestId('incident-status')).toHaveText('resolved');
    const startedAt = await a.getByTestId('incident-started').getAttribute('data-at');
    const endedAt = await a.getByTestId('incident-ended').getAttribute('data-at');
    expect(Date.parse(endedAt)).toBeGreaterThanOrEqual(Date.parse(startedAt));
    const again = await post(a, { action: 'resolve', incidentId, requestKey: `console:incident:resolve:again-${tag}` });
    expect(again.status).not.toBe(200);
    expect(again.body).toMatchObject({ ok: false, code: 'ops.incident_already_resolved' });

    // A private incident founder B declares: B sees it; to A it is not found, unlisted and uncounted.
    const secret = await post(b, {
      action: 'declare',
      requestKey: `console:incident:declare:private-${tag}`,
      title: `TEST legal matter ${tag}`,
      severity: 'major',
      private: true,
    });
    expect(secret.status).toBe(200);
    const secretId = secret.body.detail.incident.id;
    await b.goto(`${ADMIN}/incidents/${secretId}`, { waitUntil: 'load' });
    await expect(b.getByTestId('incident-visibility')).toContainText('private');
    await a.goto(`${ADMIN}/incidents/${secretId}`, { waitUntil: 'load' });
    await expect(a.getByTestId('incident-not-found')).toContainText('ops.incident_not_found');

    // The metrics A sees: the one resolved incident, its time to resolve from the stored times, and nothing of B's private one.
    await a.goto(`${ADMIN}/incidents`, { waitUntil: 'load' });
    await expect(a.getByTestId('incident-list')).not.toContainText(`TEST legal matter ${tag}`);
    await expect(a.getByTestId('incident-metric-resolved')).toContainText('1');
    await expect(a.getByTestId('incident-metric-active')).toHaveCount(0);
    const seconds = Math.floor((Date.parse(endedAt) - Date.parse(startedAt)) / 1000);
    await expect(a.getByTestId('incident-metric-ttr')).toContainText(`${duration(seconds)} over 1 resolved`);
  } finally {
    await a.context().close();
    await b.context().close();
  }
});
