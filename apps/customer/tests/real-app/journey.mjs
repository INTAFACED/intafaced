import { test as base, expect as baseExpect, chromium as playwrightChromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { guardPostingFreeze, postingFromHealth } from '../../../../tooling/scripts/journey-freeze-guard.mjs';
import { FAIL_FAST, failFastSteps, failsFast } from '../../../../tooling/scripts/journey-fail-fast.mjs';
import { REACH_ATTACHMENT, makeLogReader, makeRecorder } from '../../../../tooling/scripts/journey-reach.mjs';
import { localStackState } from '../../../../tooling/scripts/local-test-state.mjs';
import { LEDGER, ROOT, recordSignIn } from './stack.mjs';
import { enterFile } from './world-restore.mjs';

// Every journey imports `test` (and `expect`) from here, never from '@playwright/test' directly
// (tooling/scripts/journey-freeze-guard.test.mjs fails a file that does), and so does every helper that asserts, so a
// step that fails fast waits the same everywhere. Everything else is Playwright's own.
export * from '@playwright/test';

/** svc-ledger's posting switch: true (open), false (frozen) or null when the ledger does not answer. */
async function readPosting() {
  try {
    const res = await fetch(`${LEDGER}/health`, { signal: AbortSignal.timeout(2_000) });
    return postingFromHealth(await res.json());
  } catch {
    return null;
  }
}

/** Lift a LOCAL TEST freeze through the founders' freeze door, signing them in afresh (refuses any other freeze). */
async function lift() {
  // Asynchronous, so the worker keeps answering Playwright while two founders sign in.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [path.join(ROOT, 'tooling/scripts/local-test-gates.mjs'), 'posting-freeze', 'lift-leaked'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
  );
  return stdout.trim().split('\n').at(-1) ?? 'lifted';
}

// The planner's fail-fast plan, on a full CI run only (tooling/scripts/journey-fail-fast.mjs); empty elsewhere.
const FAST_PLAN = failFastSteps();

/** True inside a step that fails fast. Outside a test (a helper at import time) it is false. */
function inFastStep() {
  if (FAST_PLAN.steps.size === 0) return false;
  try {
    return failsFast(FAST_PLAN, test.info().title);
  } catch {
    return false;
  }
}

const fastExpect = baseExpect.configure({ timeout: FAIL_FAST.waitMs });

/**
 * Playwright's `expect`, except that inside a step that fails fast an assertion with no timeout of its own waits
 * FAIL_FAST.waitMs. `expect.poll`, `expect.soft` and the rest are Playwright's own.
 */
export const expect = new Proxy(baseExpect, {
  apply: (target, self, args) => Reflect.apply(inFastStep() ? fastExpect : target, self, args),
});

// What each journey file reached (tooling/scripts/journey-reach.mjs): the stack's ports and paths its Node code and its
// pages called, and the customer app's functions its pages ran, attached to the report per test as `journey-reach`. The
// file running now owns what is recorded; a file's own beforeAll and afterAll hooks enter it first (below).
const reach = makeRecorder({ root: ROOT, distDir: path.join(ROOT, 'apps', 'customer', 'dist') });
let reachFile = 'outside-any-file';
// What the stack's services logged they served, read from their own logs at each read below (journey-reach.mjs).
const stackLogs = makeLogReader(path.join(localStackState(), 'logs'));
const enterReach = (file) => {
  reachFile = file;
  reach.enter(file);
};
const readLogs = () => noted(() => reach.served(stackLogs.read(), reachFile));
const noted = (fn) => {
  try {
    fn();
  } catch {
    /* recording never stops a request, a page or a test */
  }
};

// Every sign-in or sign-up a journey sends from Node, through any helper, names an account whose resting orders come down
// before the next file (stack.mjs recordSignIn). Browser pages are watched the same way (the `browser` fixture below).
const nodeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  try {
    recordSignIn(typeof input === 'string' ? input : input?.url, typeof init?.body === 'string' ? init.body : undefined);
  } catch {
    /* recording never stops a request */
  }
  noted(() => reach.request(reachFile, typeof input === 'string' ? input : (input?.url ?? String(input)), init?.method ?? input?.method));
  return nodeFetch(input, init);
};

/**
 * Each page's coverage of the customer app: Chromium's precise coverage with call counts, started before the page's
 * first navigation and read without a gap at every test's end and before the page or its context closes (CDP
 * Profiler.takePreciseCoverage reads and resets the counts). A page the app opened by itself (a popup) starts counting
 * only once it is seen, and a page that closed or lost its session before it was read can't be read whole: both mark
 * the record incomplete, which the map reads as reaching every source.
 */
const covered = new Map(); // page -> { cdp, file }
async function startCoverage(page, { opened = false } = {}) {
  if (covered.has(page)) return;
  const entry = { cdp: null, file: reachFile, gone: false };
  covered.set(page, entry);
  try {
    entry.cdp = await page.context().newCDPSession(page);
    await entry.cdp.send('Profiler.enable');
    await entry.cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
    entry.cdp.on('close', () => {
      if (!entry.gone) reach.incomplete(reachFile, 'a page lost its coverage session before it was read');
    });
    if (opened) reach.incomplete(reachFile, 'the app opened a page by itself; its first scripts ran before coverage started');
  } catch (e) {
    reach.incomplete(reachFile, `coverage could not start on a page (${e.message})`);
  }
  page.on('websocket', (ws) => noted(() => reach.request(reachFile, ws.url(), 'WS')));
  page.on('close', () => {
    if (!entry.gone) reach.incomplete(reachFile, 'a page closed before its coverage was read');
    covered.delete(page);
  });
}
async function readCoverage(page, { last = false } = {}) {
  const entry = covered.get(page);
  if (!entry?.cdp) return;
  try {
    const { result } = await entry.cdp.send('Profiler.takePreciseCoverage');
    reach.coverage(reachFile, result);
  } catch (e) {
    if (!entry.gone) reach.incomplete(reachFile, `a page's coverage could not be read (${e.message})`);
  }
  if (last) entry.gone = true;
}
const readAll = (pages, opts) => Promise.all(pages.map((p) => readCoverage(p, opts)));

const creating = new WeakMap(); // context -> pages being made by our own newPage, not opened by the app
const watched = new WeakSet();
function watchContext(context) {
  if (watched.has(context)) return context;
  watched.add(context);
  context.on('request', (req) => {
    recordSignIn(req.url(), req.postData() ?? undefined);
    noted(() => reach.request(reachFile, req.url(), req.method()));
  });
  context.on('page', (page) => {
    if (!(creating.get(context) > 0)) void startCoverage(page, { opened: true });
  });
  const newPage = context.newPage.bind(context);
  context.newPage = async (...args) => {
    creating.set(context, (creating.get(context) ?? 0) + 1);
    let page;
    try {
      page = await newPage(...args);
    } finally {
      creating.set(context, creating.get(context) - 1);
    }
    await startCoverage(page);
    const close = page.close.bind(page);
    page.close = async (...a) => {
      await readCoverage(page, { last: true });
      return close(...a);
    };
    return page;
  };
  const closeContext = context.close.bind(context);
  context.close = async (...a) => {
    await readAll(context.pages(), { last: true });
    return closeContext(...a);
  };
  return context;
}
const watchSignIns = watchContext;

/** Every context of a browser reports its sign-ins and its reach: its own newContext and newPage, and its close. */
function watchBrowser(browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => watchContext(await newContext(...args));
  // browser.newPage(options) is a page in a context of its own, closed with the page: made here the same way, so counting
  // starts on about:blank, before its first navigation.
  browser.newPage = async (options) => {
    const context = watchContext(await newContext(options));
    const page = await context.newPage();
    const close = page.close.bind(page);
    page.close = async (...a) => {
      await close(...a);
      await closeContextQuietly(context);
    };
    return page;
  };
  const closeBrowser = browser.close.bind(browser);
  browser.close = async (...a) => {
    await readAll(
      browser.contexts().flatMap((c) => c.pages()),
      { last: true },
    );
    return closeBrowser(...a);
  };
  return browser;
}
const closeContextQuietly = async (context) => {
  try {
    await context.close();
  } catch {
    /* already closed */
  }
};

/** Playwright's chromium, whose launched browsers report like the fixture's (J-identity-08 launches its own). */
export const chromium = new Proxy(playwrightChromium, {
  get(target, prop, receiver) {
    if (prop === 'launch') return async (...args) => watchBrowser(await target.launch(...args));
    const v = Reflect.get(target, prop, receiver);
    return typeof v === 'function' ? v.bind(target) : v;
  },
});

const extended = base.extend({
  // Every context a journey opens, through the `page` fixture or its own browser.newContext(), reports its sign-ins.
  browser: [
    async ({ browser }, use) => {
      await use(watchBrowser(browser));
    },
    { scope: 'worker' },
  ],
  context: async ({ context }, use) => {
    watchSignIns(context);
    await use(context);
  },
  // No journey file leaves the shared world changed for the file after it: its resting orders, algos and bots come down,
  // and its TEST price moves are cleared, before the next file's first step (world-restore.mjs, journey-world.mjs).
  worldBetweenFiles: [
    async ({}, use, testInfo) => {
      enterReach(testInfo.file);
      await enterFile(testInfo.file);
      await use();
    },
    { auto: true, timeout: 150_000 },
  ],
  // What this test's file reached, read from every open page and attached (tooling/scripts/journey-reach.mjs). Records of
  // other files still waiting (a file's afterAll hooks, run after its last test) are attached here too, each naming its
  // own file. Never fails the test.
  // It takes `context`, so it ends before the test's own context closes and reads its pages while they are open.
  journeyReach: [
    async ({ context }, use, testInfo) => {
      void context;
      await use();
      try {
        await readAll([...covered.keys()]);
        readLogs();
        for (const file of reach.files()) {
          const record = reach.take(file);
          if (record) await testInfo.attach(REACH_ATTACHMENT, { body: JSON.stringify(record), contentType: 'application/json' });
        }
      } catch {
        /* recording never fails a test */
      }
    },
    { auto: true },
  ],
  // No journey leaves the platform posting freeze on for the journeys after it (journey-freeze-guard.mjs).
  postingFreezeGuard: [
    async ({}, use, testInfo) => {
      await guardPostingFreeze({ title: testInfo.titlePath.slice(1).join(' › '), readPosting, lift, body: () => use() });
    },
    // Its own time, apart from the test's: a test that timed out inside its freeze is exactly the one to lift.
    { auto: true, timeout: 150_000 },
  ],
  // A test that fails fast ends after FAIL_FAST.testMs, unless it has a limit other than the project's: one set before this
  // runs (describe.configure, test.use, test.slow) is kept, and one set inside the test (test.setTimeout) comes after it.
  failFastStep: [
    async ({}, use, testInfo) => {
      const ordinary = testInfo.timeout === testInfo.project.timeout && testInfo.timeout > 0;
      if (ordinary && failsFast(FAST_PLAN, testInfo.title)) testInfo.setTimeout(FAIL_FAST.testMs);
      await use();
    },
    { auto: true },
  ],
  // ...and every page it opens, through the `page` fixture or its own browser.newContext(), waits FAIL_FAST.waitMs for an
  // action and FAIL_FAST.testMs for a navigation, unless the call names its own timeout (Playwright applies these two
  // options to each context the test creates).
  actionTimeout: async ({ actionTimeout }, use, testInfo) => use(failsFast(FAST_PLAN, testInfo.title) ? FAIL_FAST.waitMs : actionTimeout),
  navigationTimeout: async ({ navigationTimeout }, use, testInfo) =>
    use(failsFast(FAST_PLAN, testInfo.title) ? FAIL_FAST.testMs : navigationTimeout),
});

/**
 * A file's own `test.beforeAll` runs before any test-scoped fixture, so `worldBetweenFiles` alone would put back the last
 * file's world after this file's first hook had already acted (its account then counted as the last file's and its
 * orders taken down). Each beforeAll therefore enters its file first. Playwright reads a hook's fixtures from its source
 * text, so the wrapper answers with the hook's own; the hook's location in a report reads as this file.
 */
const beforeAll = extended.beforeAll;
extended.beforeAll = (...args) => {
  const hook = args.pop();
  const entered = async (fixtures, testInfo) => {
    // The restore gets its own time on top of the hook's, as the worldBetweenFiles fixture does.
    if (testInfo.timeout > 0) testInfo.setTimeout(testInfo.timeout + 150_000);
    enterReach(testInfo.file);
    await enterFile(testInfo.file);
    return hook(fixtures, testInfo);
  };
  entered.toString = () => hook.toString();
  return beforeAll(...args, entered);
};

/** A file's afterAll hooks run after its last test: what they reach is its own, read once they end and attached by the
 *  next test that runs (journeyReach). */
const afterAll = extended.afterAll;
extended.afterAll = (...args) => {
  const hook = args.pop();
  const after = async (fixtures, testInfo) => {
    enterReach(testInfo.file);
    try {
      return await hook(fixtures, testInfo);
    } finally {
      await readAll([...covered.keys()]).catch(() => {});
      readLogs();
      reach.afterAll(testInfo.file);
    }
  };
  after.toString = () => hook.toString();
  return afterAll(...args, after);
};

export const test = extended;
