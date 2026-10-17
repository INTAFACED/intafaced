import { describe, expect, it } from 'vitest';
import { sessionIdFromToken, sessionMoreControl, splitSessions } from './identity-session-guards';

const SID = '22222222-2222-4222-8222-222222222222';
const b64 = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = (claims: object) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.signature`;

describe('sessionIdFromToken', () => {
  it('reads the session id from the sign-in token', () => {
    expect(sessionIdFromToken(token({ sid: SID, sub: 'x' }))).toBe(SID);
  });
  it('gives null, never a guess, when the token has no usable session id', () => {
    expect(sessionIdFromToken(token({ sub: 'x' }))).toBeNull();
    expect(sessionIdFromToken(token({ sid: 'not-a-uuid' }))).toBeNull();
    expect(sessionIdFromToken('opaque-token')).toBeNull();
    expect(sessionIdFromToken('a.%%%.c')).toBeNull();
    expect(sessionIdFromToken(undefined)).toBeNull();
  });
});

describe('splitSessions', () => {
  const now = Date.parse('2026-10-18T12:00:00.000Z');
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const seats = [
    { id: 'a', createdAt: at(1) },
    { id: 'b', createdAt: at(2) },
    { id: 'c', createdAt: at(3) },
    { id: 'd', createdAt: at(4) },
    { id: 'e', createdAt: at(5) },
    { id: 'f', createdAt: at(6) },
    { id: SID, createdAt: at(72) },
    { id: 'g', createdAt: 'not a date' },
  ];
  it('keeps the newest five in view, folds the rest, and always keeps this device in view', () => {
    const { recent, older } = splitSessions(seats, SID);
    expect(recent.map((seat) => seat.id)).toEqual(['a', 'b', 'c', 'd', 'e', SID]);
    expect(older.map((seat) => seat.id)).toEqual(['f', 'g']);
  });
  it('picks the newest by start time even when the list is not in order', () => {
    const shuffled = [...seats].reverse();
    expect(splitSessions(shuffled, null).recent.map((seat) => seat.id)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });
  it('without a known current session, the old one folds too', () => {
    expect(splitSessions(seats, null).older.map((seat) => seat.id)).toEqual(['f', SID, 'g']);
  });
  it('folds nothing when there are five or fewer', () => {
    expect(splitSessions(seats.slice(0, 5), null).older).toHaveLength(0);
  });
});

describe('sessionMoreControl', () => {
  const base = { hidden: 0, expanded: false, returned: 5, limit: 50, maxLimit: 200 };
  it('unfolds the rows already loaded first, with their count', () => {
    expect(sessionMoreControl({ ...base, hidden: 45, returned: 50 })).toBe('unfold');
  });
  it('then asks the server for the next page, only when the server filled the page', () => {
    expect(sessionMoreControl({ ...base, hidden: 45, expanded: true, returned: 50 })).toBe('fetch');
    expect(sessionMoreControl({ ...base, returned: 50 })).toBe('fetch');
    expect(sessionMoreControl({ ...base, returned: 12 })).toBe('none');
  });
  it('offers to fold when nothing more can be loaded, and stops at the 200 limit', () => {
    expect(sessionMoreControl({ ...base, hidden: 7, expanded: true, returned: 12 })).toBe('fold');
    expect(sessionMoreControl({ ...base, limit: 200, returned: 200, hidden: 195, expanded: true })).toBe('fold');
    expect(sessionMoreControl({ ...base, limit: 200, returned: 200 })).toBe('none');
  });
});
