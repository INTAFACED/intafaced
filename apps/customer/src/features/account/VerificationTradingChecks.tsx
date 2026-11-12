import { useMemo, useState, type FormEvent } from 'react';
import { kycTradingChecksResultSchema, kycTradingChecksSchema } from '@intafaced/contracts/identity-kyc-trading-checks';
import { countryOptions } from '../public/sign-up';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { verificationTradingCopy as copy } from './verification-trading-copy';

type Words = 'paused' | 'unconfigured' | 'birthUnknown' | 'unconfirmed' | 'countryInvalid' | 'regionBlocked' | 'nameInvalid' | 'levelHeld';

/** What a refusal from `kyc.tradingChecks.run` says, by its code. A code not listed shows the service's own failure. */
const REFUSED: Readonly<Record<string, Words>> = {
  'kyc.screening_list_unset': 'paused',
  'kyc.trading_checks_unconfigured': 'unconfigured',
  'kyc.date_of_birth_unknown': 'birthUnknown',
  'kyc.country_unconfirmed': 'unconfirmed',
  'kyc.country_invalid': 'countryInvalid',
  'kyc.region_blocked': 'regionBlocked',
  'kyc.legal_name_invalid': 'nameInvalid',
  'kyc.level_held': 'levelHeld',
};

/**
 * The trading checks (J-cex-spot-01 #3; OWNER 258 (4): "trading-only users get country and sanctions checks. The full ID
 * vendor comes with the bank."). The person gives their legal name and confirms the country they live in (the one given
 * at sign-up comes pre-filled); identity runs the checks. Cleared reads "Verified for trading"; a hold reads a neutral
 * "under review". No document, photo or outside check is asked for here. `onDone` reads the page again.
 */
export function VerificationTradingChecks({ disabled, onDone }: { disabled: boolean; onDone: () => void }) {
  const { api, userId } = useSession();
  const { t, Copy, requestedLocale } = copy.useCopy();
  const countries = useMemo(() => countryOptions(requestedLocale), [requestedLocale]);
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'kyc.tradingChecks.read', undefined, kycTradingChecksSchema, { signal }),
    `verification-trading:${userId}`,
  );
  const [legalName, setLegalName] = useState('');
  const [country, setCountry] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ code: string | null; failure: Parameters<typeof Failure>[0]['result'] } | null>(null);

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed')
    return (
      <section className="verification__trading" aria-label={t('form')} data-testid="verification__trading">
        <h2>
          <Copy k="failedTitle" />
        </h2>
        <Failure result={resource.failure} retry={reload} />
      </section>
    );
  const view = resource.data;
  const chosen = country ?? view.country ?? '';
  const chosenName = countries.find((c) => c.code === chosen)?.name ?? chosen;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || disabled) return;
    setBusy(true);
    setRefused(null);
    const answer = await api.mutate(
      'identity',
      'kyc.tradingChecks.run',
      { legalName: legalName.trim(), country: chosen, confirmed: confirmed as true },
      kycTradingChecksResultSchema,
    );
    setBusy(false);
    if (!answer.ok) return setRefused({ code: answer.code ?? null, failure: answer });
    reload();
    onDone();
  }

  if (view.state !== 'not_run')
    return (
      <section className="verification__trading" aria-label={t('form')} data-testid="verification__trading" data-state={view.state}>
        <h2>
          <Copy k={view.state === 'cleared' ? 'cleared' : 'held'} />
        </h2>
        <p role="status">
          <Copy k={view.state === 'cleared' ? 'clearedBody' : 'heldBody'} />
        </p>
      </section>
    );

  const words = refused?.code ? REFUSED[refused.code] : undefined;
  return (
    <section className="verification__trading" data-testid="verification__trading" data-state="not_run">
      <form className="form-stack" aria-label={t('form')} onSubmit={(event) => void submit(event)}>
        <h2>
          <Copy k="form" />
        </h2>
        <p className="muted">
          <Copy k="intro" />
        </p>
        <Field
          label={t('legalName')}
          name="trading-legal-name"
          required
          minLength={2}
          maxLength={200}
          autoComplete="name"
          value={legalName}
          disabled={disabled || busy}
          onChange={(event) => setLegalName(event.target.value)}
          hint={t('legalNameHint')}
        />
        <label className="field">
          <span>
            <Copy k="country" />
          </span>
          <select
            name="trading-country"
            required
            value={chosen}
            disabled={disabled || busy}
            onChange={(event) => {
              setCountry(event.target.value);
              setConfirmed(false);
            }}
          >
            <option value="" disabled>
              {t('countryPick')}
            </option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="verification__trading-confirm">
          <input
            type="checkbox"
            required
            checked={confirmed}
            disabled={disabled || busy || !chosen}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>{t('confirm', { country: chosenName || '…' })}</span>
        </label>
        <Button type="submit" disabled={disabled || busy || !chosen || !confirmed || legalName.trim().length < 2}>
          <Copy k={busy ? 'running' : 'run'} />
        </Button>
        {refused ? (
          words ? (
            <p className="failure" role="alert" data-code={refused.code ?? undefined}>
              <Copy k={words} />
            </p>
          ) : (
            <div role="alert" data-code={refused.code ?? undefined}>
              <Failure result={refused.failure} />
            </div>
          )
        ) : null}
      </form>
    </section>
  );
}
