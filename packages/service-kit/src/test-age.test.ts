import { describe, expect, it } from 'vitest';
import { TEST_AGE_MAX_MS, TestAgeDoorBootError, answerTestAgeDoor, testAgeDoorOpen, type TestAgeSubject } from './test-age.js';

/** A subject that records each call it gets and ages one known record. */
function recording(known = 'q1') {
  const calls: Array<[string, number]> = [];
  const age: TestAgeSubject = async (id, ms) => {
    calls.push([id, ms]);
    return id === known ? { expiresAt: new Date(Date.parse('2026-11-17T00:01:00Z') - ms).toISOString() } : null;
  };
  return { calls, subjects: { 'otc-quote': age } };
}

describe('testAgeDoorOpen', () => {
  it('is closed with the flag unset, blank or off, whatever the environment', () => {
    for (const env of [{}, { TEST_AGE_DOOR: '' }, { TEST_AGE_DOOR: '  ' }, { TEST_AGE_DOOR: 'off' }, { TEST_AGE_DOOR: 'OFF' }]) {
      for (const appEnv of ['dev', 'test', 'staging', 'prod', undefined]) {
        expect(testAgeDoorOpen({ ...env, APP_ENV: appEnv })).toBe(false);
        expect(testAgeDoorOpen({ ...env, APP_ENV: appEnv, NODE_ENV: 'production' })).toBe(false);
      }
    }
  });

  it('opens only on a TEST stack: APP_ENV exactly dev or test, and NODE_ENV not production', () => {
    expect(testAgeDoorOpen({ TEST_AGE_DOOR: 'on', APP_ENV: 'dev' })).toBe(true);
    expect(testAgeDoorOpen({ TEST_AGE_DOOR: 'on', APP_ENV: 'test', NODE_ENV: 'test' })).toBe(true);
  });

  it('refuses to start with the flag on anywhere else', () => {
    for (const env of [
      { TEST_AGE_DOOR: 'on' },
      { TEST_AGE_DOOR: 'on', APP_ENV: '' },
      { TEST_AGE_DOOR: 'on', APP_ENV: 'staging' },
      { TEST_AGE_DOOR: 'on', APP_ENV: 'prod' },
      { TEST_AGE_DOOR: 'on', APP_ENV: 'production' },
      { TEST_AGE_DOOR: 'on', APP_ENV: 'DEV' },
      { TEST_AGE_DOOR: 'on', APP_ENV: ' test' },
      { TEST_AGE_DOOR: 'on', APP_ENV: 'test', NODE_ENV: 'production' },
      { TEST_AGE_DOOR: 'on', APP_ENV: 'dev', NODE_ENV: 'production' },
      { TEST_AGE_DOOR: 'on', APP_ENV: 'test', NODE_ENV: 'Production' },
      { TEST_AGE_DOOR: 'on', APP_ENV: 'dev', NODE_ENV: ' production ' },
    ]) {
      expect(() => testAgeDoorOpen(env), JSON.stringify(env)).toThrow(TestAgeDoorBootError);
    }
  });

  it('refuses to start with any other value', () => {
    for (const value of ['1', 'true', 'yes', 'open', 'on please']) {
      expect(() => testAgeDoorOpen({ TEST_AGE_DOOR: value, APP_ENV: 'test' }), value).toThrow(TestAgeDoorBootError);
    }
  });
});

describe('answerTestAgeDoor', () => {
  it('closed: a typed refusal for every body, and no record is touched', async () => {
    const { calls, subjects } = recording();
    for (const body of [{ subject: 'otc-quote', id: 'q1', ms: 60_000 }, {}, null, 'q1']) {
      const answer = await answerTestAgeDoor(false, subjects, body);
      expect(answer.status).toBe(403);
      expect(answer.body.error).toBe('test_age.door_closed');
    }
    expect(calls).toEqual([]);
  });

  it('open: ages the named record once by the given milliseconds and returns its new times', async () => {
    const { calls, subjects } = recording();
    const answer = await answerTestAgeDoor(true, subjects, { subject: 'otc-quote', id: 'q1', ms: 60_000 });
    expect(answer).toEqual({
      status: 200,
      body: { ok: true, subject: 'otc-quote', id: 'q1', agedMs: 60_000, expiresAt: '2026-11-17T00:00:00.000Z' },
    });
    expect(calls).toEqual([['q1', 60_000]]);
  });

  it('open: a record it may not age is not found, by name', async () => {
    const answer = await answerTestAgeDoor(true, recording().subjects, { subject: 'otc-quote', id: 'q2', ms: 1 });
    expect(answer.status).toBe(404);
    expect(answer.body.error).toBe('test_age.not_found');
  });

  it('open: refuses a body out of shape before any record is touched', async () => {
    const { calls, subjects } = recording();
    for (const body of [
      null,
      {},
      { subject: 'otc-quote', id: 'q1' },
      { subject: 'otc-quote', id: 'q1', ms: 0 },
      { subject: 'otc-quote', id: 'q1', ms: -60_000 },
      { subject: 'otc-quote', id: 'q1', ms: 1.5 },
      { subject: 'otc-quote', id: 'q1', ms: TEST_AGE_MAX_MS + 1 },
      { subject: 'otc-quote', id: 'q1', ms: '60000' },
      { subject: 'otc-quote', id: ' ', ms: 1 },
      { subject: 'otc-quote', id: 'q1', ms: 1, extra: true },
      { subject: 'ledger-entry', id: 'q1', ms: 1 },
      { subject: 'constructor', id: 'q1', ms: 1 },
      { subject: '__proto__', id: 'q1', ms: 1 },
    ]) {
      const answer = await answerTestAgeDoor(true, subjects, body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body.error).toBe('test_age.invalid');
    }
    expect(calls).toEqual([]);
  });

  it('open: a day is the most one call ages', async () => {
    const { calls, subjects } = recording();
    expect((await answerTestAgeDoor(true, subjects, { subject: 'otc-quote', id: 'q1', ms: TEST_AGE_MAX_MS })).status).toBe(200);
    expect(calls).toEqual([['q1', 86_400_000]]);
  });
});
