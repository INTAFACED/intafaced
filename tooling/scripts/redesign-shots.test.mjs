// Tests for redesign-shots.mjs: argument parsing, the 127.0.0.1 guard, the assertion regexes, the keyboard
// runner and the side-by-side composer. Run: node tooling/scripts/redesign-shots.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BANNED_WORDS_RE,
  MONEY_RE,
  OURS_LABEL,
  REPO_ROOT,
  UsageError,
  assertLoopbackBase,
  buildComposerHtml,
  composeSideBySide,
  findBannedWords,
  findChromiumExecutable,
  hasLimeColor,
  isInsideRepo,
  isLoopbackUrl,
  isMoneyFormat,
  launchBrowser,
  locationMatches,
  matchFocus,
  missingReferenceFiles,
  pageChecks,
  parseArgs,
  pickAccount,
  referenceLabel,
  requestLimitFor,
  runKeyboard,
  validateKeyboardSteps,
  validateRefs,
} from './redesign-shots.mjs';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'redesign-shots.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'redesign-shots-test-'));
let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    process.stdout.write(`ok  ${name}\n`);
  } catch (error) {
    process.stdout.write(`FAIL ${name}\n`);
    throw error;
  }
};
const throwsUsage = (fn, re) => assert.throws(fn, (e) => e instanceof UsageError && (!re || re.test(e.message)));

try {
  // ---- arguments ----
  await test('parseArgs accepts a full valid command line', () => {
    const o = parseArgs(['--milestone', 'm2', '--base', 'http://127.0.0.1:3210', '--out', '/tmp/x', '--refs', '/tmp/r.json']);
    assert.equal(o.milestone, 'M2');
    assert.equal(o.base, 'http://127.0.0.1:3210');
    assert.equal(o.out, '/tmp/x');
    assert.equal(o.refs, '/tmp/r.json');
    assert.equal(o.idleSeconds, 60);
    assert.equal(o.only, null);
  });
  await test('parseArgs supports --key=value, defaults the base, and --only', () => {
    const o = parseArgs(['--milestone=M1', '--out=/tmp/x', '--refs=/tmp/r.json', '--only=home,money', '--idle-seconds=10']);
    assert.equal(o.base, 'http://127.0.0.1:3210');
    assert.deepEqual(o.only, ['home', 'money']);
    assert.equal(o.idleSeconds, 10);
  });
  await test('parseArgs rejects bad input', () => {
    const ok = ['--out', '/tmp/x', '--refs', '/tmp/r.json'];
    throwsUsage(() => parseArgs(['--milestone', 'M4', ...ok]), /M1, M2 or M3/);
    throwsUsage(() => parseArgs([...ok]), /milestone/);
    throwsUsage(() => parseArgs(['--milestone', 'M1', '--refs', '/tmp/r.json']), /--out/);
    throwsUsage(() => parseArgs(['--milestone', 'M1', '--out', '/tmp/x']), /--refs/);
    throwsUsage(() => parseArgs(['--milestone', 'M1', ...ok, '--bogus', '1']), /Unknown option/);
    throwsUsage(() => parseArgs(['--milestone', 'M1', ...ok, 'stray']), /Unexpected argument/);
    throwsUsage(() => parseArgs(['--milestone', 'M1', ...ok, '--idle-seconds', '1']), /idle-seconds/);
    throwsUsage(() => parseArgs(['--milestone', 'M1', '--out']), /needs a value/);
  });
  await test('parseArgs --help short-circuits', () => assert.deepEqual(parseArgs(['--help']), { help: true }));

  // ---- 127.0.0.1 guard ----
  await test('assertLoopbackBase allows only the literal host 127.0.0.1', () => {
    assert.equal(assertLoopbackBase('http://127.0.0.1:3210'), 'http://127.0.0.1:3210');
    assert.equal(assertLoopbackBase('http://127.0.0.1:3210/'), 'http://127.0.0.1:3210');
    assert.equal(assertLoopbackBase('https://127.0.0.1'), 'https://127.0.0.1');
    for (const bad of [
      'http://localhost:3210',
      'http://[::1]:3210',
      'http://0.0.0.0:3210',
      'http://127.0.0.2:3210',
      'http://127.0.0.1.evil.com',
      'http://127.0.0.1@evil.com',
      'http://evil.com@127.0.0.1.evil.com',
      'http://user:pw@127.0.0.1:3210',
      'https://example.com',
      'https://example.org',
      'ftp://127.0.0.1',
      'file:///etc/passwd',
      'http://127.0.0.1:3210/login',
      'not a url',
      '',
    ]) {
      throwsUsage(() => assertLoopbackBase(bad), undefined);
    }
  });
  await test('the CLI exits 2 before starting a browser for a non-127.0.0.1 base', () => {
    const refs = join(tmp, 'refs.json');
    writeFileSync(refs, '{}');
    for (const base of ['http://localhost:3210', 'https://example.com', 'http://127.0.0.1.evil.com']) {
      const r = spawnSync(process.execPath, [script, '--milestone', 'M1', '--base', base, '--out', join(tmp, 'out'), '--refs', refs], {
        encoding: 'utf8',
      });
      assert.equal(r.status, 2, `${base}: ${r.stderr}`);
      assert.match(r.stderr, /Refusing/);
    }
    assert.equal(existsSync(join(tmp, 'out')), false, 'refused runs must not create the output folder');
  });
  await test('the CLI refuses an --out inside the repository', () => {
    const r = spawnSync(
      process.execPath,
      [script, '--milestone', 'M1', '--out', join(REPO_ROOT, 'tmp-shots'), '--refs', join(tmp, 'refs.json')],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /inside this repository/);
    assert.equal(isInsideRepo(join(REPO_ROOT, 'a', 'b')), true);
    assert.equal(isInsideRepo(REPO_ROOT), true);
    assert.equal(isInsideRepo(REPO_ROOT + '-other'), false);
    assert.equal(isInsideRepo('/Users/Nitro/projects/intafaced-evidence/redesign/x'), false);
  });
  await test('isLoopbackUrl lets 127.0.0.1 and inline data through and blocks everything else', () => {
    assert.equal(isLoopbackUrl('http://127.0.0.1:3210/api/v1/tickers'), true);
    assert.equal(isLoopbackUrl('data:image/png;base64,AAAA'), true);
    assert.equal(isLoopbackUrl('https://fonts.googleapis.com/css'), false);
    assert.equal(isLoopbackUrl('http://localhost:3210/'), false);
  });

  // ---- regexes ----
  await test('banned words regex matches the spec list, case-insensitively, and reports context', () => {
    for (const w of ['unavailable', 'Not connected', 'RESTRICTED', 'fixture', 'Lifecycle']) assert.ok(BANNED_WORDS_RE.test(w), w);
    for (const ok of ['Available', 'connected', 'Est. total value', 'Buy', 'Convert']) assert.equal(BANNED_WORDS_RE.test(ok), false, ok);
    const hits = findBannedWords('Combined value unavailable\nAccess is restricted');
    assert.deepEqual(
      hits.map((h) => h.word.toLowerCase()),
      ['unavailable', 'restricted'],
    );
    assert.match(hits[0].context, /Combined value unavailable/);
    assert.deepEqual(findBannedWords('All good'), []);
    assert.deepEqual(findBannedWords(null), []);
  });
  await test('money regex accepts the formats in spec 2.6 and rejects junk', () => {
    for (const ok of [
      '$12,345.67',
      '$0.0412',
      '1,234.5 BTC',
      '0.25 BTC',
      '12.00 USDT',
      '−0.28%',
      '+4.02%',
      '+$134.46',
      '$1.2M',
      '—',
      '••••',
      '100',
      '  $5.00  ',
    ]) {
      assert.ok(isMoneyFormat(ok), `should accept ${JSON.stringify(ok)}`);
    }
    for (const bad of [
      'NaN',
      'undefined',
      '$NaN',
      'n/a',
      '-',
      '$ 12.00x',
      '12.00 usdt',
      '1e5',
      '--',
      '',
      '$',
      '+$134.46 (+4.02%)',
      'Loading',
    ]) {
      assert.equal(isMoneyFormat(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
    assert.equal(MONEY_RE.source, '^[−+]?[$]?[\\d,]+(\\.\\d+)?[%A-Z ]*$|^—$|^••••$');
  });
  await test('request budget scales with the idle window', () => {
    assert.equal(requestLimitFor(60), 120);
    assert.equal(requestLimitFor(30), 60);
    assert.equal(requestLimitFor(5), 10);
  });
  await test('locationMatches compares path and the query params the expectation names', () => {
    assert.equal(locationMatches('/trade', '/trade'), true);
    assert.equal(locationMatches('/trade/spot/BTC-USDT?x=1', '/trade/spot/BTC-USDT'), true);
    assert.equal(locationMatches('/money/activity?tab=orders&status=closed', '/money/activity?tab=orders&status=closed'), true);
    assert.equal(locationMatches('/money/activity?tab=trades', '/money/activity?tab=orders'), false);
    assert.equal(locationMatches('/exchange', '/trade'), false);
  });

  // ---- focus matching, colours, step validation ----
  await test('matchFocus checks name, href, container, outline and lime', () => {
    const info = { tag: 'A', role: '', name: 'Buy', href: '/coin/BTC', within: true, outlineVisible: true, limeOk: true };
    assert.equal(matchFocus(info, { name: '^buy$', href: '^/coin/', within: 'main', lime: true }).ok, true);
    assert.match(matchFocus(info, { name: '^Sell$' }).reasons[0], /does not match/);
    assert.match(matchFocus({ ...info, outlineVisible: false }, {}).reasons[0], /no visible focus outline/);
    assert.equal(matchFocus({ ...info, outlineVisible: false }, { outline: false }).ok, true);
    assert.match(matchFocus({ ...info, limeOk: false }, { lime: true }).reasons[0], /not lime/);
    assert.match(matchFocus({ ...info, within: false }, { within: 'main' }).reasons[0], /not inside main/);
    assert.equal(matchFocus({ none: true }, {}).ok, false);
  });
  await test('hasLimeColor finds #C8F64A in outlines and shadows only', () => {
    assert.equal(hasLimeColor('rgb(200, 246, 74) 0px 0px 0px 2px'), true);
    assert.equal(hasLimeColor('rgb(205, 240, 80) none'), true);
    assert.equal(hasLimeColor('rgb(188, 255, 47) none'), false); // OKX's own lime must not pass
    assert.equal(hasLimeColor('rgba(200, 246, 74, 0) none'), false);
    assert.equal(hasLimeColor('rgb(0, 95, 204) auto'), false);
  });
  await test('validateKeyboardSteps accepts good steps and explains bad ones', () => {
    assert.deepEqual(validateKeyboardSteps(null), []);
    assert.deepEqual(
      validateKeyboardSteps([
        { focusLast: 'header a' },
        { tabTo: { name: '^Buy$' }, max: 5 },
        { press: 'Tab', repeat: 4, expect: { href: '^/coin/' } },
      ]),
      [],
    );
    assert.match(validateKeyboardSteps([{ press: 'Tab', tabTo: {} }])[0], /exactly one/);
    assert.match(validateKeyboardSteps([{ wibble: 1 }]).join(' '), /unknown key/);
    assert.match(validateKeyboardSteps([{ press: 'Tab', expect: { name: '(' } }])[0], /valid regular expression/);
    assert.match(validateKeyboardSteps([{ press: 'Tab', repeat: 0 }])[0], /repeat/);
    assert.match(validateKeyboardSteps('x')[0], /array/);
  });
  await test('pickAccount prefers a non-friend account, honours --account, never leaks into errors', () => {
    const file = { kind: 'k', friend: { email: 'f@x', password: 'pw-f' }, main: { email: 'm@x', password: 'pw-m' } };
    assert.equal(pickAccount(file).key, 'main');
    assert.equal(pickAccount({ friend: file.friend }).key, 'friend');
    assert.equal(pickAccount(file, 'friend').email, 'f@x');
    assert.throws(
      () => pickAccount(file, 'nobody'),
      (e) => e instanceof UsageError && !/pw-/.test(e.message),
    );
    assert.throws(() => pickAccount({ kind: 'k' }), UsageError);
  });

  // ---- refs file ----
  const goodRoute = {
    id: 'home',
    milestone: 'M1',
    path: '/home',
    references: [{ vendor: 'OKX', image: '/abs/a.png' }],
    keyboard: [{ press: 'Tab' }],
  };
  await test('validateRefs accepts a good file and flags the common mistakes', () => {
    assert.deepEqual(validateRefs({ version: 1, routes: [goodRoute], redirects: [{ milestone: 'M1', from: '/a', to: '/b' }] }), []);
    assert.match(validateRefs({ version: 2, routes: [goodRoute] })[0], /version/);
    assert.match(validateRefs({ version: 1, routes: [goodRoute, goodRoute] }).join(' '), /duplicate/);
    assert.match(
      validateRefs({ version: 1, routes: [{ ...goodRoute, references: [{ vendor: 'OKX', image: 'relative.png' }] }] }).join(' '),
      /absolute/,
    );
    assert.match(
      validateRefs({ version: 1, routes: [{ ...goodRoute, references: [{ vendor: 'Binance', image: '/a.png' }] }] }).join(' '),
      /OKX or Robinhood/,
    );
    assert.match(validateRefs({ version: 1, routes: [{ ...goodRoute, path: 'home' }] }).join(' '), /path/);
    assert.match(validateRefs({ version: 1, routes: [{ ...goodRoute, milestone: 'M9' }] }).join(' '), /milestone/);
  });
  await test('missingReferenceFiles lists absent image and full files', () => {
    const refs = { routes: [{ id: 'a', references: [{ image: '/x/1.png', full: '/x/2.png' }, { image: '/x/3.png' }] }] };
    const have = new Set(['/x/1.png']);
    assert.deepEqual(
      missingReferenceFiles(refs, (p) => have.has(p)).map((m) => m.path),
      ['/x/2.png', '/x/3.png'],
    );
  });
  const REAL_REFS = '/Users/Nitro/projects/intafaced-evidence/living-world-2026-10-13/redesign-refs.json';
  await test('the real redesign-refs.json (when present) is valid, complete for M1-M3, and every image exists', () => {
    if (!existsSync(REAL_REFS)) return process.stdout.write('     (skipped: evidence folder not on this machine)\n');
    const refs = JSON.parse(readFileSync(REAL_REFS, 'utf8'));
    assert.deepEqual(validateRefs(refs), []);
    assert.deepEqual(missingReferenceFiles(refs), []);
    for (const m of ['M1', 'M2', 'M3'])
      assert.ok(
        refs.routes.some((r) => r.milestone === m),
        `no routes for ${m}`,
      );
    const paths = refs.routes.map((r) => r.path.split('?')[0]);
    for (const p of [
      '/home',
      '/money',
      '/money/activity',
      '/trade',
      '/trade/spot/BTC-USDT',
      '/trade/convert',
      '/trade/buy',
      '/coin/BTC',
      '/pay',
      '/pay/receive',
      '/more',
      '/notifications',
      '/uc/account',
      '/uc/safe',
      '/verification',
      '/view',
    ]) {
      assert.ok(paths.includes(p), `refs has no route for ${p}`);
    }
    const home = refs.routes.find((r) => r.id === 'home');
    assert.ok(home.keyboard.length > 5, 'home keyboard path from Acceptance 5.1');
    assert.ok(home.references.length >= 1);
  });

  // ---- composer (pure) ----
  await test('referenceLabel and composer HTML follow the spec labels', () => {
    assert.equal(referenceLabel({ vendor: 'OKX' }), 'Reference: OKX, captured 2026-10-13');
    assert.equal(referenceLabel({ vendor: 'Robinhood', captured: '2026-10-13' }), 'Reference: Robinhood, captured 2026-10-13');
    assert.equal(referenceLabel({ vendor: 'OKX', source: 'App Store poster' }), 'Reference: OKX, App Store poster');
    assert.equal(OURS_LABEL, 'INTAFACED (local test)');
    const html = buildComposerHtml({
      oursSrc: 'data:image/png;base64,AA',
      refSrc: 'data:image/png;base64,BB',
      refLabel: 'Reference: OKX, captured 2026-10-13<script>',
    });
    assert.ok(html.indexOf('INTAFACED (local test)') < html.indexOf('Reference: OKX, captured 2026-10-13'), 'ours is on the left');
    assert.ok(html.indexOf('data:image/png;base64,AA') < html.indexOf('data:image/png;base64,BB'));
    assert.match(html, /width:1440px/);
    assert.equal(html.includes('<script>'), false, 'labels are escaped');
    assert.match(html, /&lt;script&gt;/);
  });
  await test('findChromiumExecutable picks the newest installed browser and falls back to Chrome for Testing', () => {
    const files = new Set([
      '/c/chromium_headless_shell-1200/chrome-headless-shell-mac-arm64/chrome-headless-shell',
      '/c/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    ]);
    const listDir = (d) => (d === '/c' ? ['chromium_headless_shell-1200', 'chromium_headless_shell-1248', 'ffmpeg-1'] : []);
    const found = findChromiumExecutable({
      env: { PLAYWRIGHT_BROWSERS_PATH: '/c' },
      home: '/nohome',
      listDir,
      isFile: (p) => files.has(p),
    });
    assert.equal(found, '/c/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell');
    const cft = '/c/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
    assert.equal(
      findChromiumExecutable({
        env: { PLAYWRIGHT_BROWSERS_PATH: '/c' },
        home: '/nohome',
        listDir: () => ['chromium-1248'],
        isFile: (p) => p === cft,
      }),
      cft,
    );
    assert.equal(findChromiumExecutable({ env: {}, home: '/nohome', listDir: () => [], isFile: () => false }), undefined);
  });

  // ---- browser-backed tests (skipped when no Chromium is installed) ----
  let browser = null;
  try {
    const { chromium } = await import('@playwright/test');
    browser = await launchBrowser(chromium);
  } catch (error) {
    process.stdout.write(`     (browser tests skipped: ${String(error.message).split('\n')[0]})\n`);
  }
  if (browser) {
    const png = async (path, w, h, color) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      await page.setContent(`<body style="margin:0;background:${color}"></body>`);
      await page.screenshot({ path });
      await ctx.close();
    };
    const dims = (path) => {
      const b = readFileSync(path);
      assert.equal(b.subarray(1, 4).toString(), 'PNG');
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    };
    await test('composeSideBySide writes ours-left / reference-right at 1440 wide each (2 x 1440 + gutter)', async () => {
      await png(join(tmp, 'ours.png'), 1440, 900, '#222');
      await png(join(tmp, 'ref.png'), 720, 450, '#a33'); // narrower reference: must be scaled up to 1440 wide
      const out = join(tmp, 'sbs', 'home.png');
      await composeSideBySide(browser, {
        oursPath: join(tmp, 'ours.png'),
        refPath: join(tmp, 'ref.png'),
        outPath: out,
        refLabel: 'Reference: OKX, captured 2026-10-13',
      });
      const d = dims(out);
      assert.equal(d.w, 1440 * 2 + 16);
      assert.equal(d.h, 48 + 900, 'label bar + the taller side; 720x450 scaled to 1440 is 900 high');
    });
    await test('composeSideBySide caps very tall references', async () => {
      await png(join(tmp, 'tall.png'), 400, 3000, '#357');
      const out = join(tmp, 'sbs', 'tall.png');
      await composeSideBySide(browser, {
        oursPath: join(tmp, 'ours.png'),
        refPath: join(tmp, 'tall.png'),
        outPath: out,
        refLabel: 'Reference: Robinhood, captured 2026-10-13',
        maxHeight: 1000,
      });
      assert.equal(dims(out).h, 48 + 1000);
    });

    const fixture = `<!doctype html><html><head><style>
      body{margin:0;font:16px sans-serif} a,button{outline:none} a:focus-visible,button:focus-visible{outline:2px solid rgb(200,246,74)}
      .plain:focus-visible{outline:none}
    </style></head><body>
      <header><a href="/home">Home</a><a href="/money">Money</a><button>Account</button></header>
      <main>
        <button id="eye" aria-label="Hide balances">eye</button>
        <button>Buy</button><button class="plain">Sell</button>
        <a href="/coin/BTC">BTC</a><a href="/coin/ETH">ETH</a>
        <span data-money>$1,234.56</span><span data-money>NaN</span>
        <p>Combined value unavailable</p>
      </main></body></html>`;
    const withPage = async (html, width, fn) => {
      const ctx = await browser.newContext({ viewport: { width, height: 800 } });
      const page = await ctx.newPage();
      await page.setContent(html);
      try {
        return await fn(page);
      } finally {
        await ctx.close();
      }
    };
    await test('pageChecks reads main text, [data-money] values and horizontal overflow', async () => {
      const c = await withPage(fixture, 1280, pageChecks);
      assert.equal(c.hasMain, true);
      assert.equal(c.notFound, false);
      assert.deepEqual(c.money, ['$1,234.56', 'NaN']);
      assert.equal(findBannedWords(c.mainText).length, 1);
      assert.ok(c.overflow <= 0);
      const wide = await withPage('<main><div style="width:900px">x</div></main>', 390, pageChecks);
      assert.ok(wide.overflow > 400, 'a 900px block at 390px wide overflows');
      const nf = await withPage('<main><h1>Page not found</h1><p>This address is not available</p></main>', 1280, pageChecks);
      assert.equal(nf.notFound, true);
      const none = await withPage('<div>no main here</div>', 1280, pageChecks);
      assert.equal(none.hasMain, false);
    });
    await test('runKeyboard follows a data-driven Tab path and checks name, href, outline and lime', async () => {
      const ok = await withPage(fixture, 1440, (p) =>
        runKeyboard(p, [
          { focusLast: 'header a, header button' },
          { tabTo: { name: 'hide.*balances', within: 'main' }, max: 4 },
          { press: 'Tab', expect: { name: '^Buy$', lime: true } },
          { press: 'Tab', repeat: 1, expect: { name: '^Sell$', outline: false } },
          { press: 'Tab', repeat: 2, expect: { href: '^/coin/' } },
        ]),
      );
      assert.equal(ok.ok, true, ok.detail);
      const noOutline = await withPage(fixture, 1440, (p) =>
        runKeyboard(p, [{ focus: '#eye' }, { press: 'Tab' }, { press: 'Tab', expect: { name: '^Sell$' } }]),
      );
      assert.equal(noOutline.ok, false);
      assert.match(noOutline.detail, /no visible focus outline/);
      const wrongOrder = await withPage(fixture, 1440, (p) =>
        runKeyboard(p, [{ focus: '#eye' }, { press: 'Tab', expect: { name: '^Convert$' } }]),
      );
      assert.equal(wrongOrder.ok, false);
      assert.match(wrongOrder.detail, /does not match/);
      const lost = await withPage(fixture, 1440, (p) => runKeyboard(p, [{ focus: '#eye' }, { tabTo: { name: '^Nope$' }, max: 3 }]));
      assert.equal(lost.ok, false);
      assert.match(lost.detail, /did not reach/);
      const missingStart = await withPage(fixture, 1440, (p) => runKeyboard(p, [{ focus: '#does-not-exist' }]));
      assert.equal(missingStart.ok, false);
    });
    await test('runKeyboard handles dialogs: open, trap focus, close, and restore focus to a marked element', async () => {
      const html = `<!doctype html><style>*:focus-visible{outline:2px solid #C8F64A}</style><main>
        <button id="open">Open</button>
        <div id="dlg" role="dialog" hidden><button>One</button><button>Two</button></div></main>
        <script>
          const dlg=document.getElementById('dlg'), open=document.getElementById('open');
          open.addEventListener('click',()=>{dlg.hidden=false;dlg.querySelector('button').focus()});
          dlg.addEventListener('keydown',e=>{
            if(e.key==='Escape'){dlg.hidden=true;open.focus()}
            if(e.key==='Tab'){e.preventDefault();const b=[...dlg.querySelectorAll('button')];const i=b.indexOf(document.activeElement);b[(i+(e.shiftKey?b.length-1:1))%b.length].focus()}
          });
        </script>`;
      const r = await withPage(html, 1440, (p) =>
        runKeyboard(p, [
          { focus: '#open' },
          { mark: true },
          { press: 'Enter', expectVisible: '[role=dialog]' },
          { press: 'Tab', repeat: 5, expectFocusWithin: '[role=dialog]' },
          { press: 'Escape', expectHidden: '[role=dialog]', expectFocusOnMark: true },
        ]),
      );
      assert.equal(r.ok, true, r.detail);
    });
    await browser.close();
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.stdout.write(`\nAll ${passed} tests passed.\n`);
