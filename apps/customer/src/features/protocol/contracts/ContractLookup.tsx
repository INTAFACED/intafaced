import { useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { navigate } from '../../../app/location';
import { usePreferences } from '../../../shared/preferences';
import { ADDRESS_SHAPE } from '../routes';
import { Field } from '../volt/parts';
import { contractCopy } from './copy';

/** The Contracts tab's lookup: any address opens its contract page. */
export function ContractLookup() {
  const { language } = usePreferences();
  const { t } = contractCopy.forLocale(language);
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      aria-label={t('lookupOpen')}
      onSubmit={(event) => {
        event.preventDefault();
        const address = value.trim();
        if (!ADDRESS_SHAPE.test(address)) return setProblem(t('lookupInvalid'));
        navigate(`/protocol/contracts/${address}`);
      }}
    >
      <Field
        label={t('lookupLabel')}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        error={problem ?? undefined}
        autoComplete="off"
        spellCheck={false}
      />
      <Button tone="primary" type="submit">
        {t('lookupOpen')}
      </Button>
    </form>
  );
}
