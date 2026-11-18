// World: gates
// Market: live
import { test, expect } from './journey.mjs';
import { journeyState } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';
import { tapeWindow } from './tape.mjs';
import { criteriaDoor } from './quant-criteria.mjs';

// J-algo-dev-15, in the running app (docs/roadmap/journeys.json): the three Algo dev Preview rooms (editor, tester,
// optimiser). One test per step, titled "J-algo-dev-15 #<n>", run in order. Step 1 proves a signed-out visitor sees the
// editor, then signs up one fresh TEST developer; the later steps sign it in again from the run file. Every row in these
// rooms is TEST sample data; every engine action is refused with the platform's one typed Preview refusal
// (packages/contracts/src/preview-refusal.ts: code `preview.engine_not_built`, kind `preview`, HTTP 412), and local
// interactions store nothing on a server. No money moves. Step 8 saves one TEST strategy, stores one real backtest of it,
// sets the gate's two owner criteria to TEST values (put back as they were after the file) and runs the real promotion
// gate (AL-lifecycle-01) on its own page: the gate judges, and the runs it read are exactly that stored backtest, so
// nothing the Preview rooms showed in #1 to #7 reaches it.
const J = 'J-algo-dev-15';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const LABEL = 'Preview · sample data';
const CODE = 'preview.engine_not_built';

test.describe.configure({ mode: 'default' });

function who() {
  const s = run.read();
  if (!s.who) throw new Error(`${J}: step 1 left no account, so this step has no one to sign in`);
  return s.who;
}

/** Every write the page sends to a server while `act` runs: local interactions must send none. */
async function writesDuring(page, act) {
  const writes = [];
  const seen = (req) => {
    if (req.method() !== 'GET' && req.method() !== 'HEAD' && req.method() !== 'OPTIONS') writes.push(`${req.method()} ${req.url()}`);
  };
  page.on('request', seen);
  try {
    await act();
  } finally {
    page.off('request', seen);
  }
  return writes;
}

/** A Preview room's shell: its label, its blurred engine panels with a text alternative, and its TEST sample rows. */
async function previewRoom(page, room) {
  const root = page.getByTestId('quant-preview');
  await expect(root).toBeVisible();
  await expect(root).toHaveAttribute('data-room', room);
  await expect(root.getByText(LABEL).first()).toBeVisible();
  const engines = root.getByTestId('preview-engine');
  expect(await engines.count(), `${room} has engine panels`).toBeGreaterThan(0);
  for (const panel of await engines.all()) {
    await expect(panel).toHaveAttribute('data-blurred', 'true');
    await expect(panel).toHaveAttribute('aria-label', /sample data/);
  }
  await expect(root).toContainText('TEST');
  return root;
}

/** The tRPC error a refused call answers, from a plain or a batched reply, with or without a json envelope. */
function trpcError(body) {
  const one = Array.isArray(body) ? body[0] : body;
  const error = one?.error;
  return error?.json ?? error;
}

/**
 * Presses `button` and checks the engine refusal end to end: one POST to svc-quant `preview.act` naming this room and
 * action, answered 412 with the typed Preview refusal, and the shell's alert saying "<Action> needs the <engine>. It is
 * a preview in this build." with the same code and kind. Returns the alert.
 */
async function refused(page, button, { room, action, words = [] }) {
  const reply = page.waitForResponse((r) => r.url().includes('preview.act') && r.request().method() === 'POST');
  await button.click();
  const res = await reply;
  expect(res.status(), `${action} answers 412`).toBe(412);
  const sent = res.request().postData() ?? '';
  expect(sent, `${action} names its room`).toContain(room);
  expect(sent, `${action} names its action`).toContain(action);
  const preview = trpcError(await res.json())?.data?.preview;
  expect(preview, `${action} carries error.data.preview`).toBeTruthy();
  expect(preview.kind).toBe('preview');
  expect(preview.code).toBe(CODE);
  expect(preview.label).toBe(LABEL);
  const alert = page.getByTestId('preview-refusal');
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute('role', 'alert');
  await expect(alert).toHaveAttribute('data-code', CODE);
  await expect(alert).toHaveAttribute('data-kind', 'preview');
  await expect(alert).toContainText(/^\s*\S.* needs the .+\. It is a preview in this build\./);
  for (const w of words) await expect(alert).toContainText(w);
  return alert;
}

const EDITOR_REGIONS = ['Files', 'Editor', 'Compile', 'Debugger', 'Profiler'];

async function editorRoom(page) {
  await expect(page).toHaveURL(/\/quant\/editor$/);
  await expect(page.getByRole('heading', { name: 'Code editor', level: 1 })).toBeVisible();
  const root = await previewRoom(page, 'editor');
  for (const name of EDITOR_REGIONS) await expect(root.getByRole('region', { name, exact: true }), name).toBeVisible();
  // The file tree is a tree of files, and the sample rows are marked TEST.
  await expect(root.getByRole('region', { name: 'Files', exact: true })).toContainText('TEST');
  return root;
}

test(`${J} #1 opens the editor from the Trade menu and then from the Web3 nav: the same Preview room with every layout, rows marked TEST`, async ({
  page,
}) => {
  // Signed out, the room is there too.
  await page.goto('/quant/editor');
  await editorRoom(page);

  run.reset({ who: await signUp(page, 'jad') });
  await signIn(page, who());

  // From the Trade menu.
  await page.goto('/home');
  await page.getByTestId('tb-tab').filter({ hasText: 'Trade' }).hover();
  await page
    .getByTestId('tb-menu')
    .getByRole('link', { name: /Algo editor/ })
    .click();
  await editorRoom(page);

  // From the Web3 nav: the same room at the same address. The Web3 bar's own sections stay exactly six (J-dex-protocol-01 #1),
  // so Algo dev sits in the bar's tools nav beside them.
  await page.goto('/dex');
  await expect(page.locator('[data-shell="web3"]')).toBeVisible();
  await page.getByRole('navigation', { name: 'Web3 tools' }).getByRole('link', { name: 'Algo dev', exact: true }).click();
  await editorRoom(page);
});

/** The editor's local state, as the page keeps it: only this one localStorage key. */
const EDITOR_KEY = 'quant.preview.editor';

test(`${J} #2 toggles a breakpoint and folds a block: the local state changes and survives a reload only in browser storage`, async ({
  page,
}) => {
  await signIn(page, who());
  await page.goto('/quant/editor');
  await editorRoom(page);
  await page.evaluate((key) => localStorage.removeItem(key), EDITOR_KEY);
  await page.reload();

  const breakpoint = page.getByRole('button', { name: /^Breakpoint on line \d+$/ }).first();
  const fold = page.getByRole('button', { name: /^Fold block at line \d+$/ }).first();
  const bpName = (await breakpoint.getAttribute('aria-label')) ?? (await breakpoint.textContent());
  const foldName = (await fold.getAttribute('aria-label')) ?? (await fold.textContent());
  const bpLine = page.getByRole('button', { name: bpName.trim(), exact: true });
  const foldLine = page.getByRole('button', { name: foldName.trim(), exact: true });
  await expect(bpLine).toHaveAttribute('aria-pressed', 'false');
  await expect(foldLine).toHaveAttribute('aria-expanded', 'true');

  const before = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  const writes = await writesDuring(page, async () => {
    await bpLine.click();
    await foldLine.click();
    // The local state changes.
    await expect(bpLine).toHaveAttribute('aria-pressed', 'true');
    await expect(foldLine).toHaveAttribute('aria-expanded', 'false');
  });
  // Nothing is stored on a server.
  expect(writes, 'no write reaches a server').toEqual([]);

  // It is kept in browser storage, under the one key and nowhere else.
  const after = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(after.local[EDITOR_KEY], 'the editor key holds the state').toBeTruthy();
  const changed = Object.keys(after.local).filter((k) => after.local[k] !== before.local[k]);
  expect(changed).toEqual([EDITOR_KEY]);
  expect(after.session).toEqual(before.session);

  // It survives a reload.
  await page.reload();
  await expect(bpLine).toHaveAttribute('aria-pressed', 'true');
  await expect(foldLine).toHaveAttribute('aria-expanded', 'false');

  // Only in browser storage: a fresh browser on the same account sees the default state.
  const other = await page.context().browser().newContext();
  const fresh = await other.newPage();
  await signIn(fresh, who());
  await fresh.goto('/quant/editor');
  await expect(fresh.getByRole('button', { name: bpName.trim(), exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(fresh.getByRole('button', { name: foldName.trim(), exact: true })).toHaveAttribute('aria-expanded', 'true');
  await other.close();

  // And clearing that key here resets it.
  await page.evaluate((key) => localStorage.removeItem(key), EDITOR_KEY);
  await page.reload();
  await expect(bpLine).toHaveAttribute('aria-pressed', 'false');
  await expect(foldLine).toHaveAttribute('aria-expanded', 'true');
});

test(`${J} #3 presses Compile: a typed Preview refusal in words and no sample build shown as a real result; the sandbox link opens /quant`, async ({
  page,
}) => {
  await signIn(page, who());
  await page.goto('/quant/editor');
  const root = await editorRoom(page);
  const compile = root.getByRole('region', { name: 'Compile', exact: true });
  await refused(page, root.getByRole('button', { name: 'Compile', exact: true }), { room: 'editor', action: 'compile' });
  await expect(page.getByTestId('preview-refusal')).toContainText(/^\s*Compile needs the /);
  // No sample build is shown as a real result: the panel's list stays labelled sample TEST rows, and no result appears.
  await expect(compile).toContainText('Sample');
  await expect(compile).toContainText('TEST');
  await expect(page.getByTestId('compile-result')).toHaveCount(0);
  await page.getByRole('link', { name: 'Open the working sandbox' }).click();
  await expect(page).toHaveURL(/\/quant$/);
  await expect(page.getByRole('heading', { name: 'Algo dev', level: 1 })).toBeVisible();
});

const replay = (page) => page.getByTestId('tester-replay');
const frame = async (page) => Number(await replay(page).getAttribute('data-frame'));

/** How many frames the replay advances over `ms`. */
async function advance(page, ms) {
  const start = await frame(page);
  await page.waitForTimeout(ms);
  return (await frame(page)) - start;
}

test(`${J} #4 opens the tester, moves the speed slider and presses Pause: the local replay follows and a reload resets it`, async ({
  page,
}) => {
  await signIn(page, who());
  await page.goto('/quant/tester');
  await expect(page.getByRole('heading', { name: 'Strategy tester', level: 1 })).toBeVisible();
  await previewRoom(page, 'tester');
  const slider = page.getByRole('slider', { name: 'Replay speed' });
  await expect(slider).toHaveValue('1');
  await expect(replay(page)).toHaveAttribute('data-speed', '1');
  const storageBefore = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));

  const writes = await writesDuring(page, async () => {
    // It plays at 1x.
    const slow = await advance(page, 1_500);
    expect(slow, 'the replay plays at 1x').toBeGreaterThan(0);

    // The speed slider moves the replay faster.
    await slider.fill('8');
    await expect(slider).toHaveAttribute('aria-valuetext', '8x');
    await expect(replay(page)).toHaveAttribute('data-speed', '8');
    const fast = await advance(page, 1_500);
    expect(fast, `8x advances faster than 1x (${fast} vs ${slow} frames)`).toBeGreaterThan(slow * 2);

    // Pause stops it, and the button becomes Play.
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    expect(await advance(page, 1_000), 'paused, the replay stands still').toBe(0);
  });
  expect(writes, 'no write reaches a server').toEqual([]);
  const paused = await frame(page);
  expect(paused).toBeGreaterThan(0);

  // Nothing of it is kept, so a reload resets it.
  const storageAfter = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storageAfter).toEqual(storageBefore);
  await page.reload();
  await expect(slider).toHaveValue('1');
  await expect(replay(page)).toHaveAttribute('data-speed', '1');
  expect(await frame(page), 'the reload starts the replay again from the start').toBeLessThan(paused);
});

test(`${J} #5 presses Start in the tester: the words say the tick engine is a preview in this build; the real backtest link opens`, async ({
  page,
}) => {
  await signIn(page, who());
  await page.goto('/quant/tester');
  const root = await previewRoom(page, 'tester');
  await refused(page, root.getByRole('button', { name: 'Start', exact: true }), {
    room: 'tester',
    action: 'start',
    words: ['tick engine', 'preview in this build'],
  });
  await page.getByRole('link', { name: 'Run a real backtest' }).click();
  await expect(page).toHaveURL(/\/quant\/backtest$/);
});

const passes = (page) => page.getByRole('table', { name: 'Optimisation passes' });
const bodyRows = (page) => passes(page).locator('tbody tr');

/** The column's cell texts, in row order, by header name. */
async function column(page, name) {
  const headers = (await passes(page).getByRole('columnheader').allInnerTexts()).map((t) => t.trim());
  const at = headers.findIndex((h) => h === name || h.startsWith(name));
  expect(at, `column ${name} in ${headers.join(', ')}`).toBeGreaterThanOrEqual(0);
  return bodyRows(page).evaluateAll((rows, i) => rows.map((r) => r.children[i]?.textContent?.trim() ?? ''), at);
}

const header = (page, name) => passes(page).getByRole('columnheader', { name, exact: true });

test(`${J} #6 opens the optimiser, filters loss-making passes and clicks a performance header: narrows locally, no sort, a note; Pass sorts`, async ({
  page,
}) => {
  await signIn(page, who());
  await page.goto('/quant/optimise');
  await expect(page.getByRole('heading', { name: 'Optimiser', level: 1 })).toBeVisible();
  await previewRoom(page, 'optimise');
  await expect(passes(page)).toContainText('TEST');
  const all = await bodyRows(page).count();
  expect(all).toBeGreaterThan(0);
  const profitsAll = await column(page, 'Profit');
  expect(
    profitsAll.some((p) => p.startsWith('-')),
    'the sample has a loss-making pass',
  ).toBe(true);
  expect(
    profitsAll.some((p) => !p.startsWith('-')),
    'the sample has a profitable pass',
  ).toBe(true);

  const writes = await writesDuring(page, async () => {
    // The filter narrows the sample table locally to the loss-making passes.
    await page.getByLabel('Show passes').selectOption({ label: 'Loss-making passes' });
    await expect.poll(() => bodyRows(page).count()).toBe(profitsAll.filter((p) => p.startsWith('-')).length);
    expect(await bodyRows(page).count()).toBeLessThan(all);
    for (const p of await column(page, 'Profit')) expect(p, 'a loss-making pass').toMatch(/^-/);

    // A performance header does not sort, and the note explains the rule.
    const order = await column(page, 'Pass');
    for (const name of ['Profit', 'Profit factor', 'Drawdown', 'Trades']) {
      const sortBefore = await header(page, name).getAttribute('aria-sort');
      await header(page, name).getByRole('button').click();
      expect(await column(page, 'Pass'), `${name} leaves the order`).toEqual(order);
      expect(await header(page, name).getAttribute('aria-sort'), `${name} leaves aria-sort`).toBe(sortBefore);
      expect(sortBefore === null || sortBefore === 'none', `${name} is never sorted`).toBe(true);
    }
    const note = page.getByRole('note').filter({ hasText: /performance/i });
    await expect(note).toBeVisible();
    await expect(note).toContainText(/sort/i);

    // The pass number header sorts, both ways.
    const pass = header(page, 'Pass');
    await pass.getByRole('button').click();
    const first = await pass.getAttribute('aria-sort');
    expect(['ascending', 'descending']).toContain(first);
    const numbers = (await column(page, 'Pass')).map((t) => Number(t.replace(/\D/g, '')));
    const asc = [...numbers].sort((a, b) => a - b);
    expect(numbers).toEqual(first === 'ascending' ? asc : [...asc].reverse());
    await pass.getByRole('button').click();
    await expect(pass).toHaveAttribute('aria-sort', first === 'ascending' ? 'descending' : 'ascending');
    const flipped = (await column(page, 'Pass')).map((t) => Number(t.replace(/\D/g, '')));
    expect(flipped).toEqual(first === 'ascending' ? [...asc].reverse() : asc);
  });
  expect(writes, 'no write reaches a server').toEqual([]);
});

const windows = (page) =>
  page.getByTestId('wf-window').evaluateAll((rows) => rows.map((r) => `${r.getAttribute('data-in')}|${r.getAttribute('data-out')}`));

test(`${J} #7 opens walk-forward, changes the forward preset, then presses Stop, Resume and Export: windows re-lay locally; each refuses`, async ({
  page,
}) => {
  await signIn(page, who());
  await page.goto('/quant/optimise');
  await previewRoom(page, 'optimise');
  await page.getByRole('button', { name: 'Walk-forward', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Walk-forward', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('wf-gate-line')).toBeVisible();
  const before = await windows(page);
  expect(before.length).toBeGreaterThan(0);
  for (const w of before) expect(w).not.toMatch(/null/);

  const preset = panel.getByLabel('Forward preset');
  const current = await preset.evaluate((s) => s.options[s.selectedIndex]?.textContent?.trim());
  const next = current === '50%' ? '25%' : '50%';
  const writes = await writesDuring(page, async () => {
    await preset.selectOption({ label: next });
    // The sample windows re-lay, with the gate line still visible.
    await expect.poll(() => windows(page)).not.toEqual(before);
    await expect(panel.getByTestId('wf-gate-line')).toBeVisible();
  });
  expect(writes, 'no write reaches a server').toEqual([]);
  const relaid = await windows(page);

  for (const [name, action] of [
    ['Stop', 'stop'],
    ['Resume', 'resume'],
    ['Export', 'export'],
  ]) {
    await refused(page, panel.getByRole('button', { name, exact: true }), { room: 'optimise', action });
    await expect(page.getByTestId('preview-refusal')).toContainText(new RegExp(`^\\s*${name} needs the `));
  }
  // The refusals leave the sample windows as they were.
  expect(await windows(page)).toEqual(relaid);
});

// The gate's two criteria, set to TEST values in #8 so the gate judges instead of refusing for a blank one.
const GATE = { 'gate.paperMinutes': '1', 'gate.maxDrawdownPercent': '100' };
let gateBefore = null;

// The gate's criteria go back exactly as they were whatever happened, so no later file reads this journey's values.
test.afterAll(async () => {
  if (!gateBefore) return;
  const door = await criteriaDoor(J);
  for (const name of Object.keys(GATE)) {
    const was = gateBefore.find((row) => row.name === name);
    await door.set(name, was?.value ?? null, was?.source !== 'operator');
  }
});

/** Saves a signal-rules TEST strategy on 1 minute bars of BTC/USDT at version 1, with every risk limit set; returns its id. */
async function saveStrategy(page, name) {
  await page.goto('/quant/studio');
  const fresh = page.getByRole('button', { name: 'Start a new strategy', exact: true });
  if (await fresh.isVisible()) await fresh.click();
  await page.getByLabel('Strategy name', { exact: true }).fill(name);
  await page.getByLabel('Simulated starting cash', { exact: true }).fill('1000');
  await page.getByLabel('Block 1 symbol', { exact: true }).fill('BTC/USDT');
  await page.getByLabel('Block 1 quantity', { exact: true }).fill('0.01');
  await page.getByLabel('Max drawdown (service unit unspecified)', { exact: true }).fill('100');
  await page.getByLabel('Max notional (service unit unspecified)', { exact: true }).fill('500');
  await page.getByLabel('Kill threshold (service unit unspecified)', { exact: true }).fill('50');
  await page.getByRole('combobox', { name: /^How the strategy trades/ }).selectOption('signal');
  const builder = page.getByTestId('quant-signal-builder');
  await builder.getByLabel('Symbol', { exact: true }).fill('BTC/USDT');
  await builder.getByRole('combobox', { name: /^Bar size/ }).selectOption('1m');
  await builder.getByLabel('Fast average (bars)', { exact: true }).fill('1');
  await builder.getByLabel('Slow average (bars)', { exact: true }).fill('2');
  await builder.getByRole('combobox', { name: /^Size each entry by/ }).selectOption('quantity');
  await builder.getByLabel('Size', { exact: true }).fill('0.01');
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText('Saved as version 1.');
  await page.goto('/quant/strategies');
  const row = page.getByTestId('quant-strategy-row').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  const id = await row.getAttribute('data-id');
  expect(id, 'the saved strategy has an id').toBeTruthy();
  return id;
}

/** Runs one split backtest of version 1 of `name` on the latest TEST tape in the real backtest room; returns its stored run id. */
async function backtest(page, name, window) {
  await page.goto('/quant/backtest');
  const room = page.getByTestId('quant-bar-backtest');
  await room.getByRole('combobox', { name: /^Strategy/ }).selectOption({ label: name });
  await expect(room.getByTestId('quant-backtest-rules')).toHaveText('Version 1: BTC/USDT, 1m bars.');
  await room.getByLabel('From (UTC)', { exact: true }).fill(window.from);
  await room.getByLabel('To (UTC)', { exact: true }).fill(window.to);
  await room.getByRole('combobox', { name: /^Fill a signal at/ }).selectOption('next_open');
  await room.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await room.getByLabel('Delay (bars)', { exact: true }).fill('0');
  await room.getByLabel('Slippage (basis points)', { exact: true }).fill('5');
  await room.getByRole('combobox', { name: /^Out-of-sample split/ }).selectOption('1/3');
  await room.getByTestId('quant-backtest-run').click();
  const result = room.getByTestId('quant-bar-result');
  await expect(result).toBeVisible();
  const runId = await result.getAttribute('data-run-id');
  expect(runId, 'the backtest is stored as a run').toBeTruthy();
  return runId;
}

/** Fails if `text` carries anything a Preview room shows: its label, the word preview, sample data or the Preview code. */
function noPreview(text, what) {
  expect(text, what).not.toContain(LABEL);
  expect(text, what).not.toMatch(/preview|sample data/i);
  expect(text, what).not.toContain(CODE);
}

/** The data a tRPC reply carries, from a plain or a batched reply, with or without a json envelope. */
function trpcData(text) {
  const body = JSON.parse(text);
  const data = (Array.isArray(body) ? body[0] : body)?.result?.data;
  return data?.json ?? data;
}

test(`${J} #8 runs the promotion gate afterwards: the gate reads no Preview value`, async ({ page }) => {
  test.setTimeout(20 * 60_000);
  await signIn(page, who());
  // Afterwards: the Preview optimiser still shows its sample walk-forward windows and their gate line.
  await page.goto('/quant/optimise');
  await previewRoom(page, 'optimise');
  await page.getByRole('button', { name: 'Walk-forward', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Walk-forward', exact: true }).getByTestId('wf-gate-line')).toBeVisible();
  expect((await windows(page)).length, 'the Preview room shows sample windows').toBeGreaterThan(0);

  // The person's own strategy, saved for real, with one real backtest stored as a run and no paper run.
  const name = `TEST gate strategy ${Date.now().toString(36)}`;
  const id = await saveStrategy(page, name);
  const runId = await backtest(page, name, await tapeWindow(60));

  // The owner's gate criteria are set (TEST), so the gate judges this version rather than refusing for a blank one.
  const door = await criteriaDoor(J);
  gateBefore = await door.read();
  for (const [criterion, value] of Object.entries(GATE)) await door.set(criterion, value);

  const lifecycleReads = [];
  page.on('response', (res) => {
    if (res.url().includes('/trpc/lifecycle.get')) lifecycleReads.push(res);
  });
  await page.goto(`/quant/strategies/${encodeURIComponent(id)}`);
  const gate = page.getByRole('region', { name: 'Lifecycle and promotion', exact: true });
  await expect(gate).toBeVisible();
  const life = gate.getByTestId('quant-lifecycle-version');
  await expect(life).toHaveAttribute('data-version', '1');
  // The stage is read from this version's own stored runs: its backtest has moved it past draft.
  const stage = await life.getAttribute('data-stage');
  expect(stage, 'the stage this version reached on its own backtest').not.toBe('draft');

  // The gate as it reads now: four checks, each reading this version's own stored backtest, its own limits or nothing.
  const checks = life.getByTestId('quant-gate-check');
  await expect(checks).toHaveCount(4);
  const check = (n) => life.locator(`[data-testid="quant-gate-check"][data-check="${n}"]`);
  await expect(check('outOfSample')).toHaveAttribute('data-run-id', runId);
  await expect(check('riskLimits')).toHaveAttribute('data-status', 'met');
  await expect(check('riskLimits')).toHaveAttribute('data-run-id', '');
  // No paper run of this version exists, and the Preview tester's replay is not one: the paper check reads nothing.
  await expect(check('paperDuration')).toHaveAttribute('data-status', 'not_met');
  await expect(check('paperDuration')).toHaveAttribute('data-run-id', '');
  await expect(check('paperDuration')).toHaveAttribute('data-criterion-value', GATE['gate.paperMinutes']);
  await expect(check('paperDuration').locator('td').nth(3)).toHaveText('Nothing yet');
  await expect(check('maxDrawdown')).toHaveAttribute('data-criterion-value', GATE['gate.maxDrawdownPercent']);
  for (const row of await checks.all()) noPreview(await row.innerText(), 'a gate check row');

  // What svc-quant sent: every run the gate read is this version's own stored backtest, and no field is a Preview value.
  expect(lifecycleReads.length, 'the page read the gate from svc-quant').toBeGreaterThan(0);
  const readText = await lifecycleReads.at(-1).text();
  noPreview(readText, 'the gate reading svc-quant sent');
  const reading = trpcData(readText);
  expect(reading.gate.unset, 'the owner set every gate criterion').toEqual([]);
  const readRuns = reading.gate.checks.flatMap((c) => (c.runId ? [c.runId] : []));
  expect(readRuns.length, 'the gate read the stored backtest').toBeGreaterThan(0);
  expect(new Set(readRuns), "the gate read no run but this version's own backtest").toEqual(new Set([runId]));

  // Runs the gate: Promote asks svc-quant to judge this version. It judges, rejects (no paper run), and names as read
  // exactly the stored backtest and the owner's criteria, nothing a Preview room showed.
  const reply = page.waitForResponse((r) => r.url().includes('/trpc/lifecycle.promote') && r.request().method() === 'POST');
  await life.getByRole('button', { name: 'Promote version 1', exact: true }).click();
  const res = await reply;
  const body = await res.text();
  expect(res.status(), `the gate judges: ${body.slice(0, 300)}`).toBe(200);
  noPreview(body, 'the gate answer');
  const { decision } = trpcData(body);
  expect(decision.decision, 'the gate does not approve a version with no paper run').toBe('rejected');
  expect(decision.runIds, "the gate read only this version's stored backtest").toEqual([runId]);
  expect(decision.criteria, "the gate read the owner's criteria as set").toEqual([
    { name: 'paperMinutes', value: GATE['gate.paperMinutes'] },
    { name: 'maxDrawdownPercent', value: GATE['gate.maxDrawdownPercent'] },
  ]);
  await expect(life.getByTestId('quant-promote-decision')).toHaveAttribute('data-decision', 'rejected');
  await expect(page.locator('[data-kind="preview"], [data-code="preview.engine_not_built"]')).toHaveCount(0);
  noPreview(await life.innerText(), 'the gate checks and its answer');

  // Read back from the service: the decision is stored once, naming the backtest; the stage did not move.
  await page.reload();
  await expect(life).toHaveAttribute('data-stage', stage);
  const decisions = life.getByTestId('quant-gate-decisions');
  await expect(decisions).toHaveAttribute('data-count', '1');
  await expect(decisions).toHaveAttribute('data-stages', '0');
  const stored = decisions.getByTestId('quant-gate-decision');
  await expect(stored).toHaveCount(1);
  await expect(stored).toHaveAttribute('data-decision', 'rejected');
  await expect(stored).toHaveAttribute('data-run-ids', runId);
});
