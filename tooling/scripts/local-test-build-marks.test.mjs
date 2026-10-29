/**
 * The local test stack serves its apps with the TEST banner and the test-build tag the customer app reads to label money
 * TEST (apps/customer/src/shared/test-build.ts). Run: node --test tooling/scripts/local-test-build-marks.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEST_BUILD_META_HTML, withTestBuildMarks } from './local-test-stack.mjs';

test('the served page carries the test-build tag in its head and the banner first in its body, once each', () => {
  const html = withTestBuildMarks(
    '<!doctype html><html><head lang="en"><title>x</title></head><body class="b"><div id="root"></div></body></html>',
  );
  assert.equal(TEST_BUILD_META_HTML, '<meta name="intafaced-build" content="test">');
  assert.ok(html.includes(`<head lang="en">${TEST_BUILD_META_HTML}<title>`));
  assert.match(html, /<body class="b"><style>body\{padding-top:28px !important\}<\/style><div id="local-test-stack-banner"/);
  assert.equal(html.split('intafaced-build').length, 2);
  assert.equal(html.split('local-test-stack-banner').length, 2);
});
