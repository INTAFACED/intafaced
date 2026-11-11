// Fixture for tooling/scripts/journey-fail-fast-retries.test.mjs: a serial file keeps its retries.
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test('J-fx-02 #1 fails fast in a serial file', () => expect(1).toBe(2));
