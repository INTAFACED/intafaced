/**
 * Whether this page was served by a test build. The local test stack serves the app with
 * `<meta name="intafaced-build" content="test">` (tooling/scripts/local-test-stack.mjs, beside its TEST banner); a live
 * build serves no such tag. It only ever adds a TEST label to money a test build shows, so a missing tag hides nothing.
 */
export const TEST_BUILD_META = 'intafaced-build';

export function isTestBuild(doc: Pick<Document, 'querySelector'> | undefined = globalThis.document): boolean {
  return doc?.querySelector(`meta[name="${TEST_BUILD_META}"]`)?.getAttribute('content') === 'test';
}
