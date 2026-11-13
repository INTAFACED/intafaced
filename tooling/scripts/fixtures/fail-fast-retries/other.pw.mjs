// Fixture for tooling/scripts/journey-fail-fast-retries.test.mjs: another journey's file, as a pull request's run sees it.
import { test, expect } from '@playwright/test';

test('J-fx-03 #1 a flake: fails on its first attempt, passes on its retry', ({}, info) => expect(info.retry).toBe(1));
test('J-fx-03 #2 a real break: fails every attempt', () => expect(1).toBe(2));
