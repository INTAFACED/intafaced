// Fixture for tooling/scripts/journey-fail-fast-retries.test.mjs: Playwright's own test, no browser.
import { test, expect } from '@playwright/test';

test('J-fx-01 #1 an ordinary test that fails', () => expect(1).toBe(2));
test('J-fx-01 #2 fails fast and fails', () => expect(1).toBe(2));
test('J-fx-01 #3 fails fast and passes on its first attempt', () => expect(1).toBe(1));
test('J-fx-01 #4 a test of an unbuilt step that passed in a run read', () => expect(1).toBe(2));
