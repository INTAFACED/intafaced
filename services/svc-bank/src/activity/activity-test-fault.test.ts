import { describe, expect, it } from 'vitest';
import { ActivityService, ActivityUnavailableError } from './activity-service.js';
import { failingHistoryPages, parseActivityTestFault } from './activity-test-fault.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a-bank-activity-test-cursor-secret-long-enough';

describe('BANK_ACTIVITY_TEST_FAULT (J-home-ia-01 #5)', () => {
  it('is off when unset or blank', () => {
    expect(parseActivityTestFault(undefined, { APP_ENV: 'production' })).toBe(false);
    expect(parseActivityTestFault('', { APP_ENV: 'production' })).toBe(false);
  });

  it('turns on only with APP_ENV exactly dev or test, never in production', () => {
    expect(parseActivityTestFault('on', { APP_ENV: 'test' })).toBe(true);
    expect(parseActivityTestFault('on', { APP_ENV: 'dev' })).toBe(true);
    expect(() => parseActivityTestFault('on', { APP_ENV: 'production' })).toThrow(/TEST fault/);
    expect(() => parseActivityTestFault('on', {})).toThrow(/TEST fault/);
    expect(() => parseActivityTestFault('on', { APP_ENV: 'test', NODE_ENV: 'production' })).toThrow(/TEST fault/);
  });

  it('refuses any other value by name', () => {
    expect(() => parseActivityTestFault('yes', { APP_ENV: 'test' })).toThrow(/BANK_ACTIVITY_TEST_FAULT is "yes"/);
  });

  it('with the fault on, the activity list refuses as an unreachable ledger does, never an empty list', async () => {
    const service = new ActivityService({ allNamedSpaces: async () => [] }, { pages: failingHistoryPages(), cursorSecret: SECRET });
    await expect(service.list(ALICE, { limit: 5 })).rejects.toBeInstanceOf(ActivityUnavailableError);
  });
});
