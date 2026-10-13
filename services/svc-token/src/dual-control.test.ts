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

  it('two distinct operators accept', () => {
    expect(dualControlRefuse(OP, CONFIRM)).toBeNull();
    expect(requireDualControl(OP, CONFIRM)).toBe(CONFIRM);
  });

  it('trims the confirming operator before the empty and same-person checks', () => {
    const blank = dualControlRefuse(OP, '   ');
    expect(blank?.code).toBe(MISSING_OPERATOR);
    expect(blank?.message).toBe('confirming operator identity is required; the token service does not invent a second caller');
    expect(dualControlRefuse(OP, '')?.code).toBe(MISSING_OPERATOR);

    const paddedSelf = dualControlRefuse(OP, `  ${OP}  `);
    expect(paddedSelf?.code).toBe(MISSING_OPERATOR);
    expect(paddedSelf?.message).toBe('confirming operator must be a distinct identity; the token service does not invent a second caller');
    expect(dualControlRefuse(` ${OP} `, `\t${OP}\n`)?.code).toBe(MISSING_OPERATOR);
    expect(() => requireDualControl(OP, '   ')).toThrow(DualControlError);
    expect(() => requireDualControl(OP, `  ${OP}  `)).toThrow(DualControlError);

    expect(dualControlRefuse(`  ${OP}  `, `  ${CONFIRM}  `)).toBeNull();
    expect(requireDualControl(OP, `  ${CONFIRM}  `)).toBe(CONFIRM);
    expect(requireDualControl(`  ${OP}  `, `  ${CONFIRM}  `)).toBe(CONFIRM);
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
