/**
 * Test fixture only. Production defaults stay off and the haircut stays blank.
 * Existing position opens in this package reach the path they already test:
 * both futures switches on, and a published haircut of 0 (credit equals cash).
 * A test that needs them off sets process.env in its own body, after this hook.
 */
import { beforeEach } from 'vitest';

beforeEach(() => {
  process.env.TRADE_FUTURES_ENABLED = 'true';
  process.env.TRADE_FUTURES_JOBS_ENABLED = 'true';
  process.env.TRADE_COLLATERAL_HAIRCUT_BPS = '0';
});
