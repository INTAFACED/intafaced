// World: none
import { test, expect } from './journey.mjs';
import { journeyState } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-algo-dev-15, in the running app (docs/roadmap/journeys.json): the three Algo dev Preview rooms (editor, tester,
// optimiser). One test per step, titled "J-algo-dev-15 #<n>", run in order. Step 1 proves a signed-out visitor sees the
// editor, then signs up one fresh TEST developer; the later steps sign it in again from the run file. Every row in these
// rooms is TEST sample data; every engine action is refused with the platform's one typed Preview refusal
// (packages/contracts/src/preview-refusal.ts: code `preview.engine_not_built`, kind `preview`, HTTP 412), and local
// interactions store nothing on a server. No money moves.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #8: the promotion gate (AL-lifecycle-01) is not in this app yet.
const J = 'J-algo-dev-15';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
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

test(`${J} #8 runs the promotion gate afterwards: the gate reads no Preview value (AL-lifecycle-01, not built)`, async ({ page }) => {
  await signIn(page, who());
  await page.goto('/quant/strategies');
  // Not built: the promotion gate (AL-lifecycle-01) is not in this app yet; this is where the spec puts it.
  const gate = page.getByRole('region', { name: 'Promotion gate' });
  await expect(gate).toBeVisible(UNBUILT);
  await gate.getByRole('button', { name: /Run the promotion gate/ }).click();
  const rows = gate.getByRole('row');
  await expect.poll(() => rows.count()).toBeGreaterThan(0);
  // No row of the gate reads a value from a Preview room.
  for (const text of await rows.allInnerTexts()) {
    expect(text).not.toContain(LABEL);
    expect(text).not.toMatch(/preview|sample data/i);
  }
  await expect(gate.locator('[data-kind="preview"], [data-code="preview.engine_not_built"]')).toHaveCount(0);
});
