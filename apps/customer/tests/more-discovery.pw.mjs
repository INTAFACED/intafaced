import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const baseURL = process.env.MORE_DISCOVERY_BASE_URL;
const evidence = process.env.MORE_DISCOVERY_EVIDENCE;
if (!baseURL || !evidence) throw new Error('Use the explicit verified-candidate environment from the More config.');
mkdirSync(evidence, { recursive: true });
const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '22222222-2222-4222-8222-222222222222';
const ticketId = '33333333-3333-4333-8333-333333333333';
const fixed = 'eacb77a102ba7f36db49b6fbb2f9cab7a74e826e';
const destinations = [
  '/academy',
  '/support',
  '/blueprint',
  '/quant',
  '/agents',
  '/trade/copy',
  '/trade/bots',
  '/market',
  '/token',
  '/predict',
  '/campaigns',
  '/launch',
  '/mining',
];
const main = (page) => page.locator('.app-shell main#main');
const link = (page, href) => main(page).locator(`a[href="${href}"]`);
const moreDoor = (page) =>
  page.locator('.door-nav a[href="/more"]:visible, .mobile-doors a[href="/more"]:visible, .trade-top-nav a[href="/more"]:visible').first();
const fullLocation = (page) => page.evaluate(() => location.pathname + location.search + location.hash);
const tick = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

// Exact fixed platform-native published body, not an invented production course.
// Embedded from svc-academy curriculum/content.ts at the pin above. All network
// responses remain isolated fixtures, not live content/service authority proof.
const lessonBody =
  "# Risk first\n\nEvery path in the Academy starts here. Before charts, before setups, before an\nagent is allowed near a live order — know what you can lose.\n\nRisk is the only part of a trade that is yours to decide. The market decides\nwhether you were right; you decide what being wrong costs. Everything below\nfollows from that split, and most of the ways people lose an account come from\nignoring it while believing they were doing analysis.\n\n## Position size\n\nSize from risk, not conviction. Pick the amount of capital you are willing to\nlose on the idea, then work the size backward from the level that proves the idea\nwrong. Conviction is not an input — it runs highest exactly when you are least\nable to assess it.\n\nThe mechanism is one division: the amount you accept losing, divided by the loss\nper unit over the distance to your invalidation level.\n\n### Worked example — illustrative arithmetic only\n\nThe numbers are invented to show the arithmetic. They are not a quote, an\nobservation, or anyone's result.\n\n- Account: 10,000 units of the quote currency.\n- Risk accepted on this idea, chosen in advance: 1 percent — so 100 units.\n- The idea is disproved 5 units of price away from your intended entry.\n- Size = 100 / 5 = 20 units of the instrument.\n\nMove the invalidation to 10 units away and the size halves to 10. The amount at\nrisk did not change. That is the property worth having: your loss when wrong is a\nnumber you chose in advance rather than one the market handed you afterwards.\n\n## Drawdown\n\nDrawdown is the decline from a previous high in account value. It matters because\nrecovery is not symmetrical with loss — the deeper the hole, the larger the gain\nneeded to climb out of it, and that arithmetic is indifferent to how the hole was\ndug.\n\nA daily loss prompt is a brake, not a challenge. Identity Blueprint guardrails\nseed a default; you may raise it, never ignore it quietly. A limit gets all of\nits value from being set before the day it binds, so that the version of you\nwho is losing does not get to renegotiate with the version who was thinking\nclearly.\n\n## Common mistakes\n\n- Sizing from what the account can afford rather than from where the idea fails.\n- Adding size after a run of winners, which raises the cost of the next loss\n  precisely when the internal case for restraint is weakest.\n- Treating a leverage setting as a risk setting. Leverage changes the margin\n  required to hold a position; it does not change the loss over the invalidation\n  distance.\n- Holding several positions that share one driver and counting them as several\n  independent risks.\n\n## What this is not\n\nThis playbook does not move money. Paper practice lands with the workbook flag on\nthe trade service. Live size is your call, on your rails.\n\n## Before you move on\n\nWrite down two numbers: the fraction of the account you will risk on a single\nidea, and the daily loss at which you stop for the day. In writing, before your\nnext order — not during it.";
const lesson = {
  slug: 'foundations-risk-first',
  title: 'Risk first',
  kind: 'playbook',
  path: 'foundations',
  order: 10,
  summary: 'Position size, drawdown, and why capital preservation is the first skill.',
  estimatedMinutes: Math.max(1, Math.ceil(lessonBody.trim().split(/\s+/).length / 200)),
  body: lessonBody,
  objectives: [
    'State the maximum you are willing to lose on an idea before you look at the entry.',
    'Derive position size from an invalidation level rather than from conviction.',
    'Explain why a daily loss limit is a brake rather than a target to reach.',
  ],
  keyTerms: [
    {
      term: 'Capital preservation',
      definition: 'Treating the survival of the account as the constraint every other decision fits inside.',
    },
    { term: 'Drawdown', definition: 'The decline from a previous high in account value, measured over a stated period.' },
    { term: 'Guardrail', definition: 'A pre-set limit that constrains an action, applied by default rather than recalled under pressure.' },
  ],
  selfCheck: [
    'What fraction of the account are you willing to lose on a single idea, and when did you decide it?',
    'If your invalidation level moves twice as far away, what happens to your position size?',
    'Which of your limits is enforced by something other than your own memory?',
  ],
  locale: 'en',
  fellBack: false,
  i18nStrategy: 'default=en withBodies=en fallback=default neverInvent=1',
};
const summary = (({ slug, title, kind, path, order, summary, estimatedMinutes }) => ({
  slug,
  title,
  kind,
  path,
  order,
  summary,
  estimatedMinutes,
}))(lesson);
const kb = {
  id: 'kb-account-access',
  titleKey: 'support.kb.account_access.title',
  bodyKey: 'support.kb.account_access.body',
  version: 1,
  revision: 1,
  published: true,
};
const supportText = { subject: 'Original <reader> / propriétaire', body: 'Original private message, exactly supplied by this browser.' };
const ticket = (owner, input) => ({
  id: ticketId,
  userId: owner,
  category: input.category,
  subject: input.subject,
  body: input.body,
  status: 'open',
  assigneeId: null,
  createdAt: '2026-10-10T08:00:00.000Z',
  updatedAt: '2026-10-10T08:00:00.000Z',
});

async function network(context) {
  const state = { owner: ownerA, token: 1, reads: [], writes: [], unexpectedWrites: [], errors: [], cancelled: [], tickets: [] };
  state.lesson = async (input) =>
    input.slug === lesson.slug ? { status: 200, data: { ...lesson, fellBack: input.locale !== 'en' } } : { status: 404 };
  state.complete = async (input) => ({
    status: 200,
    data: { userId: state.owner, itemSlug: input.itemSlug, completedAt: '2026-10-10T08:00:00.000Z' },
  });
  state.search = async () => ({ status: 200, data: [kb] });
  state.create = async (input) => {
    const row = ticket(state.owner, input);
    state.tickets = [row];
    return { status: 200, data: row };
  };
  const observe = (page) => page.on('pageerror', (error) => state.errors.push(error.message));
  context.pages().forEach(observe);
  context.on('page', observe);
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : request.postDataJSON();
    const service = url.pathname.split('/')[2];
    const reply = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    if (procedure === 'auth.login')
      return reply({
        userId: state.owner,
        accessToken: `isolated-more-token-${state.token}`,
        refreshToken: `isolated-more-refresh-${state.token}`,
        expiresAt: '2027-10-10T08:00:00Z',
      });
    if (procedure === 'auth.logout') return reply({ ok: true });
    let answer;
    if (request.method() !== 'GET') {
      const write = {
        service,
        procedure,
        method: request.method(),
        body: input,
        idempotency: request.headers()['idempotency-key'] ?? null,
      };
      if (service === 'academy' && procedure === 'markCurriculumComplete') {
        state.writes.push(write);
        answer = await state.complete(input);
      } else if (service === 'support' && procedure === 'create') {
        state.writes.push(write);
        answer = await state.create(input);
      } else {
        state.unexpectedWrites.push(write);
        answer = { status: 503 };
      }
    } else {
      state.reads.push({ service, procedure, input });
      if (service === 'academy' && procedure === 'curriculum')
        answer = {
          status: 200,
          data: [summary]
            .filter((row) => (!input?.path || row.path === input.path) && (!input?.kind || row.kind === input.kind))
            .slice(0, input?.limit ?? 0),
        };
      else if (service === 'academy' && procedure === 'curriculumItemLocalized') answer = await state.lesson(input);
      else if (service === 'academy' && procedure === 'certDefinitions') answer = { status: 200, data: [] };
      else if (service === 'support' && procedure === 'searchKb') answer = await state.search(input);
      else if (service === 'support' && procedure === 'listMine') answer = { status: 200, data: state.tickets };
      else if (service === 'support' && procedure === 'get')
        answer = state.tickets.find((row) => row.id === input.ticketId)
          ? { status: 200, data: state.tickets.find((row) => row.id === input.ticketId) }
          : { status: 404 };
      else if (service === 'support' && ['listComments', 'events'].includes(procedure)) answer = { status: 200, data: [] };
      else answer = { status: 503 };
    }
    try {
      return await route.fulfill({
        status: answer.status,
        json:
          answer.status === 200
            ? { result: { data: answer.data } }
            : { error: { message: 'Isolated published contract unavailable', data: { intafacedCode: 'fixture.unavailable' } } },
      });
    } catch (error) {
      state.cancelled.push(error.message);
      return;
    }
  });
  return state;
}
async function scenario(browser, name, run) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
  const state = await network(context),
    page = await context.newPage();
  try {
    await run({ context, page, state });
    expect(state.unexpectedWrites).toEqual([]);
    expect(state.errors).toEqual([]);
  } finally {
    writeFileSync(
      `${evidence}/${name}.json`,
      JSON.stringify({ fixedFixtureSource: fixed, ...state }, (_key, value) => (typeof value === 'function' ? undefined : value), 2),
    );
    await context.close();
  }
}
async function login(page, destination = '/more', newDocument = true) {
  if (newDocument) await page.goto('/login?redirect=' + encodeURIComponent(destination));
  else await page.locator('a.button[href^="/login?redirect="]').click();
  await page.locator('input[autocomplete="username"]').fill('isolated-more-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-more-password');
  await page.locator('form button[type="submit"]').click();
  await expect.poll(() => fullLocation(page)).toBe(destination);
  await expect(main(page).getByRole('heading', { level: 1 })).toBeVisible();
}
async function returnMore(page) {
  await moreDoor(page).click();
  await expect.poll(() => fullLocation(page)).toBe('/more');
  await expect(link(page, '/academy')).toBeVisible();
}
async function follow(page, href) {
  await link(page, href).click();
  await expect.poll(() => fullLocation(page)).toBe(href);
  await expect(main(page).getByRole('heading', { level: 1 })).toBeVisible();
}
async function viewLocale(page, locale) {
  await page.locator('.person-trigger').click();
  await page.getByRole('dialog').locator('a[href="/view"]').click();
  const language = page.locator('select').filter({ has: page.locator('option[value="ar"]') });
  await language.selectOption(locale);
  await expect(language).toHaveValue(locale);
  await returnMore(page);
  // Requested Arabic is retained; empty authored dictionaries render English.
  await expect(page.locator('html')).toHaveAttribute('lang', locale === 'ar' ? 'en' : locale);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
}
async function geometry(locator) {
  return locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const nav = document.querySelector('.mobile-doors');
    const box = nav?.getBoundingClientRect();
    const visible = nav && getComputedStyle(nav).display !== 'none' && box.height > 0;
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
      clearBottom: visible ? box.top : innerHeight,
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    };
  });
}
async function openLesson(page) {
  await follow(page, '/academy');
  const published = main(page).locator(`a[href^="/academy/${lesson.slug}"]`).filter({ hasText: lesson.title }).first();
  await expect(published).toBeVisible();
  await published.click();
  await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/academy/' + lesson.slug);
  await expect(main(page).locator('.more-body')).toBeVisible();
}
async function reviewCompletion(page) {
  await main(page).getByRole('button', { name: 'Review lesson completion', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Review lesson completion', exact: true })).toBeVisible();
}
async function supportForm(page) {
  const form = main(page)
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Review request', exact: true }) });
  await form.getByLabel('Subject', { exact: true }).fill(supportText.subject);
  await form.getByLabel('Message', { exact: true }).fill(supportText.body);
  return form;
}
const markerKey = (room) => `intafaced:more:pending:${ownerA}:${room}`;
async function marker(page, room) {
  return page.evaluate((key) => localStorage.getItem(key), markerKey(room));
}
async function privateNotDurable(page, values) {
  expect(
    await page.evaluate((values) => Object.values(localStorage).some((raw) => values.some((value) => raw.includes(value))), values),
  ).toBe(false);
}

test('thirteen full task targets retain auth return and enter actual accepted rooms with keyboard arrival', async ({ browser }) => {
  await scenario(browser, 'destinations-auth-arrival', async ({ page, state }) => {
    const destination = '/more?return=owner%2Broom#original';
    await page.goto(destination);
    await expect(page.locator('a.button[href^="/login?redirect="]')).toHaveAttribute(
      'href',
      '/login?redirect=' + encodeURIComponent(destination),
    );
    await login(page, destination, false);
    const hrefs = await main(page)
      .locator('a')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')).filter((href) => href && !href.startsWith('#')));
    expect([...new Set(hrefs)].sort()).toEqual([...destinations].sort());
    await expect(main(page).getByRole('heading', { name: 'Learn & connect', exact: true })).toBeVisible();
    await expect(main(page).getByRole('heading', { name: 'Research & automate', exact: true })).toBeVisible();
    await expect(main(page).getByRole('heading', { name: 'Explore & participate', exact: true })).toBeVisible();
    for (const [name, expected] of [
      ['Learn & connect', ['/academy', '/support', '/blueprint']],
      ['Research & automate', ['/quant', '/agents', '/trade/copy', '/trade/bots']],
      ['Explore & participate', ['/market', '/token', '/predict', '/campaigns', '/launch', '/mining']],
    ]) {
      await expect(main(page).getByRole('region', { name, exact: true })).toBeVisible();
      expect(
        await main(page)
          .getByRole('region', { name, exact: true })
          .locator('a')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href'))),
      ).toEqual(expected);
    }
    for (const href of destinations) {
      const target = link(page, href);
      await expect(target).toHaveCount(1);
      const size = await geometry(target);
      expect(size.height).toBeGreaterThanOrEqual(44);
      expect(size.width).toBeGreaterThanOrEqual(44);
      await target.click();
      await expect.poll(() => page.evaluate(() => location.pathname)).toBe(href);
      await expect(main(page).getByRole('heading', { level: 1 })).toBeVisible();
      await returnMore(page);
    }
    await expect(main(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(link(page, '/academy')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(link(page, '/support')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => fullLocation(page)).toBe('/support');
    await expect(main(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(main(page).getByLabel('Search help', { exact: true })).toBeFocused();
    await returnMore(page);
    await page.evaluate(() => {
      history.pushState(null, '', '/more?simulated=true#intent');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect
      .poll(async () =>
        main(page)
          .locator('a')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href'))),
      )
      .toEqual(destinations.map((href) => href + '?simulated=true'));
    await follow(page, '/trade/copy?simulated=true');
    await returnMore(page);
    await expect(link(page, '/trade/copy')).toHaveCount(1);
    expect(state.writes).toEqual([]);
    await privateNotDurable(page, ['isolated-more-password', 'isolated-more-token']);
  });
});

test('pathname arrival preserves public input, query/hash, native history scroll and current dialogs during route races', async ({
  browser,
}) => {
  for (const width of [1440, 390])
    await scenario(browser, `arrival-preservation-${width}`, async ({ page, state }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/login?redirect=' + encodeURIComponent('/more?return=exact#original'));
      const identifier = page.locator('input[autocomplete="username"]');
      await identifier.fill('isolated-more-owner');
      await page.keyboard.press('ArrowLeft');
      const selection = await identifier.evaluate((input) => ({ start: input.selectionStart, end: input.selectionEnd }));
      await tick(page);
      await expect(identifier).toBeFocused();
      expect(await identifier.evaluate((input) => ({ start: input.selectionStart, end: input.selectionEnd }))).toEqual(selection);
      await page.locator('input[autocomplete="current-password"]').fill('isolated-more-password');
      await page.locator('form button[type="submit"]').click();
      await expect.poll(() => fullLocation(page)).toBe('/more?return=exact#original');
      await expect(main(page)).toBeFocused();
      state.coldArrival = await main(page).evaluate((element) => ({
        focused: document.activeElement === element,
        text: element.innerText,
        targets: [...element.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href')),
      }));
      // Room focus exists around Suspense; native targets become available when code loads.
      await expect(link(page, '/academy')).toBeVisible();
      await expect(link(page, '/support')).toBeVisible();
      await expect(main(page)).toBeFocused();
      expect(await page.evaluate(() => scrollY)).toBe(0);
      await page.keyboard.press('Tab');
      await expect(link(page, '/academy')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(link(page, '/support')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect.poll(() => fullLocation(page)).toBe('/support');
      await expect(main(page)).toBeFocused();
      const search = main(page).getByLabel('Search help', { exact: true });
      await search.fill('account');
      await page.evaluate(() => {
        history.pushState(null, '', '/support?q=current#kept');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await expect(search).toBeFocused();
      await expect(search).toHaveValue('account');
      await page.evaluate(() => {
        location.hash = 'native-anchor';
      });
      await tick(page);
      await expect(search).toBeFocused();
      expect(await fullLocation(page)).toBe('/support?q=current#native-anchor');
      await page.locator('.skip-link').focus();
      await page.keyboard.press('Enter');
      await expect(main(page)).toBeFocused();
      expect(await fullLocation(page)).toBe('/support?q=current#main');
      await returnMore(page);
      await expect(main(page)).toBeFocused();
      await link(page, '/mining').scrollIntoViewIfNeeded();
      await page.keyboard.press('Control+k');
      const historySearch = page.getByRole('dialog').locator('input[name="global-search"]');
      await expect(historySearch).toBeFocused();
      await historySearch.fill('Support');
      const restored = await page.evaluate(() => scrollY);
      await page.getByRole('dialog').locator('a[href="/support"]').click();
      await expect.poll(() => fullLocation(page)).toBe('/support');
      await expect(main(page)).toBeFocused();
      await page.goBack();
      await expect.poll(() => fullLocation(page)).toBe('/more');
      await expect(main(page)).toBeFocused();
      await expect.poll(async () => Math.abs((await page.evaluate(() => scrollY)) - restored)).toBeLessThanOrEqual(2);
      await page.goForward();
      await expect.poll(() => fullLocation(page)).toBe('/support');
      await expect(main(page)).toBeFocused();
      await page.locator('.search-trigger').click();
      const global = page.getByRole('dialog').locator('input[name="global-search"]');
      await expect(global).toBeFocused();
      await global.fill('Academy');
      await page.getByRole('dialog').locator('a[href="/academy"]').click();
      await expect.poll(() => fullLocation(page)).toBe('/academy');
      await expect(main(page)).toBeFocused();
      await page.locator('.person-trigger').click();
      const currentDialog = page.getByRole('dialog');
      const currentClose = currentDialog.locator('header').getByRole('button');
      await expect(currentClose).toBeFocused();
      await tick(page);
      await expect(currentClose).toBeFocused();
      await expect(currentDialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.person-trigger')).toBeFocused();
      await returnMore(page);
      await page.evaluate(() => {
        document.querySelector('main a[href="/support"]').click();
        history.replaceState(null, '', '/more?race=returned#current');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await page.locator('.person-trigger').click();
      await expect(page.getByRole('dialog').locator('header').getByRole('button')).toBeFocused();
      await tick(page);
      await expect(page.getByRole('dialog').locator('header').getByRole('button')).toBeFocused();
      expect(await fullLocation(page)).toBe('/more?race=returned#current');
      await page.keyboard.press('Escape');
      let releaseRead;
      const delayedRead = new Promise((resolve) => {
        releaseRead = resolve;
      });
      const currentSearch = state.search;
      state.search = async () => {
        await delayedRead;
        return { status: 200, data: [kb] };
      };
      const beforeHeld = state.reads.filter(({ procedure }) => procedure === 'searchKb').length;
      await follow(page, '/support');
      await expect.poll(() => state.reads.filter(({ procedure }) => procedure === 'searchKb').length).toBe(beforeHeld + 1);
      await expect(main(page)).toBeFocused();
      await returnMore(page);
      await page.locator('.person-trigger').click();
      const survivingClose = page.getByRole('dialog').locator('header').getByRole('button');
      await expect(survivingClose).toBeFocused();
      releaseRead();
      await tick(page);
      await expect(survivingClose).toBeFocused();
      await expect(page.getByRole('dialog')).toBeVisible();
      state.search = currentSearch;
      await page.keyboard.press('Escape');
      await follow(page, '/support');
      await expect(main(page)).toBeFocused();
      await expect(main(page).getByText('Sign-in and account access', { exact: true })).toBeVisible();
      expect(state.writes).toEqual([]);
    });
});

test('published lesson has substantive original body, matched completion and honest changed/unknown recovery', async ({ browser }) => {
  for (const outcome of ['matched', 'changed', 'wrong-owner', 'unknown'])
    await scenario(browser, `academy-${outcome}`, async ({ page, state }) => {
      await login(page);
      await openLesson(page);
      await expect(main(page).locator('.more-body')).toContainText('The numbers are invented to show the arithmetic.');
      await expect(main(page).locator('.more-body')).toHaveAttribute('lang', 'en');
      await expect(main(page).getByText(lesson.objectives[0], { exact: true })).toBeVisible();
      await expect(main(page).getByText(lesson.keyTerms[0].definition, { exact: true })).toBeVisible();
      const before = state.reads.filter(({ procedure }) => procedure === 'curriculumItemLocalized').length;
      if (outcome === 'changed')
        state.lesson = async () => ({ status: 200, data: { ...lesson, body: lesson.body + '\nChanged published content.' } });
      if (outcome === 'wrong-owner')
        state.complete = async (input) => ({
          status: 200,
          data: { userId: ownerB, itemSlug: input.itemSlug, completedAt: '2026-10-10T08:00:00.000Z' },
        });
      if (outcome === 'unknown') state.complete = async () => ({ status: 503 });
      await reviewCompletion(page);
      await page.getByRole('dialog').getByRole('button', { name: 'Record completion', exact: true }).click();
      await expect.poll(() => state.reads.filter(({ procedure }) => procedure === 'curriculumItemLocalized').length).toBe(before + 1);
      if (outcome === 'changed') {
        await expect(
          main(page).getByText(
            'The original lesson could not be verified. No completion was sent. Refresh the lesson before reviewing again.',
            { exact: true },
          ),
        ).toBeVisible();
        expect(state.writes).toEqual([]);
      } else {
        await expect.poll(() => state.writes.length).toBe(1);
        expect(state.writes[0]).toMatchObject({
          service: 'academy',
          procedure: 'markCurriculumComplete',
          method: 'POST',
          body: { itemSlug: lesson.slug },
        });
        if (outcome === 'matched') {
          await expect(main(page).getByRole('heading', { name: 'Lesson completion receipt', exact: true })).toBeVisible();
          await expect(
            main(page).getByText(
              'This receipt records completion of this lesson for this account. It does not confirm mastery, a certificate or XP.',
              { exact: true },
            ),
          ).toBeVisible();
          await expect.poll(() => marker(page, 'academy')).toBeNull();
        } else {
          await expect.poll(() => marker(page, 'academy')).not.toBeNull();
          const raw = await marker(page, 'academy');
          await main(page).getByRole('link', { name: 'Return to library', exact: true }).click();
          await expect(main(page).getByRole('heading', { name: 'Original completion is not confirmed', exact: true })).toBeVisible();
          await expect(
            main(page).getByText('A read-only lesson receipt lookup is required. No automatic replay or new completion is sent.', {
              exact: true,
            }),
          ).toBeVisible();
          await main(page).getByRole('link', { name: 'Return to original lesson', exact: true }).click();
          await expect(main(page).getByRole('button', { name: 'Review lesson completion', exact: true })).toBeDisabled();
          expect(await marker(page, 'academy')).toBe(raw);
          expect(state.writes).toHaveLength(1);
        }
      }
      expect(state.writes.some(({ procedure }) => /grantCert|enroll|xp|trade|ledger/i.test(procedure))).toBe(false);
      await privateNotDurable(page, [lesson.body, lesson.objectives[0], 'isolated-more-password']);
    });
});

test('published Support answer leads to reviewed owner request; wrong/unknown replies preserve original without replay', async ({
  browser,
}) => {
  for (const outcome of ['matched', 'wrong-owner', 'unknown'])
    await scenario(browser, `support-${outcome}`, async ({ page, state }) => {
      await login(page);
      await follow(page, '/support');
      const search = main(page).locator('form.more-inline');
      await search.getByLabel('Search help', { exact: true }).fill('account');
      await search.getByRole('button', { name: 'Search', exact: true }).click();
      await expect
        .poll(() => state.reads.filter(({ procedure, input }) => procedure === 'searchKb' && input.q === 'account').length)
        .toBe(1);
      expect(state.reads.filter(({ procedure }) => procedure === 'searchKb').at(-1).input).toEqual({ q: 'account', limit: 50 });
      const article = main(page)
        .locator('details')
        .filter({ has: page.getByText('Sign-in and account access', { exact: true }) });
      await article.locator('summary').click();
      await expect(article.locator('p')).toHaveText(
        'If you cannot sign in, use account recovery from the sign-in screen. Support never asks for your password or recovery codes in chat.',
      );
      await expect(article.locator('p')).toHaveAttribute('lang', 'en');
      await expect(article).toContainText(kb.id);
      state.search = async () => ({
        status: 200,
        data: [{ ...kb, id: 'untranslated-original', titleKey: 'unpublished.title.key', bodyKey: 'unpublished.body.key' }],
      });
      await search.getByLabel('Search help', { exact: true }).fill('missing');
      await search.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(main(page).getByText('Published article text is unavailable for unpublished.title.key.', { exact: true })).toBeVisible();
      if (outcome === 'wrong-owner') state.create = async (input) => ({ status: 200, data: ticket(ownerB, input) });
      if (outcome === 'unknown') state.create = async () => ({ status: 503 });
      const form = await supportForm(page);
      await form.getByRole('button', { name: 'Review request', exact: true }).click();
      const review = page.getByRole('dialog', { name: 'Review support request', exact: true });
      await expect(review.getByText(supportText.subject, { exact: true })).toBeVisible();
      await expect(review.getByText(supportText.body, { exact: true })).toBeVisible();
      await review.getByRole('button', { name: 'Send request', exact: true }).click();
      await expect.poll(() => state.writes.length).toBe(1);
      expect(state.writes[0]).toMatchObject({
        service: 'support',
        procedure: 'create',
        method: 'POST',
        body: { category: 'other', ...supportText },
      });
      if (outcome === 'matched') {
        await expect(main(page).getByText('Request created', { exact: true })).toBeVisible();
        await expect(main(page).getByRole('button', { name: 'Open ' + supportText.subject, exact: true })).toBeVisible();
        await expect.poll(() => marker(page, 'support')).toBeNull();
      } else {
        await expect.poll(() => marker(page, 'support')).not.toBeNull();
        const raw = await marker(page, 'support');
        await returnMore(page);
        await follow(page, '/support');
        await expect(
          main(page).getByText(
            'This action has no universal recovery lookup. Keep its records and contact Support before sending another request.',
            { exact: true },
          ),
        ).toBeVisible();
        await expect((await supportForm(page)).getByRole('button', { name: 'Review request', exact: true })).toBeDisabled();
        await search.getByLabel('Search help', { exact: true }).fill('account');
        await search.getByRole('button', { name: 'Search', exact: true }).click();
        expect(await marker(page, 'support')).toBe(raw);
        expect(state.writes).toHaveLength(1);
      }
      await privateNotDurable(page, [supportText.subject, supportText.body, 'isolated-more-token']);
    });
});

test('four widths and real View EN/ES/FR/Arabic fallback preserve all task links, native targets and honest lesson language', async ({
  browser,
}) => {
  await scenario(browser, 'responsive-locales', async ({ page, state }) => {
    await login(page);
    const observations = [];
    for (const locale of ['en', 'es', 'fr', 'ar']) {
      await viewLocale(page, locale);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        const hrefs = await main(page)
          .locator('a')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')).filter((href) => href && !href.startsWith('#')));
        expect([...new Set(hrefs)].sort()).toEqual([...destinations].sort());
        for (const href of destinations) {
          const target = link(page, href);
          await target.scrollIntoViewIfNeeded();
          const bounds = await geometry(target);
          expect(bounds.scroll).toBeLessThanOrEqual(bounds.client);
          expect(bounds.left).toBeGreaterThanOrEqual(0);
          expect(bounds.right).toBeLessThanOrEqual(width);
          expect(bounds.height).toBeGreaterThanOrEqual(44);
          // Bottom targets must be reachable through native keyboard without a nav overlay.
          if (href === '/mining') {
            await target.focus();
            await page.keyboard.press('Tab');
            await page.keyboard.press('Shift+Tab');
            await expect(target).toBeFocused();
            await tick(page);
            const focused = await geometry(target);
            expect(focused.bottom).toBeLessThanOrEqual(focused.clearBottom);
          }
        }
        const primary = link(page, '/academy');
        const words = await primary
          .locator('[data-i18n]')
          .evaluateAll((nodes) => nodes.map((node) => ({ language: node.lang, direction: node.dir, text: node.textContent })));
        expect(words.length).toBeGreaterThan(0);
        expect(words.every(({ language }) => language === (locale === 'ar' ? 'en' : locale))).toBe(true);
        expect(words.every(({ direction }) => direction === 'ltr')).toBe(true);
        await page.evaluate(() => document.fonts.ready);
        // Retire the pending reveal of the previously focused bottom target before captures.
        await primary.focus();
        await tick(page);
        await primary.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await page.screenshot({ path: `${evidence}/more-${locale}-${width}-whole.png`, fullPage: true });
        await page.screenshot({ path: `${evidence}/more-${locale}-${width}-primary.png` });
        await link(page, '/mining').focus();
        await tick(page);
        await link(page, '/mining').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${evidence}/more-${locale}-${width}-lower.png` });
        observations.push({ locale, width, words, bounds: await geometry(main(page)) });
      }
    }
    await viewLocale(page, 'fr');
    await page.setViewportSize({ width: 320, height: 1000 });
    await openLesson(page);
    await expect(main(page).locator('.more-body')).toHaveAttribute('lang', 'en');
    await expect(main(page).locator('.more-body')).toContainText('The numbers are invented to show the arithmetic.');
    await expect(main(page).locator('[data-i18n$=".languageFallback"]')).toBeVisible();
    state.observations = observations;
    expect(state.writes).toEqual([]);
  });
});
