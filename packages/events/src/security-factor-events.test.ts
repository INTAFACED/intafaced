import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG, SECURITY_FACTOR_CHANGES } from './catalog.js';

const base = () => ({
  userId: crypto.randomUUID(),
  change: 'totp_added',
  changedAt: new Date().toISOString(),
  noticeKey: 'factor-changed:u:1',
});

describe('I-signin-sessions-08 sign-in factor change event', () => {
  it('declares the subject under identity', () => {
    expect(EVENT_CATALOG.securityFactorChanged.subject).toBe('intafaced.identity.security_factor.updated');
  });

  it('takes each listed change and refuses any other', () => {
    for (const change of SECURITY_FACTOR_CHANGES) {
      expect(EVENT_CATALOG.securityFactorChanged.schema.safeParse({ ...base(), change }).success).toBe(true);
    }
    expect(EVENT_CATALOG.securityFactorChanged.schema.safeParse({ ...base(), change: 'recovery_email_changed' }).success).toBe(false);
  });

  it('needs the business key, and carries no secret or credential on the bus', () => {
    const { noticeKey: _k, ...noKey } = base();
    expect(EVENT_CATALOG.securityFactorChanged.schema.safeParse(noKey).success).toBe(false);
    const parsed = EVENT_CATALOG.securityFactorChanged.schema.parse({ ...base(), secret: 'JBSWY3DP', credentialId: 'cred-1' });
    expect(parsed).not.toHaveProperty('secret');
    expect(parsed).not.toHaveProperty('credentialId');
  });
});
