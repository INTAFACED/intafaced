import { describe, expect, it } from 'vitest';
import { CONTROL_COPY } from './control-copy';

describe('halt refusal copy', () => {
  it('says a user or rail halt pauses payouts, and names an unknown rail', () => {
    expect(CONTROL_COPY['pay.halt_target_unsupported']?.title).toBe('A user or rail halt only pauses payouts');
    expect(CONTROL_COPY['pay.halt_target_unsupported']?.body).toContain('payouts');
    expect(CONTROL_COPY['pay.halt_target_unknown_rail']?.title).toBe('That rail is not registered');
    expect(CONTROL_COPY['pay.halt_target_unknown_rail']?.next).toBe('Pick a registered rail.');
  });
});
