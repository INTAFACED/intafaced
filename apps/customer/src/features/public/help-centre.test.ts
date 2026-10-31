import { describe, expect, it } from 'vitest';
import type { SupportHelpCentre } from '@intafaced/contracts/support-help-centre';
import { helpCentreSwitchedOff } from './help-centre';

const settings = (published: boolean | null): SupportHelpCentre => ({
  name: null,
  address: null,
  defaultLanguage: null,
  languages: null,
  setupMode: null,
  theme: null,
  published,
  revision: published === null ? 0 : 1,
  updatedAt: published === null ? null : '2026-10-23T00:00:00.000Z',
});

describe('helpCentreSwitchedOff (SP-help-centre-03, J-support-public-01 #2)', () => {
  it('is off only when the owner switched it off', () => {
    expect(helpCentreSwitchedOff({ status: 'ready', data: settings(false) })).toBe(true);
    expect(helpCentreSwitchedOff({ status: 'ready', data: settings(true) })).toBe(false);
  });

  it('reads a blank switch, a read in flight and a failed read as not switched off', () => {
    expect(helpCentreSwitchedOff({ status: 'ready', data: settings(null) })).toBe(false);
    expect(helpCentreSwitchedOff({ status: 'loading' })).toBe(false);
    expect(
      helpCentreSwitchedOff({ status: 'failed', failure: { ok: false, status: 503, reason: 'error', code: 'X', message: 'x' } as never }),
    ).toBe(false);
  });

  it('treats an answer door refused support.help_centre_off as switched off, whatever the settings read said', () => {
    const refused = { ok: false, status: 412, reason: 'error', code: 'PRECONDITION_FAILED', message: 'support.help_centre_off' } as never;
    expect(helpCentreSwitchedOff({ status: 'ready', data: settings(null) }, refused)).toBe(true);
    expect(helpCentreSwitchedOff({ status: 'loading' }, refused)).toBe(true);
    const other = { ok: false, status: 503, reason: 'error', code: 'X', message: 'support.unavailable' } as never;
    expect(helpCentreSwitchedOff({ status: 'ready', data: settings(null) }, other)).toBe(false);
  });
});
