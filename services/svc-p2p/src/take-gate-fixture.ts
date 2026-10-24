import type { TakeGate } from './take-eligibility.js';
import type { TakeStepUp } from './take-step-up.js';
import type { ReleaseStepUp } from './release-step-up.js';

/**
 * For tests about something other than eligibility: a person who meets every take requirement. Production wires
 * `createTakeGate` (index.ts); the gate itself is proved in `take-eligibility.test.ts`.
 */
export function metTakeGate(): TakeGate {
  const acceptedAt = new Date('2026-10-23T00:00:00.000Z');
  return {
    async eligibility() {
      return {
        checks: (['verification', 'contact', 'jurisdiction', 'deposit', 'risk'] as const).map((id) => ({
          id,
          state: 'met' as const,
          reason: 'test.met',
          fix: null,
        })),
        notice: { version: 'TEST', acceptedAt },
      };
    },
    async assertCanTake() {},
    async riskNotice() {
      return { version: 'TEST', acceptedAt };
    },
    async acceptRisk() {
      return { version: 'TEST', acceptedAt };
    },
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
