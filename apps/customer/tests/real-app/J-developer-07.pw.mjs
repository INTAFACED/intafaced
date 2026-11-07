// World: restart
import { test, expect } from './journey.mjs';
import { EDGE, ORIGIN, api, restartWith } from './stack.mjs';
import { codeOf, holderAgain, keyHolder, makeKey, signedHeaders, withKey } from './developer.mjs';

// J-developer-07, in the running app (docs/roadmap/journeys.json): rotate a key, revoke a key, and respond to a leaked
// one. One test per step, titled "J-developer-07 #<n>", each written by an independent test-writer from the step's own
// words (OWNER 212); the builder makes them pass and may not weaken them. Each test starts its own TEST account with a
// passkey and a live trade key made in the browser (developer.mjs), as a running bot would hold it, so the steps do not
// lean on each other. "A key verifies" means Edge answers a signed call the key makes (the account balance).
//
// Names this file asks the product for, where main has nothing yet (the builder implements them as written):
// - the key detail page (/uc/safe/api-keys/<id>) has a "Rotate" button; its "Rotate this key" dialog asks for
//   "Overlap (seconds)" and submits with "Create with a passkey"; the new key and its signing secret show under
//   "Your new key" (api-keys__key, api-keys__signing-secret) and the old key's last moment in api-keys__overlap-ends,
//   a <time datetime="ISO">; the browser's call is identity `developerKeys.rotate`. After a lost reply the dialog stays
//   open and the person retries with the same "Create with a passkey".
// - the owner's maximum overlap is the stack setting LOCAL_STACK_IDENTITY_KEY_ROTATE_OVERLAP_MAX ("off" is blank); a
//   rotation with an overlap above zero while it is blank refuses with identity.key_rotate_overlap_unset.
// - a key asks for its own rotation with POST /api/v1/account/api-key/rotation, and a rotation request is approved with
//   POST /api/v1/account/api-key/rotation/approve { requestId }; a requester approving its own request refuses with
//   identity.rotation_self_approval. The person approves on the key's detail page, region "Rotation request", button
//   "Approve the rotation".
// - the key list has a "Revoke all keys" button; its dialog's "Revoke all" revokes every live key of the person.
// - an operator reports a leaked key string with identity `developerKeys.reportLeaked { key }` and reads the key's
//   audit with `developerKeys.operatorAudit { keyId }`; the holder's notice is a Notifications row titled
//   "API key revoked".
const J = 'J-developer-07';
// A part main does not have yet fails at its first look, not after the default wait.
const UNBUILT = { timeout: 10_000 };
const OVERLAP_MAX = 'LOCAL_STACK_IDENTITY_KEY_ROTATE_OVERLAP_MAX';
const DEAD = ['edge.api_key_revoked', 'edge.api_key_expired'];

test.describe.configure({ mode: 'default' });

/** One signed call to Edge as a developer's program sends it, with a key and the signing secret it was shown. */
async function callAs({ key, secret }, { method = 'GET', path, body } = {}) {
  if (!secret) return withKey(key, { method, path, body });
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(`${EDGE}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${key}`,
      ...(raw ? { 'content-type': 'application/json' } : {}),
      ...signedHeaders(secret, { method, path, body: raw ?? '' }),
    },
    body: raw,
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* kept as text */
  }
  return { status: res.status, body: parsed };
}

/** Whether the key verifies: Edge answers its balance read (200), or refuses it (401 with the code Edge names). */
async function verifies(cred) {
  const reply = await callAs(cred, { path: '/api/v1/account/balance' });
  return { status: reply.status, code: reply.status === 200 ? null : codeOf(reply.body), body: reply.body };
}

async function expectVerifies(cred, label) {
  const v = await verifies(cred);
  expect(v.status, `${label} verifies: ${JSON.stringify(v.body).slice(0, 300)}`).toBe(200);
}

async function expectDead(cred, label) {
  const v = await verifies(cred);
  expect(v.status, `${label} no longer verifies: ${JSON.stringify(v.body).slice(0, 300)}`).toBe(401);
  expect(DEAD, `${label} is refused as a dead key, not for another reason: ${JSON.stringify(v.body).slice(0, 300)}`).toContain(v.code);
}

/** The person's keys as identity holds them (a fresh session of their own, not the browser's). */
async function keysOf(who) {
  const reply = await (
    await api(who)
  ).get(`/api/identity/trpc/developerKeys.list?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
  expect(reply.status, JSON.stringify(reply.body).slice(0, 300)).toBe(200);
  return reply.body.result.data.keys;
}

/** What a key is, without when it was last used (a read the bot made may land later). */
const standing = (k) => ({ id: k?.id, revoked: k?.revoked, revokedAt: k?.revokedAt, revokedBy: k?.revokedBy, expiresAt: k?.expiresAt });

/** The key's id, from its row in the list (rows carry data-key-id). */
async function keyIdOf(page, name) {
  await page.goto('/uc/safe/api-keys');
  const row = page
    .getByTestId('api-keys__table')
    .locator('tbody tr')
    .filter({ has: page.getByRole('rowheader', { name, exact: true }) });
  await expect(row).toHaveCount(1);
  return row.getAttribute('data-key-id');
}

/** Reads "Your new key": the key and its signing secret, shown once. */
async function newKeyShown(page) {
  await expect(page.getByRole('heading', { name: 'Your new key' })).toBeVisible();
  const key = (await page.getByTestId('api-keys__key').locator('code').textContent())?.trim();
  const box = page.getByTestId('api-keys__signing-secret');
  const secret = (await box.count()) ? (await box.locator('code').textContent())?.trim() : undefined;
  expect(key).toMatch(/^ifc_[A-Za-z0-9_-]{20,}$/);
  return { key, secret };
}

/** Opens the key's Rotate dialog on its detail page and fills the overlap. */
async function openRotate(page, keyId, overlapSeconds) {
  await page.goto(`/uc/safe/api-keys/${keyId}`);
  await page.getByRole('button', { name: 'Rotate', exact: true }).click(UNBUILT);
  const dialog = page.getByRole('dialog', { name: 'Rotate this key' });
  await expect(dialog).toBeVisible(UNBUILT);
  await dialog.getByLabel('Overlap (seconds)').fill(String(overlapSeconds), UNBUILT);
  return dialog;
}

const rotateCall = (res) => /\/api\/identity\/trpc\/[^?]*developerKeys\.rotate\b/.test(res.url());
const waitUntil = async (ms) => {
  const left = ms - Date.now();
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
};

test(`${J} #1 rotates with a 60-second overlap: both keys verify until the end time, then only the new one; with the owner maximum blank, an overlap above zero refuses`, async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const { page, who } = await keyHolder(browser, 'jd7r');
  try {
    const old = { key: await makeKey(page, { name: 'bot-1' }) };
    await expectVerifies(old, 'the running bot key');
    const oldId = await keyIdOf(page, 'bot-1');

    // Rotate with an overlap of 60 seconds (the TEST value).
    const dialog = await openRotate(page, oldId, 60);
    const asked = Date.now();
    await dialog.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
    const fresh = await newKeyShown(page);
    expect(fresh.key).not.toBe(old.key);
    // The page says when the old key stops: the end of the 60-second overlap.
    const endsIso = await page.getByTestId('api-keys__overlap-ends').locator('time').getAttribute('datetime', UNBUILT);
    const endsAt = Date.parse(endsIso ?? '');
    expect(endsAt - asked, `the overlap ends 60 s after the rotation (${endsIso})`).toBeGreaterThanOrEqual(55_000);
    expect(endsAt - asked, `the overlap ends 60 s after the rotation (${endsIso})`).toBeLessThanOrEqual(75_000);

    // Both keys verify during the overlap, right after the rotation and again just before the end time.
    await expectVerifies(old, 'the old key during the overlap');
    await expectVerifies(fresh, 'the new key');
    await waitUntil(endsAt - 5_000);
    await expectVerifies(old, 'the old key five seconds before the end time');
    await expectVerifies(fresh, 'the new key five seconds before the end time');

    // After the end time, only the new one.
    await waitUntil(endsAt + 2_000);
    await expectDead(old, 'the old key after the end time');
    await expectVerifies(fresh, 'the new key after the end time');

    // With the owner's maximum overlap blank, a rotation with any overlap above zero refuses and changes nothing.
    const freshId = (await keysOf(who)).find((k) => fresh.key.startsWith(k.prefix) && !k.revoked)?.id;
    expect(freshId, 'the new key is in the list').toBeTruthy();
    restartWith('identity', OVERLAP_MAX, false);
    try {
      const before = await keysOf(who);
      const blank = await openRotate(page, freshId, 60);
      const answered = page.waitForResponse(rotateCall);
      await blank.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
      const reply = await answered;
      const text = await reply.text();
      expect(reply.status(), text).not.toBe(200);
      expect(text, 'refused by the blank maximum by name').toContain('identity.key_rotate_overlap_unset');
      await expect(blank.getByRole('alert')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Your new key' })).toHaveCount(0);
      expect((await keysOf(who)).map(standing)).toEqual(before.map(standing));
      await expectVerifies(fresh, 'the key a refused rotation left alone');

      // An overlap of zero is not above zero: it still rotates, and the key it replaces stops at once.
      const zero = await openRotate(page, freshId, 0);
      await zero.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
      const third = await newKeyShown(page);
      await expectDead(fresh, 'the key rotated with no overlap');
      await expectVerifies(third, 'its replacement');
    } finally {
      restartWith('identity', OVERLAP_MAX, true);
    }
  } finally {
    await page.context().close();
  }
});

test(`${J} #2 loses the reply after the replacement is issued and retries: one replacement exists`, async ({ browser }) => {
  test.setTimeout(300_000);
  const { page, who } = await keyHolder(browser, 'jd7l');
  try {
    const old = { key: await makeKey(page, { name: 'bot-1' }) };
    const oldId = await keyIdOf(page, 'bot-1');

    // The first rotation reaches identity and is answered, but the answer never reaches the browser.
    let issued = null;
    await page.route(/\/api\/identity\/trpc\/[^?]*developerKeys\.rotate\b/, async (route) => {
      await page.unroute(/\/api\/identity\/trpc\/[^?]*developerKeys\.rotate\b/);
      const res = await route.fetch();
      issued = res.status();
      await route.abort('connectionreset');
    });
    const dialog = await openRotate(page, oldId, 60);
    await dialog.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
    await expect.poll(() => issued, { timeout: 30_000, message: 'the lost reply was answered by identity' }).toBe(200);

    // The person retries the same rotation from the same dialog.
    await dialog.getByRole('button', { name: 'Create with a passkey', exact: true }).click(UNBUILT);
    await expect(dialog.getByRole('button', { name: 'Create with a passkey', exact: true })).toHaveCount(0, UNBUILT);

    // One replacement exists: the old key and exactly one other.
    const keys = await keysOf(who);
    const replacements = keys.filter((k) => k.id !== oldId);
    expect(replacements, JSON.stringify(keys.map((k) => ({ name: k.name, revoked: k.revoked })))).toHaveLength(1);
    expect(replacements[0].revoked).toBe(false);
    await expectVerifies(old, 'the old key, still inside its overlap');
  } finally {
    await page.context().close();
  }
});

test(`${J} #3 a key requests its own rotation and tries to approve it: refused; a different person approves and one replacement issues`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { page, who } = await keyHolder(browser, 'jd7a');
  try {
    const key = await makeKey(page, { name: 'bot-1' });
    const keyId = await keyIdOf(page, 'bot-1');

    // The key itself asks for its rotation.
    const asked = await withKey(key, { method: 'POST', path: '/api/v1/account/api-key/rotation', body: {} });
    expect([200, 201, 202], `the key's rotation request is taken: ${JSON.stringify(asked.body).slice(0, 300)}`).toContain(asked.status);
    const requestId = asked.body?.requestId;
    expect(requestId, 'the request has an id').toBeTruthy();

    // The requester tries to approve its own request: refused, and nothing issues.
    const self = await withKey(key, { method: 'POST', path: '/api/v1/account/api-key/rotation/approve', body: { requestId } });
    expect(self.status, JSON.stringify(self.body).slice(0, 300)).toBe(403);
    expect(codeOf(self.body)).toBe('identity.rotation_self_approval');
    expect((await keysOf(who)).map((k) => k.id)).toEqual([keyId]);

    // A different person, the account's owner signed in on a device, approves it: one replacement issues.
    await page.goto(`/uc/safe/api-keys/${keyId}`);
    const request = page.getByRole('region', { name: 'Rotation request' });
    await expect(request).toBeVisible(UNBUILT);
    await request.getByRole('button', { name: 'Approve the rotation' }).click(UNBUILT);
    const fresh = await newKeyShown(page);
    expect(fresh.key).not.toBe(key);
    await expectVerifies(fresh, 'the replacement');
    const keys = await keysOf(who);
    expect(
      keys.filter((k) => k.id !== keyId),
      'one replacement',
    ).toHaveLength(1);
    // The request is spent: approving it again issues nothing more.
    await page.goto(`/uc/safe/api-keys/${keyId}`);
    await expect(page.getByRole('button', { name: 'Approve the rotation' })).toHaveCount(0);
    expect(await keysOf(who)).toHaveLength(2);
  } finally {
    await page.context().close();
  }
});

test(`${J} #4 revokes a key: it stops verifying at once, and the list shows it revoked with its reason`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { page } = await keyHolder(browser, 'jd7v');
  try {
    const cred = { key: await makeKey(page, { name: 'bot-1' }) };
    await expectVerifies(cred, 'the running bot key');

    await page.goto('/uc/safe/api-keys');
    const row = page
      .getByTestId('api-keys__table')
      .locator('tbody tr')
      .filter({ has: page.getByRole('rowheader', { name: 'bot-1', exact: true }) });
    await row.getByRole('button', { name: 'Revoke', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Reason (optional)').fill('TEST bot retired');
    await dialog.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The key is revoked.' })).toBeVisible();

    // At once: the very next call the bot makes is refused, with no wait in between.
    const v = await verifies(cred);
    expect(v.status, JSON.stringify(v.body).slice(0, 300)).toBe(401);
    expect(v.code).toBe('edge.api_key_revoked');

    await page.reload();
    await expect(row).toContainText('Revoked by you: TEST bot retired');
    await expect(row.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

test(`${J} #5 revokes all my keys: every live key revoked, another user's keys untouched`, async ({ browser }) => {
  test.setTimeout(360_000);
  const mine = await keyHolder(browser, 'jd7m');
  const theirs = await keyHolder(browser, 'jd7o');
  try {
    const myKeys = [
      { key: await makeKey(mine.page, { name: 'bot-1' }) },
      { key: await makeKey(mine.page, { name: 'bot-2', preset: 'Read only' }) },
    ];
    const theirKey = { key: await makeKey(theirs.page, { name: 'bot-1' }) };
    for (const cred of myKeys) await expectVerifies(cred, 'my key');
    await expectVerifies(theirKey, "another user's key");

    // A revoke-all sent from my session that names the other user leaves their key working, whatever it answers.
    const me = await api(mine.who);
    const otherId = (await api(theirs.who)).userId;
    await me.post('/api/identity/trpc/revokeAllApiKeys', { userId: otherId });
    await expectVerifies(theirKey, "another user's key after a revoke-all aimed at it");

    // Revoke all my keys, from the key list.
    await mine.page.goto('/uc/safe/api-keys');
    await mine.page.getByRole('button', { name: 'Revoke all keys' }).click(UNBUILT);
    const dialog = mine.page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Revoke all', exact: true }).click(UNBUILT);

    // Every live key of mine is revoked: none verifies, and every row says so.
    for (const cred of myKeys) await expectDead(cred, 'my key after revoke all');
    expect((await keysOf(mine.who)).every((k) => k.revoked)).toBe(true);
    await mine.page.reload();
    const rows = mine.page.getByTestId('api-keys__table').locator('tbody tr');
    await expect(rows).toHaveCount(2);
    for (const row of await rows.all()) await expect(row).toContainText('Revoked by you');

    // Another user's key is untouched: it verifies, and their list shows it active.
    await expectVerifies(theirKey, "another user's key after my revoke-all");
    const theirPage = await holderAgain(browser, theirs.who);
    try {
      await theirPage.goto('/uc/safe/api-keys');
      await expect(theirPage.getByTestId('api-keys__table').locator('tbody tr')).toContainText(['Active']);
      expect((await keysOf(theirs.who)).map((k) => k.revoked)).toEqual([false]);
    } finally {
      await theirPage.context().close();
    }
  } finally {
    await mine.page.context().close();
    await theirs.page.context().close();
  }
});

test(`${J} #6 an operator reports a leaked key string: revoked with one audit entry and one notice; a second report is a no-op; a string that matches nothing gets an identical reply`, async ({
  browser,
}) => {
  test.setTimeout(360_000);
  const { page, who } = await keyHolder(browser, 'jd7k');
  try {
    const cred = { key: await makeKey(page, { name: 'bot-1' }) };
    const keyId = await keyIdOf(page, 'bot-1');
    await expectVerifies(cred, 'the key before the report');

    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const ops = await gates.operatorSessions(ctx);
    const token = await ops.a.complianceToken();
    const report = async (key) => {
      const res = await ctx.edge.mutate('identity', 'developerKeys.reportLeaked', { key }, token);
      return { status: res.status, body: res.json ?? res.text };
    };
    const audit = async () => {
      const res = await ctx.edge.query('identity', 'developerKeys.operatorAudit', { keyId, limit: 50 }, token);
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      return res.json.result.data.entries;
    };
    const notices = async () => {
      await page.goto('/notifications');
      return page.getByTestId('nf-row').filter({ has: page.getByTestId('nf-title').getByText('API key revoked', { exact: true }) });
    };

    // The report: the key is revoked, with one audit entry and one notice to its holder.
    const first = await report(cred.key);
    expect(first.status, JSON.stringify(first.body).slice(0, 300)).toBe(200);
    await expectDead(cred, 'the reported key');
    const listed = (await keysOf(who)).find((k) => k.id === keyId);
    expect(listed).toMatchObject({ revoked: true, revokedBy: 'operator' });
    await expect.poll(async () => (await audit()).length, { timeout: 20_000 }).toBe(1);
    await expect(async () => {
      await expect(await notices()).toHaveCount(1, { timeout: 2_000 });
    }).toPass({ timeout: 45_000 });

    // A second report of the same string is a no-op: the same reply, and still one audit entry and one notice.
    const second = await report(cred.key);
    expect(second).toEqual(first);
    await page.waitForTimeout(5_000);
    expect(await audit()).toHaveLength(1);
    await expect(await notices()).toHaveCount(1);
    expect(standing((await keysOf(who)).find((k) => k.id === keyId))).toEqual(standing(listed));

    // A string that matches no key gets an identical reply, so a report never tells whether a string was a key.
    const nothing = await report(`ifc_${'TESTnomatch'.padEnd(40, '0')}`);
    expect(nothing).toEqual(first);
  } finally {
    await page.context().close();
  }
});
