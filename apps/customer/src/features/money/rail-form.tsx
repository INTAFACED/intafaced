import { useId } from 'react';
import { Field } from '../../shared/ui';
import type { RailRequirements } from './contracts';
import { railSendCopy } from './rail-send-copy';

/** One rail's recipient form as svc-bank publishes it (`bank.railSends.requirements`), shared by sending and the book. */

export type Rail = RailRequirements['rails'][number];
// The keys a rail, field or choice name maps to: words with no placeholder.
export type Key = Exclude<
  Parameters<ReturnType<typeof railSendCopy.useCopy>['t']>[0],
  'noPartner' | 'reference' | 'coolingActive' | 'bookMore'
>;

/** The filled fields of a rail's form; a choice field starts on its first choice, as its select shows. */
export function filled(rail: Rail | null, values: Record<string, string>): Record<string, string> {
  if (!rail) return {};
  return Object.fromEntries(
    rail.fields
      .map((field) => [field.name, (values[field.name] ?? (field.choices ? field.choices[0] : '') ?? '').trim()] as const)
      .filter(([, value]) => value !== ''),
  );
}

export function RailForm({
  rail,
  values,
  onChange,
}: {
  rail: Rail;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  const { t } = railSendCopy.useCopy();
  const id = useId();
  return (
    <>
      {rail.fields.map((field) =>
        field.choices ? (
          <label className="field" htmlFor={`${id}-${field.name}`} key={field.name}>
            <span>{t(`field_${field.name}` as Key)}</span>
            <select
              id={`${id}-${field.name}`}
              value={values[field.name] ?? field.choices[0] ?? ''}
              onChange={(event) => onChange(field.name, event.target.value)}
            >
              {field.choices.map((choice) => (
                <option key={choice} value={choice}>
                  {t(`choice_${choice}` as Key)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <Field
            key={field.name}
            label={t(`field_${field.name}` as Key)}
            name={field.name}
            autoComplete="off"
            spellCheck={false}
            value={values[field.name] ?? ''}
            onChange={(event) => onChange(field.name, event.target.value)}
          />
        ),
      )}
    </>
  );
}
