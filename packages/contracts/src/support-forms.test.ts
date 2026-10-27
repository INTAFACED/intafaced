import { describe, expect, it } from 'vitest';
import { supportFieldDefinitionProblem, supportFormValuesProblem, supportFormValuesTrimmed, type SupportField } from './support-forms.js';

const at = '2026-10-24T00:00:00.000Z';
const fields: SupportField[] = [
  {
    id: 'device',
    label: 'Device',
    kind: 'choice',
    options: [
      { value: 'phone', label: 'Phone' },
      { value: 'computer', label: 'Computer' },
    ],
    revision: 1,
    updatedAt: at,
  },
  {
    id: 'system',
    label: 'System',
    kind: 'choice',
    options: [
      { value: 'ios', label: 'iOS' },
      { value: 'windows', label: 'Windows' },
    ],
    parent: { fieldId: 'device', allowed: { phone: ['ios'], computer: ['windows'] } },
    revision: 1,
    updatedAt: at,
  },
  { id: 'model', label: 'Model', kind: 'text', revision: 1, updatedAt: at },
  { id: 'agree', label: 'Agree', kind: 'checkbox', revision: 1, updatedAt: at },
  { id: 'when', label: 'When', kind: 'date', revision: 1, updatedAt: at },
  { id: 'figure', label: 'Figure', kind: 'decimal', revision: 1, updatedAt: at },
];
const form = {
  fields: [
    { fieldId: 'device', required: true },
    { fieldId: 'system', required: true },
    { fieldId: 'model', required: true, showWhen: { fieldId: 'device', value: 'phone' } },
    { fieldId: 'agree', required: false },
    { fieldId: 'when', required: false },
    { fieldId: 'figure', required: false },
  ],
};

describe('supportFormValuesProblem (SP-tickets-03)', () => {
  it('accepts answers that fit the form', () => {
    expect(
      supportFormValuesProblem(form, fields, {
        device: 'phone',
        system: 'ios',
        model: 'P7',
        agree: true,
        when: '2026-10-20',
        figure: '-12.50',
      }),
    ).toBeNull();
    expect(supportFormValuesProblem(form, fields, { device: 'computer', system: 'windows' })).toBeNull();
  });
  it('a conditional field is required while shown and refused while hidden', () => {
    expect(supportFormValuesProblem(form, fields, { device: 'phone', system: 'ios' })).toEqual({ fieldId: 'model', problem: 'required' });
    expect(supportFormValuesProblem(form, fields, { device: 'computer', system: 'windows', model: 'x' })).toEqual({
      fieldId: 'model',
      problem: 'not_shown',
    });
  });
  it('a dependent choice its parent does not allow is refused', () => {
    expect(supportFormValuesProblem(form, fields, { device: 'computer', system: 'ios' })).toEqual({
      fieldId: 'system',
      problem: 'not_allowed',
    });
  });
  it('wrong kinds and fields off the form are refused', () => {
    const ok = { device: 'computer', system: 'windows' };
    expect(supportFormValuesProblem(form, fields, { ...ok, figure: '12.5 USD' })?.problem).toBe('wrong_kind');
    expect(supportFormValuesProblem(form, fields, { ...ok, when: '2026-13-45' })?.problem).toBe('wrong_kind');
    expect(supportFormValuesProblem(form, fields, { ...ok, agree: 'yes' })?.problem).toBe('wrong_kind');
    expect(supportFormValuesProblem(form, fields, { ...ok, device: 'tablet' })?.problem).toBe('wrong_kind');
    expect(supportFormValuesProblem(form, fields, { ...ok, extra: 'x' })).toEqual({ fieldId: 'extra', problem: 'not_on_form' });
  });
});

describe('supportFieldDefinitionProblem', () => {
  it('a choice needs options; only a choice has options or a parent; allowed values must be options', () => {
    expect(supportFieldDefinitionProblem({ id: 'a', kind: 'choice' })).toBe('a choice needs options');
    expect(supportFieldDefinitionProblem({ id: 'a', kind: 'text', options: [{ value: 'x', label: 'X' }] })).toBe(
      'only a choice has options',
    );
    expect(supportFieldDefinitionProblem({ ...fields[1]!, parent: { fieldId: 'device', allowed: { phone: ['android'] } } })).toBe(
      'an allowed value is not an option',
    );
    expect(supportFieldDefinitionProblem(fields[1]!)).toBeNull();
  });

  it('refuses a date that does not exist and treats blank text as no answer', () => {
    const ok = { device: 'computer', system: 'windows' };
    expect(supportFormValuesProblem(form, fields, { ...ok, when: '2026-02-30' })).toEqual({ fieldId: 'when', problem: 'wrong_kind' });
    expect(supportFormValuesProblem(form, fields, { ...ok, when: '2028-02-29' })).toBeNull();
    expect(supportFormValuesProblem(form, fields, { device: 'phone', system: 'ios', model: '   ' })).toEqual({
      fieldId: 'model',
      problem: 'required',
    });
    expect(supportFormValuesTrimmed({ model: '  P7 ', note: '  ', agree: false })).toEqual({ model: 'P7', agree: false });
  });
});
