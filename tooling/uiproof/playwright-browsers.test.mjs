import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChromiumExecutable, resolveChromiumExecutablePath, resolvePlaywrightBrowsersPath } from './playwright-browsers.mjs';

const REPO = '/wt/intafaced';
const HOME = '/Users/Nitro';
const WORKTREE = join(REPO, '.tools', 'ms-playwright');
const SYSTEM = join(HOME, 'Library', 'Caches', 'ms-playwright');
const CFT = join('chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');

function listFrom(map) {
  return (dir) => map[dir] ?? [];
}

test('keeps PLAYWRIGHT_BROWSERS_PATH when already set', () => {
  const path = resolvePlaywrightBrowsersPath({
    env: { PLAYWRIGHT_BROWSERS_PATH: '/forced/browsers' },
    repoRoot: REPO,
    home: HOME,
    listDir: listFrom({
      [WORKTREE]: ['chromium-1'],
      [SYSTEM]: ['chromium-1234'],
    }),
  });
  assert.equal(path, '/forced/browsers');
});

test('uses worktree .tools/ms-playwright when it has a chromium dir', () => {
  const path = resolvePlaywrightBrowsersPath({
    env: {},
    repoRoot: REPO,
    home: HOME,
    listDir: listFrom({
      [WORKTREE]: ['chromium-9'],
      [SYSTEM]: ['chromium-1234'],
    }),
  });
  assert.equal(path, WORKTREE);
});

test('falls back to ~/Library/Caches/ms-playwright when worktree has no chromium', () => {
  const path = resolvePlaywrightBrowsersPath({
    env: {},
    repoRoot: REPO,
    home: HOME,
    listDir: listFrom({
      [WORKTREE]: ['ffmpeg-1011'],
      [SYSTEM]: ['chromium-1234', 'chromium_headless_shell-1234'],
    }),
  });
  assert.equal(path, SYSTEM);
});

test('does not invent an empty worktree browsers path', () => {
  const path = resolvePlaywrightBrowsersPath({
    env: {},
    repoRoot: REPO,
    home: HOME,
    listDir: listFrom({
      [WORKTREE]: [],
      [SYSTEM]: [],
    }),
  });
  assert.equal(path, undefined);
});

test('prefers full Chrome for Testing when headless_shell is absent', () => {
  const browsers = '/cache/ms-playwright';
  const exe = join(browsers, 'chromium-1234', CFT);
  const path = resolveChromiumExecutablePath(browsers, {
    listDir: listFrom({ [browsers]: ['chromium-1234'] }),
    isFile: (candidate) => candidate === exe,
  });
  assert.equal(path, exe);
});

test('leaves executable unset when headless_shell is present', () => {
  const browsers = '/cache/ms-playwright';
  const path = resolveChromiumExecutablePath(browsers, {
    listDir: listFrom({
      [browsers]: ['chromium-1234', 'chromium_headless_shell-1234'],
    }),
    isFile: () => true,
  });
  assert.equal(path, undefined);
});

// A Linux home (the build box): no ~/Library, Playwright's downloads in ~/.cache/ms-playwright, linux builds only.
const LINUX_HOME = '/home/builder';
const LINUX_CACHE = join(LINUX_HOME, '.cache', 'ms-playwright');
const LINUX_SHELL = join(LINUX_CACHE, 'chromium_headless_shell-1254', 'chrome-headless-shell-linux64', 'chrome-headless-shell');
const LINUX_CFT = join(LINUX_CACHE, 'chromium-1254', 'chrome-linux64', 'chrome');

test("a Linux home's ~/.cache/ms-playwright is Playwright's browsers path", () => {
  const path = resolvePlaywrightBrowsersPath({
    env: {},
    repoRoot: REPO,
    home: LINUX_HOME,
    listDir: listFrom({ [LINUX_CACHE]: ['chromium-1254', 'chromium_headless_shell-1254'] }),
  });
  assert.equal(path, LINUX_CACHE);
});

test('the one finder takes the newest headless shell of any platform, and full Chrome for Testing when asked', () => {
  const files = new Set([
    LINUX_SHELL,
    LINUX_CFT,
    join(LINUX_CACHE, 'chromium_headless_shell-1200', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
  ]);
  const opts = {
    env: {},
    home: LINUX_HOME,
    listDir: listFrom({ [LINUX_CACHE]: ['chromium-1254', 'chromium_headless_shell-1200', 'chromium_headless_shell-1254', 'ffmpeg-1013'] }),
    isFile: (p) => files.has(p),
  };
  assert.equal(findChromiumExecutable(opts), LINUX_SHELL);
  assert.equal(findChromiumExecutable({ ...opts, full: true }), LINUX_CFT);
  assert.equal(findChromiumExecutable({ ...opts, env: { PLAYWRIGHT_BROWSERS_PATH: '/empty' }, home: '/nohome' }), undefined);
});

test('no harness finds a browser on its own: a Mac cache path or build name lives only in this finder', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  let out = '';
  try {
    out = execFileSync(
      'git',
      [
        'grep',
        '-nE',
        "Library/Caches/ms-playwright|'Library', 'Caches'|chrome-headless-shell-mac|chrome-mac",
        '--',
        '*.mjs',
        '*.js',
        '*.cjs',
        '*.ts',
        '*.tsx',
      ],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch (error) {
    if (error.status !== 1) throw error; // 1: no match
  }
  const own = new Set([
    'tooling/uiproof/playwright-browsers.mjs',
    'tooling/uiproof/playwright-browsers.test.mjs',
    'tooling/scripts/redesign-shots.test.mjs',
  ]);
  const strays = out
    .split('\n')
    .filter(Boolean)
    .filter((line) => !own.has(line.split(':')[0]));
  assert.deepEqual(strays, [], 'import findChromiumExecutable from tooling/uiproof/playwright-browsers.mjs instead');
});
