import { describe, expect, it } from 'vitest';
import type { SupportField, SupportForm } from '@intafaced/contracts/support-forms';
import { formAnswers, formReady } from './SupportRequestForm';

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
  { id: 'model', label: 'Phone model', kind: 'text', revision: 1, updatedAt: at },
];
const form: SupportForm = {
  id: 'device-problem',
  name: 'Device problem',
  fields: [
    { fieldId: 'device', required: true },
    { fieldId: 'system', required: true },
    { fieldId: 'model', required: true, showWhen: { fieldId: 'device', value: 'phone' } },
  ],
  revision: 1,
  updatedAt: at,
};

describe('the request form of a request type (J-support-public-02 #3)', () => {
  it('sends only shown answers, and drops a dependent choice the new parent value does not allow', () => {
    expect(formAnswers(form, fields, { device: 'computer', system: 'ios', model: ' P7 ' })).toEqual({ device: 'computer' });
    expect(formAnswers(form, fields, { device: 'phone', system: 'ios', model: ' P7 ' })).toEqual({
      device: 'phone',
      system: 'ios',
      model: 'P7',
    });
  });
  it('is ready only when every shown required question is answered', () => {
    expect(formReady(form, fields, { device: 'phone', system: 'ios' })).toBe(false);
    expect(formReady(form, fields, { device: 'phone', system: 'ios', model: 'P7' })).toBe(true);
    expect(formReady(form, fields, { device: 'computer', system: 'windows' })).toBe(true);
    expect(formReady(form, fields, { device: 'computer', system: 'ios' })).toBe(false);
  });
});
