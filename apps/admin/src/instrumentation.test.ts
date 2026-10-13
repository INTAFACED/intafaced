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
