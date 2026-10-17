import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from './instrumentation';

const REAL = 'q8Vx2mZr7LpT4nBw9KcYh3JdFgA6sUeO1iRtXvNzMoE';
const DEV = 'dev-only-admin-session-secret-xxxxxxxxxx';

describe('admin boot refuses development material in production posture', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exits 1 (not a zombie server) on a dev-only session secret outside dev/test, naming the variable and never the value', async () => {
    const exit = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await register({ NEXT_RUNTIME: 'nodejs', APP_ENV: 'prod', ADMIN_SESSION_SECRET: DEV }, exit);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    const printed = String(error.mock.calls[0]?.[0]);
    expect(printed).toMatch(/config\.dev_material_in_production_posture/);
    expect(printed).toContain('ADMIN_SESSION_SECRET');
    expect(printed).not.toContain(DEV);
  });

  it('starts when the environment is real, and when it is explicitly dev', async () => {
    const exit = vi.fn();
    await register({ NEXT_RUNTIME: 'nodejs', APP_ENV: 'prod', ADMIN_SESSION_SECRET: REAL }, exit);
    await register({ NEXT_RUNTIME: 'nodejs', APP_ENV: 'dev', ADMIN_SESSION_SECRET: DEV }, exit);
    expect(exit).not.toHaveBeenCalled();
  });

  it('does nothing outside the node runtime', async () => {
    const exit = vi.fn();
    await register({ NEXT_RUNTIME: 'edge', APP_ENV: 'prod', ADMIN_SESSION_SECRET: DEV }, exit);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('admin boot refuses an invalid HSTS setting', () => {
  afterEach(() => vi.restoreAllMocks());
  const base = { NEXT_RUNTIME: 'nodejs', ADMIN_SESSION_SECRET: REAL } as const;

  async function boot(env: Record<string, unknown>) {
    const exit = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await register({ ...base, ...env }, exit);
    return { exit, printed: error.mock.calls.map((call) => String(call[0])).join('\n') };
  }

  it('exits 1 with the stable code and the problem, naming variables and never values', async () => {
    const { exit, printed } = await boot({ APP_ENV: 'prod', HSTS_MAX_AGE_SECONDS: '63072001', HSTS_INCLUDE_SUBDOMAINS: 'maybe' });
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(printed).toContain('config.hsts_invalid');
    expect(printed).toContain('hsts.max_age_invalid (HSTS_MAX_AGE_SECONDS)');
    expect(printed).toContain('hsts.include_subdomains_invalid (HSTS_INCLUDE_SUBDOMAINS)');
    expect(printed).not.toContain('63072001');
    expect(printed).not.toContain('maybe');
  });

  it.each(['-1', '1.5', 'abc', '1e9', '63072001'])('refuses HSTS_MAX_AGE_SECONDS=%s', async (value) => {
    const { exit } = await boot({ APP_ENV: 'prod', HSTS_MAX_AGE_SECONDS: value });
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('refuses includeSubDomains on the registrable domain, and when the host is unknown', async () => {
    const apex = await boot({ APP_ENV: 'prod', HSTS_INCLUDE_SUBDOMAINS: 'true', ADMIN_ORIGIN: 'https://intafaced.com' });
    expect(apex.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(apex.printed).toContain('hsts.include_subdomains_on_registrable_domain');
    const unknown = await boot({ APP_ENV: 'prod', HSTS_INCLUDE_SUBDOMAINS: 'true' });
    expect(unknown.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(unknown.printed).toContain('hsts.include_subdomains_host_unknown');
  });

  it('refuses more than one day outside production posture, allows it in production posture', async () => {
    const dev = await boot({ APP_ENV: 'dev', HSTS_MAX_AGE_SECONDS: '31536000' });
    expect(dev.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(dev.printed).toContain('hsts.max_age_above_non_production_cap');
    const prod = await boot({ APP_ENV: 'prod', HSTS_MAX_AGE_SECONDS: '31536000' });
    expect(prod.exit).not.toHaveBeenCalled();
  });

  it('starts on the defaults and on a valid leaf-host stage', async () => {
    expect((await boot({ APP_ENV: 'prod' })).exit).not.toHaveBeenCalled();
    expect((await boot({ APP_ENV: 'dev' })).exit).not.toHaveBeenCalled();
    const stage = await boot({
      APP_ENV: 'staging',
      HSTS_MAX_AGE_SECONDS: '604800',
      HSTS_INCLUDE_SUBDOMAINS: 'true',
      ADMIN_ORIGIN: 'https://admin.intafaced.com',
    });
    expect(stage.exit).not.toHaveBeenCalled();
  });

  it('exits once when production posture and HSTS are both wrong (the posture refusal wins)', async () => {
    const { exit, printed } = await boot({ APP_ENV: 'prod', ADMIN_SESSION_SECRET: DEV, HSTS_MAX_AGE_SECONDS: 'x' });
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(printed).toContain('config.dev_material_in_production_posture');
  });

  it('does nothing outside the node runtime', async () => {
    const exit = vi.fn();
    await register({ NEXT_RUNTIME: 'edge', HSTS_MAX_AGE_SECONDS: 'x' }, exit);
    expect(exit).not.toHaveBeenCalled();
  });
});
