import { describe, expect, it } from 'vitest';
import { amendRemainingPaperImplementationShortfallParent } from './oms-is-paper-amend-remaining.js';

const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;

describe('amendRemainingPaperImplementationShortfallParent', () => {
  it('refuses missing parentClientOrderId', () => {
    expect(
      amendRemainingPaperImplementationShortfallParent({
        status: 'paper',
        remaining: '5',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      amendRemainingPaperImplementationShortfallParent({
        parentClientOrderId: '   ',
        status: 'paper',
        remaining: '5',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it("paper unwired / paper_off refuse even with status paper + remaining '5'", () => {
    expect(
      amendRemainingPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        kind: 'implementation_shortfall',
        status: 'paper',
        remaining: '5',
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      amendRemainingPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        kind: 'implementation_shortfall',
        status: 'paper',
        remaining: '5',
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      amendRemainingPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        kind: 'twap',
        status: 'paper',
        remaining: '5',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status running / approved / omitted with not_live', () => {
    const base = {
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      remaining: '5',
      paper: PAPER_ON,
    };
    expect(amendRemainingPaperImplementationShortfallParent({ ...base, status: 'running' })).toMatchObject({
      ok: false,
      reason: 'not_live',
    });
    expect(amendRemainingPaperImplementationShortfallParent({ ...base, status: 'approved' })).toMatchObject({
      ok: false,
      reason: 'not_live',
    });
    expect(amendRemainingPaperImplementationShortfallParent(base)).toMatchObject({
      ok: false,
      reason: 'not_live',
    });
  });

  it('refuses omitted / null / whitespace remaining with remaining_blank', () => {
    const base = {
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'paper',
      paper: PAPER_ON,
    };
    expect(amendRemainingPaperImplementationShortfallParent(base)).toMatchObject({
      ok: false,
      reason: 'remaining_blank',
    });
    expect(amendRemainingPaperImplementationShortfallParent({ ...base, remaining: null })).toMatchObject({
      ok: false,
      reason: 'remaining_blank',
    });
    expect(amendRemainingPaperImplementationShortfallParent({ ...base, remaining: '' })).toMatchObject({
      ok: false,
      reason: 'remaining_blank',
    });
    expect(amendRemainingPaperImplementationShortfallParent({ ...base, remaining: '   ' })).toMatchObject({
      ok: false,
      reason: 'remaining_blank',
    });
  });

  it("refuses 'nope' with remaining_invalid", () => {
    expect(
      amendRemainingPaperImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        kind: 'implementation_shortfall',
        status: 'paper',
        remaining: 'nope',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'remaining_invalid' });
  });

  it('refuses children with outcome unknown with children_unknown (remaining valid — leftover not invented/written)', () => {
    const result = amendRemainingPaperImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'paper',
      remaining: '5',
      paper: PAPER_ON,
      children: [
        { childClientOrderId: 'c-1', outcome: 'stopped' },
        { childClientOrderId: 'c-2', outcome: 'unknown' },
      ],
    });
    expect(result).toMatchObject({ ok: false, reason: 'children_unknown' });
    expect(result).not.toHaveProperty('residual');
  });

  it("happy: status paper + remaining '5' + paper on + one child stopped", () => {
    const result = amendRemainingPaperImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'paper',
      remaining: '5',
      paper: PAPER_ON,
      children: [{ childClientOrderId: 'c-1', outcome: 'stopped' }],
    });
    expect(result).toEqual({
      ok: true,
      amended: true,
      paper: true,
      parent: { parentClientOrderId: 'p-is', kind: 'implementation_shortfall' },
      children: [{ childClientOrderId: 'c-1', outcome: 'stopped' }],
      residual: { remaining: '5' },
    });
    if (result.ok) {
      expect(result.children).toHaveLength(1);
      expect(result.children[0]?.outcome).toBe('stopped');
    }
  });

  it("happy: no children array (none live) + remaining '0' + paper on + status paper", () => {
    const result = amendRemainingPaperImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'paper',
      remaining: '0',
      paper: PAPER_ON,
    });
    expect(result).toEqual({
      ok: true,
      amended: true,
      paper: true,
      parent: { parentClientOrderId: 'p-is', kind: 'implementation_shortfall' },
      children: [],
      residual: { remaining: '0' },
    });
  });
});
