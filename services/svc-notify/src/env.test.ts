import { beforeAll, describe, expect, it } from 'vitest';

/**
 * BOOT REFUSAL — the half of "the channel refuses honestly" that honesty alone
 * does not cover.
 *
 * A channel with no credentials records a refusal on every message. That is the
 * right behaviour and it is not sufficient: nobody reads `notify.deliveries`
 * until somebody complains, so a production deployment whose SMS gateway was
 * never wired looks healthy for exactly as long as it takes a borrower to be
 * liquidated without warning.
 *
 * So an operator states what the deployment depends on, and the absence of a
 * credential for a declared-required channel STOPS THE BOOT. The model is
 * `EDGE_PRINCIPAL_SECRET` in `@intafaced/config`: no default, no fallback, the
 * process does not start.
 *
 * These tests exercise the schema, not a running process, because the whole
 * point is the state that must never reach a running process.
 */

/** Never connected to. `*_test` per the test-db scan; this suite opens no socket. */
const BASE = {
  DATABASE_URL: 'postgres://svc_notify:svc_notify@localhost:5432/intafaced_notify_test',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: 'e'.repeat(40),
  SERVICE_NAME: 'svc-notify',
};

const CREDS = {
  NOTIFY_SMS_GATEWAY_URL: 'https://gateway.internal/sms',
  NOTIFY_SMS_GATEWAY_TOKEN: 's'.repeat(24),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let envSchema: any;

beforeAll(async () => {
  // The module parses `process.env` at import time — deliberately, that is what
  // "fatal at boot" means — so it needs a loadable environment to import at all.
  Object.assign(process.env, BASE);
  ({ envSchema } = await import('./env.js'));
});

function parse(over: Record<string, string>) {
  return envSchema.safeParse({ ...BASE, ...over });
}

function messages(result: { success: boolean; error?: { issues: Array<{ message: string }> } }): string {
  return result.error?.issues.map((i) => i.message).join('\n') ?? '';
}

describe('dev and test stay frictionless', () => {
  it('boots with no gateway credentials at all', () => {
    expect(parse({ APP_ENV: 'dev' }).success).toBe(true);
    expect(parse({ APP_ENV: 'test' }).success).toBe(true);
  });

  it('boots with NOTIFY_REQUIRED_CHANNELS unset — nobody needs an SMS provider to run a unit test', () => {
    const result = parse({ APP_ENV: 'dev' });
    expect(result.success).toBe(true);
    expect(result.data.NOTIFY_REQUIRED_CHANNELS).toBeUndefined();
  });

  it('blank NOTIFY_MARKETS_LIST_LIMIT is unpublished — never 50', () => {
    const unset = parse({ APP_ENV: 'dev' });
    expect(unset.success).toBe(true);
    expect(unset.data.NOTIFY_MARKETS_LIST_LIMIT).toBeUndefined();
    const blank = parse({ APP_ENV: 'dev', NOTIFY_MARKETS_LIST_LIMIT: '' });
    expect(blank.success).toBe(true);
    expect(blank.data.NOTIFY_MARKETS_LIST_LIMIT).toBeUndefined();
    const set = parse({ APP_ENV: 'dev', NOTIFY_MARKETS_LIST_LIMIT: '500' });
    expect(set.success).toBe(true);
    expect(set.data.NOTIFY_MARKETS_LIST_LIMIT).toBe(500);
    expect(parse({ APP_ENV: 'dev', NOTIFY_MARKETS_LIST_LIMIT: '0' }).success).toBe(false);
    expect(parse({ APP_ENV: 'dev', NOTIFY_MARKETS_LIST_LIMIT: '501' }).success).toBe(false);
  });

  it('blank whale-flow allow-list is absent — dark, never a wildcard', () => {
    const unset = parse({ APP_ENV: 'dev' });
    expect(unset.success).toBe(true);
    expect(unset.data.NOTIFY_WHALE_FLOW_ALLOWLIST).toBeUndefined();
    const blank = parse({ APP_ENV: 'dev', NOTIFY_WHALE_FLOW_ALLOWLIST: '' });
    expect(blank.success).toBe(true);
    expect(blank.data.NOTIFY_WHALE_FLOW_ALLOWLIST).toBeUndefined();
    const set = parse({ APP_ENV: 'dev', NOTIFY_WHALE_FLOW_ALLOWLIST: 'BTC-USD' });
    expect(set.success).toBe(true);
    expect(set.data.NOTIFY_WHALE_FLOW_ALLOWLIST).toBe('BTC-USD');
  });

  it('blank MATCHING_URL is absent — never localhost, never an invented halt board', () => {
    const unset = parse({ APP_ENV: 'dev' });
    expect(unset.success).toBe(true);
    expect(unset.data.MATCHING_URL).toBeUndefined();
    expect(unset.data.NOTIFY_INCIDENT_SILENCE).toBe(false);
    expect(unset.data.NOTIFY_INCIDENT_ALL_CLEAR).toBe(false);
    const blank = parse({ APP_ENV: 'dev', MATCHING_URL: '' });
    expect(blank.success).toBe(true);
    expect(blank.data.MATCHING_URL).toBeUndefined();
  });
});

describe('a blank bool is absent and a padded false is off', () => {
  it('does not arm the incident latches when compose leaves them blank', () => {
    for (const blank of ['', ' ', '   ', '\t', '\n']) {
      const result = parse({
        APP_ENV: 'dev',
        NOTIFY_INCIDENT_SILENCE: blank,
        NOTIFY_INCIDENT_ALL_CLEAR: blank,
      });
      expect(result.success, JSON.stringify(blank)).toBe(true);
      expect(result.data.NOTIFY_INCIDENT_SILENCE, JSON.stringify(blank)).toBe(false);
      expect(result.data.NOTIFY_INCIDENT_ALL_CLEAR, JSON.stringify(blank)).toBe(false);
    }
  });

  it('does not leave sending on when fan-out or out-of-app is a padded false', () => {
    for (const padded of [' false ', 'false ', ' false', '\tfalse\n', ' FALSE ']) {
      const result = parse({
        APP_ENV: 'dev',
        NOTIFY_FANOUT_ENABLED: padded,
        NOTIFY_OUT_OF_APP_ENABLED: padded,
      });
      expect(result.success, JSON.stringify(padded)).toBe(true);
      expect(result.data.NOTIFY_FANOUT_ENABLED, JSON.stringify(padded)).toBe(false);
      expect(result.data.NOTIFY_OUT_OF_APP_ENABLED, JSON.stringify(padded)).toBe(false);
    }
  });

  it('still enables a flag on an explicit true', () => {
    for (const on of ['true', ' true ', 'TRUE']) {
      const result = parse({
        APP_ENV: 'dev',
        NOTIFY_INCIDENT_SILENCE: on,
        NOTIFY_INCIDENT_ALL_CLEAR: on,
        NOTIFY_FANOUT_ENABLED: on,
        NOTIFY_OUT_OF_APP_ENABLED: on,
      });
      expect(result.success, JSON.stringify(on)).toBe(true);
      expect(result.data.NOTIFY_INCIDENT_SILENCE, JSON.stringify(on)).toBe(true);
      expect(result.data.NOTIFY_INCIDENT_ALL_CLEAR, JSON.stringify(on)).toBe(true);
      expect(result.data.NOTIFY_FANOUT_ENABLED, JSON.stringify(on)).toBe(true);
      expect(result.data.NOTIFY_OUT_OF_APP_ENABLED, JSON.stringify(on)).toBe(true);
    }
  });
});

describe('an enforced environment must state what it depends on', () => {
  for (const APP_ENV of ['staging', 'prod']) {
    it(`refuses to boot in ${APP_ENV} with NOTIFY_REQUIRED_CHANNELS unset`, () => {
      const result = parse({ APP_ENV });
      expect(result.success).toBe(false);
      expect(messages(result)).toMatch(/must state which out-of-app channels/);
    });
  }

  it('accepts `none` — "in-app only, on purpose" is a decision and may be recorded as one', () => {
    expect(parse({ APP_ENV: 'prod', NOTIFY_REQUIRED_CHANNELS: 'none' }).success).toBe(true);
  });

  it('does not accept an empty string as a statement — compose interpolates an unset variable to ""', () => {
    const result = parse({ APP_ENV: 'prod', NOTIFY_REQUIRED_CHANNELS: '' });
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/must state which out-of-app channels/);
  });

  it('treats an empty gateway URL as not wired rather than as a malformed URL', () => {
    // Without this the compose passthrough would take the service down instead
    // of leaving the channel honestly unconfigured.
    const result = parse({ APP_ENV: 'dev', NOTIFY_EMAIL_GATEWAY_URL: '', NOTIFY_EMAIL_GATEWAY_TOKEN: '' });
    expect(result.success).toBe(true);
    expect(result.data.NOTIFY_EMAIL_GATEWAY_URL).toBeUndefined();
  });

  it('does not accept separators as a statement either — `,` is typed, so blankAsAbsent lets it through', () => {
    // The gap `blankAsAbsent` cannot see. `""` is absent; `","` is something the
    // operator typed, and "typed something" was being read as "stated a
    // posture". It names no channel, so prod booted depending on none — the
    // silent outage the variable exists to prevent. `none` is how you say none.
    const result = parse({ APP_ENV: 'prod', NOTIFY_REQUIRED_CHANNELS: ',' });
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/unknown channel\(s\)/);
  });

  it('still accepts a stray comma inside a real list — a typo in a stated posture is not an absent one', () => {
    expect(parse({ APP_ENV: 'prod', NOTIFY_REQUIRED_CHANNELS: 'sms,', ...CREDS }).success).toBe(true);
  });

  it('rejects a channel name that does not exist rather than silently requiring nothing', () => {
    const result = parse({ APP_ENV: 'prod', NOTIFY_REQUIRED_CHANNELS: 'email,telegraph' });
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/unknown channel\(s\): telegraph/);
  });
});

describe('a required channel with no credentials is fatal, and says which variable is missing', () => {
  it('refuses when both variables are absent', () => {
    const result = parse({ APP_ENV: 'prod', NOTIFY_REQUIRED_CHANNELS: 'sms' });
    expect(result.success).toBe(false);
    // The message is an ops instruction: it must name the variables verbatim.
    expect(messages(result)).toContain('NOTIFY_SMS_GATEWAY_URL');
    expect(messages(result)).toContain('NOTIFY_SMS_GATEWAY_TOKEN');
  });

  it('refuses when only the token is absent', () => {
    const result = parse({ APP_ENV: 'prod', NOTIFY_REQUIRED_CHANNELS: 'sms', NOTIFY_SMS_GATEWAY_URL: CREDS.NOTIFY_SMS_GATEWAY_URL });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain('NOTIFY_SMS_GATEWAY_TOKEN');
  });

  it('boots once the pair is set', () => {
    expect(parse({ APP_ENV: 'prod', NOTIFY_REQUIRED_CHANNELS: 'sms', ...CREDS }).success).toBe(true);
  });

  it('still refuses a URL without a token even when the channel is not required — an open relay is an open relay', () => {
    const result = parse({ APP_ENV: 'dev', NOTIFY_EMAIL_GATEWAY_URL: 'https://gateway.internal/email' });
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/open relay/);
  });
});

describe('the two settings may not disagree about whether messages go out', () => {
  it('refuses a deployment that requires a channel and switches all sending off', () => {
    const result = parse({ APP_ENV: 'prod', NOTIFY_REQUIRED_CHANNELS: 'sms', NOTIFY_OUT_OF_APP_ENABLED: 'false', ...CREDS });
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/every\s+required channel would refuse/);
  });

  it('allows the kill-switch when nothing is required — that is a considered posture, not a contradiction', () => {
    expect(parse({ APP_ENV: 'prod', NOTIFY_REQUIRED_CHANNELS: 'none', NOTIFY_OUT_OF_APP_ENABLED: 'false' }).success).toBe(true);
  });

  it('refuses prod when a required channel is wired, out-of-app is on, and fan-out is off', () => {
    // Credentials and out-of-app on used to satisfy the refine while fan-out
    // off still acked, inserted nothing, and sent nothing.
    const result = parse({
      APP_ENV: 'prod',
      NOTIFY_REQUIRED_CHANNELS: 'sms',
      NOTIFY_OUT_OF_APP_ENABLED: 'true',
      NOTIFY_FANOUT_ENABLED: 'false',
      ...CREDS,
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/NOTIFY_FANOUT_ENABLED is off/);
    expect(messages(result)).toMatch(/insert no inbox rows/);
  });

  it('still allows fan-out off when nothing is required — the kill-switch is not itself a contradiction', () => {
    expect(
      parse({
        APP_ENV: 'prod',
        NOTIFY_REQUIRED_CHANNELS: 'none',
        NOTIFY_OUT_OF_APP_ENABLED: 'true',
        NOTIFY_FANOUT_ENABLED: 'false',
      }).success,
    ).toBe(true);
  });
});
