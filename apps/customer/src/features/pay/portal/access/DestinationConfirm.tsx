import { Button } from '@intafaced/ui';
import { Field } from '../../ui-kit';
import { stepUpCopy } from './step-up-copy';
import type { DestinationProof } from './destination-step-up';

/**
 * Inside the destination review: the authenticator code, or a passkey instead. The review's own button then confirms
 * and saves in one go. The code is the owner's to type each time: it is cleared after every try, right or wrong.
 */
export function DestinationConfirm({ proof, onChange }: { proof: DestinationProof; onChange: (proof: DestinationProof) => void }) {
  const { t } = stepUpCopy.useCopy();
  if (!('code' in proof))
    return (
      <div data-testid="form-stack" className="form-stack">
        <p className="muted">{t('suDestinationPasskey')}</p>
        <Button variant="ghost" onClick={() => onChange({ code: '' })}>
          {t('suOr')}
        </Button>
      </div>
    );
  return (
    <div data-testid="form-stack" className="form-stack">
      <Field
        label={`${t('suCode')} *`}
        name="destination-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={proof.code}
        hint={t('suWhyDestination')}
        onChange={(event) => onChange({ code: event.target.value.replace(/\D/g, '').slice(0, 6) })}
        data-security-sensitive="true"
      />
      <Button variant="ghost" onClick={() => onChange({ passkey: true })}>
        {t('suPasskey')}
      </Button>
    </div>
  );
}
