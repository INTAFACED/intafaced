import type { TakeGate } from './take-eligibility.js';
import type { TakeStepUp } from './take-step-up.js';
import type { ReleaseStepUp } from './release-step-up.js';
import type { InstrumentStepUp } from './instrument-step-up.js';

/**
 * For tests about something other than eligibility: a person who meets every take requirement. Production wires
 * `createTakeGate` (index.ts); the gate itself is proved in `take-eligibility.test.ts`.
 */
export function metTakeGate(): TakeGate {
  return {
    async eligibility() {
      return {
        checks: (['verification', 'contact', 'jurisdiction', 'deposit'] as const).map((id) => ({
          id,
          state: 'met' as const,
          reason: 'test.met',
          fix: null,
        })),
      };
    },
    async assertCanTake() {},
  };
}

/**
 * For tests about something other than the take confirmation: every take is confirmed. Production wires
 * `createTakeStepUp` (index.ts); the confirmation itself is proved in `take-step-up.test.ts`.
 */
export function confirmedTakeStepUp(): TakeStepUp {
  return {
    async assertConfirmed() {},
    async window() {
      return { confirmedUntil: null };
    },
  };
}

/**
 * For tests about something other than the release confirmation: every release is confirmed. Production wires
 * `createReleaseStepUp` (index.ts); the confirmation itself is proved in `release-step-up.test.ts`.
 */
export function confirmedReleaseStepUp(): ReleaseStepUp {
  return {
    async assertConfirmed() {},
    async window() {
      return { confirmedUntil: null };
    },
  };
}

/**
 * For tests about something other than the payment-method confirmation: every change is confirmed. Production wires
 * `createInstrumentStepUp` (index.ts); the confirmation itself is proved in `instrument-step-up.test.ts`.
 */
export function confirmedInstrumentStepUp(): InstrumentStepUp {
  return {
    async assertConfirmed() {},
  };
}
