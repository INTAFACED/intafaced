import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BROWSER_HOOK_TIMEOUT, BROWSER_TEST_TIMEOUT } from './test-browser.mjs';

// A cold browser launch on a CI runner can take longer than vitest's default 10 s hook timeout, which fails the file
// and skips every test in it. Every unit test here that launches a browser does it through test-browser.mjs, in a hook
// given BROWSER_HOOK_TIMEOUT.
const HERE = dirname(fileURLToPath(import.meta.url));
const VITEST_DEFAULT_HOOK_TIMEOUT = 10_000;
const VITEST_DEFAULT_TEST_TIMEOUT = 5_000;
const launching = readdirSync(HERE)
  .filter((name) => name.endsWith('.test.mjs') && name !== 'test-browser.test.mjs')
  .map((name) => ({ name, source: readFileSync(join(HERE, name), 'utf8') }))
  .filter(({ source }) => /chromium|launchTestBrowser/.test(source));

describe('browser launch in unit tests', () => {
  it('gives a cold browser launch far more than vitest’s default hook timeout', () => {
    expect(BROWSER_HOOK_TIMEOUT).toBeGreaterThanOrEqual(6 * VITEST_DEFAULT_HOOK_TIMEOUT);
  });

  it('gives a test that drives the browser far more than vitest’s default test timeout', () => {
    expect(BROWSER_TEST_TIMEOUT).toBeGreaterThanOrEqual(6 * VITEST_DEFAULT_TEST_TIMEOUT);
  });

  it('finds the unit tests that launch a browser', () => {
    expect(launching.map(({ name }) => name)).toEqual(expect.arrayContaining(['agent-builder.test.mjs', 'step-picture.test.mjs']));
  });

  it.each(launching.map(({ name, source }) => [name, source]))(
    '%s launches through test-browser.mjs in a hook given BROWSER_HOOK_TIMEOUT, its tests given BROWSER_TEST_TIMEOUT',
    (_name, source) => {
      expect(source).not.toMatch(/chromium\.launch\(/);
      expect(source).toMatch(
        /beforeAll\(async \(\) => \{\s*\(\{ browser, why \} = await launchTestBrowser\(\)\);\s*\}, BROWSER_HOOK_TIMEOUT\);/,
      );
      // Every block of its tests runs under the browser test budget.
      const blocks = source.match(/^describe\(.*$/gm) ?? [];
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) expect(b).toContain('{ timeout: BROWSER_TEST_TIMEOUT }');
    },
  );
});
