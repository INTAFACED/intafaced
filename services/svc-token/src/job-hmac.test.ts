import { describe, expect, it } from 'vitest';
import { JOB_CALLER, JOB_FORBIDDEN, authorizeTokenJobHttp } from './job-hmac.js';

describe('authorizeTokenJobHttp', () => {
  it('null is 401 token.unauthenticated', () => {
    expect(authorizeTokenJobHttp(null)).toEqual({
      ok: false,
      status: 401,
      code: 'token.unauthenticated',
      error: 'service credentials required',
    });
  });

  it('svc-trade is 403 token.forbidden', () => {
    expect(authorizeTokenJobHttp('svc-trade')).toEqual({
      ok: false,
      status: 403,
      code: 'token.forbidden',
      error: JOB_FORBIDDEN,
    });
  });

  it('svc-token passes', () => {
    expect(authorizeTokenJobHttp(JOB_CALLER)).toEqual({ ok: true, service: JOB_CALLER });
  });
});
