import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const output = process.env.TOKEN_GOVERNANCE_EVIDENCE || '/tmp/intafaced-token-governance';
mkdirSync(output, { recursive: true });
const catalogs = JSON.parse(readFileSync(process.env.TOKEN_GOVERNANCE_CATALOGS, 'utf8'));
const text = (key, locale = 'en') => catalogs[locale][key];
const actor = '11111111-1111-4111-8111-111111111111',
  anotherActor = '99999999-9999-4999-8999-999999999999';
// Stored proposal ids are text business keys, not uuids (MC-token-01).
const first = `gov:proposal:ifc:${actor}:1`,
  second = `gov:proposal:ifc:${anotherActor}:1`;
const voteId = '31111111-1111-4111-8111-111111111111';
const markerKey = `intafaced:more:pending:${actor}:token`,
  ballotKey = `intafaced:token:ballot:${actor}`;
const body = { title: 'Original <proposal> / prix / Ω', note: '原文 <script>ignored()</script> 0.000000000000000001', terms: ['A', 'B'] };
const provider = 'Original provider / resultado / Ω <opaque> 0.000000000000000001';
const environments = new Map(),
  summary = [];
const selected = (page) => page.locator('#token-selected-proposal');
const detailBody = (page) => selected(page).locator('.token-proposal-body');
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

async function network(context, page, baseURL) {
  const now = Date.now();
  const proposal = {
    id: first,
    kind: 'curriculum',
    body,
    status: 'open',
    createdAt: new Date(now - 120000).toISOString(),
    opensAt: new Date(now - 60000).toISOString(),
    closesAt: new Date(now + 3600000).toISOString(),
    title: null,
    authorId: actor,
  };
  const other = {
    ...proposal,
    id: second,
    authorId: anotherActor,
    kind: 'grant',
    body: { title: 'Another original proposal', value: '0.000000000000000002' },
    status: 'passed',
  };
  const state = {
    actor,
    proposal,
    other,
    outcome: 'valid',
    detailMode: 'valid',
    preflightMode: 'valid',
    stake: '40.75',
    count: 2,
    hold: null,
    holdId: null,
    preflight: false,
    choice: 'for',
    responseWeight: '50.750000000000000001',
  };
  const calls = {
    reads: [],
    writes: [],
    requests: [],
    external: [],
    primaryPages: 1,
    newTabPages: 0,
    primaryErrors: [],
    newTabErrors: [],
    observations: [],
  };
  page.on('pageerror', (error) => calls.primaryErrors.push(error.message));
  context.on('page', (future) => {
    calls.newTabPages++;
    future.on('pageerror', (error) => calls.newTabErrors.push(error.message));
  });
  context.on('request', (request) => calls.requests.push({ method: request.method(), url: request.url() }));
  await context.routeWebSocket('**', (socket) => socket.close());
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : request.postDataJSON();
    const reply = (data) => route.fulfill({ json: { result: { data } } });
    if (procedure === 'auth.login')
      return reply({
        userId: state.actor,
        accessToken: 'isolated-token-' + state.actor,
        refreshToken: 'isolated-refresh-' + state.actor,
        expiresAt: '2027-10-10T00:00:00Z',
      });
    if (procedure === 'auth.logout') return reply({ ok: true });
    if (request.method() !== 'GET') {
      calls.writes.push({ procedure, input, authorization: request.headers().authorization });
      if (procedure === 'castVote') {
        expect(input).toEqual({ proposalId: first, choice: state.choice });
        if (state.outcome === 'abort') return route.abort('failed');
        if (state.outcome === 'unknown')
          return route.fulfill({
            status: 503,
            json: { error: { message: provider, data: { cause: { code: 'token.isolated_unknown' } } } },
          });
        if (state.outcome === 'duplicate')
          return route.fulfill({ status: 403, json: { error: { message: provider, data: { cause: { code: 'token.already_voted' } } } } });
        if (state.outcome === 'unreadable') return route.fulfill({ contentType: 'application/json', body: 'not-json' });
        const receipt = {
          id: voteId,
          proposalId: first,
          userId: actor,
          choice: state.choice,
          weight: state.responseWeight,
          castAt: new Date().toISOString(),
        };
        if (state.outcome === 'wrong-proposal') receipt.proposalId = second;
        if (state.outcome === 'wrong-actor') receipt.userId = anotherActor;
        if (state.outcome === 'wrong-choice') receipt.choice = state.choice === 'for' ? 'against' : 'for';
        if (state.outcome === 'zero') receipt.weight = '0';
        if (state.outcome === 'negative') receipt.weight = '-1';
        if (state.outcome === 'bad-weight') receipt.weight = 'not-a-weight';
        if (state.outcome === 'bad-time') receipt.castAt = 'not-an-instant';
        if (state.outcome === 'bad-id') receipt.id = 'not-a-uuid';
        return reply(receipt);
      }
      if (procedure === 'createProposal') {
        const created = calls.writes.filter((w) => w.procedure === 'createProposal');
        const ordinal = created.findIndex((w) => w.input.handle === input.handle) + 2;
        const { handle: _handle, ...fields } = input;
        return reply({ ...proposal, ...fields, id: `gov:proposal:ifc:${actor}:${ordinal}`, authorId: actor, status: 'draft' });
      }
      if (procedure === 'closeProposal')
        return route.fulfill({
          status: 412,
          json: { error: { message: provider, data: { cause: { code: 'token.governance_quorum_unset' } } } },
        });
      return route.fulfill({ status: 503, json: { message: 'Unexpected isolated write' } });
    }
    calls.reads.push({ procedure, input, authorization: request.headers().authorization });
    if (procedure === 'listProposals') {
      const rows =
        state.count === 2
          ? [state.proposal, state.other]
          : Array.from({ length: state.count }, (_, i) =>
              i === 0
                ? state.proposal
                : {
                    ...proposal,
                    id: `gov:proposal:ifc:${anotherActor}:${i + 1}`,
                    authorId: anotherActor,
                    body: { title: 'Window proposal ' + i },
                  },
            );
      return reply(
        rows.filter((p) => (!input.status || p.status === input.status) && (!input.kind || p.kind === input.kind)).slice(0, input.limit),
      );
    }
    if (procedure === 'getProposal') {
      const p = input.proposalId === first ? state.proposal : state.other;
      const mode = state.preflight ? state.preflightMode : state.detailMode;
      if (state.hold && input.proposalId === state.holdId) await state.hold.promise;
      if (mode === 'failed') return route.fulfill({ status: 503, json: { message: provider } });
      if (mode === 'not-found')
        return route.fulfill({
          status: 404,
          json: { error: { message: provider, data: { cause: { code: 'token.proposal_not_found' } } } },
        });
      if (mode === 'duplicate')
        return route.fulfill({ status: 403, json: { error: { message: provider, data: { cause: { code: 'token.already_voted' } } } } });
      const value = {
        ...p,
        tally: {
          forWeight: '125.250000000000000001',
          againstWeight: '40',
          abstainWeight: '12',
          totalWeight: '177.250000000000000001',
          voterCount: 8,
        },
      };
      if (mode === 'wrong-id') value.id = input.proposalId === first ? second : first;
      if (mode === 'bad-time') value.opensAt = 'not-an-instant';
      if (mode === 'bad-tally') value.tally.forWeight = '-2';
      if (mode === 'bad-total') value.tally.totalWeight = '900';
      if (mode === 'bad-body') value.body = null;
      if (mode === 'changed-body') value.body = { ...p.body, note: 'Materially changed terms' };
      if (mode === 'changed-kind') value.kind = 'grant';
      if (mode === 'changed-opens') value.opensAt = new Date(Date.parse(p.opensAt) - 1000).toISOString();
      if (mode === 'changed-closes') value.closesAt = new Date(Date.parse(p.closesAt) + 1000).toISOString();
      if (mode === 'future') value.opensAt = new Date(Date.now() + 60000).toISOString();
      if (mode === 'closed') value.closesAt = new Date(Date.now() - 1000).toISOString();
      if (mode === 'cancelled') value.status = 'cancelled';
      if (mode === 'reordered') value.body = { terms: p.body.terms, note: p.body.note, title: p.body.title };
      return reply(value);
    }
    if (procedure === 'stakeOf') return reply({ staked: state.stake });
    if (procedure === 'votingPower.ofProposal')
      return reply({
        proposalId: input.proposalId,
        power: state.stake,
        reason: state.stake === '0' ? 'no_stake_at_creation' : null,
        takenAt: state.stake === '0' ? null : proposal.createdAt,
        rule: { minPower: '0', code: null },
        signing: { available: false, code: 'token.signed_vote_unavailable' },
      });
    if (procedure === 'accessOf') return reply({ staked: '40.75', tier: 'flex', feeDiscountBps: 0 });
    if (procedure === 'listStakes' || procedure === 'webauthn.list') return reply([]);
    if (procedure === 'burnedSupply') return reply({ burned: '0' });
    return route.fulfill({ status: 503, json: { message: 'Isolated read unavailable' } });
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseURL).origin) {
      calls.external.push(url.href);
      return route.abort();
    }
    return route.fallback();
  });
  environments.set(context, { state, calls });
  return { state, calls };
}
async function login(page, destination = '/token') {
  await page.goto('/login?redirect=' + encodeURIComponent(destination));
  await page.locator('input[name="identifier"]').fill('isolated-token-governance');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(destination + '$'));
}
async function open(page) {
  await page.getByRole('button', { name: 'Governance', exact: true }).click();
  await page.getByRole('button', { name: text('inspect').replace('{id}', first), exact: true }).click();
  await expect(detailBody(page)).toHaveText(JSON.stringify(body, null, 2));
  await expect(selected(page).getByRole('button', { name: text('reviewFor'), exact: true })).toBeEnabled();
}
async function remount(page) {
  await page.locator('.door-nav a[href="/more"]:visible, .mobile-doors a[href="/more"]:visible').click();
  await page.locator('.more-room-link[href="/token"]').click();
  await expect(page).toHaveURL(/\/token$/);
}
async function stage(page, locale = 'en', choice = 'for') {
  await selected(page)
    .getByRole('button', {
      name: text(choice === 'against' ? 'reviewAgainst' : choice === 'abstain' ? 'reviewAbstain' : 'reviewFor', locale),
      exact: true,
    })
    .click();
  await expect(page.getByRole('dialog')).toContainText(first);
  await expect(page.getByRole('dialog')).toContainText(actor);
}
async function confirm(page, state, locale = 'en') {
  state.preflight = true;
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('cast', locale), exact: true })
    .click();
}
async function stored(page, key) {
  return page.evaluate((key) => localStorage.getItem(key), key);
}
async function capture(page, label) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const file = output + '/' + label + '.png';
  await page.screenshot({ path: file, fullPage: true });
}
async function tabTo(page, target) {
  for (let i = 0; i < 35; i++) {
    if (await target.evaluate((e) => e === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Native Tab did not reach the expected control');
}
test.afterEach(async ({ context }, info) => {
  const env = environments.get(context);
  if (!env) return;
  expect(env.calls.primaryErrors).toEqual([]);
  expect(env.calls.newTabErrors).toEqual([]);
  expect(env.calls.external).toEqual([]);
  expect(env.calls.writes.filter((w) => !['castVote', 'createProposal', 'closeProposal'].includes(w.procedure))).toEqual([]);
  const record = { name: info.title, status: info.status, ...env.calls };
  summary.push(record);
  writeFileSync(output + '/native-observations.json', JSON.stringify(summary, null, 2) + '\n');
});

for (const width of [1440, 768, 390, 320])
  test('bounded filters original selection body and remount at ' + width, async ({ page, context, baseURL }) => {
    const { calls } = await network(context, page, baseURL);
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    await open(page);
    await page.getByRole('combobox', { name: text('kindFilter'), exact: true }).selectOption('grant');
    await expect(page.getByRole('button', { name: text('inspect').replace('{id}', second), exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: text('statusFilter'), exact: true }).selectOption('open');
    await expect(page.getByText(text('empty'), { exact: true })).toBeVisible();
    expect(
      calls.reads.some(
        (r) => r.procedure === 'listProposals' && r.input.kind === 'grant' && r.input.status === 'open' && r.input.limit === 50,
      ),
    ).toBe(true);
    await expect(detailBody(page)).toHaveText(JSON.stringify(body, null, 2));
    await expect(detailBody(page)).toHaveAttribute('lang', 'und');
    await remount(page);
    await expect(detailBody(page)).toHaveText(JSON.stringify(body, null, 2));
    expect(await detailBody(page).textContent()).toBe(JSON.stringify(body, null, 2));
    if (width <= 390) {
      const tally = await selected(page)
        .locator('.token-tally')
        .evaluate((dl) =>
          [...dl.children].map((row) => {
            const label = row.querySelector('dt'),
              value = row.querySelector('dd'),
              l = label.getBoundingClientRect(),
              v = value.getBoundingClientRect();
            return {
              text: value.textContent,
              labelBottom: l.bottom,
              valueTop: v.top,
              valueHeight: v.height,
              lineHeight: Number.parseFloat(getComputedStyle(value).lineHeight),
              fontSize: getComputedStyle(value).fontSize,
              numeric: getComputedStyle(value).fontVariantNumeric,
              width: v.width,
              rowWidth: row.getBoundingClientRect().width,
            };
          }),
        );
      calls.observations.push({ exactPhoneTally: tally });
      for (const row of tally) {
        expect(row.valueTop).toBeGreaterThan(row.labelBottom);
        expect(row.valueHeight).toBe(row.lineHeight);
        expect(Number.parseFloat(row.fontSize)).toBeGreaterThanOrEqual(16);
        expect(row.numeric).toBe('tabular-nums');
        expect(row.width).toBe(row.rowWidth);
      }
      expect(tally[0].text).toBe('125.250000000000000001');
      expect(tally[3].text).toBe('177.250000000000000001');
    }
    expect(await stored(page, `intafaced:token:proposal:${actor}`)).toBe(first);
    expect(calls.writes).toEqual([]);
    await capture(page, 'original-selection-' + width);
  });
test('bounded list expands only to published200 cap', async ({ page, context, baseURL }) => {
  const { state, calls } = await network(context, page, baseURL);
  state.count = 220;
  await login(page);
  await page.getByRole('button', { name: 'Governance', exact: true }).click();
  for (const count of [100, 150, 200]) {
    await page.getByRole('button', { name: 'Load a larger window', exact: true }).click();
    await expect(page.locator('.token-proposal-row')).toHaveCount(count);
  }
  await expect(page.getByRole('button', { name: 'Load a larger window', exact: true })).toHaveCount(0);
  expect(calls.reads.filter((r) => r.procedure === 'listProposals').map((r) => r.input.limit)).toEqual([50, 100, 150, 200]);
});
for (const locale of ['es', 'fr'])
  test('native View language privacy review and exact receipt ' + locale, async ({ page, context, baseURL }) => {
    const { state, calls } = await network(context, page, baseURL);
    await page.setViewportSize({ width: 390, height: 1000 });
    await login(page);
    await open(page);
    await stage(page);
    const timeOrigin = await page.evaluate(() => performance.timeOrigin),
      view = await context.newPage();
    await login(view, '/view');
    await view.getByLabel('Hide balance values', { exact: true }).check();
    await view
      .locator('select')
      .filter({ has: view.locator('option[value="es"]') })
      .selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.getByRole('dialog')).toHaveAccessibleName(text('review', locale));
    await expect(page.getByRole('dialog')).not.toContainText('40.75');
    await expect(page.getByRole('dialog')).toContainText(text('hidden', locale));
    await expect(detailBody(page)).toHaveText(JSON.stringify(body, null, 2));
    await confirm(page, state, locale);
    await expect(page.locator('.token-ballot-context')).toContainText(text('recorded', locale));
    const ballot = JSON.parse(await stored(page, ballotKey));
    expect(ballot.receipt).toMatchObject({ proposalId: first, userId: actor, choice: 'for', weight: state.responseWeight });
    expect(await stored(page, markerKey)).toBeNull();
    await expect(page.locator('.token-ballot-context')).not.toContainText(state.responseWeight);
    await view.locator('input[type="checkbox"]').first().uncheck();
    await expect(page.locator('.token-ballot-context')).toContainText(state.responseWeight);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    expect(calls.writes).toHaveLength(1);
    await capture(page, 'receipt-' + locale);
    await view.close();
    await remount(page);
    await expect(page.locator('.token-ballot-context')).toContainText(state.responseWeight);
  });
test('native phone Tab Enter and dialog focus cast exact positive tiny weight', async ({ page, context, baseURL }) => {
  const { state, calls } = await network(context, page, baseURL);
  state.responseWeight = '0.000000000000000001';
  await page.setViewportSize({ width: 320, height: 1000 });
  await login(page);
  await open(page);
  const button = selected(page).getByRole('button', { name: text('reviewFor'), exact: true });
  await tabTo(page, button);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toContainText(first);
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  expect(calls.writes).toEqual([]);
  await page.keyboard.press('Enter');
  await tabTo(page, page.getByRole('dialog').getByRole('button', { name: text('cast'), exact: true }));
  state.preflight = true;
  await page.keyboard.press('Space');
  await expect(page.locator('.token-ballot-context')).toContainText('0.000000000000000001');
  const axe = await new AxeBuilder({ page }).include('.token-governance').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations).toEqual([]);
  calls.observations.push({ nativeTabEnterSpace: true, axeViolations: [] });
  await capture(page, 'phone-keyboard-receipt');
});
test('fresh reordered JSON keys preserve material terms and allow authoritative changed weight', async ({ page, context, baseURL }) => {
  const { state, calls } = await network(context, page, baseURL);
  await login(page);
  await open(page);
  await stage(page);
  state.preflightMode = 'reordered';
  await confirm(page, state);
  await expect(page.locator('.token-ballot-context')).toContainText(state.responseWeight);
  expect(calls.writes).toHaveLength(1);
});
for (const choice of ['against', 'abstain'])
  test('native original review and matching receipt choice ' + choice, async ({ page, context, baseURL }) => {
    const { state, calls } = await network(context, page, baseURL);
    state.choice = choice;
    await login(page);
    await open(page);
    await stage(page, 'en', choice);
    await confirm(page, state);
    await expect(page.locator('.token-ballot-context')).toContainText(text('recorded'));
    expect(JSON.parse(await stored(page, ballotKey))).toMatchObject({
      actor,
      proposalId: first,
      choice,
      status: 'recorded',
      receipt: { choice },
    });
    expect(calls.writes).toHaveLength(1);
  });
for (const outcome of [
  'wrong-proposal',
  'wrong-actor',
  'wrong-choice',
  'zero',
  'negative',
  'bad-weight',
  'bad-time',
  'bad-id',
  'unreadable',
  'abort',
])
  test('unverified ballot stays original and blocked: ' + outcome, async ({ page, context, baseURL }) => {
    const { state, calls } = await network(context, page, baseURL);
    state.outcome = outcome;
    await login(page);
    await open(page);
    await stage(page);
    await confirm(page, state);
    await expect(page.locator('.token-ballot-context')).toContainText(text('unknown'));
    const marker = await stored(page, markerKey),
      ballot = JSON.parse(await stored(page, ballotKey));
    expect(ballot).toMatchObject({ actor, proposalId: first, choice: 'for', status: 'unknown' });
    expect(ballot.receipt).toBeUndefined();
    expect(JSON.parse(marker).reference).toBe(first);
    expect(calls.writes).toHaveLength(1);
    await expect(selected(page).getByRole('button', { name: text('reviewFor'), exact: true })).toBeDisabled();
    await remount(page);
    expect(await stored(page, markerKey)).toBe(marker);
    await expect(page.locator('.token-ballot-context')).toContainText(first);
    expect(calls.writes).toHaveLength(1);
  });
test('unknown original survives current passed tally duplicate403 failed read retry and another selection', async ({
  page,
  context,
  baseURL,
}) => {
  const { state, calls } = await network(context, page, baseURL);
  state.outcome = 'unknown';
  await page.setViewportSize({ width: 390, height: 1000 });
  await login(page);
  await open(page);
  await stage(page);
  await confirm(page, state);
  await expect(page.getByText(provider, { exact: true })).toBeVisible();
  const marker = await stored(page, markerKey),
    ballot = await stored(page, ballotKey);
  state.proposal.status = 'passed';
  state.detailMode = 'valid';
  state.preflight = false;
  await page.getByRole('combobox', { name: text('kindFilter'), exact: true }).selectOption('grant');
  await page.getByRole('button', { name: text('inspect').replace('{id}', second), exact: true }).click();
  await expect(detailBody(page)).toContainText('Another original proposal');
  await expect(page.locator('.token-ballot-context')).toContainText(first);
  await page
    .locator('.token-ballot-context')
    .getByRole('button', { name: text('readOriginal'), exact: true })
    .click();
  await expect(detailBody(page)).toHaveText(JSON.stringify(body, null, 2));
  state.detailMode = 'duplicate';
  await selected(page)
    .getByRole('button', { name: text('refresh'), exact: true })
    .click();
  await expect(detailBody(page)).toHaveCount(0);
  expect(await stored(page, markerKey)).toBe(marker);
  await expect(selected(page).locator('.failure')).toContainText(provider);
  state.detailMode = 'failed';
  await selected(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(selected(page)).toContainText(provider);
  await expect(detailBody(page)).toHaveCount(0);
  state.detailMode = 'valid';
  await selected(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(detailBody(page)).toHaveText(JSON.stringify(body, null, 2));
  expect(await stored(page, ballotKey)).toBe(ballot);
  expect(await stored(page, markerKey)).toBe(marker);
  expect(calls.writes).toHaveLength(1);
  await expect(selected(page).getByRole('button', { name: text('reviewFor'), exact: true })).toBeDisabled();
  await capture(page, 'unknown-original-read-recovery');
});
for (const mode of ['wrong-id', 'bad-time', 'bad-tally', 'bad-total', 'bad-body', 'not-found'])
  test('original detail invalidity hides earlier values: ' + mode, async ({ page, context, baseURL }) => {
    const { state, calls } = await network(context, page, baseURL);
    await login(page);
    await open(page);
    state.detailMode = mode;
    await selected(page)
      .getByRole('button', { name: text('refresh'), exact: true })
      .click();
    await expect(detailBody(page)).toHaveCount(0);
    await expect(selected(page).locator('.failure')).toBeVisible();
    await expect(selected(page)).toContainText(first);
    expect(calls.writes).toEqual([]);
    state.detailMode = 'valid';
    await selected(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(detailBody(page)).toHaveText(JSON.stringify(body, null, 2));
  });
for (const mode of [
  'changed-body',
  'changed-kind',
  'changed-opens',
  'changed-closes',
  'future',
  'closed',
  'cancelled',
  'wrong-id',
  'failed',
])
  test('fresh original preflight refuses without votePOST: ' + mode, async ({ page, context, baseURL }) => {
    const { state, calls } = await network(context, page, baseURL);
    await login(page);
    await open(page);
    await stage(page);
    state.preflightMode = mode;
    await confirm(page, state);
    await expect(page.locator('.token-ballot-context')).toContainText(text('refused'));
    expect(calls.writes).toEqual([]);
    expect(await stored(page, markerKey)).toBeNull();
    expect(JSON.parse(await stored(page, ballotKey))).toMatchObject({ actor, proposalId: first, choice: 'for', status: 'refused' });
  });
for (const weight of ['0', '-1', 'not-a-weight'])
  test('fresh stake refuses without votePOST: ' + weight, async ({ page, context, baseURL }) => {
    const { state, calls } = await network(context, page, baseURL);
    await login(page);
    await open(page);
    await stage(page);
    state.stake = weight;
    await confirm(page, state);
    await expect(page.locator('.token-ballot-context')).toContainText(text('refused'));
    expect(calls.writes).toEqual([]);
    expect(await stored(page, markerKey)).toBeNull();
  });
test('opening time gates native review before anyPOST', async ({ page, context, baseURL }) => {
  const { state, calls } = await network(context, page, baseURL);
  state.proposal.opensAt = new Date(Date.now() + 60000).toISOString();
  await login(page);
  await page.getByRole('button', { name: 'Governance', exact: true }).click();
  await page.getByRole('button', { name: text('inspect').replace('{id}', first), exact: true }).click();
  await expect(selected(page).getByRole('button', { name: text('reviewFor'), exact: true })).toBeDisabled();
  expect(calls.writes).toEqual([]);
});
test('late previous detail cannot replace another original selection', async ({ page, context, baseURL }) => {
  const { state, calls } = await network(context, page, baseURL);
  state.hold = deferred();
  state.holdId = first;
  await login(page);
  await page.getByRole('button', { name: 'Governance', exact: true }).click();
  await page.getByRole('button', { name: text('inspect').replace('{id}', first), exact: true }).click();
  await expect
    .poll(() => calls.reads.filter((r) => r.procedure === 'getProposal' && r.input.proposalId === first).length)
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: text('inspect').replace('{id}', second), exact: true }).click();
  await expect(detailBody(page)).toHaveText(JSON.stringify(state.other.body, null, 2));
  state.hold.resolve();
  await expect(selected(page)).toContainText(second);
  await expect(detailBody(page)).not.toContainText(body.title);
});
test('native signout during fresh read hides old actor and sends no vote', async ({ page, context, baseURL }) => {
  const { state, calls } = await network(context, page, baseURL);
  await login(page);
  await open(page);
  await stage(page);
  state.hold = deferred();
  state.holdId = first;
  await confirm(page, state);
  await expect(detailBody(page)).toHaveCount(0);
  await page.locator('.person-trigger').click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByText('Sign in to continue', { exact: true })).toBeVisible();
  state.hold.resolve();
  await expect(page.locator('.token-ballot-context')).toHaveCount(0);
  expect(calls.writes).toEqual([]);
  state.actor = anotherActor;
  await page.locator('#main').getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.locator('input[name="identifier"]').fill('another-isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(/\/token$/);
  await page.getByRole('button', { name: 'Governance', exact: true }).click();
  await expect(page.locator('.token-ballot-context')).toHaveCount(0);
  await expect(selected(page)).not.toContainText(first);
});
test('retained create close dependencies and unpublished stake unit stay honest', async ({ page, context, baseURL }) => {
  const { state, calls } = await network(context, page, baseURL);
  await login(page);
  await expect(page.getByText('Which token is staked', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Stake|^Unstake/ })).toHaveCount(0);
  await open(page);
  await page.locator('.token-create > summary').click();
  await page.getByLabel('Proposal body as JSON object', { exact: true }).fill(JSON.stringify({ title: 'Original creation body' }));
  await page.getByRole('button', { name: 'Review proposal', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit proposal', exact: true }).click();
  await expect(page.getByText('Proposal created', { exact: true })).toBeVisible();
  expect(calls.writes.at(-1)).toMatchObject({
    procedure: 'createProposal',
    input: { kind: 'curriculum', body: { title: 'Original creation body' }, handle: expect.any(String) },
  });
  expect(calls.writes.at(-1).input).not.toHaveProperty('proposalId');
  state.proposal.closesAt = new Date(Date.now() - 1000).toISOString();
  await selected(page)
    .getByRole('button', { name: text('refresh'), exact: true })
    .click();
  await selected(page).getByRole('button', { name: 'Close voting', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close proposal', exact: true }).click();
  await expect(page.getByText(provider, { exact: true })).toBeVisible();
  expect(calls.writes.at(-1)).toMatchObject({ procedure: 'closeProposal', input: { proposalId: first } });
  expect(calls.writes.filter((r) => r.procedure === 'castVote')).toEqual([]);
});
test('unknown canonical Support navigation and return preserve both original journals without replay', async ({
  page,
  context,
  baseURL,
}) => {
  const { state, calls } = await network(context, page, baseURL);
  state.outcome = 'unknown';
  await page.setViewportSize({ width: 390, height: 1000 });
  await login(page);
  await open(page);
  await stage(page);
  await confirm(page, state);
  await expect(page.locator('.token-ballot-context')).toContainText(text('unknown'));
  const marker = await stored(page, markerKey),
    ballot = await stored(page, ballotKey);
  const support = page.locator('.token-ballot-context').getByRole('link', { name: text('support'), exact: true });
  await expect(support).toHaveAttribute('href', '/support');
  await tabTo(page, support);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/support$/);
  await expect(page.getByRole('heading', { name: 'Support', level: 1, exact: true })).toBeVisible();
  expect(await stored(page, markerKey)).toBe(marker);
  expect(await stored(page, ballotKey)).toBe(ballot);
  await page.goBack();
  await expect(page).toHaveURL(/\/token$/);
  await expect(page.locator('.token-ballot-context')).toContainText(first);
  await expect(page.locator('.token-ballot-context')).toContainText(actor);
  await expect(selected(page).getByRole('button', { name: text('reviewFor'), exact: true })).toBeDisabled();
  expect(await stored(page, markerKey)).toBe(marker);
  expect(await stored(page, ballotKey)).toBe(ballot);
  expect(calls.writes).toHaveLength(1);
  const axe = await new AxeBuilder({ page }).include('.token-ballot-context').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations).toEqual([]);
  calls.observations.push({ nativeSupportTabEnter: true, axeViolations: [] });
  await capture(page, 'unknown-support-return');
});
test('ordinary compiled Token private boundary has no seeded identity or mutation', async ({ page, context }) => {
  const requests = [],
    errors = [],
    newTabErrors = [];
  let newTabs = 0;
  page.on('request', (request) => requests.push({ method: request.method(), url: request.url() }));
  page.on('pageerror', (error) => errors.push(error.message));
  context.on('page', (future) => {
    newTabs++;
    future.on('pageerror', (error) => newTabErrors.push(error.message));
  });
  await page.goto('/token');
  await expect(page.getByText('Sign in to continue', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Governance', exact: true })).toHaveCount(0);
  expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('intafaced:token:proposal:11111111-1111-4111-8111-111111111111'))).toBeNull();
  expect(newTabErrors).toEqual([]);
  writeFileSync(
    output + '/ordinary-token.json',
    JSON.stringify(
      { requests, primaryPages: 1, newTabPages: newTabs, primaryErrors: errors, newTabErrors, fixtures: 0, interceptions: 0, mutations: 0 },
      null,
      2,
    ) + '\n',
  );
});
