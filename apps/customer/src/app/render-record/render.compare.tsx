// @vitest-environment happy-dom
/**
 * The Customer app's rendered output, part by part: every room the look gate draws (tests/real-app/routes.mjs) and the
 * named states in parts.ts, signed in as the look gate's TEST account at its frozen time, each compared with the markup
 * main recorded in apps/customer/render-record/. A difference fails its part and prints the first lines that differ.
 *
 *   pnpm --filter @intafaced/customer render:compare    compare (RENDER_RESULT=<file> also writes the result as JSON)
 *   pnpm --filter @intafaced/customer render:record     record again: the changed files are the change in what people see
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { renderPart, type Part } from './harness';
import { fileOf, STATES } from './parts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.useFakeTimers({ toFake: ['Date'] });

// Paths from the package root, where vitest runs (happy-dom's URL can't make a file path from import.meta.url).
const DIR = 'render-record';
const RECORD = process.env.RENDER_RECORD === '1';
// The look gate's own list, read in Node: the same rooms it draws, no second list to keep in step.
const routes: string[] = JSON.parse(
  execFileSync(
    process.execPath,
    ['--input-type=module', '-e', "import { sweepRoutes } from './tests/real-app/routes.mjs'; console.log(JSON.stringify(sweepRoutes()))"],
    { encoding: 'utf8' },
  ),
);
const parts: Part[] = [...routes.map((route) => ({ name: route, route })), ...STATES];
const files = new Set(parts.map((part) => fileOf(part.name)));
const differing: string[] = [];
const missing: string[] = [];
let matched = 0;
let stale: string[] = [];

/** One line per tag, so a difference reads as the lines that changed. */
const lines = (html: string) => html.replace(/></g, '>\n<');

function firstDifferences(recorded: string, now: string) {
  const a = recorded.split('\n');
  const b = now.split('\n');
  const at = a.findIndex((line, i) => line !== b[i]);
  const from = at === -1 ? Math.min(a.length, b.length) : at;
  return [
    `first difference at line ${from + 1}:`,
    ...a.slice(from, from + 3).map((l) => `- ${l.slice(0, 200)}`),
    ...b.slice(from, from + 3).map((l) => `+ ${l.slice(0, 200)}`),
  ].join('\n');
}

describe('the Customer app renders what main recorded, part by part', () => {
  if (RECORD) mkdirSync(DIR, { recursive: true });

  it.each(parts.map((part) => [part.name, part]))('%s', async (_name, part) => {
    const now = `${lines(await renderPart(part as Part))}\n`;
    const path = `${DIR}/${fileOf((part as Part).name)}`;
    if (RECORD) return writeFileSync(path, now);
    if (!existsSync(path)) {
      missing.push((part as Part).name);
      throw new Error(`${path} is not recorded: run render:record and commit it`);
    }
    const recorded = readFileSync(path, 'utf8');
    if (recorded !== now) {
      differing.push((part as Part).name);
      expect.fail(`${(part as Part).name} renders differently from ${path}\n${firstDifferences(recorded, now)}`);
    }
    matched++;
  });

  it('records no part that no longer exists', () => {
    stale = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.html') && !files.has(f)) : [];
    if (RECORD) return stale.forEach((f) => rmSync(`${DIR}/${f}`));
    expect(stale, 'recordings with no part: delete them with render:record').toEqual([]);
  });

  afterAll(() => {
    if (RECORD || !process.env.RENDER_RESULT) return;
    writeFileSync(
      process.env.RENDER_RESULT,
      // Every part that did not match counts, whatever stopped it (a difference, no recording, a throw, a timeout).
      `${JSON.stringify({ parts: parts.length, matched, differences: parts.length - matched + stale.length, differing, missing, stale }, null, 2)}\n`,
    );
  });
});
