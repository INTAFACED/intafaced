import { describe, expect, it } from 'vitest';
import {
  OPS_RESTORE_STEP_OUT_OF_ORDER,
  OPS_RESTORE_TARGET_UNSET,
  OPS_RESTORE_WATERMARKS_DISAGREE,
  RESTORE_SERVICES as CONTRACT_SERVICES,
  RESTORE_STEPS as CONTRACT_STEPS,
} from '@intafaced/contracts';
import { moduleForApi, moduleForPage } from '@/lib/modules';
import {
  DISAGREE_WORDS,
  RESTORE_SERVICES,
  RESTORE_STEPS,
  SERVICE_LABEL,
  STEP_LABEL,
  finalizeKey,
  parseRestoreQuery,
  parseRunDetail,
  parseStamps,
  refusalWords,
  startKey,
  stepKey,
} from './model';

describe('restore model', () => {
  it('repeats the contracts lists exactly and words every entry', () => {
    expect([...RESTORE_STEPS]).toEqual([...CONTRACT_STEPS]);
    expect([...RESTORE_SERVICES]).toEqual([...CONTRACT_SERVICES]);
    for (const s of RESTORE_STEPS) expect(STEP_LABEL[s]).toBeTruthy();
    for (const s of RESTORE_SERVICES) expect(SERVICE_LABEL[s]).toBeTruthy();
    expect(Object.keys(DISAGREE_WORDS).sort()).toEqual([
      'cutoff_invalid',
      'position_differs',
      'read_missing',
      'stamp_missing',
      'written_after_cutoff',
    ]);
  });

  it('says what each contract refusal means', () => {
    for (const code of [OPS_RESTORE_WATERMARKS_DISAGREE, OPS_RESTORE_TARGET_UNSET, OPS_RESTORE_STEP_OUT_OF_ORDER]) {
      expect(refusalWords(code)).toBeTruthy();
    }
    expect(refusalWords('ops.unknown_thing')).toBeNull();
    expect(refusalWords(null)).toBeNull();
  });

  it('builds business keys from the run and step, never random ones', () => {
    expect(startKey('R-1')).toBe('restore:start:R-1');
    expect(stepKey('R-1', 'validate')).toBe('restore:step:R-1:validate');
    expect(finalizeKey('R-1')).toBe('restore:finalize:R-1');
  });

  it('opens a run only for a well-formed restore number', () => {
    expect(parseRestoreQuery({ run: 'R-1' }).runNo).toBe('R-1');
    expect(parseRestoreQuery({ run: '../x' }).runNo).toBeNull();
    expect(parseRestoreQuery({}).runNo).toBeNull();
  });

  it('reads no stamps as not stamped, and refuses a malformed row', () => {
    expect(parseStamps({ watermarks: null })).toEqual({ stamped: false, rows: [] });
    expect(parseStamps({ watermarks: { rows: [{ service: 'svc-ledger' }] } })).toBeNull();
  });

  it('refuses a run detail with an unknown step', () => {
    const base = {
      run: { restoreNo: 'R-1', cutOff: '2026-10-20T12:00:00.000Z', startedBy: 'a', startedAt: '2026-10-20T12:01:00.000Z' },
      steps: [{ restoreNo: 'R-1', step: 'bogus', actor: 'a', at: '2026-10-20T12:02:00.000Z' }],
      restored: false,
      next: 'validate',
      finalizeOffered: false,
      live: { joint: { agree: true, cutOff: '2026-10-20T12:00:00.000Z', services: [] }, reads: [], halt: { halted: true } },
    };
    expect(parseRunDetail(base)).toBeNull();
    expect(parseRunDetail({ ...base, steps: [] })?.next).toBe('validate');
  });

  it('reads whether the posting freeze is on, and refuses a run detail without it', () => {
    const base = {
      run: { restoreNo: 'R-1', cutOff: '2026-10-20T12:00:00.000Z', startedBy: 'a', startedAt: '2026-10-20T12:01:00.000Z' },
      steps: [],
      restored: false,
      next: 'validate',
      finalizeOffered: false,
      live: { joint: { agree: true, cutOff: '2026-10-20T12:00:00.000Z', services: [] }, reads: [] },
    };
    expect(parseRunDetail(base)).toBeNull();
    expect(parseRunDetail({ ...base, live: { ...base.live, halt: { halted: false } } })).toBeNull();
    const off = { halted: false, code: 'ops.restore_platform_not_halted', message: 'the posting freeze is off' };
    expect(parseRunDetail({ ...base, live: { ...base.live, halt: off } })?.live.halt).toEqual(off);
    expect(parseRunDetail({ ...base, live: { ...base.live, halt: { halted: true } } })?.live.halt).toEqual({ halted: true });
    expect(refusalWords('ops.restore_platform_not_halted')).toContain('posting freeze is off');
    expect(refusalWords('ops.restore_halt_unreadable')).toContain('could not be read');
  });

  it('maps the page and its API to the ledger module', () => {
    expect(moduleForPage('/restore')).toBe('ledger');
    expect(moduleForApi('/api/restore')).toBe('ledger');
  });
});
