import { Select } from '@intafaced/ui/lit';
import type { RailRequirements } from '../contracts';
import { railSendCopy } from '../rail-send-copy';
import { TextField as Field } from './TransferParts';

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
  return (
    <>
      {rail.fields.map((field) =>
        field.choices ? (
          <Select
            key={field.name}
            label={t(`field_${field.name}` as Key)}
            value={values[field.name] ?? field.choices[0] ?? ''}
            options={field.choices.map((choice) => [choice, t(`choice_${choice}` as Key)] as const)}
            onChange={(value) => onChange(field.name, value)}
          />
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
