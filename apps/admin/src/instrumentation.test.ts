import { describe, expect, it } from 'vitest';
import { register } from './instrumentation';

const REAL = 'q8Vx2mZr7LpT4nBw9KcYh3JdFgA6sUeO1iRtXvNzMoE';
const DEV = 'dev-only-admin-session-secret-xxxxxxxxxx';

describe('admin boot refuses development material in production posture', () => {
  it('refuses to start on a dev-only session secret outside dev/test', async () => {
    await expect(register({ NEXT_RUNTIME: 'nodejs', APP_ENV: 'prod', ADMIN_SESSION_SECRET: DEV })).rejects.toThrow(
      /config\.dev_material_in_production_posture/,
    );
  });

  it('starts when the environment is real, and when it is explicitly dev', async () => {
    await expect(register({ NEXT_RUNTIME: 'nodejs', APP_ENV: 'prod', ADMIN_SESSION_SECRET: REAL })).resolves.toBeUndefined();
    await expect(register({ NEXT_RUNTIME: 'nodejs', APP_ENV: 'dev', ADMIN_SESSION_SECRET: DEV })).resolves.toBeUndefined();
  });
});
