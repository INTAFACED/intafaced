import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Playwright's own download folders: macOS keeps them in ~/Library/Caches, Linux in ~/.cache.
const CACHE_RELATIVE = [join('Library', 'Caches', 'ms-playwright'), join('.cache', 'ms-playwright')];

const SHELL_RELATIVE = [
  join('chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
  join('chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
  join('chrome-headless-shell-linux64', 'chrome-headless-shell'),
  join('chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
];

const CFT_RELATIVE = [
  join('chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  join('chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  join('chrome-linux64', 'chrome'),
  join('chrome-linux', 'chrome'),
  join('chrome-win64', 'chrome.exe'),
  join('chrome-win', 'chrome.exe'),
];

function defaultListDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function defaultIsFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function hasChromiumDir(dir, listDir) {
  return listDir(dir).some((name) => name.startsWith('chromium'));
}

function revisions(names, prefix) {
  return names
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
}

const chromiumRevisions = (names) => revisions(names, 'chromium-');

/** Playwright's download folders on this machine's kind: PLAYWRIGHT_BROWSERS_PATH, then the macOS and Linux defaults. */
function playwrightCaches({ env = process.env, home = env.HOME || homedir() } = {}) {
  const forced = typeof env.PLAYWRIGHT_BROWSERS_PATH === 'string' ? env.PLAYWRIGHT_BROWSERS_PATH.trim() : '';
  return [...(forced ? [forced] : []), ...CACHE_RELATIVE.map((relative) => join(home, relative))];
}

/**
 * The one finder of a browser a harness launches outside the journey runner: the newest installed headless shell, else
 * the newest full Chrome for Testing (`full: true` skips the shell, for a harness that measures the real browser), from
 * playwrightCaches, for any platform's build. Undefined when none is installed: Playwright then uses its own.
 */
export function findChromiumExecutable({
  env = process.env,
  home = env.HOME || homedir(),
  listDir = defaultListDir,
  isFile = defaultIsFile,
  full = false,
} = {}) {
  const groups = [...(full ? [] : [['chromium_headless_shell-', SHELL_RELATIVE]]), ['chromium-', CFT_RELATIVE]];
  for (const root of playwrightCaches({ env, home })) {
    const names = listDir(root);
    for (const [prefix, relatives] of groups) {
      for (const revision of revisions(names, prefix)) {
        for (const relative of relatives) {
          const candidate = join(root, revision, relative);
          if (isFile(candidate)) return candidate;
        }
      }
    }
  }
  return undefined;
}

/**
 * Env wins. Else worktree `.tools/ms-playwright` if it has a chromium dir.
 * Else Playwright's own cache (`~/Library/Caches` on macOS, `~/.cache` on Linux) if it has chromium. Never an empty path.
 */
export function resolvePlaywrightBrowsersPath({
  env = process.env,
  repoRoot,
  home = env.HOME || homedir(),
  listDir = defaultListDir,
} = {}) {
  const forced = env.PLAYWRIGHT_BROWSERS_PATH;
  if (typeof forced === 'string' && forced.trim() !== '') return forced;

  const worktree = join(repoRoot, '.tools', 'ms-playwright');
  if (hasChromiumDir(worktree, listDir)) return worktree;

  return CACHE_RELATIVE.map((relative) => join(home, relative)).find((system) => hasChromiumDir(system, listDir));
}

/**
 * Playwright headless prefers chromium_headless_shell. When that revision is
 * missing, point at full Chrome for Testing so launch still works.
 */
export function resolveChromiumExecutablePath(browsersPath, { listDir = defaultListDir, isFile = defaultIsFile } = {}) {
  if (!browsersPath) return undefined;
  const names = listDir(browsersPath);
  if (names.some((name) => name.startsWith('chromium_headless_shell'))) return undefined;

  for (const revision of chromiumRevisions(names)) {
    for (const relative of CFT_RELATIVE) {
      const candidate = join(browsersPath, revision, relative);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export function applyPlaywrightBrowsersEnv({ env = process.env, repoRoot, home, listDir = defaultListDir, isFile = defaultIsFile } = {}) {
  const browsersPath = resolvePlaywrightBrowsersPath({ env, repoRoot, home, listDir });
  if (browsersPath) env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  return {
    browsersPath,
    executablePath: resolveChromiumExecutablePath(browsersPath, { listDir, isFile }),
  };
}
