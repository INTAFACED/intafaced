import { describe, expect, it } from 'vitest';
import { TRPCError } from '@intafaced/contracts';
import { defineRefusals, RefusalError } from './refusals.js';

const forms = defineRefusals('FormError', {
  'support.form_cap_unset': 'PRECONDITION_FAILED',
  'support.form_unknown': 'BAD_REQUEST',
});

describe('defineRefusals', () => {
  it('lists its codes in the order declared', () => {
    expect(forms.codes).toEqual(['support.form_cap_unset', 'support.form_unknown']);
  });

  it('throws a typed refusal that carries its code, message, details and name', () => {
    let thrown: unknown;
    try {
      forms.refuse('support.form_cap_unset', 'the cap is not set', { setting: 'SUPPORT_FORM_CAP' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RefusalError);
    expect(forms.is(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      name: 'FormError',
      code: 'support.form_cap_unset',
      message: 'the cap is not set',
      details: { setting: 'SUPPORT_FORM_CAP' },
    });
  });

  it('defaults the message to the code', () => {
    expect(new forms.Error('support.form_unknown').message).toBe('support.form_unknown');
  });

  it('refuses to build an error for a code it does not declare', () => {
    expect(() => new forms.Error('support.other' as never)).toThrow(/not one of this family's codes/);
  });

  it("tells its own refusals from another family's with the same code", () => {
    const other = defineRefusals('OtherError', { 'support.form_unknown': 'NOT_FOUND' });
    const theirs = new other.Error('support.form_unknown');
    expect(forms.is(theirs)).toBe(false);
    expect(forms.toTrpc(theirs)).toBe(theirs);
  });

  it('maps its refusal to the declared tRPC status with the refusal as cause', () => {
    const wire = forms.toTrpc(new forms.Error('support.form_unknown', 'no such form'));
    expect(wire).toBeInstanceOf(TRPCError);
    expect(wire).toMatchObject({ code: 'BAD_REQUEST', message: 'support.form_unknown: no such form' });
    expect((wire as TRPCError).cause).toMatchObject({ code: 'support.form_unknown' });
    expect(forms.statusOf('support.form_cap_unset')).toBe('PRECONDITION_FAILED');
  });

  it("uses the service's copy for the message when it has words for the code", () => {
    const worded = defineRefusals(
      'W',
      { 'a.b': 'CONFLICT', 'a.c': 'CONFLICT' },
      { copy: (c) => (c === 'a.b' ? 'Already taken.' : undefined) },
    );
    expect(worded.toTrpc(new worded.Error('a.b', 'raw'))).toMatchObject({ message: 'Already taken.' });
    expect(worded.toTrpc(new worded.Error('a.c', 'raw'))).toMatchObject({ message: 'a.c: raw' });
  });

  it('passes every other error through unchanged', () => {
    const crash = new Error('boom');
    const auth = new TRPCError({ code: 'UNAUTHORIZED' });
    expect(forms.toTrpc(crash)).toBe(crash);
    expect(forms.toTrpc(auth)).toBe(auth);
  });

  it('guard returns the body, throws refusals as TRPCError and crashes unchanged', async () => {
    await expect(forms.guard(async () => 7)).resolves.toBe(7);
    await expect(forms.guard(() => forms.refuse('support.form_unknown'))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { code: 'support.form_unknown' },
    });
    const crash = new Error('boom');
    await expect(forms.guard(() => Promise.reject(crash))).rejects.toBe(crash);
  });

  it('refuses an empty family', () => {
    expect(() => defineRefusals('Empty', {})).toThrow(/at least one code/);
  });
});
