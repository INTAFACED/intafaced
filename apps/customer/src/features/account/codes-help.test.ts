import { describe, expect, it } from 'vitest';
import { DRIFT_LIMIT_SECONDS, clockDriftSeconds, clockVerdict } from './codes-help';

describe('codes help clock check', () => {
  const server = '2026-10-23T02:30:00.000Z';
  const at = Date.parse(server);

  it('measures the device clock against the middle of the round trip', () => {
    expect(clockDriftSeconds(server, at + 89_000, at + 91_000)).toBe(90);
    expect(clockDriftSeconds(server, at - 91_000, at - 89_000)).toBe(-90);
    expect(clockDriftSeconds(server, at - 400, at + 400)).toBe(0);
  });

  it('says ahead or behind with the number, and in sync below half a code’s life', () => {
    expect(clockVerdict(90)).toEqual({ kind: 'ahead', seconds: 90 });
    expect(clockVerdict(-90)).toEqual({ kind: 'behind', seconds: 90 });
    expect(clockVerdict(DRIFT_LIMIT_SECONDS)).toMatchObject({ kind: 'ahead' });
    expect(clockVerdict(DRIFT_LIMIT_SECONDS - 1)).toEqual({ kind: 'in-sync', seconds: DRIFT_LIMIT_SECONDS - 1 });
    expect(clockVerdict(0)).toEqual({ kind: 'in-sync', seconds: 0 });
  });

  it('refuses a server time it cannot read, so no drift is claimed', () => {
    expect(() => clockDriftSeconds('not a time', at, at)).toThrow();
  });
});
