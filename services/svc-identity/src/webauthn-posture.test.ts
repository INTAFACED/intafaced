import { describe, expect, it } from 'vitest';
import { WEBAUTHN_RP_UNPUBLISHED_CODE, assertWebauthnPosture, webauthnPostureIssues } from './webauthn-posture.js';

const REAL = { WEBAUTHN_ENABLED: true, WEBAUTHN_RP_ID: 'intafaced.com', WEBAUTHN_ORIGIN: 'https://app.intafaced.com' };
const DEFAULTS = { WEBAUTHN_ENABLED: true, WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGIN: 'http://localhost:3000' };

describe('WebAuthn relying party in production posture', () => {
  it('refuses the development defaults in staging and prod, naming both variables', () => {
    for (const APP_ENV of ['staging', 'prod']) {
      const issues = webauthnPostureIssues(DEFAULTS, { APP_ENV });
      expect(issues).toHaveLength(2);
      expect(() => assertWebauthnPosture(DEFAULTS, { APP_ENV })).toThrow(WEBAUTHN_RP_UNPUBLISHED_CODE);
    }
  });

  it('refuses an unset APP_ENV inside a production container', () => {
    expect(webauthnPostureIssues(DEFAULTS, { NODE_ENV: 'production' })).toHaveLength(2);
  });

  it('refuses http, local and unparseable origins even when the RP id is real', () => {
    for (const WEBAUTHN_ORIGIN of [
      'http://app.intafaced.com',
      'https://localhost:3000',
      'https://x.localhost',
      'https://app.intafaced.com,http://127.0.0.1:3000',
      'not a url',
    ]) {
      expect(webauthnPostureIssues({ ...REAL, WEBAUTHN_ORIGIN }, { APP_ENV: 'prod' }), WEBAUTHN_ORIGIN).toHaveLength(1);
    }
  });

  it('allows a real RP in prod, the defaults in dev/test, and anything when WebAuthn is switched off', () => {
    expect(webauthnPostureIssues(REAL, { APP_ENV: 'prod' })).toEqual([]);
    expect(webauthnPostureIssues(REAL, { APP_ENV: 'staging' })).toEqual([]);
    expect(webauthnPostureIssues(DEFAULTS, { APP_ENV: 'dev' })).toEqual([]);
    expect(webauthnPostureIssues(DEFAULTS, { APP_ENV: 'test' })).toEqual([]);
    expect(webauthnPostureIssues(DEFAULTS, {})).toEqual([]);
    expect(webauthnPostureIssues({ ...DEFAULTS, WEBAUTHN_ENABLED: false }, { APP_ENV: 'prod' })).toEqual([]);
  });
});
