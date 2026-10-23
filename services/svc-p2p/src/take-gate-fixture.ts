import type { TakeGate } from './take-eligibility.js';

/**
 * For tests about something other than eligibility: a person who meets every take requirement. Production wires
 * `createTakeGate` (index.ts); the gate itself is proved in `take-eligibility.test.ts`.
 */
export function metTakeGate(): TakeGate {
  const acceptedAt = new Date('2026-10-23T00:00:00.000Z');
  return {
    async eligibility() {
      return (['verification', 'contact', 'jurisdiction', 'deposit', 'risk'] as const).map((id) => ({
        id,
        state: 'met' as const,
        reason: 'test.met',
        fix: null,
      }));
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
