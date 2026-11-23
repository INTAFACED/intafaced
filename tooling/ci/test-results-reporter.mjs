/**
 * TEST RESULTS REPORTER — what one vitest run failed, written as data for the Tests job's verdict (base-failures.mjs).
 *
 * CI's Tests job sets INTAFACED_TEST_RESULTS to a folder; every vitest config then adds this reporter beside vitest's own
 * (tooling/vitest/budget.mjs testResults, apps/customer/vite.config.ts), and each run writes one file there: its package,
 * why the run ended, the errors no test owned, and each failed test file, suite and test with its errors' first lines.
 * Passing tests are counted, not listed. It changes no result: vitest's exit code and console output stay its own.
 *
 * Unset (a person's machine), nothing adds it and nothing is written.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESULTS_ENV = 'INTAFACED_TEST_RESULTS';
export const REPORT_VERSION = 1;
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** An error as one line: its name and the first line of its message, the checkout's path made relative. */
export function errorLine(e, root = ROOT) {
  const name = String(e?.name ?? 'Error');
  const first =
    String(e?.message ?? e ?? '')
      .split('\n')
      .find((l) => l.trim() !== '') ?? '';
  return `${name}: ${first}`.split(`${root}/`).join('').slice(0, 500);
}

const lines = (errors) => (errors ?? []).map((e) => errorLine(e));
const rel = (p) => relative(ROOT, p).split('\\').join('/');

/** The report of one run, from vitest's TestModules (pure apart from reading their state, so its test can feed fakes). */
export function reportOf({ dir, name, testModules, unhandledErrors, reason }) {
  const failed = [];
  let tests = 0;
  for (const m of testModules) {
    const entry = { file: rel(m.moduleId), state: m.state(), errors: lines(m.errors()), suites: [], tests: [] };
    for (const s of m.children.allSuites()) {
      const errors = lines(s.errors());
      if (errors.length) entry.suites.push({ name: s.fullName, errors });
    }
    for (const t of m.children.allTests()) {
      tests += 1;
      const r = t.result();
      if (r.state === 'failed') entry.tests.push({ name: t.fullName, errors: lines(r.errors) });
    }
    if (entry.state === 'failed' || entry.errors.length || entry.suites.length || entry.tests.length) failed.push(entry);
  }
  return {
    v: REPORT_VERSION,
    package: name,
    dir,
    reason,
    pid: process.pid,
    modules: testModules.length,
    tests,
    unhandled: lines(unhandledErrors),
    failed,
  };
}

export default class TestResultsReporter {
  onInit(vitest) {
    this.root = vitest.config.root;
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    const out = process.env[RESULTS_ENV];
    if (!out) return;
    const root = this.root ?? process.cwd();
    let name = rel(root);
    try {
      name = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name ?? name;
    } catch {
      // A run outside a package keeps its folder as its name.
    }
    const report = reportOf({ dir: rel(root), name, testModules, unhandledErrors, reason });
    mkdirSync(out, { recursive: true });
    const file = `${name.replace(/[^\w.-]+/g, '_')}.${process.pid}.${Date.now()}.json`;
    writeFileSync(join(out, file), `${JSON.stringify(report, null, 1)}\n`);
  }
}
