import { describe, expect, it } from 'vitest';
import { thisSessionId } from './this-session';

const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sid = '3f2a1c9e-1111-4222-8333-444455556666';

describe('thisSessionId', () => {
  it('reads the sid claim', () => {
    expect(thisSessionId(`${b64url({ alg: 'HS256' })}.${b64url({ sid, sub: 'x' })}.sig`)).toBe(sid);
  });
  it('gives null for anything that is not a readable token', () => {
    expect(thisSessionId(undefined)).toBeNull();
    expect(thisSessionId('')).toBeNull();
    expect(thisSessionId('not-a-token')).toBeNull();
    expect(thisSessionId('a.%%%.c')).toBeNull();
    expect(thisSessionId(`a.${b64url({ sid: 'nope' })}.c`)).toBeNull();
    expect(thisSessionId(`a.${b64url({ other: 1 })}.c`)).toBeNull();
  });
});
