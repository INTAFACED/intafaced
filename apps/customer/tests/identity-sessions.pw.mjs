import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const service = await import(pathToFileURL(process.env.IDENTITY_SESSION_SERVICE_FIXTURE).href);
const owner = '11111111-1111-4111-8111-111111111111',
  other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  one = '22222222-2222-4222-8222-222222222222',
  two = '33333333-3333-4333-8333-333333333333';
// Both inside the last 24 hours, so neither row is folded behind "Show N more" (that has its own check below).
const stamp = new Date(Date.now() - 2 * 3_600_000).toISOString(),
  older = new Date(Date.now() - 3 * 3_600_000).toISOString(),
  key = 'intafaced.customer.session-revoke.v1:' + owner;
const evidence = process.env.IDENTITY_SESSION_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const errors = new WeakMap(),
  summary = [];
test.beforeEach(async ({ context }) => {
  const list = [];
  errors.set(context, list);
  const observe = (page) => page.on('pageerror', (e) => list.push(e.message));
  context.pages().forEach(observe);
  context.on('page', observe);
});
test.afterEach(async ({ context }, info) => {
  expect(errors.get(context)).toEqual([]);
  summary.push({ name: info.title, status: info.status, pageErrors: errors.get(context) });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summary, null, 2)));
async function network(context, options = {}) {
  const state = {
    owner,
    reads: [],
    writes: [],
    rows: [
      { id: one, user_id: owner, created_at: new Date(stamp), revoked: false },
      { id: two, user_id: owner, created_at: new Date(older), revoked: false },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', user_id: other, created_at: new Date(stamp), revoked: false },
    ],
    ...options,
  };
  const tokens = new Map();
  state.tokens = tokens;
  let sequence = 0;
  state.sql = async (strings, ...values) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('select'))
      return state.rows
        .filter((r) => r.user_id === values[0] && !r.revoked)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, values[1])
        .map((r) => ({ id: r.id, created_at: r.created_at, revoked: r.revoked }));
    if (text.includes('update sessions')) {
      const r = state.rows.find((r) => r.id === values[0] && r.user_id === values[1] && !r.revoked);
      if (r) {
        r.revoked = true;
        return [{ id: r.id }];
      }
      return [];
    }
    throw Error('Unexpected isolated SQL');
  };
  await context.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1)),
      input = req.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : req.postDataJSON();
    const reply = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    if (procedure === 'auth.login') {
      const token = 'isolated-seat-' + ++sequence;
      tokens.set(token, state.owner);
      return reply({
        userId: state.owner,
        accessToken: token,
        refreshToken: 'isolated-refresh-' + sequence,
        expiresAt: state.expiresAt ?? '2027-10-10T09:41:00.000Z',
      });
    }
    if (procedure === 'auth.logout') return reply({ ok: true });
    (req.method() === 'GET' ? state.reads : state.writes).push({ procedure, input });
    if (state[procedure]) return state[procedure](route, input, reply);
    if (procedure === 'webauthn.list') return reply([]);
    if (procedure === 'listSessions') {
      const r = await service.listSessions(state.sql, input.userId, input.limit);
      return reply({ ...r, sessions: r.sessions.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })) });
    }
    if (procedure === 'revokeSession')
      return reply(
        await service.revokeNamedSession(
          state.sql,
          tokens.get(req.headers().authorization?.replace('Bearer ', '')),
          input.userId,
          input.sessionId,
        ),
      );
    return route.fulfill({
      status: 503,
      json: { error: { message: 'Isolated unavailable read', data: { cause: { code: 'SERVICE_UNAVAILABLE' } } } },
    });
  });
  return state;
}
async function login(page, path = '/uc/safe') {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new URL(path, test.info().project.use.baseURL).href);
}
const region = (page, name = 'Where you’re signed in') => page.getByRole('region', { name, exact: true });
// Rows no longer show the session id; the row carries it as a data attribute so a test can still pick one.
const seatButton = (page, id = one) =>
  region(page)
    .locator('[data-session-id="' + id + '"]')
    .getByRole('button', { name: /^Sign out the session last active / });
const unknown = (page) => region(page).getByRole('region', { name: 'Original revoke is not confirmed', exact: true });
const receipt = (page) => region(page).getByRole('region', { name: 'Sign-out result', exact: true });
async function send(page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out this session', exact: true }).click();
}
async function marker(page) {
  return page.evaluate((key) => localStorage.getItem(key), key);
}
async function shot(page, name) {
  await page.screenshot({ path: evidence + '/' + name + '.png', fullPage: true });
}
async function viewLocale(context, lang) {
  const view = await context.newPage();
  await login(view, '/view');
  await view
    .locator('select')
    .filter({ has: view.locator('option[value="es"]') })
    .selectOption(lang);
  return view;
}
async function logout(page) {
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
}
const fail = (route, status = 503, message = 'Isolated lost response', code = 'ISOLATED_REFUSAL') =>
  route.fulfill({ status, json: { error: { message, data: { cause: { code } } } } });

test('native owner inspection to original reviewed session and matching true receipt', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await expect(seatButton(page)).toBeVisible();
  await expect(region(page)).toContainText(stamp.slice(0, 4));
  await seatButton(page).click();
  await expect(page.getByRole('dialog')).toContainText('Last active ');
  await expect(page.getByRole('dialog')).not.toContainText(one);
  expect(state.writes).toEqual([]);
  await send(page);
  await expect(receipt(page)).toContainText('The service revoked the selected session.');
  await expect(receipt(page)).toContainText('Last active ');
  await expect(receipt(page)).not.toContainText(one);
  await expect(receipt(page)).not.toContainText(owner);
  await expect(seatButton(page)).toHaveCount(0);
  await expect(seatButton(page, two)).toBeEnabled();
  expect(state.writes).toEqual([{ procedure: 'revokeSession', input: { userId: owner, sessionId: one } }]);
  expect(await marker(page)).toBeNull();
  expect(
    state.reads
      .filter((r) => r.procedure === 'listSessions')
      .every((r) => r.input.userId === owner && r.input.limit >= 1 && r.input.limit <= 200),
  ).toBe(true);
  await shot(page, 'confirmed-desktop');
});
test('native matching false is no live change and not recovery of an earlier request', async ({ page, context }) => {
  const state = await network(context, {
    revokeSession: (route, input, reply) => reply({ userId: input.userId, sessionId: input.sessionId, revoked: false }),
  });
  await login(page);
  await seatButton(page).click();
  await send(page);
  await expect(receipt(page)).toContainText('This result changed no session');
  await expect(receipt(page)).toContainText('Last active ');
  await expect(receipt(page)).not.toContainText(one);
  await expect(receipt(page)).not.toContainText(owner);
  expect(await marker(page)).toBeNull();
  expect(state.writes).toHaveLength(1);
});
for (const malformed of ['owner', 'duplicate', 'date', 'impossibleDate', 'overLimit', 'order'])
  test('native malformed live read ' + malformed + ' hides session controls', async ({ page, context }) => {
    const state = await network(context);
    state.listSessions = (route, input, reply) => {
      const rows = [
        { id: one, createdAt: stamp, revoked: false },
        { id: two, createdAt: older, revoked: false },
      ];
      return reply({
        userId: malformed === 'owner' ? other : owner,
        sessions:
          malformed === 'duplicate'
            ? [rows[0], rows[0]]
            : malformed === 'date'
              ? [{ ...rows[0], createdAt: 'invalid-date' }]
              : malformed === 'impossibleDate'
                ? [{ ...rows[0], createdAt: '2026-02-30T09:41:00.000Z' }]
                : malformed === 'overLimit'
                  ? Array.from({ length: input.limit + 1 }, () => rows[0])
                  : malformed === 'order'
                    ? [rows[1], rows[0]]
                    : rows,
      });
    };
    await login(page);
    await expect(region(page).getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await expect(region(page).locator('time')).toHaveCount(0);
    await expect(region(page).getByRole('button', { name: /^Sign out the session last active / })).toHaveCount(0);
    await expect(region(page)).not.toContainText('Invalid Date');
    expect(state.writes).toEqual([]);
  });
test('native failed refresh hides old rows then GET-only retry restores bounded same owner', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await expect(seatButton(page)).toBeVisible();
  state.listSessions = (route) => fail(route, 503, 'Session reader unavailable');
  await region(page).getByRole('button', { name: 'Refresh sessions', exact: true }).click();
  await expect(region(page)).toContainText('Session reader unavailable');
  await expect(seatButton(page)).toHaveCount(0);
  delete state.listSessions;
  await region(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(seatButton(page)).toBeVisible();
  expect(state.writes).toEqual([]);
  await shot(page, 'read-retry');
});
test('native zero live window stays distinct from read refusal and does not prove a revoke', async ({ page, context }) => {
  const state = await network(context, { rows: [] });
  await login(page);
  await expect(region(page)).toContainText('No active sessions');
  await expect(receipt(page)).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
test('native explicit live window is bounded50 100 150 200 with no cursor or completeness', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  for (const n of [100, 150, 200]) {
    await region(page).getByRole('button', { name: 'Show more', exact: true }).click();
    await expect.poll(() => state.reads.filter((r) => r.procedure === 'listSessions').at(-1)?.input.limit).toBe(n);
  }
  await expect(region(page)).toContainText('older sessions may not be listed');
  await expect(region(page).getByRole('button', { name: 'Show more', exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
for (const changed of ['absent', 'createdAt'])
  test('native original ' + changed + ' fresh seat refuses before journal or POST', async ({ page, context }) => {
    const state = await network(context);
    await login(page);
    await seatButton(page).click();
    state.listSessions = (route, input, reply) =>
      reply({ userId: owner, sessions: changed === 'absent' ? [] : [{ id: one, createdAt: older, revoked: false }] });
    await send(page);
    await expect(region(page)).toContainText('The session changed or is no longer in the list.');
    expect(state.writes).toEqual([]);
    expect(await marker(page)).toBeNull();
  });
test('native fresh original read refusal permits explicit review after read-only retry', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await seatButton(page).click();
  state.listSessions = (route) => fail(route, 503, 'Fresh owner read failed');
  await send(page);
  await expect(region(page)).toContainText('Fresh owner read failed');
  expect(state.writes).toEqual([]);
  expect(await marker(page)).toBeNull();
  delete state.listSessions;
  await region(page).getByRole('button', { name: 'Refresh sessions', exact: true }).click();
  await seatButton(page).click();
  await send(page);
  await expect(receipt(page)).toBeVisible();
  expect(state.writes).toHaveLength(1);
});
for (const mismatch of ['owner', 'seat', 'boolean'])
  test('native impossible revoke ' + mismatch + ' keeps original unknown journal', async ({ page, context }) => {
    const state = await network(context, {
      revokeSession: (route, input, reply) =>
        reply({
          userId: mismatch === 'owner' ? other : owner,
          sessionId: mismatch === 'seat' ? two : one,
          revoked: mismatch === 'boolean' ? 'yes' : true,
        }),
    });
    await login(page);
    await seatButton(page).click();
    await send(page);
    await expect(unknown(page)).toContainText(one);
    await expect(seatButton(page, two)).toBeDisabled();
    const original = await marker(page);
    expect(JSON.parse(original).owner).toBe(owner);
    expect(JSON.parse(original).seat.id).toBe(one);
    await region(page).getByRole('button', { name: 'Refresh sessions', exact: true }).click();
    await expect(seatButton(page, two)).toBeDisabled();
    expect(await marker(page)).toBe(original);
    expect(state.writes).toHaveLength(1);
  });
test('native lost revoke preserves original journal through Support and history even if absent', async ({ page, context }) => {
  const state = await network(context, { revokeSession: (route) => fail(route) });
  await login(page);
  await seatButton(page).click();
  await send(page);
  await expect(unknown(page)).toContainText(one);
  const original = await marker(page);
  state.rows = state.rows.filter((row) => row.id !== one);
  await region(page).getByRole('button', { name: 'Refresh sessions', exact: true }).click();
  await expect(seatButton(page)).toHaveCount(0);
  expect(await marker(page)).toBe(original);
  await unknown(page).getByRole('link', { name: 'Contact Support', exact: true }).click();
  await expect(page).toHaveURL(new URL('/support', test.info().project.use.baseURL).href);
  expect(await marker(page)).toBe(original);
  await page.goBack();
  await expect(unknown(page)).toContainText(one);
  await expect(unknown(page)).toContainText('Reference for Support');
  await expect(unknown(page)).not.toContainText(owner);
  await expect(seatButton(page, two)).toBeDisabled();
  expect(await marker(page)).toBe(original);
  expect(state.writes).toHaveLength(1);
  await shot(page, 'unknown-support-return');
});
test('native typed refusal stays distinct from unknown and allows new explicit original review', async ({ page, context }) => {
  const state = await network(context, { revokeSession: (route) => fail(route, 403, 'Permission refused', 'IDENTITY_WRITE_REFUSED') });
  await login(page);
  await seatButton(page).click();
  await send(page);
  await expect(region(page)).toContainText('Permission refused');
  await expect(unknown(page)).toHaveCount(0);
  expect(await marker(page)).toBeNull();
  await expect(seatButton(page)).toBeEnabled();
  delete state.revokeSession;
  await seatButton(page).click();
  await send(page);
  await expect(receipt(page)).toBeVisible();
  expect(state.writes).toHaveLength(2);
});
for (const unavailable of ['writeStorage', 'readStorage', 'locks'])
  test('native unavailable ' + unavailable + ' refuses before POST', async ({ page, context }) => {
    const state = await network(context);
    await login(page);
    await seatButton(page).click();
    await page.evaluate(
      ({ which, key }) => {
        if (which === 'locks') Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
        else {
          const original = Storage.prototype[which === 'writeStorage' ? 'setItem' : 'getItem'];
          Storage.prototype[which === 'writeStorage' ? 'setItem' : 'getItem'] = function (k, ...rest) {
            if (k === key) throw new Error('Isolated storage refusal');
            return original.call(this, k, ...rest);
          };
        }
      },
      { which: unavailable, key },
    );
    await send(page);
    await expect(region(page)).toContainText(
      unavailable === 'locks' ? 'Safe coordination between tabs is unavailable' : 'The original request cannot be safely saved or read',
    );
    expect(state.writes).toEqual([]);
  });
test('native corrupt or foreign-owner journal blocks without displaying private references', async ({ page, context }) => {
  const state = await network(context);
  await login(page, '/view');
  await page.evaluate(
    ({ key, other, two }) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          requestId: crypto.randomUUID(),
          owner: other,
          seat: { id: two, createdAt: '2026-10-10T09:41:00.000Z', revoked: false },
          createdAt: new Date().toISOString(),
        }),
      ),
    { key, other, two },
  );
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('link', { name: 'Security', exact: true }).click();
  await expect(region(page)).toContainText('The original request cannot be safely saved or read');
  await expect(region(page)).not.toContainText(other);
  await expect(seatButton(page)).toBeDisabled();
  expect(state.writes).toEqual([]);
});
test('native logout during held successful fresh read creates no journal or phantom revoke', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await seatButton(page).click();
  let release;
  state.listSessions = async (route, input, reply) => {
    await new Promise((done) => (release = done));
    return reply({ userId: owner, sessions: [{ id: one, createdAt: stamp, revoked: false }] });
  };
  await send(page);
  await expect.poll(() => typeof release).toBe('function');
  await logout(page);
  release();
  await expect(region(page)).toHaveCount(0);
  expect(state.writes.filter((r) => r.procedure === 'revokeSession')).toEqual([]);
  expect(await marker(page)).toBeNull();
});
test('native route departure during held fresh read cannot dispatch after unmount', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await seatButton(page).click();
  let release;
  state.listSessions = async (route, input, reply) => {
    await new Promise((done) => (release = done));
    return reply({ userId: owner, sessions: [{ id: one, createdAt: stamp, revoked: false }] });
  };
  await send(page);
  await expect.poll(() => typeof release).toBe('function');
  await page.locator('a[href="/more"]:visible').first().click();
  release();
  await expect(page).toHaveURL(new URL('/more', test.info().project.use.baseURL).href);
  expect(state.writes).toEqual([]);
  expect(await marker(page)).toBeNull();
});
test('native token change for same owner during fresh read refuses original dispatch', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await seatButton(page).click();
  let release;
  state.listSessions = async (route, input, reply) => {
    await new Promise((done) => (release = done));
    return reply({ userId: owner, sessions: [{ id: one, createdAt: stamp, revoked: false }] });
  };
  await send(page);
  await expect.poll(() => typeof release).toBe('function');
  await logout(page);
  delete state.listSessions;
  await login(page);
  release();
  await expect(seatButton(page)).toBeVisible();
  expect(state.writes.filter((r) => r.procedure === 'revokeSession')).toEqual([]);
  expect(await marker(page)).toBeNull();
});
test('native other owner cannot see or clear prior owner unknown context', async ({ page, context }) => {
  const state = await network(context, { revokeSession: (route) => fail(route) });
  await login(page);
  await seatButton(page).click();
  await send(page);
  await expect(unknown(page)).toBeVisible();
  const original = await marker(page);
  await logout(page);
  state.owner = other;
  await login(page);
  await expect(region(page)).not.toContainText(one);
  await expect(unknown(page)).toHaveCount(0);
  expect(await marker(page)).toBe(original);
  await logout(page);
  state.owner = owner;
  await login(page);
  await expect(unknown(page)).toContainText(one);
  expect(await marker(page)).toBe(original);
  expect(state.writes.filter((r) => r.procedure === 'revokeSession')).toHaveLength(1);
});
for (const locale of ['es', 'fr'])
  test('native View ' + locale + ' updates review and unknown text without original request change', async ({ page, context }) => {
    const state = await network(context, { revokeSession: (route) => fail(route) });
    await login(page);
    await seatButton(page).click();
    await viewLocale(context, locale);
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('button', { name: locale === 'es' ? 'Revocar esta sesión' : 'Révoquer cette session', exact: true }),
    ).toBeVisible();
    await expect(dialog).not.toContainText(one);
    await dialog.getByRole('button', { name: locale === 'es' ? 'Revocar esta sesión' : 'Révoquer cette session', exact: true }).click();
    const scoped = region(page, locale === 'es' ? 'Sesiones de identidad activas' : 'Sessions d’identité actives');
    await expect(
      scoped.getByRole('heading', {
        name: locale === 'es' ? 'La revocación original no está confirmada' : 'La révocation initiale n’est pas confirmée',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      scoped.getByRole('link', { name: locale === 'es' ? 'Contactar con soporte' : 'Contacter l’assistance', exact: true }),
    ).toBeVisible();
    expect(state.writes).toEqual([{ procedure: 'revokeSession', input: { userId: owner, sessionId: one } }]);
    expect(JSON.parse(await marker(page)).seat.id).toBe(one);
    await shot(page, 'unknown-' + locale);
  });
for (const width of [320, 390, 768])
  test('native ' + width + ' keyboard original review and row touch fit', async ({ page, context }) => {
    const state = await network(context);
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    const button = seatButton(page);
    await expect(button).toBeVisible();
    await button.focus();
    await expect(button).toBeFocused();
    expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toContainText('Last active ');
    await page.keyboard.press('Escape');
    await expect(button).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(region(page)).not.toContainText(one);
    expect(state.writes).toEqual([]);
    await shot(page, 'sessions-phone-' + width);
  });
test('native two tabs held fresh read and unknown result prevent duplicate revoke', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  const second = await context.newPage();
  await login(second);
  await seatButton(page).click();
  await seatButton(second, two).click();
  let release,
    held = false;
  state.listSessions = async (route, input, reply) => {
    if (!held) {
      held = true;
      await new Promise((done) => (release = done));
    }
    const out = await service.listSessions(state.sql, input.userId, input.limit);
    return reply({ ...out, sessions: out.sessions.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })) });
  };
  state.revokeSession = (route) => fail(route);
  await send(page);
  await expect.poll(() => typeof release).toBe('function');
  await send(second);
  await expect(region(second)).toContainText('Another tab is reviewing or sending');
  expect(state.writes).toEqual([]);
  release();
  await expect(unknown(page)).toContainText(one);
  await expect(unknown(second)).toContainText(one);
  await expect(seatButton(second, two)).toBeDisabled();
  expect(state.writes).toHaveLength(1);
});
test('native closed sending tab retains same original journal in newly signed-in tab', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await seatButton(page).click();
  let release;
  state.revokeSession = async (route) => {
    await new Promise((done) => (release = done));
    return fail(route);
  };
  await send(page);
  await expect.poll(() => typeof release).toBe('function');
  const original = await marker(page);
  await page.close();
  release();
  const reopened = await context.newPage();
  await login(reopened);
  await expect(unknown(reopened)).toContainText(one);
  await expect(seatButton(reopened, two)).toBeDisabled();
  expect(await marker(reopened)).toBe(original);
  expect(state.writes).toHaveLength(1);
});
test('native guest private route makes no owner session requests or writes', async ({ page, context }) => {
  const state = await network(context);
  await page.goto('/uc/safe');
  await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(state.reads.filter((r) => r.procedure === 'listSessions')).toEqual([]);
  expect(state.writes).toEqual([]);
});
test('native session journey has no serious or critical accessibility violations', async ({ page, context }) => {
  await network(context);
  await login(page);
  await expect(seatButton(page)).toBeVisible();
  const report = await new AxeBuilder({ page }).include('[data-testid="identity-sessions"]').analyze();
  writeFileSync(evidence + '/axe.json', JSON.stringify(report, null, 2));
  expect(report.violations.filter((v) => ['serious', 'critical'].includes(v.impact))).toEqual([]);
});

test('native actual refresh changes token while original review is open and refuses dispatch', async ({ page, context }) => {
  const state = await network(context, { expiresAt: new Date(Date.now() + 34000).toISOString() });
  let release,
    refreshed = false;
  state['auth.refresh'] = async (route, input, reply) => {
    await new Promise((done) => (release = done));
    state.tokens.set('isolated-refreshed-seat', owner);
    refreshed = true;
    return reply({
      userId: owner,
      accessToken: 'isolated-refreshed-seat',
      refreshToken: 'isolated-refreshed-refresh',
      expiresAt: '2027-10-10T09:41:00.000Z',
    });
  };
  await login(page);
  await seatButton(page).click();
  await expect.poll(() => typeof release).toBe('function');
  const completedRefresh = page.waitForResponse((response) => response.url().includes('auth.refresh'));
  release();
  await completedRefresh;
  await expect.poll(() => refreshed).toBe(true);
  await expect.poll(() => state.reads.filter((r) => r.procedure === 'listSessions').length).toBeGreaterThan(0);

  await send(page);
  await expect(region(page)).toContainText('The account or original review changed. No revocation was sent.');
  expect(state.writes.filter((r) => r.procedure === 'revokeSession')).toEqual([]);
  expect(await marker(page)).toBeNull();
});

test('native known response with failed journal removal stays honest and blocks further revocation', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await seatButton(page).click();
  await page.evaluate((key) => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (k) {
      if (k === key) throw Error('Isolated removal refusal');
      return remove.call(this, k);
    };
  }, key);
  await send(page);
  await expect(receipt(page)).toContainText('The service revoked the selected session.');
  await expect(region(page).getByRole('region', { name: 'Result received; browser record kept', exact: true })).toContainText(one);
  await expect(unknown(page)).toHaveCount(0);
  await expect(seatButton(page, two)).toBeDisabled();
  const original = await marker(page);
  expect(JSON.parse(original).seat.id).toBe(one);
  await region(page).getByRole('link', { name: 'Contact Support', exact: true }).click();
  await page.goBack();
  await expect(unknown(page)).toContainText(one);
  expect(await marker(page)).toBe(original);
  await expect(seatButton(page, two)).toBeDisabled();
  expect(state.writes).toHaveLength(1);
});

test('native sessions not active in 24 hours fold behind Show N more and the list shows no session ids', async ({ page, context }) => {
  const stale = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const state = await network(context);
  state.rows.push({ id: stale, user_id: owner, created_at: new Date(Date.now() - 30 * 3_600_000), revoked: false });
  await login(page);
  await expect(seatButton(page)).toBeVisible();
  await expect(seatButton(page, stale)).toHaveCount(0);
  await expect(region(page)).not.toContainText(one);
  await expect(region(page)).not.toContainText(stale);
  await region(page).getByRole('button', { name: 'Show 1 more (not active in the last 24 hours)', exact: true }).click();
  await expect(seatButton(page, stale)).toBeVisible();
  await expect(region(page)).not.toContainText(stale);
  expect(state.writes).toEqual([]);
});
