// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { publicAuthKey, readAuth, saveAuth } from './public-auth-guards';

const record = (target: string) => ({
  localRef: crypto.randomUUID(),
  kind: 'password' as const,
  createdAt: new Date().toISOString(),
  target,
});

beforeEach(() => localStorage.removeItem(publicAuthKey));

describe('where a sign-in attempt may resume', () => {
  it('a signed-in room and the help-centre pages are kept', () => {
    for (const target of ['/money', '/helpdetail', '/help', '/help/section/:id', '/help/category/:id']) {
      expect(saveAuth(record(target)), target).toBe(true);
    }
    expect(readAuth().records).toHaveLength(5);
  });

  it('sign-in, sign-up, recovery and the front page are refused, so a sign-in never resumes into itself', () => {
    for (const target of ['/login', '/register', '/findPwd', '/']) {
      expect(saveAuth(record(target)), target).toBe(false);
    }
    expect(readAuth().records).toHaveLength(0);
  });
});
