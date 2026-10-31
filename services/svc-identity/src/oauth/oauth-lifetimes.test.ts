import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { OAuthService } from './oauth.js';

// The lifetimes read needs no database: it reports the owner's settings as published, a blank one as null.
const service = (settings: ConstructorParameters<typeof OAuthService>[1]) => new OAuthService({} as Sql, settings);

describe('OAuth lifetimes as published (oauth.lifetimes)', () => {
  it('reads each lifetime the owner published', () => {
    expect(service({ codeTtlSeconds: 60, accessTokenTtlSeconds: 3600 }).lifetimes()).toEqual({
      codeTtlSeconds: 60,
      accessTokenTtlSeconds: 3600,
    });
  });

  it('reads a blank lifetime as null, never a default', () => {
    expect(service({}).lifetimes()).toEqual({ codeTtlSeconds: null, accessTokenTtlSeconds: null });
    expect(service({ codeTtlSeconds: 60 }).lifetimes()).toEqual({ codeTtlSeconds: 60, accessTokenTtlSeconds: null });
  });
});
