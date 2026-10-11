import { describe, expect, it } from 'vitest';
import { DualControlError, MISSING_OPERATOR, dualControlRefuse, readConfirmOperatorId, requireDualControl } from './dual-control.js';

const OP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('dualControlRefuse', () => {
  it('missing or blank operator refuses', () => {
    expect(dualControlRefuse(null, CONFIRM)?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse('   ', CONFIRM)?.code).toBe(MISSING_OPERATOR);
  });

  it('missing/blank/same confirm refuses — no invented second caller', () => {
    expect(dualControlRefuse(OP, null)?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse(OP, OP)?.code).toBe(MISSING_OPERATOR);
    expect(readConfirmOperatorId({ confirmOperatorId: '   ' })).toBeNull();
    expect(dualControlRefuse(OP, readConfirmOperatorId({ confirmOperatorId: '   ' }))?.code).toBe(MISSING_OPERATOR);
  });

  it('blank or whitespace confirm id is missing, not a second operator', () => {
    expect(dualControlRefuse(OP, '')?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse(OP, '   ')?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse(OP, '\t\n')?.code).toBe(MISSING_OPERATOR);
    expect(() => requireDualControl(OP, '')).toThrow(DualControlError);
    expect(() => requireDualControl(OP, '   ')).toThrow(DualControlError);
  });

  it('confirm id that is the actor with surrounding spaces is the same operator', () => {
    const padded = `  ${OP}  `;
    expect(dualControlRefuse(OP, padded)?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse(`  ${OP}`, `${OP}  `)?.code).toBe(MISSING_OPERATOR);
    expect(() => requireDualControl(OP, padded)).toThrow(DualControlError);
  });

  it('a distinct non-blank confirm id passes and is returned trimmed', () => {
    const padded = `  ${CONFIRM}\t`;
    expect(dualControlRefuse(OP, padded)).toBeNull();
    expect(requireDualControl(OP, padded)).toBe(CONFIRM);
    expect(requireDualControl(OP, CONFIRM)).toBe(CONFIRM);
  });

  it('a missing actor is still refused', () => {
    expect(dualControlRefuse(null, `  ${CONFIRM}  `)?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse('', CONFIRM)?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse('   ', CONFIRM)?.code).toBe(MISSING_OPERATOR);
    expect(() => requireDualControl(null, CONFIRM)).toThrow(DualControlError);
    expect(() => requireDualControl('  ', `  ${CONFIRM}  `)).toThrow(DualControlError);
  });

  it('two distinct operators accept', () => {
    expect(dualControlRefuse(OP, CONFIRM)).toBeNull();
    expect(requireDualControl(OP, CONFIRM)).toBe(CONFIRM);
  });

  it('requireDualControl throws DualControlError on refuse', () => {
    expect(() => requireDualControl(OP, null)).toThrow(DualControlError);
    try {
      requireDualControl(OP, OP);
      throw new Error('expected DualControlError');
    } catch (err) {
      expect(err).toBeInstanceOf(DualControlError);
      expect((err as DualControlError).code).toBe(MISSING_OPERATOR);
    }
  });
});
