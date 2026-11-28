import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { OpenPositionInput } from '../futures/position-service.js';
import { principalFor } from '../spot/testing.js';
import { layeredStandIn } from '../layered.testkit.js';
import { withCollateralHaircutOpen } from '../futures/collateral-haircut.js';
import { withPositionModeOpen } from '../futures/position-mode.js';
import { withPreTradeCreditOpen } from '../futures/pretrade-credit.js';

describe('Installed futures policies preserve live admission authority', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('forwards the exact original principal through all three installed open wrappers', async () => {
    for (const key of ['TRADE_MAX_ORDER', 'TRADE_MAX_POSITION', 'TRADE_MAX_LOSS']) vi.stubEnv(key, '100');
    // A published 0 is the owner's zero. Blank refuses in the haircut credit tests
    // and never reaches this principal-forwarding open.
    vi.stubEnv('TRADE_COLLATERAL_HAIRCUT_BPS', '0');
    const received: Array<Principal | undefined> = [];
    class Owner {
      async readAccountMode() {
        return { mode: 'one_way' as const, source: 'stored' as const };
      }
      async open(input: OpenPositionInput, principal?: Principal) {
        received.push(principal);
        return input;
      }
    }
    const LayeredOwner = layeredStandIn(Owner, withCollateralHaircutOpen, withPositionModeOpen, withPreTradeCreditOpen);
    const principal = principalFor('a1111111-1111-4111-8111-111111111111');
    const input = {
      userId: principal.userId,
      side: 'long',
      positionMode: 'one_way',
      collateralClass: 'cash',
    } as OpenPositionInput;
    expect(await new LayeredOwner().open(input, principal)).toBe(input);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(principal);
    await new LayeredOwner().open(input);
    expect(received[1]).toBeUndefined();
  });
});
