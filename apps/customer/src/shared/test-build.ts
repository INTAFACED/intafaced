/**
 * Whether this page was served by a test build. The local test stack serves the app with its TEST banner,
 * `<div id="local-test-stack-banner">` (tooling/scripts/local-test-stack.mjs, BANNER_HTML); a live build serves none.
 * It only ever adds a TEST label to money a test build shows, so a missing banner hides nothing.
 */
export const TEST_BUILD_BANNER_ID = 'local-test-stack-banner';

const read = (doc: Pick<Document, 'getElementById'> | undefined): boolean => Boolean(doc?.getElementById(TEST_BUILD_BANNER_ID));

let served: boolean | undefined;

/** The banner is fixed when the page is served, so the page's own answer is read once. */
export function isTestBuild(doc?: Pick<Document, 'getElementById'>): boolean {
  if (doc) return read(doc);
  return (served ??= read(globalThis.document));
}
