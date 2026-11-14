// World: book, restart
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signIn, signUp } from './desk.mjs';
import { ROOT, api, journeyState, restartWith } from './stack.mjs';

// J-campaigns-17, in the running app (docs/roadmap/journeys.json): run a campaign, watch it, issue codes, export. One
// test per step, titled "J-campaigns-17 #<n>", run in order. The operator is the stack's LOCAL TEST founder A on the
// founder console's campaign watch desk (/more-ops/campaigns/watch). It starts from this run's TEST voucher campaign, live
// now and made through svc-campaigns' operator doors (A creates and asks, B approves, A activates), with TEST
// participation: a TEST customer joined, claimed a voucher founder A issued, and redeemed part of it. Every figure the desk
// shows is checked against a direct count of svc-campaigns' own rows; no money moves from the desk. The stack's labelled
// TEST owner values (tooling/profiles/test-owner-values/campaigns.json): a batch holds at most 5 codes, an export's link
// works 20 seconds, and both alert thresholds are blank, as in production.
// #3 to #6 share one signed-in console page: the codes a batch makes are in that page once, and nowhere else.
const J = 'J-campaigns-17';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const DAY = 86_400_000;
const FACE = '0.02';
const BATCH_MAX = 5;
const LINK_SECONDS = 20;

test.describe.configure({ mode: 'default' });

function state(...keys) {
  const s = run.read();
  for (const k of keys) if (!s[k]) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
  return s;
}

let gates;
let ctx;
let pair;
async function operators() {
  gates ??= await import('../../../../tooling/scripts/local-test-gates.mjs');
  ctx ??= await gates.makeContext({ log: () => {} });
  pair ??= await gates.approverSessions(ctx);
  return { ctx, pair };
}

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** svc-campaigns' own database role on the stack, to count what is stored. */
async function campaignsDb() {
  const c = (await operators()).ctx;
  const postgres = createRequire(path.join(ROOT, 'services', 'svc-campaigns', 'package.json'))('postgres');
  const port = c.marker.ports.postgres ?? 15460;
  return postgres(`postgres://svc_campaigns:${encodeURIComponent(c.secrets.pgService)}@127.0.0.1:${port}/intafaced_local_test`, {
    max: 1,
    onnotice: () => {},
  });
}
async function withDb(fn) {
  const sql = await campaignsDb();
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

const sha = (code) => createHash('sha256').update(code.trim().toUpperCase(), 'utf8').digest('hex');
/** A decimal string in units of 10^-18, so sums are exact. */
const units = (d) => {
  const neg = d.startsWith('-');
  const [w, f = ''] = (neg ? d.slice(1) : d).split('.');
  const v = BigInt(w) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
  return neg ? -v : v;
};

/** The budget a `watch-budget` list shows: limit, reserved, spent and left, each with its asset. */
async function budgetShown(list) {
  const read = async (term) => {
    const text = (await list.locator(`[data-budget="${term}"]`).innerText()).trim();
    return text.split(' ')[0];
  };
  return { limit: await read('limit'), reserved: await read('reserved'), spent: await read('spent'), left: await read('left') };
}

/** Founder A, signed in once on one console page that #3 to #6 share. */
let consolePage;
async function founderPage(browser) {
  if (consolePage && !consolePage.isClosed()) return consolePage;
  consolePage = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await founderSignIn(consolePage, 'a');
  return consolePage;
}

async function openCampaign(page, campaignId) {
  await page.goto(`${ADMIN}/more-ops/campaigns/watch?id=${encodeURIComponent(campaignId)}`);
  await expect(page.getByTestId('campaigns-watch')).toHaveAttribute('data-view', 'campaign');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(state('campaignName').campaignName);
}

const shownCount = async (page, part) =>
  Number(await page.locator(`[data-testid="watch-count"][data-part="${part}"]`).getAttribute('data-count'));

/** Every text svc-campaigns stores, upper case: a plain batch code must be in none of it. */
const everythingStored = () =>
  withDb(async (sql) => {
    const tables = await sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'campaigns' AND table_type = 'BASE TABLE'`;
    let out = '';
    for (const { table_name: t } of tables) {
      const rows = await sql`SELECT row_to_json(x)::text AS raw FROM ${sql('campaigns')}.${sql(t)} x`;
      out += rows.map((r) => r.raw).join('\n');
    }
    return out.toUpperCase();
  });

/** A CSV file the operator picks, written to the test's output folder. */
function csvFile(testInfo, name, codes) {
  return { name, mimeType: 'text/csv', buffer: Buffer.from(['code', ...codes].join('\n') + '\n') };
}

const batches = (page) => page.getByRole('region', { name: 'Code batches' });

test(`${J} #1 opens the overview: KPIs, redemption trends, top campaigns and alerts; a blank alert threshold reads not set and refuses to enable`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  run.reset({});
  // The start: this run's TEST voucher campaign, live now, with TEST participation.
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const name = `TEST codes ${tag}`;
  const definition = {
    name,
    type: 'voucher',
    rules: `TEST rules for ${name}: claim a voucher by its code, then redeem it to your account. Its value is TEST USDT.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 14 * DAY).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    budget: { asset: 'USDT', limit: '0.1' },
    limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
    reward: { asset: 'USDT', amount: FACE },
    vouchers: { claimBy: new Date(Date.now() + 7 * DAY).toISOString(), useBy: new Date(Date.now() + 7 * DAY).toISOString() },
  };
  const made = data(await ctx.edge.mutate('campaigns', 'ops.campaigns.create', definition, a), 'ops.campaigns.create');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'submit', revision: 1 }, a), 'submit');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'approve', revision: 1 }, b), 'approve');
  const live = data(
    await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'activate', revision: 1 }, a),
    'activate',
  );
  expect(live.state).toBe('active');
  const typed = `JC17-${tag}-T`;
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.vouchers.issue', { campaignId: live.id, code: typed }, a), 'vouchers.issue');
  const customerPage = await (await browser.newContext()).newPage();
  const me = await signUp(customerPage, 'jc17me');
  const client = await api(me);
  const joined = await client.post('/api/campaigns/trpc/participation.join', { campaignId: live.id });
  expect(joined.body?.result?.data, JSON.stringify(joined.body).slice(0, 300)).toBeTruthy();
  const claimed = await client.post('/api/campaigns/trpc/vouchers.claim', { code: typed });
  expect(claimed.body?.result?.data?.state, JSON.stringify(claimed.body).slice(0, 300)).toBe('claimed');
  const redeemed = await client.post('/api/campaigns/trpc/vouchers.redeem', {
    voucherId: claimed.body.result.data.id,
    amount: '0.005',
    sequence: 1,
  });
  expect(redeemed.body?.result?.data?.created, JSON.stringify(redeemed.body).slice(0, 300)).toBe(true);
  run.write({ campaignId: live.id, campaignName: name, me, typed });

  const page = await (await browser.newContext()).newPage();
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/more-ops/campaigns`);
  await page.getByRole('link', { name: 'Watch running campaigns' }).click();
  await expect(page.getByRole('heading', { name: 'Campaign watch', level: 1 })).toBeVisible();

  // KPIs, each equal to a direct count of the rows (no other journey writes campaigns on this stack while this one runs).
  const kpis = page.getByRole('region', { name: 'Key figures' });
  await expect(kpis).toBeVisible();
  const direct = await withDb(async (sql) => {
    const running = sql`('scheduled', 'active', 'paused', 'ended', 'closed')`;
    const [r] = await sql`
      SELECT
        (SELECT count(*)::int FROM campaigns.campaigns WHERE state IN ${running}) AS running,
        (SELECT count(*)::int FROM campaigns.participations p JOIN campaigns.campaigns c ON c.id = p.campaign_id WHERE c.state IN ${running}) AS participants,
        (SELECT count(*)::int FROM campaigns.vouchers v JOIN campaigns.campaigns c ON c.id = v.campaign_id WHERE c.state IN ${running} AND v.state <> 'generated') AS "vouchersIssued",
        (SELECT count(*)::int FROM campaigns.vouchers v JOIN campaigns.campaigns c ON c.id = v.campaign_id WHERE c.state IN ${running} AND v.claimed_by IS NOT NULL) AS "vouchersClaimed",
        (SELECT count(*)::int FROM campaigns.reward_intents i JOIN campaigns.campaigns c ON c.id = i.campaign_id
          WHERE c.state IN ${running} AND i.state NOT IN ('failed', 'forfeited', 'withheld')) AS redemptions`;
    return r;
  });
  for (const [kpi, n] of Object.entries(direct)) {
    await expect(kpis.locator(`[data-kpi="${kpi}"]`), kpi).toHaveAttribute('data-count', String(n));
  }
  expect(direct.running).toBeGreaterThan(0);
  // Budgets: each limit is reserved plus spent plus left.
  const budgets = page.getByTestId('watch-budget');
  expect(await budgets.count()).toBeGreaterThan(0);
  for (const list of await budgets.all()) {
    const shown = await budgetShown(list);
    expect(units(shown.reserved) + units(shown.spent) + units(shown.left), JSON.stringify(shown)).toBe(units(shown.limit));
  }
  // The redemption trend: 14 UTC days ending today, today counting at least this run's redemption.
  const days = page.getByTestId('watch-trend-day');
  await expect(days).toHaveCount(14);
  const today = new Date().toISOString().slice(0, 10);
  await expect(days.last()).toHaveAttribute('data-day', today);
  const todayShown = Number(await days.last().getAttribute('data-count'));
  const todayDirect = await withDb(
    async (sql) =>
      (
        await sql`SELECT count(*)::int AS n FROM campaigns.reward_intents
          WHERE created_at >= ${`${today}T00:00:00Z`} AND state NOT IN ('failed', 'forfeited', 'withheld')`
      )[0].n,
  );
  expect(todayShown).toBe(todayDirect);
  expect(todayShown).toBeGreaterThan(0);
  // Top campaigns: the running campaigns with the most rewards and redemptions, each figure counted.
  // Each shown figure equals a direct count of that campaign's rows, the rows run from most to fewest, at most five
  // are shown, and no running campaign left out has more than the last one shown.
  const top = page.getByTestId('watch-top-row');
  const perCampaign = new Map(
    (
      await withDb(
        (sql) => sql`SELECT c.id,
          (SELECT count(*)::int FROM campaigns.reward_intents i WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')) AS redemptions,
          (SELECT count(*)::int FROM campaigns.participations p WHERE p.campaign_id = c.id) AS participants
          FROM campaigns.campaigns c WHERE c.state IN ('scheduled', 'active', 'paused', 'ended', 'closed')`,
      )
    ).map((r) => [r.id, r]),
  );
  const shownTop = [];
  for (const row of await top.all()) {
    const id = await row.getAttribute('data-campaign-id');
    const cells = row.locator('td');
    shownTop.push({ id, redemptions: Number(await cells.nth(2).innerText()), participants: Number(await cells.nth(3).innerText()) });
  }
  expect(shownTop.length).toBe(Math.min(5, perCampaign.size));
  for (const t of shownTop) {
    const d = perCampaign.get(t.id);
    expect(d, `top campaign ${t.id} is a running campaign`).toBeTruthy();
    expect(t, `top campaign ${t.id}`).toEqual({ id: t.id, redemptions: d.redemptions, participants: d.participants });
  }
  for (let i = 1; i < shownTop.length; i += 1)
    expect(shownTop[i - 1].redemptions, 'top campaigns run from most to fewest').toBeGreaterThanOrEqual(shownTop[i].redemptions);
  const lastShown = shownTop.at(-1).redemptions;
  for (const [id, d] of perCampaign)
    if (!shownTop.some((t) => t.id === id)) expect(d.redemptions, `left-out campaign ${id}`).toBeLessThanOrEqual(lastShown);
  // Alerts: both thresholds are blank, read "not set", and switching one on is refused by name; nothing is stored.
  const alerts = page.getByRole('region', { name: 'Alerts' });
  for (const [kind, setting] of [
    ['budget_low', 'CAMPAIGNS_ALERT_BUDGET_LEFT_PERCENT'],
    ['redemptions_spike', 'CAMPAIGNS_ALERT_REDEMPTIONS_PER_HOUR'],
  ]) {
    const alert = alerts.locator(`[data-testid="watch-alert"][data-kind="${kind}"]`);
    await expect(alert.getByTestId('alert-threshold')).toHaveText(`Threshold: not set (owner value ${setting})`);
    await expect(alert).toHaveAttribute('data-enabled', 'false');
  }
  await alerts.getByRole('button', { name: 'Switch on: Budget running low' }).click();
  await expect(alerts.getByTestId('alert-refusal')).toHaveAttribute('data-code', 'campaigns.alert_threshold_unset');
  await expect(alerts.locator('[data-kind="budget_low"]')).toHaveAttribute('data-enabled', 'false');
  expect(await withDb((sql) => sql`SELECT kind FROM campaigns.alert_settings WHERE enabled`)).toHaveLength(0);
});

test(`${J} #2 opens one campaign: participation, vouchers, redemptions and publications; counts equal a direct row count`, async ({
  browser,
}) => {
  const { campaignId, campaignName } = state('campaignId', 'campaignName');
  const page = await (await browser.newContext()).newPage();
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/more-ops/campaigns/watch`);
  await page.getByRole('region', { name: 'Running campaigns' }).getByRole('link', { name: campaignName, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(campaignName);
  const direct = await withDb(async (sql) => {
    const n = async (t) => (await sql`SELECT count(*)::int AS n FROM ${sql('campaigns')}.${sql(t)} WHERE campaign_id = ${campaignId}`)[0].n;
    return {
      participation: await n('participations'),
      vouchers: await n('vouchers'),
      redemptions: await n('reward_intents'),
      publications: await n('code_publications'),
    };
  });
  for (const region of ['Participation', 'Vouchers', 'Redemptions', 'Publications']) {
    await expect(page.getByRole('region', { name: region })).toBeVisible();
  }
  for (const [part, n] of Object.entries(direct)) expect(await shownCount(page, part), part).toBe(n);
  // The TEST participation the journey starts from: one account, its voucher, its redemption, nothing published yet.
  expect(direct).toEqual({ participation: 1, vouchers: 1, redemptions: 1, publications: 0 });
  // The budget: limit = reserved + spent + left, and reserved + spent is what the campaign's rewards hold.
  const shown = await budgetShown(page.getByRole('region', { name: 'Budget' }).getByTestId('watch-budget'));
  expect(units(shown.reserved) + units(shown.spent) + units(shown.left)).toBe(units(shown.limit));
  expect(shown.limit).toBe('0.1');
  const drawn = await withDb(
    async (sql) =>
      (
        await sql`SELECT COALESCE(sum(amount), 0)::text AS s FROM campaigns.reward_intents
          WHERE campaign_id = ${campaignId} AND state NOT IN ('failed', 'forfeited', 'withheld')`
      )[0].s,
  );
  expect(units(shown.reserved) + units(shown.spent)).toBe(units(drawn));
  expect(units(drawn)).toBe(units('0.005'));
});

test(`${J} #3 generates a bulk code batch and imports a CSV: no duplicate codes; the database holds hashes and last four characters only; an import over a blank or exceeded limit refuses`, async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const { campaignId, typed } = state('campaignId', 'typed');
  const imported = [`JC17-${tag}-I1`, `JC17-${tag}-I2`, `JC17-${tag}-I3`];
  const countRows = () =>
    withDb(async (sql) => ({
      vouchers: (await sql`SELECT count(*)::int AS n FROM campaigns.vouchers WHERE campaign_id = ${campaignId}`)[0].n,
      batches: (await sql`SELECT count(*)::int AS n FROM campaigns.code_batches WHERE campaign_id = ${campaignId}`)[0].n,
    }));

  // A blank batch limit: svc-campaigns restarted with CAMPAIGNS_CODE_BATCH_MAX blank refuses the import and the generate.
  restartWith('campaigns', 'LOCAL_STACK_CAMPAIGNS_CODE_BATCH_MAX', false);
  try {
    const page = await founderPage(browser);
    await openCampaign(page, campaignId);
    const before = await countRows();
    await batches(page).getByLabel('Import name').fill(`TEST import ${tag}`);
    await batches(page)
      .getByLabel('CSV file')
      .setInputFiles(csvFile(testInfo, 'codes.csv', imported));
    await batches(page).getByRole('button', { name: 'Import codes' }).click();
    await expect(batches(page).getByTestId('batch-refusal')).toHaveAttribute('data-code', 'campaigns.code_batch_limit_unset');
    await batches(page).getByLabel('Batch name').fill(`TEST batch ${tag}`);
    await batches(page).getByLabel('How many codes').fill(String(BATCH_MAX));
    await batches(page).getByRole('button', { name: 'Generate codes' }).click();
    await expect(batches(page).getByTestId('batch-refusal')).toHaveAttribute('data-code', 'campaigns.code_batch_limit_unset');
    expect(await countRows()).toEqual(before);
  } finally {
    restartWith('campaigns', 'LOCAL_STACK_CAMPAIGNS_CODE_BATCH_MAX', true);
  }

  const page = await founderPage(browser);
  await openCampaign(page, campaignId);
  const before = await countRows();
  // Over the TEST limit of 5: refused, nothing stored.
  const six = Array.from({ length: BATCH_MAX + 1 }, (_, i) => `JC17-${tag}-X${i}`);
  await batches(page).getByLabel('Import name').fill(`TEST import over ${tag}`);
  await batches(page)
    .getByLabel('CSV file')
    .setInputFiles(csvFile(testInfo, 'six.csv', six));
  await batches(page).getByRole('button', { name: 'Import codes' }).click();
  await expect(batches(page).getByTestId('batch-refusal')).toHaveAttribute('data-code', 'campaigns.code_batch_limit_exceeded');
  // A file that repeats a code, or holds one already issued, is refused whole: no duplicate code is ever stored.
  await batches(page).getByLabel('Import name').fill(`TEST import repeat ${tag}`);
  await batches(page)
    .getByLabel('CSV file')
    .setInputFiles(csvFile(testInfo, 'repeat.csv', [imported[0], imported[0].toLowerCase()]));
  await batches(page).getByRole('button', { name: 'Import codes' }).click();
  await expect(batches(page).getByTestId('batch-refusal')).toHaveAttribute('data-code', 'campaigns.code_import_duplicate');
  await batches(page).getByLabel('Import name').fill(`TEST import taken ${tag}`);
  await batches(page)
    .getByLabel('CSV file')
    .setInputFiles(csvFile(testInfo, 'taken.csv', [imported[1], typed]));
  await batches(page).getByRole('button', { name: 'Import codes' }).click();
  await expect(batches(page).getByTestId('batch-refusal')).toHaveAttribute('data-code', 'campaigns.voucher_code_taken');
  expect(await countRows()).toEqual(before);

  // The import within the limit.
  await batches(page).getByLabel('Import name').fill(`TEST import ${tag}`);
  await batches(page)
    .getByLabel('CSV file')
    .setInputFiles(csvFile(testInfo, 'codes.csv', imported));
  await batches(page).getByRole('button', { name: 'Import codes' }).click();
  await expect(batches(page).getByTestId('batch-notice')).toContainText(`Imported 3 codes as batch TEST import ${tag}`);

  // The generate: its answer is the one place the plain codes exist.
  await batches(page).getByLabel('Batch name').fill(`TEST batch ${tag}`);
  await batches(page).getByLabel('How many codes').fill(String(BATCH_MAX));
  const answered = page.waitForResponse((r) => r.url().includes('/api/more-ops/campaigns/watch') && r.request().method() === 'POST');
  await batches(page).getByRole('button', { name: 'Generate codes' }).click();
  const generated = (await (await answered).json()).data;
  expect(generated.created).toBe(true);
  await expect(batches(page).getByTestId('batch-notice')).toContainText(`${BATCH_MAX} codes made in batch TEST batch ${tag}`);
  const codes = generated.codes;
  expect(codes).toHaveLength(BATCH_MAX);
  expect(new Set(codes).size).toBe(BATCH_MAX);

  const stored = await withDb(
    (sql) => sql`
      SELECT v.code, v.code_hash, v.code_last4, v.state, b.reference FROM campaigns.vouchers v
      JOIN campaigns.code_batches b ON b.id = v.batch_id WHERE v.campaign_id = ${campaignId}`,
  );
  // Every batch code: no plain code, only its hash and last four, and every hash once across every campaign.
  expect(stored).toHaveLength(BATCH_MAX + imported.length);
  expect(stored.every((r) => r.code === null && /^[0-9a-f]{64}$/.test(r.code_hash) && r.code_last4.length === 4)).toBe(true);
  expect(stored.map((r) => r.code_hash).sort()).toEqual([...codes, ...imported].map(sha).sort());
  expect(stored.map((r) => r.code_last4).sort()).toEqual([...codes, ...imported].map((c) => c.toUpperCase().slice(-4)).sort());
  const [{ dupes }] = await withDb(
    (sql) => sql`SELECT count(*)::int AS dupes FROM (SELECT code_hash FROM campaigns.vouchers GROUP BY code_hash HAVING count(*) > 1) d`,
  );
  expect(dupes).toBe(0);
  const everything = await everythingStored();
  for (const plain of [...codes, ...imported]) expect(everything, 'a plain code is stored').not.toContain(plain.toUpperCase());
  run.write({ ...run.read(), batchName: `TEST batch ${tag}`, batchId: generated.batch.id, codeCount: codes.length });
});

test(`${J} #4 takes the one-time download: no endpoint returns a plain code afterwards`, async ({ browser }) => {
  const { campaignId, batchName, batchId } = state('campaignId', 'batchName', 'batchId');
  const page = await founderPage(browser);
  const download = page.waitForEvent('download');
  await batches(page).getByRole('button', { name: 'Download the codes (once)' }).click();
  const file = await download;
  const text = readFileSync(await file.path(), 'utf8');
  const [header, ...codes] = text.trim().split('\n');
  expect(header).toBe('code');
  expect(codes).toHaveLength(BATCH_MAX);
  const hashes = await withDb((sql) => sql`SELECT code_hash FROM campaigns.vouchers WHERE batch_id = ${batchId}`);
  expect(hashes.map((h) => h.code_hash).sort()).toEqual(codes.map(sha).sort());
  // The codes left the page with the file: the button is gone, and a reload offers none.
  await expect(batches(page).getByRole('button', { name: 'Download the codes (once)' })).toHaveCount(0);
  await expect(batches(page).getByTestId('batch-notice')).toContainText('this was the only download');
  await openCampaign(page, campaignId);
  await expect(batches(page).getByRole('button', { name: 'Download the codes (once)' })).toHaveCount(0);
  // The same generate again returns the batch and no code.
  await batches(page).getByLabel('Batch name').fill(batchName);
  await batches(page).getByLabel('How many codes').fill(String(BATCH_MAX));
  const again = page.waitForResponse((r) => r.url().includes('/api/more-ops/campaigns/watch') && r.request().method() === 'POST');
  await batches(page).getByRole('button', { name: 'Generate codes' }).click();
  const second = (await (await again).json()).data;
  expect(second).toMatchObject({ created: false, codes: null, batch: { id: batchId } });
  await expect(batches(page).getByTestId('batch-notice')).toContainText('were given out once');
  await expect(batches(page).getByRole('button', { name: 'Download the codes (once)' })).toHaveCount(0);
  // No endpoint returns a plain code: every read of the console and of svc-campaigns' operator doors, and a voucher export.
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const reads = [
    await page.request.get(`${ADMIN}/api/more-ops/campaigns/watch?id=${encodeURIComponent(campaignId)}`).then((r) => r.text()),
    await page.request.get(`${ADMIN}/api/more-ops/campaigns/watch`).then((r) => r.text()),
    await page.request.get(`${ADMIN}/api/more-ops/campaigns?vouchers=${encodeURIComponent(campaignId)}`).then((r) => r.text()),
    (await ctx.edge.query('campaigns', 'ops.campaigns.vouchers.list', { campaignId }, a)).text,
    (await ctx.edge.query('campaigns', 'ops.campaigns.watch.campaign', { id: campaignId }, a)).text,
    (await ctx.edge.query('campaigns', 'ops.payouts.list', { campaignId }, a)).text,
    await page.content(),
  ];
  for (const r of reads) for (const plain of codes) expect(r.toUpperCase(), 'a read returned a plain code').not.toContain(plain);
  // Every one of them shows the batch's vouchers by their last four characters.
  expect(reads[0]).toContain(codes[0].slice(-4));
  run.write({ ...run.read(), codes });
});

test(`${J} #5 publishes codes to customers, then deactivates a voucher: claim and use of the deactivated voucher refuse`, async ({
  browser,
}) => {
  const { campaignId, batchName, batchId, codes, me } = state('campaignId', 'batchName', 'batchId', 'codes', 'me');
  const page = await founderPage(browser);
  await openCampaign(page, campaignId);
  // Not yet published: a customer's claim is the generic refusal.
  const client = await api(me);
  const early = await client.post('/api/campaigns/trpc/vouchers.claim', { code: codes[0] });
  expect(early.body?.error?.message ?? '').toContain('[campaigns.voucher_invalid]');
  await batches(page)
    .getByRole('button', { name: `Publish to customers: ${batchName}` })
    .click();
  await expect(batches(page).getByTestId('batch-notice')).toContainText(`Batch ${batchName} is published`);
  await expect(page.locator(`[data-testid="watch-batch"][data-batch-id="${batchId}"]`)).toHaveAttribute('data-state', 'published');
  expect(await shownCount(page, 'publications')).toBe(
    await withDb(
      async (sql) => (await sql`SELECT count(*)::int AS n FROM campaigns.code_publications WHERE campaign_id = ${campaignId}`)[0].n,
    ),
  );
  // The customer claims one published code; another stays free.
  const claimed = await client.post('/api/campaigns/trpc/vouchers.claim', { code: codes[0] });
  const mine = claimed.body?.result?.data;
  expect(mine?.state, JSON.stringify(claimed.body).slice(0, 300)).toBe('claimed');
  expect(mine.code).toBe(`…${codes[0].slice(-4)}`);
  const [free] = await withDb((sql) => sql`SELECT id FROM campaigns.vouchers WHERE code_hash = ${sha(codes[1])}`);

  // The operator deactivates both: the one the customer holds and the one still free.
  const vouchers = page.getByRole('region', { name: 'Vouchers' });
  await vouchers.getByRole('button', { name: `Deactivate voucher …${codes[0].slice(-4)}` }).click();
  await expect(page.locator(`[data-testid="watch-voucher"][data-voucher-id="${mine.id}"]`)).toHaveAttribute('data-state', 'deactivated');
  await vouchers.getByRole('button', { name: `Deactivate voucher …${codes[1].slice(-4)}` }).click();
  await expect(page.locator(`[data-testid="watch-voucher"][data-voucher-id="${free.id}"]`)).toHaveAttribute('data-state', 'deactivated');

  // Use of the deactivated voucher refuses, and nothing is written for it.
  const used = await client.post('/api/campaigns/trpc/vouchers.redeem', { voucherId: mine.id, amount: '0.005', sequence: 1 });
  expect(used.body?.error?.message ?? JSON.stringify(used.body)).toContain('[campaigns.voucher_deactivated]');
  const intents = await withDb((sql) => sql`SELECT reward_key FROM campaigns.reward_intents WHERE period LIKE ${`voucher:${mine.id}:%`}`);
  expect(intents).toEqual([]);
  // Claim of the deactivated voucher refuses, in the customer's own wallet, with the generic answer.
  const customer = await (await browser.newContext()).newPage();
  await signIn(customer, me);
  await customer.goto('/campaigns/mine');
  await expect(customer.getByTestId('my-vouchers')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  const form = customer.getByRole('form', { name: 'Voucher code' });
  await form.getByRole('textbox', { name: 'Code' }).fill(codes[1]);
  await form.getByRole('button', { name: 'Claim this voucher' }).click();
  await expect(customer.getByTestId('voucher-refusal')).toHaveAttribute('data-code', 'campaigns.voucher_invalid');
  const [still] = await withDb((sql) => sql`SELECT state, claimed_by FROM campaigns.vouchers WHERE id = ${free.id}`);
  expect(still).toEqual({ state: 'deactivated', claimed_by: null });
  // A code still published claims as before.
  const third = await client.post('/api/campaigns/trpc/vouchers.claim', { code: codes[2] });
  expect(third.body?.result?.data?.state, JSON.stringify(third.body).slice(0, 300)).toBe('claimed');
});

test(`${J} #6 requests the same export twice: one job runs; the file has the selected fields only; a link past its validity refuses`, async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { campaignId } = state('campaignId');
  const page = await founderPage(browser);
  await openCampaign(page, campaignId);
  const exportsPart = page.getByRole('region', { name: 'Exports' });
  await exportsPart.getByLabel('Export', { exact: true }).selectOption('participants');
  await exportsPart.getByRole('checkbox', { name: 'joinedAt' }).uncheck();
  await exportsPart.getByRole('button', { name: 'Request the export' }).click();
  await expect(exportsPart.getByTestId('export-notice')).toContainText('is ready');
  await exportsPart.getByRole('button', { name: 'Request the export' }).click();
  await expect(exportsPart.getByTestId('export-notice')).toContainText('no second job was started');
  const jobs = await withDb(
    (sql) => sql`SELECT id, fields, state FROM campaigns.export_jobs WHERE export_key = ${`export:${campaignId}:participants:accountId`}`,
  );
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ fields: ['accountId'], state: 'ready' });
  const jobId = jobs[0].id;
  await expect(exportsPart.getByTestId('watch-export')).toHaveCount(1);

  // The file: the selected field only, one row per participant.
  const download = page.waitForEvent('download');
  await exportsPart.getByRole('button', { name: `Download export ${jobId}` }).click();
  const lines = readFileSync(await (await download).path(), 'utf8')
    .trim()
    .split('\n');
  const accounts = await withDb(
    (sql) => sql`SELECT account_id FROM campaigns.participations WHERE campaign_id = ${campaignId} ORDER BY created_at, account_id`,
  );
  expect(lines).toEqual(['accountId', ...accounts.map((r) => r.account_id)]);
  expect(lines.every((l) => !l.includes(','))).toBe(true);

  // Past its validity the link refuses, on the page and at the link itself.
  // The link works until its validity (the TEST owner value, 20 seconds), and from then on refuses.
  const [{ expires_at: expiresAt, ready_at: readyAt }] = await withDb(
    (sql) => sql`SELECT expires_at, ready_at FROM campaigns.export_jobs WHERE id = ${jobId}`,
  );
  expect(new Date(expiresAt).getTime() - new Date(readyAt).getTime()).toBe(LINK_SECONDS * 1000);
  const link = `${ADMIN}/api/more-ops/campaigns/watch?export=${encodeURIComponent(jobId)}`;
  let refusedAt = 0;
  await expect
    .poll(
      async () => {
        const res = await page.request.get(link);
        if (res.status() !== 200) refusedAt = Date.now();
        return res.status();
      },
      { timeout: (LINK_SECONDS + 15) * 1000, intervals: [1_000] },
    )
    .toBe(409);
  expect(refusedAt, 'the link refused only once its validity had passed').toBeGreaterThanOrEqual(new Date(expiresAt).getTime());
  expect(await (await page.request.get(link)).text()).toContain('campaigns.export_expired');
  await exportsPart.getByRole('button', { name: `Download export ${jobId}` }).click();
  await expect(exportsPart.getByTestId('export-refusal')).toHaveAttribute('data-code', 'campaigns.export_expired');
});
