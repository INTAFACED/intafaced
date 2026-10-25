import { describe, expect, it } from 'vitest';
import { LOCAL_TEST_SCREENER, openScreeningScreener } from './local-test-screener.js';

describe('the W9 screener setting', () => {
  it('installs nothing when blank, so every custodial send stays refused as unavailable', () => {
    expect(openScreeningScreener({ appEnv: 'production', setting: undefined })).toBeNull();
    expect(openScreeningScreener({ appEnv: 'dev', setting: '  ' })).toBeNull();
  });

  it('refuses a screener this build does not have', () => {
    expect(() => openScreeningScreener({ appEnv: 'dev', setting: 'acme' })).toThrow(/pay.screening_screener_refused/);
  });

  it('refuses the test stand-in outside APP_ENV dev or test, including a blank or mistyped APP_ENV', () => {
    for (const appEnv of ['production', 'staging', undefined, '', 'Dev', 'development'])
      expect(() => openScreeningScreener({ appEnv, setting: LOCAL_TEST_SCREENER })).toThrow(
        /allowed only when APP_ENV is exactly dev or test/,
      );
  });

  it('in dev and test answers clear, labelled local-test, as a named list for itself only', async () => {
    for (const appEnv of ['dev', 'test']) {
      const opened = openScreeningScreener({ appEnv, setting: LOCAL_TEST_SCREENER })!;
      expect(opened.providerLabel).toBe('local-test');
      expect(opened.listPosture).toBe('named');
      await expect(opened.screener!()).resolves.toEqual({ category: 'clear', factors: [{ code: 'local_test_clear' }] });
    }
  });
});
