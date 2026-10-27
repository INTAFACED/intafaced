import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const output = process.env.SUPPORT_EVIDENCE,
  catalogs = JSON.parse(readFileSync(process.env.SUPPORT_CATALOGS, 'utf8'));
mkdirSync(output, { recursive: true });
const t = (locale, key) => catalogs[locale]['support.' + key],
  common = (locale, key) => catalogs[locale]['common.' + key];
const owner = '11111111-1111-4111-8111-111111111111',
  originalId = '33333333-3333-4333-8333-333333333333';
const subject = 'Original English <subject> BTC-USD ' + 'long subject '.repeat(11),
  body =
    ' Original English <body> BTC-USD ' + 'Keep the original request, without inventing a notification or reply receipt. '.repeat(16) + ' ',
  reply = ' Original English <reply> BTC-USD ' + 'Keep the same request and source bytes. '.repeat(9) + ' ';
const provider = 'Original English provider explanation: keep original request bytes and reference. '.repeat(6);
const original = {
  id: originalId,
  userId: owner,
  category: 'account',
  subject,
  body,
  status: 'resolved',
  assigneeId: null,
  createdAt: '2026-10-09T01:20:00Z',
  updatedAt: '2026-10-09T01:20:00Z',
};
const markerKey = 'intafaced:more:pending:' + owner + ':support';
const summaries = [];
async function login(page, path) {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('isolated-support-review');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(path + '$'));
}
async function language(view, page, locale) {
  await view
    .locator('select')
    .filter({ has: view.locator('option[value="es"]') })
    .selectOption(locale);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}
async function network(context, outcome, kbRows = []) {
  const calls = { reads: [], writes: [], errors: [] };
  let current = { ...original };
  const observeErrors = (page) => page.on('pageerror', (error) => calls.errors.push(error.message));
  for (const page of context.pages()) observeErrors(page);
  context.on('page', observeErrors);
  await context.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1)),
      input = req.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : req.postDataJSON();
    const response = (data) => route.fulfill({ json: { result: { data } } });
    if (procedure === 'auth.login')
      return response({
        userId: owner,
        accessToken: 'isolated-support-token',
        refreshToken: 'isolated-support-refresh',
        expiresAt: '2027-10-09T00:00:00Z',
      });
    if (procedure === 'auth.logout') return response({ ok: true });
    if (req.method() === 'GET') {
      calls.reads.push({ procedure, input });
      if (procedure === 'searchKb') return response(kbRows);
      if (procedure === 'events' || procedure === 'listComments' || procedure === 'webauthn.list') return response([]);
      if (procedure === 'listMine') return response([current]);
      if (procedure === 'get') return response(current);
      return route.fulfill({ status: 503, json: { message: provider } });
    }
    const marker = await context.pages()[0].evaluate((key) => localStorage.getItem(key), markerKey);
    calls.writes.push({ procedure, input, marker });
    expect(['create', 'comment']).toContain(procedure);
    if (outcome === 'unknown') {
      if (procedure === 'comment') current = { ...current, status: 'open' };
      return route.abort('failed');
    }
    if (outcome === 'refused')
      return route.fulfill({ status: 412, json: { error: { message: provider, data: { code: 'PRECONDITION_FAILED' } } } });
    if (procedure === 'create') return response({ ...original, ...input, status: 'open' });
    current = { ...current, status: 'open' };
    return response({
      id: '44444444-4444-4444-8444-444444444444',
      ticketId: input.ticketId,
      authorId: owner,
      authorRole: 'user',
      body: input.body,
      createdAt: original.createdAt,
    });
  });
  return calls;
}
async function fill(page, mode) {
  if (mode === 'create') {
    await page.getByRole('combobox', { name: t('en', 'category'), exact: true }).selectOption('deposit_withdraw');
    await page.getByLabel(t('en', 'subject'), { exact: true }).fill(subject);
    await page.getByLabel(t('en', 'message'), { exact: true }).fill(body);
  } else {
    await page.getByRole('button', { name: t('en', 'open').replace('{value1}', subject), exact: true }).click();
    await page.getByLabel(t('en', 'reply'), { exact: true }).fill(reply);
  }
}
for (const mode of ['create', 'reply'])
  test('native open ' + mode + ' review label follows second-tab View', async ({ page, context }) => {
    const calls = await network(context, 'success');
    await login(page, '/support');
    await fill(page, mode);
    const view = await context.newPage();
    await login(view, '/view');
    const stageKey = mode === 'create' ? 'review.request' : 'review.reply',
      reviewKey = mode === 'create' ? 'review.support.request' : 'review.reply';
    await page.getByRole('button', { name: t('en', stageKey), exact: true }).click();
    const dialog = page.getByRole('dialog'),
      node = await dialog.elementHandle();
    await page.screenshot({ path: output + '/' + mode + '-before-switch-en.png', fullPage: true });
    await language(view, page, 'es');
    await page.screenshot({ path: output + '/' + mode + '-after-switch-es.png', fullPage: true });
    await expect(dialog).toHaveAccessibleName(t('es', reviewKey));
    expect(await node.evaluate((x) => x.isConnected && x.open)).toBe(true);
    expect(calls.writes).toEqual([]);
  });
for (const mode of ['create', 'reply'])
  for (const outcome of ['success', 'refused', 'unknown'])
    test('native ' + mode + ' ' + outcome + ' review follows View with original intent', async ({ page, context }) => {
      const calls = await network(context, outcome);
      await login(page, '/support');
      await fill(page, mode);
      const view = await context.newPage();
      await login(view, '/view');
      const origin = await page.evaluate(() => performance.timeOrigin),
        originalInputs = await page.locator('input,textarea,select').elementHandles(),
        inputBytes = await page.locator('input,textarea,select').evaluateAll((xs) => xs.map((x) => x.value));
      const reviewKey = mode === 'create' ? 'review.support.request' : 'review.reply',
        stageKey = mode === 'create' ? 'review.request' : 'review.reply',
        confirmKey = mode === 'create' ? 'send.request' : 'send.reply',
        successKey = mode === 'create' ? 'request.created' : 'reply.posted';
      await page.getByRole('button', { name: t('en', stageKey), exact: true }).click();
      const dialog = page.getByRole('dialog'),
        originalDialog = await dialog.elementHandle();
      for (const locale of ['en', 'es', 'fr']) {
        if (locale !== 'en') await language(view, page, locale);
        await expect(dialog).toHaveAccessibleName(t(locale, reviewKey));
        await expect(dialog.getByRole('button', { name: t(locale, confirmKey), exact: true })).toBeVisible();
        await expect(dialog.getByText(subject, { exact: true })).toHaveAttribute('lang', 'und');
        await expect(dialog.getByText(mode === 'create' ? body : reply, { exact: true })).toHaveAttribute('lang', 'und');
        if (mode === 'reply') {
          await expect(dialog.getByText(originalId, { exact: true })).toHaveAttribute('lang', 'zxx');
          await expect(dialog.getByText('resolved', { exact: true })).toHaveAttribute('lang', 'zxx');
        }
        expect(await page.locator('input,textarea,select').evaluateAll((xs) => xs.map((x) => x.value))).toEqual(inputBytes);
        for (const input of originalInputs) expect(await input.evaluate((x) => x.isConnected)).toBe(true);
        expect(await originalDialog.evaluate((x) => x.isConnected && x.open)).toBe(true);
        expect(calls.writes).toEqual([]);
        expect(await page.evaluate((key) => localStorage.getItem(key), markerKey)).toBeNull();
        if (outcome === 'success')
          for (const width of [320, 390, 1440]) {
            await page.setViewportSize({ width, height: 1000 });
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await page.screenshot({ path: output + '/' + mode + '-review-' + locale + '-' + width + '.png', fullPage: true });
          }
      }
      await page.setViewportSize({ width: 320, height: 1000 });
      const confirm = dialog.getByRole('button', { name: t('fr', confirmKey), exact: true });
      for (let step = 0; step < 8 && !(await confirm.evaluate((el) => el === document.activeElement)); step++)
        await page.keyboard.press('Tab');
      await expect(confirm).toBeFocused();
      await expect
        .poll(() =>
          confirm.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
          }),
        )
        .toBe(true);
      await dialog.screenshot({ path: output + '/' + mode + '-' + outcome + '-keyboard-confirm-fr-320.png' });
      await page.keyboard.press('Enter');
      await expect.poll(() => calls.writes.length).toBe(1);
      expect(calls.writes[0].input).toEqual(
        mode === 'create'
          ? { category: 'deposit_withdraw', subject: subject.trim(), body: body.trim() }
          : { ticketId: originalId, body: reply.trim() },
      );
      const marker = JSON.parse(calls.writes[0].marker);
      expect(marker.title).toBe(t('en', reviewKey));
      if (mode === 'reply') expect(marker.reference).toBe(originalId);
      if (outcome === 'success') {
        await expect(page.getByText(t('fr', successKey), { exact: true })).toBeVisible();
        await language(view, page, 'es');
        await expect(page.getByText(t('es', successKey), { exact: true })).toBeVisible();
        expect(await page.evaluate((key) => localStorage.getItem(key), markerKey)).toBeNull();
      } else if (outcome === 'refused') {
        await expect(page.getByText(provider, { exact: true })).toBeVisible();
        expect(await page.getByText(provider, { exact: true }).evaluate((el) => el.closest('[lang]').lang)).toBe('und');
        await language(view, page, 'es');
        await expect(page.getByText(provider, { exact: true })).toBeVisible();
        expect(await page.evaluate((key) => localStorage.getItem(key), markerKey)).toBeNull();
      } else {
        await expect(page.getByText(common('fr', 'this.action.has.no.universal.recovery.lookup'), { exact: true })).toBeVisible();
        const bytes = await page.evaluate((key) => localStorage.getItem(key), markerKey);
        expect(JSON.parse(bytes)).toEqual(marker);
        await language(view, page, 'es');
        await expect(page.getByText(common('es', 'this.action.has.no.universal.recovery.lookup'), { exact: true })).toBeVisible();
        if (mode === 'reply') {
          await page.getByRole('button', { name: catalogs.events.es.refreshRequest, exact: true }).click();
          await expect(page.locator('small[lang="zxx"]').filter({ hasText: originalId })).toHaveText('open · ' + originalId);
        }
        expect(await page.evaluate((key) => localStorage.getItem(key), markerKey)).toBe(bytes);
        await expect(page.getByRole('button', { name: t('es', stageKey), exact: true })).toBeDisabled();
      }
      if (outcome !== 'success') await expect(page.locator('[data-testid="failure"] h3 span[lang]').first()).toHaveAttribute('lang', 'es');
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: output + '/' + mode + '-' + outcome + '-cached-es-' + width + '.png', fullPage: true });
      }
      expect(calls.writes).toHaveLength(1);
      expect(calls.errors).toEqual([]);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
      summaries.push({ mode, outcome, requests: calls.writes, reads: calls.reads, documentUnchanged: true, inputBytes });
    });
test('native raw ticket subject and conversation metadata retain unknown language', async ({ page, context }) => {
  const calls = await network(context, 'success');
  await login(page, '/support');
  const view = await context.newPage();
  await login(view, '/view');
  await language(view, page, 'fr');
  const open = page.getByRole('button', { name: t('fr', 'open').replace('{value1}', subject), exact: true });
  await expect(open).toHaveAttribute('lang', 'und');
  await open.click();
  await expect(page.getByRole('heading', { name: subject, exact: true })).toHaveAttribute('lang', 'und');
  await expect(page.getByText(body, { exact: true })).toHaveAttribute('lang', 'und');
  for (const key of ['subject', 'message', 'reply']) {
    const field = page.getByLabel(t('fr', key), { exact: true });
    await expect(field).toHaveAttribute('lang', 'und');
    await expect(
      field
        .locator('..')
        .locator('[data-i18n="customer.more.support.' + key + '"]')
        .first(),
    ).toHaveAttribute('lang', 'fr');
  }
  expect(calls.writes).toEqual([]);
});
test('native missing KB content follows authored fallback language in second-tab View', async ({ page, context }) => {
  const rows = [
    {
      id: 'unknown-article-original-id',
      titleKey: 'support.unpublished.original.title',
      bodyKey: 'support.unpublished.original.body',
      version: 1,
      published: true,
    },
    { id: 'template-article-original-id', titleKey: 'auth.twofa.prompt', bodyKey: 'auth.twofa.prompt', version: 1, published: true },
    {
      id: 'published-article-original-id',
      titleKey: 'support.kb.account_access.title',
      bodyKey: 'support.kb.account_access.body',
      version: 1,
      published: true,
    },
  ];
  const calls = await network(context, 'success', rows);
  await login(page, '/support');
  const view = await context.newPage();
  await login(view, '/view');
  const origin = await page.evaluate(() => performance.timeOrigin),
    articles = page.locator('[data-testid="more-articles"] details');
  await expect(articles).toHaveCount(rows.length);
  const nodes = await articles.elementHandles();
  for (let index = 0; index < rows.length; index++) await articles.nth(index).locator('summary').click();
  const observed = [];
  for (const locale of ['es', 'fr']) {
    await language(view, page, locale);
    for (let index = 0; index < rows.length; index++) {
      const article = articles.nth(index),
        row = rows[index],
        summary = article.locator('summary'),
        body = article.locator('p'),
        fallback = (key) => t(locale, 'published.article.text.is.unavailable.for').replace('{value1}', key);
      if (index < 2) {
        await expect(summary).toHaveText(fallback(row.titleKey));
        await expect(body).toHaveText(fallback(row.bodyKey));
      } else {
        await expect(summary).toHaveText('Sign-in and account access');
        await expect(body).not.toContainText(fallback(row.bodyKey));
      }
      await expect(article.getByText(row.id, { exact: true })).toHaveAttribute('lang', 'zxx');
      expect(await nodes[index].evaluate((node) => node.isConnected && node.open)).toBe(true);
      observed.push({
        locale,
        id: row.id,
        titleKey: row.titleKey,
        bodyKey: row.bodyKey,
        titleLanguage: await summary.getAttribute('lang'),
        bodyLanguage: await body.getAttribute('lang'),
        expectedLanguage: index < 2 ? locale : 'en',
      });
    }
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: output + '/kb-fallback-' + locale + '-' + width + '.png', fullPage: true });
    }
  }
  writeFileSync(output + '/kb-fallback-observed.json', JSON.stringify(observed, null, 2));
  expect(
    observed.map((row) => ({ locale: row.locale, id: row.id, titleLanguage: row.titleLanguage, bodyLanguage: row.bodyLanguage })),
  ).toEqual(
    observed.map((row) => ({ locale: row.locale, id: row.id, titleLanguage: row.expectedLanguage, bodyLanguage: row.expectedLanguage })),
  );
  expect(calls.writes).toEqual([]);
  expect(calls.errors).toEqual([]);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
  summaries.push({ kbFallback: observed, documentUnchanged: true, originalArticleNodes: true, reads: calls.reads, writes: calls.writes });
});
test.afterAll(() => writeFileSync(output + '/native-summary.json', JSON.stringify(summaries, null, 2)));
