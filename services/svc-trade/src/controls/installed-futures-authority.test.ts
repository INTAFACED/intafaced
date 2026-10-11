import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { OpenPositionInput, PositionService } from '../futures/position-service.js';
import { installCollateralHaircutOpen } from '../futures/collateral-haircut.js';
import { installPositionModeOpen } from '../futures/position-mode.js';
import { installPreTradeCreditOpen } from '../futures/pretrade-credit.js';
import { principalFor } from '../spot/testing.js';

describe('Installed futures policies preserve live admission authority', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('forwards the exact original principal through all three installed open wrappers', async () => {
    for (const key of ['TRADE_MAX_ORDER', 'TRADE_MAX_POSITION', 'TRADE_MAX_LOSS']) vi.stubEnv(key, '100');
    vi.stubEnv('TRADE_COLLATERAL_HAIRCUT_BPS', '');
    const received: Array<Principal | undefined> = [];
    class Owner {
      async open(input: OpenPositionInput, principal?: Principal) {
        received.push(principal);
        return input;
      }
    }
    const ctor = Owner as unknown as typeof PositionService;
    installCollateralHaircutOpen(ctor);
    installPositionModeOpen(ctor);
    installPreTradeCreditOpen(ctor);
    const principal = principalFor('a1111111-1111-4111-8111-111111111111');
    const input = {
      userId: principal.userId,
      side: 'long',
      positionMode: 'one_way',
      collateralClass: 'cash',
    } as unknown as OpenPositionInput;
    expect(await new Owner().open(input, principal)).toBe(input);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(principal);
    await new Owner().open(input);
    expect(received[1]).toBeUndefined();
  });
});
