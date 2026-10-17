import { describe, expect, it } from 'vitest';
import { RECENT_SESSION_MS, sessionIdFromToken, splitSessions } from './identity-session-guards';

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
    { id: 'b', createdAt: at(23.9) },
    { id: 'c', createdAt: at(25) },
    { id: SID, createdAt: at(72) },
    { id: 'd', createdAt: 'not a date' },
  ];
  it('folds sessions older than 24 hours and keeps this device in view whatever its age', () => {
    const { recent, older } = splitSessions(seats, SID, now);
    expect(recent.map((seat) => seat.id)).toEqual(['a', 'b', SID]);
    expect(older.map((seat) => seat.id)).toEqual(['c', 'd']);
  });
  it('without a known current session, the old one folds too', () => {
    expect(splitSessions(seats, null, now).older.map((seat) => seat.id)).toEqual(['c', SID, 'd']);
  });
  it('exactly 24 hours is still recent', () => {
    expect(splitSessions([{ id: 'x', createdAt: new Date(now - RECENT_SESSION_MS).toISOString() }], null, now).recent).toHaveLength(1);
  });
});
