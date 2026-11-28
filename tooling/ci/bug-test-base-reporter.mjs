/**
 * A node:test reporter for tooling/ci/bug-test-base.mjs: one JSON line per finished test, with its file, name and, when
 * it failed, the name and code of the error the test itself threw (node wraps it as `cause`). A file that could not load
 * (a missing module or export) is reported as one failure named after the file, its error node's own "test failed".
 *
 *   node --test --test-reporter=./tooling/ci/bug-test-base-reporter.mjs --test-reporter-destination=<out> <file>
 */
export default async function* bugTestBaseReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { name, file, skip, todo, details } = event.data;
    const cause = details?.error?.cause;
    yield `${JSON.stringify({
      passed: event.type === 'test:pass',
      name,
      file,
      skipped: Boolean(skip || todo),
      error: cause
        ? { name: String(cause.name ?? 'Error'), code: cause.code ?? null, message: String(cause.message ?? cause).split('\n')[0] }
        : null,
    })}\n`;
  }
}
