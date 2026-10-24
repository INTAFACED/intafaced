import {
  supportFieldAllowedOptions,
  supportFormFieldShown,
  supportFormValuesProblem,
  type SupportField,
  type SupportFieldValue,
  type SupportForm,
  type SupportRequestForms,
} from '@intafaced/contracts/support-forms';
import { Field } from '../../shared/ui';
import { deskCopy } from './support-desk-copy';

export type FormAnswers = Record<string, SupportFieldValue>;

/**
 * The answers to send: only fields the form shows for these answers, without empty text or an unticked box, and without a
 * dependent choice its parent no longer allows (picking another parent value clears it).
 */
export function formAnswers(form: SupportForm, fields: readonly SupportField[], raw: FormAnswers): FormAnswers {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const out: FormAnswers = {};
  for (const entry of form.fields) {
    const field = byId.get(entry.fieldId);
    const value = raw[entry.fieldId];
    if (!field || value === undefined || value === '' || value === false) continue;
    if (!supportFormFieldShown(entry, out)) continue;
    if (field.kind === 'choice' && !supportFieldAllowedOptions(field, out).some((option) => option.value === value)) continue;
    out[entry.fieldId] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}

/** Whether these answers can be sent: the same rule the support service applies. */
export function formReady(form: SupportForm, fields: readonly SupportField[], raw: FormAnswers): boolean {
  return supportFormValuesProblem(form, fields, formAnswers(form, fields, raw)) === null;
}

/**
 * The request type picker and the questions of the picked type (SP-tickets-03). With no request type defined by the
 * desk, the picker offers only a general request and says so; nothing is invented.
 */
export function RequestTypeFields({
  catalogue,
  formId,
  onFormId,
  answers,
  onAnswers,
}: {
  catalogue: SupportRequestForms | null;
  formId: string;
  onFormId: (id: string) => void;
  answers: FormAnswers;
  onAnswers: (next: FormAnswers) => void;
}) {
  const copy = deskCopy.useCopy();
  const forms = catalogue?.forms ?? [];
  const form = forms.find((row) => row.id === formId) ?? null;
  const shown = form && catalogue ? formAnswers(form, catalogue.fields, answers) : {};
  // A changed answer drops the answers it no longer allows (a hidden field, a child its parent now refuses), so they do
  // not come back picked when the parent changes back. The field being typed in keeps its raw text.
  const set = (fieldId: string, value: SupportFieldValue) => {
    const next = { ...answers, [fieldId]: value };
    if (!form || !catalogue) return onAnswers(next);
    const kept = formAnswers(form, catalogue.fields, next);
    onAnswers(Object.fromEntries(Object.entries(next).filter(([id]) => id === fieldId || id in kept)));
  };
  return (
    <>
      <label className="field">
        <span>{copy.t('requestTypeField')}</span>
        <select value={formId} onChange={(event) => onFormId(event.target.value)}>
          <option value="">{copy.t('requestTypeGeneral')}</option>
          {forms.map((row) => (
            <option key={row.id} value={row.id} lang="und">
              {row.name}
            </option>
          ))}
        </select>
        {catalogue && forms.length === 0 && <small>{copy.t('requestTypeNone')}</small>}
        {!catalogue && <small>{copy.t('requestTypeUnread')}</small>}
      </label>
      {form &&
        catalogue &&
        form.fields.map((entry) => {
          const field = catalogue.fields.find((row) => row.id === entry.fieldId);
          if (!field || !supportFormFieldShown(entry, shown)) return null;
          const value = answers[field.id];
          const label = (
            <>
              <span lang="und">{field.label}</span>
              {entry.required ? ` (${copy.t('requiredMark')})` : ''}
            </>
          );
          if (field.kind === 'choice') {
            const options = supportFieldAllowedOptions(field, shown);
            return (
              <label className="field" key={field.id}>
                <span>{label}</span>
                <select
                  aria-required={entry.required}
                  required={entry.required}
                  value={typeof value === 'string' && options.some((o) => o.value === value) ? value : ''}
                  onChange={(event) => set(field.id, event.target.value)}
                >
                  <option value="">{copy.t('fieldPick')}</option>
                  {options.map((option) => (
                    <option key={option.value} value={option.value} lang="und">
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          }
          if (field.kind === 'checkbox')
            return (
              <label className="field field--check" key={field.id}>
                <input
                  type="checkbox"
                  required={entry.required}
                  checked={value === true}
                  onChange={(event) => set(field.id, event.target.checked)}
                />
                <span>{label}</span>
              </label>
            );
          return (
            <Field
              key={field.id}
              label={label}
              type={field.kind === 'date' ? 'date' : 'text'}
              inputMode={field.kind === 'decimal' ? 'decimal' : undefined}
              hint={field.kind === 'decimal' ? copy.t('fieldDecimalHint') : undefined}
              required={entry.required}
              maxLength={2000}
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => set(field.id, event.target.value)}
            />
          );
        })}
    </>
  );
}
