import { test } from './journey.mjs';
import { tool } from './stack.mjs';

// PROOF ONLY, never merged (branch claude/journey-freeze-guard-proof): a journey that turns the platform posting freeze
// on and leaves it on. The guard in journey.mjs must fail this test by name and lift the freeze, so the journey after
// it (J-ops-console-04-freeze #1, which asserts posting is open first) runs unfrozen.
test('J-aa-freeze-leak #1 leaks the platform posting freeze on purpose (PROOF)', () => {
  tool('local-test-gates.mjs', 'posting-freeze', 'on');
});
